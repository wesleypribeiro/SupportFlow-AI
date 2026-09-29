import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AIMessage } from '@langchain/core/messages';
import { createLeadResultSchema, languageSchoolChatResponseSchema, leadPendingActionSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput } from '@supportflow/contracts/language-school';
import { createApplication } from '../src/app.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const data = (): CreateLeadInput => ({
  name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
  courseId: 'course_english_travel', goal: 'viagem',
});

describe('primeiro lead: proposta separada da confirmação HTTP', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede externa proibida nos testes.'); });

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

  function application(model = new ScriptedChatModel([])) {
    const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
    const leadRepository = new InMemoryLeadRepository();
    const app = createApplication({}, { schoolRepository, leadRepository, model });
    servers.push(app.server);
    return { ...app, schoolRepository, leadRepository, model };
  }

  function conversation(app: ReturnType<typeof application>, input = data()) {
    const current = app.conversations.create();
    current.context = { ...current.context, ...structuredClone(input), revision: 7 };
    app.conversations.save(current);
    return current;
  }

  function confirm(server: FastifyInstance, conversationId: string, actionId: string, extra = {}) {
    return server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId, actionId, ...extra } });
  }

  it('Ana/ana@example.com/inglês/viagem gera somente prévia; confirmar cria exatamente um lead', async () => {
    const app = application();
    const current = conversation(app);
    const write = vi.spyOn(app.leadRepository, 'createForConversation');
    const prepared = await app.prepareLead(current.id, data());
    expect(createLeadResultSchema.parse(prepared.result)).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    expect(pending.preview).toEqual(data());
    expect(await app.leadRepository.findByConversationId(current.id)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(app.conversations.get(current.id)?.context.leadId).toBeNull();

    const response = await confirm(app.server, current.id, pending.actionId);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    const saved = await app.leadRepository.findByConversationId(current.id);
    expect(saved).toEqual({ ...data(), id: expect.any(String) });
    expect(saved?.id).not.toBe(current.id);
    expect(body.results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: saved } } }]);
    expect(body.pendingAction).toBeNull();
    expect(write).toHaveBeenCalledExactlyOnceWith(current.id, data());
    expect(app.conversations.get(current.id)).toEqual({ ...current, context: { ...current.context, leadId: saved?.id } });
    const repeated = await confirm(app.server, current.id, pending.actionId);
    expect(repeated.json()).toEqual(body);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual(saved);
    expect(app.model.calls).toHaveLength(0);
    expect(app.model.contextCalls).toHaveLength(0);
  });

  it('cria com objetivo null e telefone válido sem normalizar seus dados', async () => {
    const app = application();
    const input: CreateLeadInput = { ...data(), goal: null, contact: { type: 'phone', value: '+55 (11) 99999-1234' } };
    const current = conversation(app, input);
    const prepared = await app.prepareLead(current.id, input);
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    const response = await confirm(app.server, current.id, pending.actionId);
    expect(response.statusCode).toBe(200);
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual({ ...input, id: expect.any(String) });
  });

  it('recusa argumentos do navegador e mantém o snapshot após mutações na entrada e na prévia', async () => {
    const app = application();
    const current = conversation(app);
    const input = data();
    const prepared = await app.prepareLead(current.id, input);
    if (!prepared.pendingAction) throw new Error('Prévia esperada.');
    input.name = 'Maria';
    input.contact.value = 'maria@example.com';
    if ('contact' in prepared.pendingAction.preview) prepared.pendingAction.preview.contact.value = 'preview@example.com';
    const invalid = await confirm(app.server, current.id, prepared.pendingAction.actionId, { args: input, confirmed: true });
    expect(invalid.statusCode).toBe(400);
    expect(await app.leadRepository.findByConversationId(current.id)).toBeNull();
    const response = await confirm(app.server, current.id, prepared.pendingAction.actionId);
    expect(response.statusCode).toBe(200);
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual({ ...data(), id: expect.any(String) });
  });

  it('uma correção anterior à confirmação torna a ação stale e não grava lead', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Objetivo corrigido.')], {
      contextSteps: [{ goal: 'entrevistas de emprego', name: null, contact: null, courseReference: null }],
    }));
    const current = conversation(app);
    const prepared = await app.prepareLead(current.id, data());
    const action = leadPendingActionSchema.parse(prepared.pendingAction);
    const correction = await app.server.inject({
      method: 'POST', url: '/api/chat', payload: { conversationId: current.id, message: 'Agora quero entrevistas de emprego.' },
    });
    expect(correction.statusCode).toBe(200);
    expect(correction.json().pendingAction).toBeNull();
    const confirmation = await confirm(app.server, current.id, action.actionId);
    expect(confirmation.statusCode).toBe(409);
    expect(confirmation.json().error.code).toBe('ACTION_STALE');
    expect(await app.leadRepository.findByConversationId(current.id)).toBeNull();
    expect(app.conversations.get(current.id)?.context.leadId).toBeNull();
  });

  it('revalida o catálogo quando o curso deixa de estar disponível após a prévia', async () => {
    const app = application();
    const current = conversation(app);
    const prepared = await app.prepareLead(current.id, data());
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    vi.spyOn(app.schoolRepository, 'findActiveCourseById').mockResolvedValue(null);
    const write = vi.spyOn(app.leadRepository, 'createForConversation');
    const response = await confirm(app.server, current.id, pending.actionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([{ tool: 'create_lead', result: {
      ok: false, error: { code: 'NOT_FOUND', message: 'Curso não encontrado ou indisponível.' },
    } }]);
    expect(write).not.toHaveBeenCalled();
    expect(await app.leadRepository.findByConversationId(current.id)).toBeNull();
    expect(app.conversations.get(current.id)).toEqual(current);
  });

  it('revalida a coerência mesmo para ação preparada diretamente pela composição interna', async () => {
    const app = application();
    const current = conversation(app);
    const action = await app.prepareAction(current.id, { kind: 'create_lead', preview: { ...data(), name: 'Maria' } });
    const response = await confirm(app.server, current.id, action.actionId);
    expect(response.json().results[0].result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await app.leadRepository.findByConversationId(current.id)).toBeNull();
  });

  it('falha antes da gravação não cria lead parcial, não consome recibo de sucesso e permite retry', async () => {
    const app = application();
    const current = conversation(app);
    const prepared = await app.prepareLead(current.id, data());
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    const write = vi.spyOn(app.leadRepository, 'createForConversation').mockRejectedValueOnce(new Error('INTERNAL_ONLY: repository indisponível'));
    const failed = await confirm(app.server, current.id, pending.actionId);
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe('CHAT_ERROR');
    expect(failed.body).not.toContain('INTERNAL_ONLY');
    expect(await app.leadRepository.findByConversationId(current.id)).toBeNull();
    expect(app.conversations.get(current.id)).toEqual(current);
    const retry = await confirm(app.server, current.id, pending.actionId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().results[0].result.data.outcome).toBe('created');
    expect(write).toHaveBeenCalledTimes(2); // Primeira tentativa falhou sem escrita.
    const saved = await app.leadRepository.findByConversationId(current.id);
    expect(saved?.id).toBe(app.conversations.get(current.id)?.context.leadId);
  });

  it('recupera o recibo de cadastro após falha no envio HTTP sem criar outro lead', async () => {
    const app = application();
    let failOnce = true;
    app.server.addHook('onSend', async (request, reply, payload) => {
      if (request.url === '/api/chat/confirm' && reply.statusCode === 200 && failOnce) {
        failOnce = false;
        throw new Error('Falha simulada após a conclusão.');
      }
      return payload;
    });
    const current = conversation(app);
    const prepared = await app.prepareLead(current.id, data());
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    const write = vi.spyOn(app.leadRepository, 'createForConversation');
    expect((await confirm(app.server, current.id, pending.actionId)).statusCode).toBe(500);
    const saved = await app.leadRepository.findByConversationId(current.id);
    expect(saved).not.toBeNull();
    const retry = await confirm(app.server, current.id, pending.actionId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().results[0].result).toEqual({ ok: true, data: { outcome: 'created', lead: saved } });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('recibo concluído sobrevive a correção posterior sem atualizar o lead', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Objetivo atualizado na conversa.')], {
      contextSteps: [{ goal: 'entrevistas', name: null, contact: null, courseReference: null }],
    }));
    const current = conversation(app);
    const prepared = await app.prepareLead(current.id, data());
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    const first = await confirm(app.server, current.id, pending.actionId);
    const saved = await app.leadRepository.findByConversationId(current.id);
    await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: current.id, message: 'Agora quero entrevistas.' } });
    expect(app.conversations.get(current.id)?.context).toMatchObject({ goal: 'entrevistas', leadId: saved?.id, revision: 8 });
    expect((await confirm(app.server, current.id, pending.actionId)).json()).toEqual(first.json());
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual(saved);
    const next = await app.prepareLead(current.id, { ...data(), goal: 'entrevistas' });
    expect(next.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(next.pendingAction?.preview).toEqual({ ...data(), goal: 'entrevistas' });
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual(saved);
  });

  it('mantém leads distintos com os mesmos dados e recusa confirmação de outra conversa', async () => {
    const app = application();
    const first = conversation(app);
    const other = conversation(app);
    const a = leadPendingActionSchema.parse((await app.prepareLead(first.id, data())).pendingAction);
    const b = leadPendingActionSchema.parse((await app.prepareLead(other.id, data())).pendingAction);
    expect((await confirm(app.server, other.id, a.actionId)).statusCode).toBe(404);
    expect(await app.leadRepository.findByConversationId(first.id)).toBeNull();
    expect(await app.leadRepository.findByConversationId(other.id)).toBeNull();
    const responses = await Promise.all([confirm(app.server, first.id, a.actionId), confirm(app.server, other.id, b.actionId)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const leadA = await app.leadRepository.findByConversationId(first.id);
    const leadB = await app.leadRepository.findByConversationId(other.id);
    expect(leadA).toEqual({ ...data(), id: expect.any(String) });
    expect(leadB).toEqual({ ...data(), id: expect.any(String) });
    expect(leadA?.id).not.toBe(leadB?.id);
    expect(app.conversations.get(first.id)?.context.leadId).toBe(leadA?.id);
    expect(app.conversations.get(other.id)?.context.leadId).toBe(leadB?.id);
  });

  it('confirma uma nova ação com dados idênticos como existing sem duplicação', async () => {
    const app = application();
    const current = conversation(app);
    const first = leadPendingActionSchema.parse((await app.prepareLead(current.id, data())).pendingAction);
    await confirm(app.server, current.id, first.actionId);
    const saved = await app.leadRepository.findByConversationId(current.id);
    const second = await app.prepareAction(current.id, { kind: 'create_lead', preview: data() });
    const create = vi.spyOn(app.leadRepository, 'createForConversation');
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    const response = await confirm(app.server, current.id, second.actionId);
    expect(response.json().results[0].result).toEqual({ ok: true, data: { outcome: 'existing', lead: saved } });
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual(saved);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('disponibiliza create_lead sem preparar ação durante uma saudação', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Olá!')]));
    const response = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Olá' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingAction).toBeNull();
    const names = app.model.boundTools.map((tool) => 'name' in tool ? tool.name : 'function' in tool ? tool.function?.name : undefined);
    expect(names.sort()).toEqual(['create_lead', 'get_available_slots', 'get_course_details', 'get_courses', 'get_school_info', 'schedule_trial_class', 'transfer_to_human']);
  });

  it('não prepara cadastro para conversa inexistente', async () => {
    const app = application();
    expect(await app.prepareLead('unknown', data())).toMatchObject({
      result: { ok: false, error: { code: 'NOT_FOUND' } }, pendingAction: null,
    });
  });
});
