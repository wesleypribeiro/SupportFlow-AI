import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AIMessage } from '@langchain/core/messages';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { createApplication } from '../src/app.js';
import type { PreparedAction } from '../src/core/pending-actions.js';
import type { LanguageSchoolAction } from '../src/modules/language-school/infrastructure/pending-actions.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const unchanged = { goal: null, name: null, contact: null, courseReference: null };
const proposal = () => ({
  kind: 'create_lead' as const,
  preview: {
    name: 'Ana Exemplo', contact: { type: 'email' as const, value: 'ana@example.com' },
    courseId: 'course_english_travel', goal: 'viagem',
  },
});

// Somente o teste simula uma escrita. Não existe LeadRepository nem executor de negócio na aplicação.
function receipt(action: PreparedAction<LanguageSchoolAction>) {
  if (action.kind !== 'create_lead') throw new Error('Ação não preparada neste teste.');
  return {
    reply: 'Resultado do executor simulado.',
    results: [{
      tool: 'create_lead' as const,
      result: { ok: true as const, data: { outcome: 'created' as const, lead: { id: 'lead_test', ...action.args } } },
    }],
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('confirmação vinculada e serializada pelo backend', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede externa proibida.'); });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function application(model = new ScriptedChatModel([]), executeAction = vi.fn(async (action: PreparedAction<LanguageSchoolAction>) => receipt(action))) {
    const app = createApplication({}, { model, executeAction });
    servers.push(app.server);
    return { ...app, executeAction, model };
  }

  function conversation(app: ReturnType<typeof createApplication>) {
    const item = app.conversations.create();
    item.context = { ...item.context, ...proposal().preview, revision: 2 };
    app.conversations.save(item);
    return item;
  }

  function confirm(server: FastifyInstance, conversationId: string, actionId: string, extras = {}) {
    return server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId, actionId, ...extras } });
  }

  function post(server: FastifyInstance, conversationId: string, message: string) {
    return server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId, message } });
  }

  it('aceita somente IDs, executa os argumentos armazenados e não consulta a LLM', async () => {
    const app = application();
    const current = conversation(app);
    const prepared = await app.prepareAction(current.id, proposal());
    const response = await confirm(app.server, current.id, prepared.actionId);
    const body = languageSchoolChatResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      conversationId: current.id, pendingAction: null,
      ...receipt({ ...proposal(), args: proposal().preview, actionId: prepared.actionId, conversationId: current.id, revision: 2 }),
    });
    expect(app.executeAction).toHaveBeenCalledExactlyOnceWith({
      ...proposal(), args: proposal().preview, actionId: prepared.actionId, conversationId: current.id, revision: 2,
    });
    expect(Object.keys(prepared).sort()).toEqual(['actionId', 'kind', 'preview']);
    expect(app.model.calls).toHaveLength(0);
    expect(app.model.contextCalls).toHaveLength(0);
    expect(app.conversations.get(current.id)).toEqual(current); // Nenhum lead real foi gravado.
  });

  it.each([
    { args: proposal().preview }, { name: 'Outro Nome' }, { contact: proposal().preview.contact },
    { courseId: 'outro_curso' }, { slotId: 'slot_fake' }, { confirmed: true }, { revision: 2 },
    { history: [] }, { context: {} }, { schoolId: 'school_other' }, { extra: true },
  ])('rejeita campos/argumentos adicionais: %j', async (extra) => {
    const app = application();
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const response = await confirm(app.server, current.id, action.actionId, extra);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(app.executeAction).not.toHaveBeenCalled();
  });

  it.each([
    {}, { conversationId: 'conversation' }, { actionId: 'action' },
    { conversationId: 1, actionId: 'action' }, { conversationId: 'conversation', actionId: true },
    { conversationId: '', actionId: 'action' }, { conversationId: 'conversation', actionId: '' },
    { conversationId: null, actionId: null },
  ])('rejeita IDs ausentes/incorretos: %j', async (payload) => {
    const app = application();
    const response = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(app.executeAction).not.toHaveBeenCalled();
  });

  it('recusa JSON malformado com envelope público', async () => {
    const app = application();
    const response = await app.server.inject({
      method: 'POST', url: '/api/chat/confirm', headers: { 'content-type': 'application/json' }, payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
  });

  it('não diferencia ação inexistente, estrangeira ou conversa inexistente', async () => {
    const app = application();
    const owner = conversation(app);
    const other = conversation(app);
    const action = await app.prepareAction(owner.id, proposal());
    const missing = await confirm(app.server, other.id, 'missing_action');
    const foreign = await confirm(app.server, other.id, action.actionId);
    const absentConversation = await confirm(app.server, 'missing_conversation', action.actionId);
    expect([missing.statusCode, foreign.statusCode, absentConversation.statusCode]).toEqual([404, 404, 404]);
    expect(missing.json()).toEqual(foreign.json());
    expect(missing.json()).toEqual(absentConversation.json());
    expect(foreign.body).not.toContain(owner.id);
    expect(foreign.body).not.toContain(action.actionId);
    expect(app.executeAction).not.toHaveBeenCalled();
    await confirm(app.server, owner.id, action.actionId);
    const completedForeign = await confirm(app.server, other.id, action.actionId);
    expect(completedForeign.statusCode).toBe(404);
    expect(completedForeign.json()).toEqual(missing.json());
    expect(app.executeAction).toHaveBeenCalledTimes(1);
  });

  it('captura cópias dos argumentos e da prévia sem permitir substituição pelo navegador', async () => {
    const app = application();
    const current = conversation(app);
    const input = proposal();
    const original = structuredClone(input);
    const action = await app.prepareAction(current.id, input);
    input.preview.name = 'Alterado depois';
    input.preview.contact.value = 'alterado@example.com';
    if ('contact' in action.preview) action.preview.contact.value = 'preview@example.com';
    const invalid = await confirm(app.server, current.id, action.actionId, { args: input.preview });
    expect(invalid.statusCode).toBe(400);
    const response = await confirm(app.server, current.id, action.actionId);
    expect(response.statusCode).toBe(200);
    expect(app.executeAction.mock.calls[0]?.[0].args).toEqual(original.preview);
    expect(response.json().results[0].result.data.lead).toEqual({ id: 'lead_test', ...original.preview });
  });

  it.each([
    { message: 'Agora quero entrevistas.', patch: { ...unchanged, goal: 'entrevistas' } },
    { message: 'Meu nome é Bia.', patch: { ...unchanged, name: 'Bia' } },
    { message: 'Use novo@example.com.', patch: { ...unchanged, contact: { type: 'email', value: 'novo@example.com' } } },
    { message: 'Quero espanhol.', patch: { ...unchanged, courseReference: 'espanhol' } },
  ])('invalida a ação após correção efetiva: $message', async ({ message, patch }) => {
    const app = application(new ScriptedChatModel([new AIMessage('Entendido.')], { contextSteps: [patch] }));
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const chat = await post(app.server, current.id, message);
    expect(chat.statusCode).toBe(200);
    expect(chat.json().pendingAction).toBeNull();
    expect(app.conversations.get(current.id)?.context.revision).toBe(3);
    const confirmation = await confirm(app.server, current.id, action.actionId);
    expect(confirmation.statusCode).toBe(409);
    expect(confirmation.json().error.code).toBe('ACTION_STALE');
    expect(app.executeAction).not.toHaveBeenCalled();
  });

  it.each(['Pode continuar?', 'Sim'])('preserva a prévia sem autorizar execução por texto: %s', async (message) => {
    const app = application(new ScriptedChatModel([new AIMessage('Podemos continuar.')], {
      contextSteps: [{ ...unchanged, goal: 'viagem', name: 'Ana Exemplo', contact: proposal().preview.contact }],
    }));
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const response = await post(app.server, current.id, message);
    expect(response.statusCode).toBe(200);
    expect(languageSchoolChatResponseSchema.parse(response.json()).pendingAction).toEqual(action);
    expect(app.conversations.get(current.id)?.context.revision).toBe(2);
    expect(app.executeAction).not.toHaveBeenCalled();
    expect((await confirm(app.server, current.id, action.actionId)).statusCode).toBe(200);
  });

  it('substitui a prévia atual e conserva a anterior como stale', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Vamos continuar.') ]));
    const current = conversation(app);
    const first = await app.prepareAction(current.id, proposal());
    const second = await app.prepareAction(current.id, proposal());
    expect(second.actionId).not.toBe(first.actionId);
    const chat = await post(app.server, current.id, 'Pode continuar?');
    expect(chat.json().pendingAction).toEqual(second);
    const stale = await confirm(app.server, current.id, first.actionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ACTION_STALE');
    expect(app.executeAction).not.toHaveBeenCalled();
    expect((await confirm(app.server, current.id, second.actionId)).statusCode).toBe(200);
  });

  it('valida a preparação sem substituir uma prévia válida por dados inválidos', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Vamos continuar.')]));
    const current = conversation(app);
    const first = await app.prepareAction(current.id, proposal());
    await expect(app.prepareAction(current.id, { ...proposal(), confirmed: true })).rejects.toThrow();
    await expect(app.prepareAction('unknown', proposal())).rejects.toThrow();
    const response = await post(app.server, current.id, 'Pode continuar?');
    expect(response.json().pendingAction).toEqual(first);
  });

  it('recupera o recibo original antes de avaliar revisão, inclusive com uma nova ação pendente', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Objetivo corrigido.')], {
      contextSteps: [{ ...unchanged, goal: 'entrevistas' }],
    }));
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const first = await confirm(app.server, current.id, action.actionId);
    const repeated = await confirm(app.server, current.id, action.actionId);
    expect(repeated.json()).toEqual(first.json());
    await post(app.server, current.id, 'Agora quero entrevistas.');
    expect(app.conversations.get(current.id)?.context.revision).toBe(3);
    const afterCorrection = await confirm(app.server, current.id, action.actionId);
    expect(afterCorrection.json()).toEqual(first.json());
    const newAction = await app.prepareAction(current.id, { ...proposal(), preview: { ...proposal().preview, goal: 'entrevistas' } });
    const withPending = await confirm(app.server, current.id, action.actionId);
    expect(withPending.json()).toEqual({ ...first.json(), pendingAction: newAction });
    expect(app.executeAction).toHaveBeenCalledTimes(1);
  });

  it('recupera o recibo salvo quando o envio HTTP falha depois da conclusão', async () => {
    const app = application();
    let failOnce = true;
    app.server.addHook('onSend', async (request, reply, payload) => {
      if (request.url === '/api/chat/confirm' && reply.statusCode === 200 && failOnce) {
        failOnce = false;
        throw new Error('INTERNAL_ONLY: falha após salvar o recibo');
      }
      return payload;
    });
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const failure = await confirm(app.server, current.id, action.actionId);
    expect(failure.statusCode).toBe(500);
    expect(failure.json().error.code).toBe('CHAT_ERROR');
    expect(failure.body).not.toContain('INTERNAL_ONLY');
    const retry = await confirm(app.server, current.id, action.actionId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().results[0].result.data.lead.id).toBe('lead_test');
    expect(retry.json().pendingAction).toBeNull();
    expect(app.executeAction).toHaveBeenCalledTimes(1);
  });

  it.each(['context', 'model', 'response'])('falha de %s não grava turno parcial nem invalida a ação anterior', async (stage) => {
    const model = new ScriptedChatModel([
      stage === 'model' ? new Error('INTERNAL_ONLY') : new AIMessage(stage === 'response' ? '' : 'Entendido.'),
    ], { contextSteps: [stage === 'context'
      ? { ...unchanged, goal: 'entrevistas', contact: { type: 'email', value: 'inválido' } }
      : { ...unchanged, goal: 'entrevistas' }] });
    const app = application(model);
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const failure = await post(app.server, current.id, 'Agora quero entrevistas.');
    expect(failure.statusCode).toBe(500);
    expect(app.conversations.get(current.id)).toEqual(current);
    expect((await confirm(app.server, current.id, action.actionId)).statusCode).toBe(200);
  });

  it('confirmação espera a correção que chegou antes e observa a nova revisão', async () => {
    const started = gate();
    const release = gate();
    const queued = gate();
    const model = new ScriptedChatModel([async () => {
      started.release();
      await release.promise;
      return new AIMessage('Objetivo corrigido.');
    }], { contextSteps: [{ ...unchanged, goal: 'entrevistas' }] });
    const app = application(model);
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const chat = post(app.server, current.id, 'Agora quero entrevistas.').then((response) => response);
    await started.promise;
    const runExclusive = app.conversations.runExclusive.bind(app.conversations);
    vi.spyOn(app.conversations, 'runExclusive').mockImplementation((id, operation) => {
      const running = runExclusive(id, operation);
      queued.release();
      return running;
    });
    const confirmation = confirm(app.server, current.id, action.actionId).then((response) => response);
    await queued.promise;
    expect(app.executeAction).not.toHaveBeenCalled();
    expect(app.conversations.get(current.id)?.context.revision).toBe(2);
    release.release();
    const [chatResponse, confirmationResponse] = await Promise.all([chat, confirmation]);
    expect(chatResponse.statusCode).toBe(200);
    expect(app.conversations.get(current.id)?.context.revision).toBe(3);
    expect(confirmationResponse.statusCode).toBe(409);
    expect(confirmationResponse.json().error.code).toBe('ACTION_STALE');
    expect(app.executeAction).not.toHaveBeenCalled();
  });

  it('outra conversa processa mensagem e confirmação enquanto a primeira aguarda', async () => {
    const started = gate();
    const release = gate();
    const app = application(new ScriptedChatModel([
      async () => { started.release(); await release.promise; return new AIMessage('Resposta A.'); },
      new AIMessage('Resposta B.'),
    ]));
    const first = conversation(app);
    const other = conversation(app);
    const action = await app.prepareAction(other.id, proposal());
    const waiting = post(app.server, first.id, 'Pode continuar?').then((response) => response);
    await started.promise;
    try {
      const chat = await post(app.server, other.id, 'Pode continuar?');
      expect(chat.statusCode).toBe(200);
      expect((await confirm(app.server, other.id, action.actionId)).statusCode).toBe(200);
      expect(app.conversations.get(first.id)?.history).toHaveLength(0);
    } finally {
      release.release();
    }
    expect((await waiting).statusCode).toBe(200);
  });

  it('duas confirmações concorrentes executam uma única vez', async () => {
    const started = gate();
    const release = gate();
    const queued = gate();
    const execute = vi.fn(async (action: PreparedAction<LanguageSchoolAction>) => {
      started.release(); await release.promise; return receipt(action);
    });
    const app = application(new ScriptedChatModel([]), execute);
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const first = confirm(app.server, current.id, action.actionId).then((response) => response);
    await started.promise;
    const runExclusive = app.conversations.runExclusive.bind(app.conversations);
    vi.spyOn(app.conversations, 'runExclusive').mockImplementation((id, operation) => {
      const running = runExclusive(id, operation);
      queued.release();
      return running;
    });
    const second = confirm(app.server, current.id, action.actionId).then((response) => response);
    await queued.promise;
    expect(execute).toHaveBeenCalledTimes(1);
    release.release();
    const results = await Promise.all([first, second]);
    expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(results[0]?.json()).toEqual(results[1]?.json());
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['exception', 'invalid_receipt'])('sanitiza %s do executor sem publicar resultados internos', async (failure) => {
    const executeAction = vi.fn(async () => {
      if (failure === 'exception') throw new Error('INTERNAL_ONLY: falha do executor');
      return { reply: 'INTERNAL_ONLY', results: [{ tool: 'invented_tool', result: {} }] };
    });
    const app = createApplication({}, { executeAction });
    servers.push(app.server);
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    const response = await confirm(app.server, current.id, action.actionId);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('CHAT_ERROR');
    expect(response.body).not.toContain('INTERNAL_ONLY');
    expect(response.body).not.toContain('invented_tool');
    expect(app.conversations.get(current.id)).toEqual(current);
  });

  it('permanece inicializável sem executor e sanitiza tentativa de confirmação', async () => {
    const app = createApplication({});
    servers.push(app.server);
    const current = conversation(app);
    const action = await app.prepareAction(current.id, proposal());
    expect((await app.server.inject('/health')).statusCode).toBe(200);
    const response = await confirm(app.server, current.id, action.actionId);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: {
      code: 'CHAT_ERROR', message: 'Não foi possível concluir o atendimento. Tente novamente.',
    } });
    expect(response.body).not.toContain('Executor');
  });
});
