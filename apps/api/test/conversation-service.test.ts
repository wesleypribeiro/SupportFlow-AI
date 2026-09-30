import assert from 'node:assert/strict';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { chatErrorResponseSchema } from '@supportflow/contracts/chat';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApplication } from '../src/app.js';
import { createConversationService } from '../src/core/conversation-service.js';
import type { ConversationServiceResult } from '../src/core/conversation-service.js';
import { InMemoryConversations } from '../src/core/conversations.js';
import { InMemoryPendingActions } from '../src/core/pending-actions.js';
import { createConversationContext } from '../src/modules/language-school/domain/conversation-context.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import {
  createJourneyModel, dialogue, handoffTurn, leadTurn, modelContext, query, scheduleTurn,
  type JourneyScript,
} from './helpers/journey-script.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const email = { type: 'email' as const, value: 'ana@example.com' };
const leadPatch = { name: 'Ana', contact: email, goal: 'viagem', courseReference: 'inglês' };
const registrationMessage = 'Quero inglês para viagem. Meu nome é Ana. Meu email é ana@example.com. Quero me cadastrar.';
const slotSelection = { slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } };
const bookingMessage = 'Escolho 11/06/2030 às 10h. Quero agendar.';

function success(result: ConversationServiceResult<LanguageSchoolChatResponse>) {
  assert(result.ok, JSON.stringify(result));
  expect(languageSchoolChatResponseSchema.parse(result.response)).toEqual(result.response);
  return result.response;
}
function confirmation(body: LanguageSchoolChatResponse) {
  assert(body.pendingAction);
  return { conversationId: body.conversationId, actionId: body.pendingAction.actionId };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Mesma composição das rotas, repositories e tools reais. Somente a geração é simulada.
// A fronteira interna é exercitada diretamente e intercalada com server.inject().
describe('ConversationService — extração compatível com a API', () => {
  const servers: FastifyInstance[] = [];
  const network = vi.fn(() => { throw new Error('Rede externa proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', network);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function application(script: JourneyScript) {
    const model = createJourneyModel(script);
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
    const handoffRepository = new InMemoryHandoffRepository();
    const app = createApplication({}, { model, leadRepository, trialClassRepository, handoffRepository, now });
    servers.push(app.server);
    return { ...app, model, leadRepository, trialClassRepository, handoffRepository };
  }
  type App = ReturnType<typeof application>;
  async function send(app: App, message: string, conversationId?: string) {
    return success(await app.conversationService.sendMessage({ message, ...(conversationId ? { conversationId } : {}) }));
  }
  async function confirm(app: App, body: LanguageSchoolChatResponse) {
    return success(await app.conversationService.confirmAction(confirmation(body)));
  }

  describe('1.2 — abertura interna e leitura consistente', () => {
    async function open(app: App) {
      const result = await app.conversationService.openConversation();
      assert(result.ok, JSON.stringify(result));
      expect(Object.keys(result.response)).toEqual(['conversationId']);
      return result.response.conversationId;
    }
    async function read(app: App, conversationId: string) {
      const result = await app.conversationService.getCurrentPendingAction({ conversationId });
      assert(result.ok, JSON.stringify(result));
      expect(Object.keys(result.response)).toEqual(['pendingAction']);
      return result.response.pendingAction;
    }

    it('abre duas conversas persistidas com IDs do backend e defaults oficiais, sem modelo ou negócios', async () => {
      const app = application([]);
      const create = vi.spyOn(app.conversations, 'create');
      const lock = vi.spyOn(app.conversations, 'runExclusive');
      const [first, second] = await Promise.all([open(app), open(app)]);
      expect(first).not.toBe(second);
      expect(first).toBe(create.mock.results[0]!.value.id);
      expect(second).toBe(create.mock.results[1]!.value.id);
      for (const id of [first, second]) {
        expect(id.trim()).not.toBe('');
        expect(app.conversations.get(id)).toEqual({ id, history: [], context: {
          goal: null, name: null, contact: null, courseId: null,
          slotId: null, leadId: null, revision: 0,
        } });
        expect(await read(app, id)).toBeNull();
        expect(await app.leadRepository.findByConversationId(id)).toBeNull();
        expect(await app.handoffRepository.findOpenByConversationId(id)).toBeNull();
      }
      for (const slot of slotFixtures) expect(await app.trialClassRepository.findConfirmedBySlotId(slot.slotId)).toBeNull();
      expect(create).toHaveBeenCalledTimes(2);
      expect(lock).toHaveBeenCalledTimes(4); // Duas aberturas e duas leituras, sem aquisição interna extra.
      expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    });

    it('primeiro turno reutiliza a conversa aberta e atualiza normalmente contexto e histórico', async () => {
      const app = application([dialogue(new AIMessage('Olá!'), { goal: 'viagem' })]);
      const create = vi.spyOn(app.conversations, 'create');
      const id = await open(app);
      const other = await open(app);
      const beforeOther = app.conversations.get(other);
      const body = await send(app, 'Olá, quero estudar para viagem.', id);
      expect(body.conversationId).toBe(id);
      expect(create).toHaveBeenCalledTimes(2); // O turno não cria uma terceira conversa.
      expect(app.conversations.get(id)?.context).toEqual({ ...createConversationContext(), goal: 'viagem', revision: 1 });
      expect(app.conversations.get(id)?.history.map((message) => message.text)).toEqual(['Olá, quero estudar para viagem.', 'Olá!']);
      expect(app.conversations.get(other)).toEqual(beforeOther);
    });

    it.each(['contexto', 'seleção', 'redação', 'envelope'])('falha de %s no primeiro turno preserva a conversa explicitamente aberta', async (failure) => {
      const turn = failure === 'contexto'
        ? dialogue(new AIMessage('Olá'), { name: 'Nome inventado' })
        : failure === 'seleção'
          ? dialogue(new Error('PRIVATE'), leadPatch)
          : query('create_lead', ({ name, contact, courseId, goal }) => ({ name, contact, courseId, goal }),
            leadPatch, failure === 'redação' ? new Error('PRIVATE') : new AIMessage(''));
      const app = application([turn]);
      const id = await open(app);
      const before = app.conversations.get(id);
      const save = vi.spyOn(app.conversations, 'save');
      const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
      expect(await app.conversationService.sendMessage({ conversationId: id, message: registrationMessage }))
        .toEqual({ ok: false, code: 'CHAT_ERROR' });
      expect(app.conversations.get(id)).toEqual(before);
      expect(save).not.toHaveBeenCalled();
      expect(await read(app, id)).toBeNull();
      expect(await app.leadRepository.findByConversationId(id)).toBeNull();
      if (failure === 'envelope') {
        expect(stage).toHaveBeenCalledOnce();
        const discarded = stage.mock.results[0]!.value as { preview: { actionId: string } };
        expect(await app.conversationService.confirmAction({ conversationId: id, actionId: discarded.preview.actionId }))
          .toEqual({ ok: false, code: 'NOT_FOUND' });
      } else expect(stage).not.toHaveBeenCalled();
    });

    it('leitura de conversa inexistente retorna NOT_FOUND sem criar sessão ou consultar modelo', async () => {
      const app = application([]);
      const create = vi.spyOn(app.conversations, 'create');
      const save = vi.spyOn(app.conversations, 'save');
      expect(await app.conversationService.getCurrentPendingAction({ conversationId: 'missing' }))
        .toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(create).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
      expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    });

    it('leitura publica somente cópia defensiva da prévia, sem efeitos no contexto/lifecycle/negócios', async () => {
      const app = application([leadTurn(leadPatch)]);
      const id = await open(app);
      const proposed = await send(app, registrationMessage, id);
      const before = app.conversations.get(id);
      const calls = app.model.calls.length;
      const contextCalls = app.model.contextCalls.length;
      const create = vi.spyOn(app.conversations, 'create');
      const save = vi.spyOn(app.conversations, 'save');
      const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
      const execute = vi.spyOn(InMemoryPendingActions.prototype, 'confirm');
      const invalidate = vi.spyOn(InMemoryPendingActions.prototype, 'invalidate');
      const leadWrite = vi.spyOn(app.leadRepository, 'createForConversation');
      const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
      const handoff = vi.spyOn(app.handoffRepository, 'requestForConversation');
      const current = await read(app, id);
      expect(current).toEqual(proposed.pendingAction);
      assert(current && 'contact' in current.preview);
      expect(Object.keys(current).sort()).toEqual(['actionId', 'kind', 'preview']);
      current.preview.contact.value = 'alterado@example.com'; current.actionId = 'alterado';
      expect(await read(app, id)).toEqual(proposed.pendingAction);
      expect(app.conversations.get(id)).toEqual(before);
      expect(app.model.calls).toHaveLength(calls); expect(app.model.contextCalls).toHaveLength(contextCalls);
      for (const operation of [create, save, stage, execute, invalidate, leadWrite, reserve, handoff]) expect(operation).not.toHaveBeenCalled();
    });

    it('leitura não publica ação concluída; recibo original continua acessível após nova revisão', async () => {
      const app = application([leadTurn(leadPatch), dialogue(new AIMessage('Corrigido.'), { goal: 'entrevistas' })]);
      const id = await open(app);
      const proposed = await send(app, registrationMessage, id);
      expect(await read(app, id)).toEqual(proposed.pendingAction);
      const create = vi.spyOn(app.leadRepository, 'createForConversation');
      const receipt = await confirm(app, proposed);
      expect(await read(app, id)).toBeNull();
      await send(app, 'Agora quero entrevistas.', id);
      expect(await read(app, id)).toBeNull();
      expect(await confirm(app, proposed)).toEqual(receipt);
      expect(create).toHaveBeenCalledOnce();
    });

    it.each([false, true])('leitura aguarda proposta local e observa commit ou rollback (falha: %s)', async (fails) => {
      const entered = gate(); const release = gate();
      const app = application([leadTurn(leadPatch), query('create_lead',
        ({ name, contact, courseId, goal }) => ({ name, contact, courseId, goal }),
        { contact: { type: 'email', value: 'ana.novo@example.com' } }, async () => {
          entered.release(); await release.promise;
          if (fails) throw new Error('PRIVATE');
          return new AIMessage('Revise a nova prévia.');
        })]);
      const id = await open(app);
      const previous = await send(app, registrationMessage, id);
      const before = app.conversations.get(id);
      const turn = app.conversationService.sendMessage({ conversationId: id, message: 'Meu email é ana.novo@example.com.' });
      await entered.promise; // A tool já propôs, a redação ainda não terminou.
      let observed = false;
      const reading = read(app, id).then((value) => { observed = true; return value; });
      try {
        const other = await open(app); // Prova de progresso independente, sem sleep.
        expect(await read(app, other)).toBeNull();
        expect(observed).toBe(false);
        expect(app.conversations.get(id)).toEqual(before);
      } finally { release.release(); }
      const result = await turn;
      const preview = await reading;
      if (fails) {
        expect(result).toEqual({ ok: false, code: 'CHAT_ERROR' });
        expect(preview).toEqual(previous.pendingAction);
        expect(app.conversations.get(id)).toEqual(before);
      } else {
        expect(preview).toEqual(success(result).pendingAction);
        expect(preview?.actionId).not.toBe(previous.pendingAction?.actionId);
        expect(preview?.preview).toMatchObject({ contact: { value: 'ana.novo@example.com' } });
      }
      expect(await app.leadRepository.findByConversationId(id)).toBeNull();
    });

    it('correção de contato → leitura → confirmação observa invalidação e não grava dados antigos', async () => {
      const entered = gate(); const release = gate();
      const app = application([leadTurn(leadPatch), dialogue(async () => {
        entered.release(); await release.promise; return new AIMessage('Contato corrigido.');
      }, { contact: { type: 'email', value: 'ana.novo@example.com' } })]);
      const id = await open(app);
      const proposed = await send(app, registrationMessage, id);
      const lock = vi.spyOn(app.conversations, 'runExclusive');
      const correction = app.conversationService.sendMessage({ conversationId: id, message: 'Meu novo email é ana.novo@example.com.' });
      await entered.promise;
      const reading = read(app, id);
      const confirming = app.conversationService.confirmAction(confirmation(proposed));
      release.release();
      const [changed, preview, result] = await Promise.all([correction, reading, confirming]);
      expect(success(changed).pendingAction).toBeNull();
      expect(preview).toBeNull();
      expect(result).toEqual({ ok: false, code: 'ACTION_STALE' });
      expect(app.conversations.get(id)?.context).toMatchObject({ contact: { value: 'ana.novo@example.com' }, revision: 2 });
      expect(await app.leadRepository.findByConversationId(id)).toBeNull();
      expect(lock).toHaveBeenCalledTimes(3);
      expect(lock.mock.calls.every(([conversationId]) => conversationId === id)).toBe(true);
    });

    it('confirmação → leitura → correção preserva recibo antigo e a gravação autorizada', async () => {
      const entered = gate(); const release = gate();
      const app = application([leadTurn(leadPatch), dialogue(new AIMessage('Contato corrigido.'), {
        contact: { type: 'email', value: 'ana.novo@example.com' },
      })]);
      const id = await open(app);
      const proposed = await send(app, registrationMessage, id);
      const create = app.leadRepository.createForConversation.bind(app.leadRepository);
      // Apenas pausa a execução: a gravação continua usando o repository real.
      const write = vi.spyOn(app.leadRepository, 'createForConversation').mockImplementation(async (...args) => {
        entered.release(); await release.promise; return create(...args);
      });
      const lock = vi.spyOn(app.conversations, 'runExclusive');
      const confirming = confirm(app, proposed);
      await entered.promise;
      const reading = read(app, id);
      const correction = app.conversationService.sendMessage({ conversationId: id, message: 'Meu novo email é ana.novo@example.com.' });
      release.release();
      const [receipt, preview, changed] = await Promise.all([confirming, reading, correction]);
      expect(receipt.results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: { contact: email } } } });
      expect(preview).toBeNull(); expect(changed.ok).toBe(true);
      expect(app.conversations.get(id)?.context.contact?.value).toBe('ana.novo@example.com');
      expect((await app.leadRepository.findByConversationId(id))?.contact).toEqual(email);
      expect(await confirm(app, proposed)).toEqual(receipt);
      expect(write).toHaveBeenCalledOnce(); expect(lock).toHaveBeenCalledTimes(4);
    });

    it('leitura entre dois turnos recebe a prévia intermediária, nunca um snapshot anterior à fila', async () => {
      const firstEntered = gate(); const firstRelease = gate();
      const secondEntered = gate(); const secondRelease = gate();
      const args = ({ name, contact, courseId, goal }: ReturnType<typeof createConversationContext>) => ({ name, contact, courseId, goal });
      const app = application([
        query('create_lead', args, leadPatch, async () => {
          firstEntered.release(); await firstRelease.promise; return new AIMessage('Prévia A.');
        }),
        query('create_lead', args, { contact: { type: 'email', value: 'ana.novo@example.com' } }, async () => {
          secondEntered.release(); await secondRelease.promise; return new AIMessage('Prévia B.');
        }),
      ]);
      const id = await open(app);
      const first = app.conversationService.sendMessage({ conversationId: id, message: registrationMessage });
      await firstEntered.promise;
      const reading = read(app, id);
      const second = app.conversationService.sendMessage({ conversationId: id, message: 'Meu novo email é ana.novo@example.com.' });
      firstRelease.release();
      await secondEntered.promise;
      try {
        const intermediate = await reading;
        expect(intermediate).toEqual(success(await first).pendingAction);
        expect(intermediate?.preview).toMatchObject({ contact: email });
        expect(app.conversations.get(id)?.context.contact).toEqual(email);
        expect(app.model.calls.at(-1)?.messages.some((message) => message.text === 'Prévia A.')).toBe(true);
      } finally { secondRelease.release(); }
      const latest = success(await second);
      expect(await read(app, id)).toEqual(latest.pendingAction);
      expect(latest.pendingAction?.preview).toMatchObject({ contact: { value: 'ana.novo@example.com' } });
      expect(app.conversations.get(id)?.context.revision).toBe(2);
      expect(await app.leadRepository.findByConversationId(id)).toBeNull();
    });
  });

  it('gera ID no backend e inicia somente após primeiro turno completo, sem HTTP', async () => {
    const app = application([dialogue(new AIMessage('Olá!'))]);
    const create = vi.spyOn(app.conversations, 'create');
    const body = await send(app, 'Olá');
    expect(body).toEqual({ conversationId: expect.any(String), reply: 'Olá!', results: [], pendingAction: null });
    expect(create).toHaveBeenCalledOnce();
    expect(body.conversationId).toBe(create.mock.results[0]!.value.id);
    expect(app.conversations.get(body.conversationId)).toMatchObject({
      context: createConversationContext(), history: [expect.any(HumanMessage), expect.any(AIMessage)],
    });
    expect(await app.leadRepository.findByConversationId(body.conversationId)).toBeNull();
  });

  it('mantém equivalência HTTP, normalização e continuidade alternando os dois adapters', async () => {
    const app = application([dialogue(new AIMessage('Olá!')), dialogue(new AIMessage('Olá!')), dialogue()]);
    const internal = await send(app, 'Olá');
    const method = vi.spyOn(app.conversationService, 'sendMessage');
    const lock = vi.spyOn(app.conversations, 'runExclusive');
    const http = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { message: '  Olá  ' } });
    expect(http.statusCode).toBe(200);
    expect(http.json()).toEqual({ ...internal, conversationId: expect.any(String) });
    expect(http.json().conversationId).not.toBe(internal.conversationId);
    expect(method).toHaveBeenCalledExactlyOnceWith({ message: 'Olá' });
    expect(lock).toHaveBeenCalledOnce();
    const continued = await send(app, 'Pode continuar?', http.json().conversationId);
    expect(continued.conversationId).toBe(http.json().conversationId);
    expect(app.model.calls[2]!.messages.filter((message) => message.type === 'human').map((message) => message.text))
      .toEqual(['Olá', 'Pode continuar?']);
    expect(app.conversations.get(internal.conversationId)?.history).toHaveLength(2);
  });

  it.each(['message', 'confirmation'] as const)('conversa inexistente: %s retorna erro interno e HTTP 404 idênticos', async (operation) => {
    const app = application([]);
    const message = { conversationId: 'missing', message: 'Olá' };
    const confirmation = { conversationId: 'missing', actionId: 'missing' };
    const payload = operation === 'message' ? message : confirmation;
    const result = operation === 'message'
      ? await app.conversationService.sendMessage(message)
      : await app.conversationService.confirmAction(confirmation);
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
    const response = await app.server.inject({ method: 'POST', url: operation === 'message' ? '/api/chat' : '/api/chat/confirm', payload });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Conversa ou ação não encontrada.' } });
    expect(app.model.calls).toHaveLength(0);
    expect(app.model.contextCalls).toHaveLength(0);
  });

  it.each([
    { url: '/api/chat', payload: { message: '  ' } },
    { url: '/api/chat', payload: { message: 42 } },
    { url: '/api/chat', payload: { message: 'Olá', context: {} } },
    { url: '/api/chat', payload: { message: 'Olá', channel: 'whatsapp' } },
    { url: '/api/chat/confirm', payload: { conversationId: 'id' } },
    { url: '/api/chat/confirm', payload: { conversationId: 'id', actionId: 'id', confirmed: true } },
  ])('contrato inválido não alcança serviço: $url $payload', async ({ url, payload }) => {
    const app = application([]);
    const sendMessage = vi.spyOn(app.conversationService, 'sendMessage');
    const confirmAction = vi.spyOn(app.conversationService, 'confirmAction');
    const response = await app.server.inject({ method: 'POST', url, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Requisição de chat inválida.' } });
    expect(sendMessage).not.toHaveBeenCalled(); expect(confirmAction).not.toHaveBeenCalled();
  });

  it.each(['context', 'model', 'envelope'] as const)('falha no primeiro turno em %s não persiste conversa parcial', async (stage) => {
    const app = application([dialogue(stage === 'model' ? new Error('PRIVATE') : new AIMessage(stage === 'envelope' ? '' : 'Olá'),
      stage === 'context' ? { name: 'Nome inventado' } : {})]);
    const create = vi.spyOn(app.conversations, 'create');
    const save = vi.spyOn(app.conversations, 'save');
    expect(await app.conversationService.sendMessage({ message: 'Olá' })).toEqual({ ok: false, code: 'CHAT_ERROR' });
    expect(save).not.toHaveBeenCalled();
    expect(app.conversations.get(create.mock.results[0]!.value.id)).toBeUndefined();
  });

  it('atualiza contexto antes da decisão e repetição não incrementa revision', async () => {
    const app = application([
      dialogue(new AIMessage('Entendi.'), { goal: 'viagem' }),
      dialogue((messages) => { expect(modelContext(messages).goal).toBe('entrevistas'); return new AIMessage('Objetivo atualizado.'); }, { goal: 'entrevistas' }),
      dialogue(new AIMessage('Continuamos.'), { goal: 'entrevistas' }),
    ]);
    const first = await send(app, 'Quero inglês para viagem.');
    const id = first.conversationId;
    expect(app.conversations.get(id)?.context.revision).toBe(1);
    await send(app, 'Na verdade, quero entrevistas.', id);
    expect(app.conversations.get(id)?.context).toMatchObject({ goal: 'entrevistas', revision: 2 });
    await send(app, 'Pode continuar?', id);
    expect(app.conversations.get(id)?.context).toMatchObject({ goal: 'entrevistas', revision: 2 });
    expect(app.conversations.get(id)?.history.filter((message) => message.type === 'human').map((message) => message.text))
      .toEqual(['Quero inglês para viagem.', 'Na verdade, quero entrevistas.', 'Pode continuar?']);
  });

  it('proposta não grava lead; confirmação usa recibo histórico antes da revisão posterior', async () => {
    const app = application([leadTurn(leadPatch), dialogue(new AIMessage('Corrigido.'), { goal: 'entrevistas' })]);
    const proposed = await send(app, registrationMessage);
    const ids = confirmation(proposed);
    expect(proposed.results[0]).toMatchObject({ tool: 'create_lead', result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED' } } });
    expect(await app.leadRepository.findByConversationId(ids.conversationId)).toBeNull();
    const create = vi.spyOn(app.leadRepository, 'createForConversation');
    const receipt = await confirm(app, proposed);
    expect(receipt.results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } } });
    expect(app.conversations.get(ids.conversationId)?.context.leadId).toBe((await app.leadRepository.findByConversationId(ids.conversationId))?.id);
    await send(app, 'Agora quero entrevistas.', ids.conversationId);
    expect(success(await app.conversationService.confirmAction(ids))).toEqual(receipt);
    const http = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: ids });
    expect(http.statusCode).toBe(200); expect(http.json()).toEqual(receipt);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(['redação', 'envelope'])('falha de %s após proposta preserva contexto, histórico e ação anterior', async (failure) => {
    const app = application([leadTurn(leadPatch),
      query('create_lead', ({ name, contact, courseId, goal }) => ({ name, contact, courseId, goal }),
        { goal: 'entrevistas' }, failure === 'redação' ? new Error('PRIVATE') : new AIMessage('')),
      dialogue()]);
    const previous = await send(app, registrationMessage);
    const before = app.conversations.get(previous.conversationId);
    const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
    expect(await app.conversationService.sendMessage({ conversationId: previous.conversationId, message: 'Agora quero entrevistas.' }))
      .toEqual({ ok: false, code: 'CHAT_ERROR' });
    expect(app.conversations.get(previous.conversationId)).toEqual(before);
    expect(stage).toHaveBeenCalledTimes(failure === 'redação' ? 0 : 1);
    if (failure === 'envelope') {
      const discarded = stage.mock.results[0]!.value as { preview: { actionId: string } };
      expect(await app.conversationService.confirmAction({ conversationId: previous.conversationId, actionId: discarded.preview.actionId }))
        .toEqual({ ok: false, code: 'NOT_FOUND' });
    }
    expect((await send(app, 'Pode continuar?', previous.conversationId)).pendingAction).toEqual(previous.pendingAction);
    expect(await app.leadRepository.findByConversationId(previous.conversationId)).toBeNull();
    expect((await confirm(app, previous)).results[0]).toMatchObject({ result: { ok: true, data: { lead: { goal: 'viagem' } } } });
  });

  it('ação estrangeira não revela nem executa os argumentos da conversa proprietária', async () => {
    const app = application([leadTurn(leadPatch), dialogue()]);
    const owner = await send(app, registrationMessage);
    const other = await send(app, 'Olá');
    const ids = { ...confirmation(owner), conversationId: other.conversationId };
    expect(await app.conversationService.confirmAction(ids)).toEqual({ ok: false, code: 'NOT_FOUND' });
    const response = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: ids });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(owner.conversationId);
    expect(await app.leadRepository.findByConversationId(owner.conversationId)).toBeNull();
    expect(await app.leadRepository.findByConversationId(other.conversationId)).toBeNull();
  });

  it('reserva e fallback pós-escrita funcionam sem HTTP; retry HTTP preserva created', async () => {
    const app = application([leadTurn(leadPatch), scheduleTurn(slotSelection), new Error('PRIVATE_LLM')]);
    const registration = await send(app, registrationMessage);
    await confirm(app, registration);
    const proposal = await send(app, bookingMessage, registration.conversationId);
    expect(proposal.pendingAction?.kind).toBe('schedule_trial_class');
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const receipt = await confirm(app, proposal);
    expect(receipt.reply).toBe('Aula experimental confirmada na agenda de demonstração.');
    expect(receipt.results).toEqual([{ tool: 'schedule_trial_class', result: { ok: true, data: {
      outcome: 'created', booking: await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'),
    } } }]);
    const calls = app.model.calls.length;
    const http = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: confirmation(proposal) });
    expect(http.statusCode).toBe(200); expect(http.json()).toEqual(receipt);
    expect(reserve).toHaveBeenCalledOnce(); expect(app.model.calls).toHaveLength(calls);
  });

  it('duas conversas disputam pelo serviço/HTTP; SLOT_UNAVAILABLE permanece recibo HTTP 200', async () => {
    const app = application([leadTurn(leadPatch), scheduleTurn(slotSelection),
      leadTurn({ ...leadPatch, name: 'Bruno', contact: { type: 'email', value: 'bruno@example.com' } }), scheduleTurn(slotSelection),
      new Error('Redação indisponível'), new Error('Redação indisponível')]);
    const first = await send(app, registrationMessage); await confirm(app, first);
    const firstAction = await send(app, bookingMessage, first.conversationId);
    const other = await send(app, registrationMessage.replaceAll('Ana', 'Bruno').replaceAll('ana@', 'bruno@')); await confirm(app, other);
    const otherAction = await send(app, bookingMessage, other.conversationId);
    const [direct, http] = await Promise.all([
      app.conversationService.confirmAction(confirmation(firstAction)),
      app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: confirmation(otherAction) }),
    ]);
    expect(http.statusCode).toBe(200);
    const responses = [success(direct), languageSchoolChatResponseSchema.parse(http.json())];
    expect(responses.flatMap((body) => body.results).filter((entry) => entry.result.ok)).toHaveLength(1);
    const conflict = responses.find((body) => body.results.some((entry) => !entry.result.ok && entry.result.error.code === 'SLOT_UNAVAILABLE'));
    assert(conflict);
    const conflictAction = conflict.conversationId === first.conversationId ? firstAction : otherAction;
    const retry = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: confirmation(conflictAction) });
    expect(retry.statusCode).toBe(200); expect(retry.json()).toEqual(conflict);
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a');
    expect(booking).not.toBeNull();
    expect(booking?.leadId).not.toBe(app.conversations.get(conflict.conversationId)?.context.leadId);
  });

  it('handoff sem lead preserva ação/revisão e contingência; não exige nem executa confirmação', async () => {
    const app = application([leadTurn(leadPatch), handoffTurn('Prefiro falar com alguém.', new Error('PRIVATE_LLM')), dialogue()]);
    const pending = await send(app, registrationMessage);
    const before = app.conversations.get(pending.conversationId)!;
    const response = await send(app, 'Prefiro falar com alguém.', pending.conversationId);
    const request = await app.handoffRepository.findOpenByConversationId(pending.conversationId);
    expect(request).not.toBeNull();
    expect(response.results).toEqual([{ tool: 'transfer_to_human', result: { ok: true, data: { request } } }]);
    expect(response.reply).toContain(`Protocolo: ${request!.id}`);
    expect(response.pendingAction).toEqual(pending.pendingAction);
    expect(app.conversations.get(pending.conversationId)?.context).toEqual(before.context);
    expect(app.conversations.get(pending.conversationId)?.history.at(-1)?.text).toBe(response.reply);
    expect(await app.leadRepository.findByConversationId(pending.conversationId)).toBeNull();
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    const notAnAction = await app.conversationService.confirmAction({ conversationId: pending.conversationId, actionId: request!.id });
    expect(notAnAction).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await send(app, 'Sim', pending.conversationId)).pendingAction).toEqual(pending.pendingAction);
    expect(await app.leadRepository.findByConversationId(pending.conversationId)).toBeNull();
    expect((await confirm(app, pending)).results[0]?.tool).toBe('create_lead');
    expect(await app.handoffRepository.findOpenByConversationId(pending.conversationId)).toEqual(request);
  });

  it('serviço e HTTP compartilham uma fila: correção antes de confirmação, sem bloquear outra conversa', async () => {
    const entered = gate(); const release = gate();
    const app = application([leadTurn(leadPatch), dialogue(async () => {
      entered.release(); await release.promise; return new AIMessage('Corrigido.');
    }, { goal: 'entrevistas' }), dialogue()]);
    const action = await send(app, registrationMessage);
    const queued = gate();
    const original = app.conversations.runExclusive.bind(app.conversations);
    const lock = vi.spyOn(app.conversations, 'runExclusive').mockImplementation((id, operation) => {
      const result = original(id, operation);
      if (lock.mock.calls.length === 2) queued.release();
      return result;
    });
    const correction = app.conversationService.sendMessage({ conversationId: action.conversationId, message: 'Quero entrevistas.' });
    await entered.promise;
    const confirmationRequest = app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: confirmation(action) }).then((response) => response);
    try {
      await queued.promise;
      expect(await app.leadRepository.findByConversationId(action.conversationId)).toBeNull();
      expect(app.conversations.get(action.conversationId)?.context.goal).toBe('viagem');
      const other = await send(app, 'Olá');
      expect(other.conversationId).not.toBe(action.conversationId);
    } finally { release.release(); }
    expect((await correction).ok).toBe(true);
    const stale = await confirmationRequest;
    expect(stale.statusCode).toBe(409);
    expect(chatErrorResponseSchema.parse(stale.json()).error.code).toBe('ACTION_STALE');
    expect(await app.conversationService.confirmAction(confirmation(action))).toEqual({ ok: false, code: 'ACTION_STALE' });
    expect(lock).toHaveBeenCalledTimes(4); // Uma aquisição por operação, sem lock na rota.
    expect(await app.leadRepository.findByConversationId(action.conversationId)).toBeNull();
  });

  it('duas mensagens internas simultâneas observam o turno anterior na mesma fila', async () => {
    const entered = gate(); const release = gate();
    const app = application([dialogue(), dialogue(async () => {
      entered.release(); await release.promise; return new AIMessage('Primeira resposta.');
    }, { goal: 'viagem' }), dialogue((messages) => {
      expect(modelContext(messages).goal).toBe('viagem');
      expect(messages.some((message) => message.text === 'Primeira resposta.')).toBe(true);
      return new AIMessage('Segunda resposta.');
    })]);
    const { conversationId } = await send(app, 'Olá');
    const first = app.conversationService.sendMessage({ conversationId, message: 'Quero viagem.' });
    await entered.promise;
    const second = app.conversationService.sendMessage({ conversationId, message: 'Pode continuar?' });
    release.release();
    const responses = await Promise.all([first, second]);
    expect(responses.every((result) => result.ok)).toBe(true);
    expect(app.conversations.get(conversationId)?.context.revision).toBe(1);
    expect(app.conversations.get(conversationId)?.history.filter((message) => message.type === 'human').map((message) => message.text))
      .toEqual(['Olá', 'Quero viagem.', 'Pode continuar?']);
  });
});

