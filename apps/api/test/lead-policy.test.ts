import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AIMessage } from '@langchain/core/messages';
import { createLeadResultSchema, languageSchoolChatResponseSchema, leadPendingActionSchema, leadSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput } from '@supportflow/contracts/language-school';
import { createApplication } from '../src/app.js';
import { conversationContextSchema } from '../src/modules/language-school/domain/conversation-context.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const data = (): CreateLeadInput => ({
  name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
  courseId: 'course_english_travel', goal: 'viagem',
});
const unchanged = { goal: null, name: null, contact: null, courseReference: null };
const email = (value: string) => ({ type: 'email' as const, value });
const phone = (value: string) => ({ type: 'phone' as const, value });

describe('política determinística created/existing/updated', () => {
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

  function application(patches: unknown[] = []) {
    const model = new ScriptedChatModel(patches.map(() => new AIMessage('Informação atualizada na conversa.')), { contextSteps: patches });
    const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
    const leadRepository = new InMemoryLeadRepository();
    const app = createApplication({}, { model, schoolRepository, leadRepository });
    servers.push(app.server);
    return { ...app, model, schoolRepository, leadRepository };
  }

  function confirm(app: ReturnType<typeof application>, conversationId: string, actionId: string, extra = {}) {
    return app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId, actionId, ...extra } });
  }

  async function registered(app: ReturnType<typeof application>, input = data()) {
    const conversation = app.conversations.create();
    conversation.context = { ...conversation.context, ...structuredClone(input), revision: 7 };
    app.conversations.save(conversation);
    const prepared = await app.prepareLead(conversation.id, input);
    expect(prepared.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(await app.leadRepository.findByConversationId(conversation.id)).toBeNull();
    const action = leadPendingActionSchema.parse(prepared.pendingAction);
    const response = await confirm(app, conversation.id, action.actionId);
    expect(response.statusCode).toBe(200);
    const receipt = languageSchoolChatResponseSchema.parse(response.json());
    const lead = leadSchema.parse(await app.leadRepository.findByConversationId(conversation.id));
    expect(receipt.results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead } } }]);
    return { conversationId: conversation.id, actionId: action.actionId, lead, receipt };
  }

  async function correct(app: ReturnType<typeof application>, conversationId: string, message: string) {
    const response = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId, message } });
    expect(response.statusCode).toBe(200);
    return languageSchoolChatResponseSchema.parse(response.json());
  }

  it('lead idêntico retorna existing do repository sem escrita, nova ação ou revisão', async () => {
    const app = application();
    const initial = await registered(app);
    const create = vi.spyOn(app.leadRepository, 'createForConversation');
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    const saveContext = vi.spyOn(app.conversations, 'save');
    const input = data();
    const output = await app.prepareLead(initial.conversationId, input);
    expect(createLeadResultSchema.parse(output.result)).toEqual({ ok: true, data: { outcome: 'existing', lead: initial.lead } });
    expect(output.pendingAction).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(saveContext).not.toHaveBeenCalled();
    expect(app.conversations.get(initial.conversationId)?.context.revision).toBe(7);
    input.contact.value = 'mutacao@example.com';
    expect(output.result).toMatchObject({ data: { lead: initial.lead } });
    expect(app.model.calls).toHaveLength(0);
    expect(app.model.contextCalls).toHaveLength(0);
  });

  it('existing invalida uma prévia redundante sem consumir recibos concluídos', async () => {
    const app = application();
    const initial = await registered(app);
    const redundant = await app.prepareAction(initial.conversationId, { kind: 'create_lead', preview: data() });
    const existing = await app.prepareLead(initial.conversationId, data());
    expect(existing.pendingAction).toBeNull();
    expect(existing.result).toMatchObject({ ok: true, data: { outcome: 'existing', lead: initial.lead } });
    const stale = await confirm(app, initial.conversationId, redundant.actionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ACTION_STALE');
    expect((await confirm(app, initial.conversationId, initial.actionId)).json()).toEqual(initial.receipt);
  });

  it.each([
    { label: 'nome', message: 'Meu nome é Ana Silva.', patch: { ...unchanged, name: 'Ana Silva' }, initial: data(), next: { ...data(), name: 'Ana Silva' } },
    { label: 'email', message: 'Meu novo email é ana.novo@example.com.', patch: { ...unchanged, contact: email('ana.novo@example.com') }, initial: data(), next: { ...data(), contact: email('ana.novo@example.com') } },
    { label: 'tipo para telefone', message: 'Use +55 (11) 99999-1234.', patch: { ...unchanged, contact: phone('+55 (11) 99999-1234') }, initial: data(), next: { ...data(), contact: phone('+55 (11) 99999-1234') } },
    { label: 'valor do telefone', message: 'Use +55 (11) 99999-5678.', patch: { ...unchanged, contact: phone('+55 (11) 99999-5678') }, initial: { ...data(), contact: phone('+55 (11) 99999-1234') }, next: { ...data(), contact: phone('+55 (11) 99999-5678') } },
    { label: 'curso', message: 'Agora quero espanhol.', patch: { ...unchanged, courseReference: 'espanhol' }, initial: data(), next: { ...data(), courseId: 'course_spanish_conversation' } },
    { label: 'objetivo', message: 'Agora quero entrevistas de emprego.', patch: { ...unchanged, goal: 'entrevistas de emprego' }, initial: data(), next: { ...data(), goal: 'entrevistas de emprego' } },
  ])('correção de $label só atualiza o mesmo lead após nova confirmação', async ({ message, patch, initial, next }) => {
    const app = application([patch]);
    const registeredLead = await registered(app, initial);
    const { conversationId, lead } = registeredLead;
    const create = vi.spyOn(app.leadRepository, 'createForConversation');
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    await correct(app, conversationId, message);
    expect(app.conversations.get(conversationId)?.context).toMatchObject({ ...next, leadId: lead.id, revision: 8 });
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual(lead);
    const prepared = await app.prepareLead(conversationId, next);
    expect(prepared.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    expect(pending.preview).toEqual(next);
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual(lead);
    expect(update).not.toHaveBeenCalled();
    const response = await confirm(app, conversationId, pending.actionId);
    expect(response.statusCode).toBe(200);
    const expected = { ...next, id: lead.id };
    expect(response.json().results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'updated', lead: expected } } }]);
    expect(response.json().pendingAction).toBeNull();
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual(expected);
    expect(update).toHaveBeenCalledExactlyOnceWith(conversationId, next);
    expect(create).not.toHaveBeenCalled();
    expect(app.conversations.get(conversationId)?.context).toMatchObject({ leadId: lead.id, revision: 8, slotId: null });
    expect(await app.prepareLead(conversationId, next)).toEqual({
      result: { ok: true, data: { outcome: 'existing', lead: expected } }, pendingAction: null,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('permite goal null quando esse é o contexto vigente validado, sem mudar a interpretação de patches', async () => {
    const app = application();
    const initial = await registered(app);
    await app.conversations.runExclusive(initial.conversationId, () => {
      const conversation = app.conversations.get(initial.conversationId)!;
      // O patch da LLM continua usando null como "preservar". Este teste exercita
      // a política de cadastro com um estado null permitido pelo schema interno.
      app.conversations.save({ ...conversation, context: conversationContextSchema.parse({ ...conversation.context, goal: null, revision: 8 }) });
    });
    const prepared = await app.prepareLead(initial.conversationId, { ...data(), goal: null });
    const pending = leadPendingActionSchema.parse(prepared.pendingAction);
    expect(await app.leadRepository.findByConversationId(initial.conversationId)).toEqual(initial.lead);
    const response = await confirm(app, initial.conversationId, pending.actionId);
    expect(response.json().results[0].result).toEqual({ ok: true, data: { outcome: 'updated', lead: { ...initial.lead, goal: null } } });
  });

  it('nova correção deixa a ação antiga stale e nunca grava o email intermediário', async () => {
    const app = application([
      { ...unchanged, contact: email('novo@example.com') },
      { ...unchanged, contact: email('final@example.com') },
    ]);
    const { conversationId, lead } = await registered(app);
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    await correct(app, conversationId, 'Meu email é novo@example.com.');
    const old = leadPendingActionSchema.parse((await app.prepareLead(conversationId, { ...data(), contact: email('novo@example.com') })).pendingAction);
    await correct(app, conversationId, 'Na verdade, use final@example.com.');
    const stale = await confirm(app, conversationId, old.actionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ACTION_STALE');
    expect(update).not.toHaveBeenCalled();
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual(lead);
    const nextInput = { ...data(), contact: email('final@example.com') };
    const next = leadPendingActionSchema.parse((await app.prepareLead(conversationId, nextInput)).pendingAction);
    expect(next.preview).toEqual(nextInput);
    expect((await confirm(app, conversationId, next.actionId)).json().results[0].result.data.outcome).toBe('updated');
    expect(update).toHaveBeenCalledExactlyOnceWith(conversationId, nextInput);
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual({ ...lead, contact: nextInput.contact });
  });

  it('uma segunda prévia na mesma revisão invalida somente a primeira ação pendente', async () => {
    const app = application([{ ...unchanged, name: 'Ana Silva' }]);
    const initial = await registered(app);
    await correct(app, initial.conversationId, 'Meu nome é Ana Silva.');
    const next = { ...data(), name: 'Ana Silva' };
    const a = leadPendingActionSchema.parse((await app.prepareLead(initial.conversationId, next)).pendingAction);
    const b = leadPendingActionSchema.parse((await app.prepareLead(initial.conversationId, next)).pendingAction);
    expect(a.actionId).not.toBe(b.actionId);
    expect((await confirm(app, initial.conversationId, a.actionId)).statusCode).toBe(409);
    expect(await app.leadRepository.findByConversationId(initial.conversationId)).toEqual(initial.lead);
    expect((await confirm(app, initial.conversationId, b.actionId)).json().results[0].result.data.outcome).toBe('updated');
  });

  it('múltiplos updates mantêm ID e retries retornam recibos históricos de created e updated', async () => {
    const app = application([
      { ...unchanged, contact: email('novo@example.com') },
      { ...unchanged, contact: email('final@example.com') },
    ]);
    const initial = await registered(app);
    const { conversationId, lead } = initial;
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    const receipts = [];
    for (const value of ['novo@example.com', 'final@example.com']) {
      await correct(app, conversationId, `Meu email é ${value}.`);
      const action = leadPendingActionSchema.parse((await app.prepareLead(conversationId, { ...data(), contact: email(value) })).pendingAction);
      const response = await confirm(app, conversationId, action.actionId);
      const body = languageSchoolChatResponseSchema.parse(response.json());
      expect(body.results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'updated', lead: { ...lead, contact: email(value) } } } }]);
      receipts.push({ actionId: action.actionId, body });
    }
    for (const receipt of receipts) {
      expect((await confirm(app, conversationId, receipt.actionId)).json()).toEqual(receipt.body);
    }
    expect((await confirm(app, conversationId, initial.actionId)).json()).toEqual(initial.receipt);
    expect(update).toHaveBeenCalledTimes(2);
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual({ ...lead, contact: email('final@example.com') });
  });

  it('duas confirmações simultâneas da mesma atualização executam uma única escrita', async () => {
    const app = application([{ ...unchanged, name: 'Ana Silva' }]);
    const initial = await registered(app);
    await correct(app, initial.conversationId, 'Meu nome é Ana Silva.');
    const action = leadPendingActionSchema.parse((await app.prepareLead(initial.conversationId, { ...data(), name: 'Ana Silva' })).pendingAction);
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    const responses = await Promise.all([
      confirm(app, initial.conversationId, action.actionId), confirm(app, initial.conversationId, action.actionId),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]?.json()).toEqual(responses[1]?.json());
    expect(responses[0]?.json().results[0].result.data.outcome).toBe('updated');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('falha técnica no update mantém registro antigo e permite repetir a ação', async () => {
    const app = application([{ ...unchanged, goal: 'entrevistas' }]);
    const initial = await registered(app);
    await correct(app, initial.conversationId, 'Agora quero entrevistas.');
    const action = leadPendingActionSchema.parse((await app.prepareLead(initial.conversationId, { ...data(), goal: 'entrevistas' })).pendingAction);
    const context = app.conversations.get(initial.conversationId);
    const update = vi.spyOn(app.leadRepository, 'updateForConversation').mockRejectedValueOnce(new Error('INTERNAL_ONLY: falha antes de escrever'));
    const failed = await confirm(app, initial.conversationId, action.actionId);
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error.code).toBe('CHAT_ERROR');
    expect(failed.body).not.toContain('INTERNAL_ONLY');
    expect(await app.leadRepository.findByConversationId(initial.conversationId)).toEqual(initial.lead);
    expect(app.conversations.get(initial.conversationId)).toEqual(context);
    const retry = await confirm(app, initial.conversationId, action.actionId);
    expect(retry.json().results[0].result).toEqual({ ok: true, data: { outcome: 'updated', lead: { ...initial.lead, goal: 'entrevistas' } } });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('falha de transporte depois do update preserva o recibo updated, sem reinterpretá-lo como existing', async () => {
    const app = application([{ ...unchanged, goal: 'entrevistas' }]);
    let failNext = false;
    app.server.addHook('onSend', async (request, reply, payload) => {
      if (failNext && request.url === '/api/chat/confirm' && reply.statusCode === 200) {
        failNext = false;
        throw new Error('Falha simulada após update.');
      }
      return payload;
    });
    const initial = await registered(app);
    await correct(app, initial.conversationId, 'Agora quero entrevistas.');
    const action = leadPendingActionSchema.parse((await app.prepareLead(initial.conversationId, { ...data(), goal: 'entrevistas' })).pendingAction);
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    failNext = true;
    expect((await confirm(app, initial.conversationId, action.actionId)).statusCode).toBe(500);
    const saved = await app.leadRepository.findByConversationId(initial.conversationId);
    expect(saved).toEqual({ ...initial.lead, goal: 'entrevistas' });
    const retry = await confirm(app, initial.conversationId, action.actionId);
    expect(retry.json().results[0].result).toEqual({ ok: true, data: { outcome: 'updated', lead: saved } });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('curso que fica indisponível antes da confirmação impede update e existing', async () => {
    const app = application([{ ...unchanged, name: 'Ana Silva' }]);
    const initial = await registered(app);
    await correct(app, initial.conversationId, 'Meu nome é Ana Silva.');
    const next = { ...data(), name: 'Ana Silva' };
    const action = leadPendingActionSchema.parse((await app.prepareLead(initial.conversationId, next)).pendingAction);
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    vi.spyOn(app.schoolRepository, 'findActiveCourseById').mockResolvedValue(null);
    expect((await confirm(app, initial.conversationId, action.actionId)).json().results[0].result)
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(update).not.toHaveBeenCalled();
    expect(await app.leadRepository.findByConversationId(initial.conversationId)).toEqual(initial.lead);
    // Outra conversa ainda idêntica ao lead salvo também precisa validar curso ativo.
    const other = app.conversations.create();
    const saved = leadSchema.parse(await app.leadRepository.createForConversation(other.id, data()));
    app.conversations.save({ ...other, context: { ...other.context, ...data(), leadId: saved.id } });
    expect((await app.prepareLead(other.id, data())).result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('update isolado preserva outro lead mesmo quando ambos usam o mesmo contato', async () => {
    const app = application([{ ...unchanged, goal: 'entrevistas' }]);
    const a = await registered(app);
    const b = await registered(app);
    expect(a.lead.id).not.toBe(b.lead.id);
    expect(a.lead.contact).toEqual(b.lead.contact);
    await correct(app, a.conversationId, 'Agora quero entrevistas.');
    const action = leadPendingActionSchema.parse((await app.prepareLead(a.conversationId, { ...data(), goal: 'entrevistas' })).pendingAction);
    expect((await confirm(app, b.conversationId, action.actionId)).statusCode).toBe(404);
    await confirm(app, a.conversationId, action.actionId);
    expect(await app.leadRepository.findByConversationId(a.conversationId)).toEqual({ ...a.lead, goal: 'entrevistas' });
    expect(await app.leadRepository.findByConversationId(b.conversationId)).toEqual(b.lead);
    expect(app.conversations.get(b.conversationId)?.context.leadId).toBe(b.lead.id);
  });

  it.each(['missing_link', 'wrong_link', 'missing_record'])('recusa inconsistência interna %s sem recuperar silenciosamente', async (kind) => {
    const app = application();
    const initial = kind === 'missing_record' ? null : await registered(app);
    const conversation = initial ? app.conversations.get(initial.conversationId)! : app.conversations.create();
    conversation.context = { ...conversation.context, ...data(), leadId: kind === 'missing_link' ? null : 'lead_incorreto' };
    app.conversations.save(conversation);
    const before = await app.leadRepository.findByConversationId(conversation.id);
    const create = vi.spyOn(app.leadRepository, 'createForConversation');
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    expect((await app.prepareLead(conversation.id, data())).result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    const action = await app.prepareAction(conversation.id, { kind: 'create_lead', preview: data() });
    const response = await confirm(app, conversation.id, action.actionId);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('CHAT_ERROR');
    expect(response.body).not.toContain('lead_incorreto');
    expect(response.body).not.toContain('Vínculo interno');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await app.leadRepository.findByConversationId(conversation.id)).toEqual(before);
    expect(app.conversations.get(conversation.id)).toEqual(conversation);
  });

  it('não aceita outcome externo, argumentos reenviados nem mutações na prévia do update', async () => {
    const app = application([{ ...unchanged, contact: email('novo@example.com') }]);
    const initial = await registered(app);
    await correct(app, initial.conversationId, 'Meu email é novo@example.com.');
    const next = { ...data(), contact: email('novo@example.com') };
    expect((await app.prepareLead(initial.conversationId, { ...next, outcome: 'updated' })).result)
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const prepared = await app.prepareLead(initial.conversationId, next);
    if (!prepared.pendingAction) throw new Error('Prévia esperada.');
    const actionId = prepared.pendingAction.actionId;
    next.contact.value = 'alterado@example.com';
    if ('contact' in prepared.pendingAction.preview) prepared.pendingAction.preview.contact.value = 'preview@example.com';
    for (const extras of [{ outcome: 'created' }, { args: next }, { slotId: 'slot_inventado', confirmed: true }]) {
      expect((await confirm(app, initial.conversationId, actionId, extras)).statusCode).toBe(400);
    }
    expect(await app.leadRepository.findByConversationId(initial.conversationId)).toEqual(initial.lead);
    const response = await confirm(app, initial.conversationId, actionId);
    expect(response.json().results).toEqual([{ tool: 'create_lead', result: { ok: true, data: {
      outcome: 'updated', lead: { ...initial.lead, contact: email('novo@example.com') },
    } } }]);
    expect(app.conversations.get(initial.conversationId)?.context.slotId).toBeNull();
    expect((await confirm(app, initial.conversationId, 'outra_acao')).statusCode).toBe(404);
  });
});