// Testes do commit do core usam tipos genéricos locais, sem regra escolar ou HTTP.
describe('ConversationService — validação e fronteira de commit', () => {
  function composition() {
    const conversations = new InMemoryConversations(() => ({ revision: 0 }));
    const actions = new InMemoryPendingActions(
      (value) => z.strictObject({ kind: z.literal('operation'), args: z.strictObject({ value: z.string() }), preview: z.string() }).parse(value),
      (value) => z.strictObject({ reply: z.string().min(1), results: z.array(z.string()) }).parse(value),
    );
    const proposal = { kind: 'operation' as const, args: { value: 'official' }, preview: 'Review' };
    const responseSchema = z.strictObject({
      conversationId: z.string(), reply: z.string().min(1), results: z.array(z.string()),
      pendingAction: z.strictObject({ actionId: z.string(), kind: z.literal('operation'), preview: z.string() }).nullable(),
    });
    return { conversations, actions, proposal, responseSchema };
  }

  it('abertura usa exclusivamente a factory injetada, sem conhecer defaults escolares', async () => {
    const factory = vi.fn(() => ({ revision: 0, preferences: { categories: ['demo'] } }));
    const conversations = new InMemoryConversations(factory);
    const { actions, responseSchema } = composition();
    const runTurn = vi.fn(async () => { throw new Error('Abertura não executa turno.'); });
    const parseResponse = vi.fn((value: unknown) => responseSchema.parse(value));
    const service = createConversationService({ conversations, actions, runTurn, parseResponse });
    const opened = await service.openConversation();
    assert(opened.ok);
    expect(factory).toHaveBeenCalledOnce();
    expect(conversations.get(opened.response.conversationId)).toEqual({
      id: opened.response.conversationId, history: [],
      context: { revision: 0, preferences: { categories: ['demo'] } },
    });
    // A saída da factory também não fica armazenada por referência.
    factory.mock.results[0]!.value.preferences.categories.push('alterada');
    expect(conversations.get(opened.response.conversationId)?.context.preferences.categories).toEqual(['demo']);
    expect(await service.getCurrentPendingAction(opened.response)).toEqual({ ok: true, response: { pendingAction: null } });
    expect(runTurn).not.toHaveBeenCalled(); expect(parseResponse).not.toHaveBeenCalled();
  });

  it('leitura filtra revisão antiga sem invalidar ou mutar o lifecycle', async () => {
    const { conversations, actions, proposal, responseSchema } = composition();
    const runTurn = vi.fn(async () => { throw new Error('Leitura não executa turno.'); });
    const service = createConversationService({ conversations, actions, runTurn, parseResponse: (value) => responseSchema.parse(value) });
    const opened = await service.openConversation();
    assert(opened.ok);
    const { conversationId } = opened.response;
    const action = actions.prepare(conversationId, 0, proposal);
    const conversation = conversations.get(conversationId)!;
    conversations.save({ ...conversation, context: { revision: 1 } });
    const invalidate = vi.spyOn(actions, 'invalidate');
    const invalidateCurrent = vi.spyOn(actions, 'invalidateCurrent');
    const pending = vi.spyOn(actions, 'pending');
    expect(await service.getCurrentPendingAction({ conversationId })).toEqual({ ok: true, response: { pendingAction: null } });
    expect(pending).toHaveBeenCalledExactlyOnceWith(conversationId, 1);
    expect(invalidate).not.toHaveBeenCalled(); expect(invalidateCurrent).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
    expect(await service.confirmAction({ conversationId, actionId: action.actionId })).toEqual({ ok: false, code: 'ACTION_STALE' });
  });

  it('envelope é validado antes de ambos os commits; stage ainda não é ação confirmável', async () => {
    const { conversations, actions, proposal, responseSchema } = composition();
    const service = createConversationService({
      conversations, actions,
      runTurn: async (conversation, message) => ({
        reply: 'Revise.', results: [], context: { revision: 1 },
        history: [...conversation.history, new HumanMessage(message), new AIMessage('Revise.')], actionProposal: proposal,
      }),
      parseResponse: (value) => {
        const response = responseSchema.parse(value);
        expect(conversations.get(response.conversationId)).toBeUndefined();
        expect(actions.pending(response.conversationId, 1)).toBeNull();
        expect(response.pendingAction).not.toBeNull();
        return response;
      },
    });
    const result = await service.sendMessage({ message: 'Preparar operação.' });
    assert(result.ok);
    expect(conversations.get(result.response.conversationId)?.context.revision).toBe(1);
    expect(actions.pending(result.response.conversationId, 1)).toEqual(result.response.pendingAction);
  });

  it('falha de validação da resposta após conclusão conserva recibo e retry não reexecuta', async () => {
    const { conversations, actions, proposal, responseSchema } = composition();
    const conversation = conversations.create(); conversations.save(conversation);
    const action = actions.prepare(conversation.id, 0, proposal);
    const executeAction = vi.fn(async () => ({ reply: 'Concluída.', results: ['official'] }));
    const parseResponse = vi.fn((value: unknown) => responseSchema.parse(value));
    parseResponse.mockImplementationOnce(() => { throw new Error('PRIVATE'); });
    const service = createConversationService({
      conversations, actions, executeAction, parseResponse,
      runTurn: async () => { throw new Error('Confirmação não consulta o modelo.'); },
    });
    const request = { conversationId: conversation.id, actionId: action.actionId };
    expect(await service.confirmAction(request)).toEqual({ ok: false, code: 'CHAT_ERROR' });
    conversations.save({ ...conversation, context: { revision: 9 } });
    expect(await service.confirmAction(request)).toEqual({ ok: true, response: {
      conversationId: conversation.id, reply: 'Concluída.', results: ['official'], pendingAction: null,
    } });
    expect(executeAction).toHaveBeenCalledOnce();
  });
});
