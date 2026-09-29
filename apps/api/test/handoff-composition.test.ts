import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { transferToHumanResultSchema, trialClassPendingActionSchema } from '@supportflow/contracts/language-school';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryPendingActions } from '../src/core/pending-actions.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { schoolFixture, courseFixtures } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { slotFixtures, trialClassFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const leadData = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseId: 'course_english_travel', goal: 'viagem' };
const now = () => new Date('2030-06-10T12:00:00Z');

describe('handoff local, independente do cadastro e do chat', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede externa proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function application(model = new ScriptedChatModel([])) {
    const handoffRepository = new InMemoryHandoffRepository();
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures, trialClassFixtures);
    const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
    const app = createApplication({}, { model, handoffRepository, leadRepository, trialClassRepository, schoolRepository, now });
    servers.push(app.server);
    return { ...app, model, handoffRepository, leadRepository, trialClassRepository, schoolRepository };
  }

  it.each([
    { visitorIntent: 'request' as const, withLead: false },
    { visitorIntent: 'accepted_offer' as const, withLead: false },
    { visitorIntent: 'request' as const, withLead: true },
    { visitorIntent: 'accepted_offer' as const, withLead: true },
  ])('registra $visitorIntent com lead=$withLead sem efeitos comerciais ou LLM', async ({ visitorIntent, withLead }) => {
    const app = application();
    const conversation = app.conversations.create();
    if (withLead) {
      const lead = (await app.leadRepository.createForConversation(conversation.id, leadData))!;
      conversation.context = { ...conversation.context, ...leadData, leadId: lead.id, revision: 4 };
    }
    // A intenção é fornecida pelo backend. Não há interpretação de mensagens na 6.1.
    conversation.history = visitorIntent === 'request'
      ? [new HumanMessage('Não quero me cadastrar. Prefiro falar com alguém.')]
      : [new AIMessage('Posso registrar uma solicitação local de atendimento humano?'), new HumanMessage('Aceito o encaminhamento.')];
    app.conversations.save(conversation);
    const before = app.conversations.get(conversation.id);
    const savedLead = await app.leadRepository.findByConversationId(conversation.id);
    const bookings = await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)));
    const noEffects = [
      vi.spyOn(app.leadRepository, 'findByConversationId'), vi.spyOn(app.leadRepository, 'createForConversation'), vi.spyOn(app.leadRepository, 'updateForConversation'),
      vi.spyOn(app.trialClassRepository, 'listSlotsByCourseId'), vi.spyOn(app.trialClassRepository, 'reserveSlot'),
      vi.spyOn(app.schoolRepository, 'getSchool'), vi.spyOn(app.schoolRepository, 'listActiveCourses'), vi.spyOn(app.schoolRepository, 'findActiveCourseById'),
      vi.spyOn(app.conversations, 'save'), vi.spyOn(InMemoryPendingActions.prototype, 'stage'),
      vi.spyOn(InMemoryPendingActions.prototype, 'invalidateCurrent'), vi.spyOn(InMemoryPendingActions.prototype, 'confirm'),
    ];
    const reason = visitorIntent === 'request' ? 'Não quero me cadastrar. Prefiro falar com alguém.' : 'Visitante aceitou a oferta de atendimento humano.';
    const result = await app.requestHumanHandoff(conversation.id, { reason }, visitorIntent);
    expect(transferToHumanResultSchema.parse(result)).toEqual({ ok: true, data: {
      request: await app.handoffRepository.findOpenByConversationId(conversation.id),
    } });
    expect(result).toMatchObject({ data: { request: { reason, status: 'requested' } } });
    expect(await app.requestHumanHandoff(conversation.id, { reason: 'Outra dúvida' }, visitorIntent)).toEqual(result);
    expect(app.conversations.get(conversation.id)).toEqual(before);
    for (const spy of noEffects) expect(spy).not.toHaveBeenCalled();
    expect(await app.leadRepository.findByConversationId(conversation.id)).toEqual(savedLead);
    if (!withLead) expect(savedLead).toBeNull();
    expect(await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)))).toEqual(bookings);
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
  });

  it('não invalida a prévia existente; o chat continua com somente as seis tools anteriores', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Pode revisar a prévia atual.')]));
    const conversation = app.conversations.create();
    const lead = (await app.leadRepository.createForConversation(conversation.id, leadData))!;
    conversation.context = { ...conversation.context, ...leadData, leadId: lead.id, slotId: 'slot_english_a', revision: 3 };
    app.conversations.save(conversation);
    const pending = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: lead.id, slotId: 'slot_english_a' })).pendingAction);
    const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
    const invalidate = vi.spyOn(InMemoryPendingActions.prototype, 'invalidateCurrent');
    const result = await app.requestHumanHandoff(conversation.id, { reason: 'Prefiro falar com alguém.' }, 'request');
    expect(result.ok).toBe(true);
    expect(stage).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    expect(app.conversations.get(conversation.id)).toEqual(conversation);
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    const response = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: conversation.id, message: 'Pode continuar?' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ results: [], pendingAction: pending });
    expect(app.conversations.get(conversation.id)?.context).toEqual(conversation.context);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    expect(app.model.boundTools.map((tool) => 'name' in tool ? tool.name : undefined)).toEqual([
      'get_school_info', 'get_courses', 'get_course_details', 'get_available_slots', 'create_lead', 'schedule_trial_class',
    ]);
  });

  it('conversas isoladas e concorrência conservam protocolo e motivo por conversa', async () => {
    const app = application();
    const a = app.conversations.create(); const b = app.conversations.create();
    app.conversations.save(a); app.conversations.save(b);
    const results = await Promise.all([
      app.requestHumanHandoff(a.id, { reason: 'Quero falar com um atendente' }, 'request'),
      app.requestHumanHandoff(a.id, { reason: 'Outra dúvida' }, 'request'),
      app.requestHumanHandoff(b.id, { reason: 'Quero falar com um atendente' }, 'request'),
    ]);
    expect(results[0]).toEqual(results[1]);
    const first = (await app.handoffRepository.findOpenByConversationId(a.id))!;
    const second = (await app.handoffRepository.findOpenByConversationId(b.id))!;
    expect(first.id).not.toBe(second.id);
    const forged = await app.requestHumanHandoff(a.id, { reason: 'Outra solicitação', conversationId: b.id }, 'request');
    expect(forged).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await app.handoffRepository.findOpenByConversationId(a.id)).toEqual(first);
    expect(await app.handoffRepository.findOpenByConversationId(b.id)).toEqual(second);
  });

  it('escopo inexistente ou intenção ausente não gera solicitação', async () => {
    const app = application();
    expect(await app.requestHumanHandoff('missing', { reason: 'Quero uma pessoa.' }, 'request'))
      .toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(await app.handoffRepository.findOpenByConversationId('missing')).toBeNull();
    expect(app.conversations.get('missing')).toBeUndefined();
    const conversation = app.conversations.create(); app.conversations.save(conversation);
    expect(await app.requestHumanHandoff(conversation.id, { reason: 'Oferta ainda não aceita.' }, null))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await app.handoffRepository.findOpenByConversationId(conversation.id)).toBeNull();
  });

  it('composição padrão funciona sem credenciais e recupera a solicitação sem LLM', async () => {
    const app = createApplication({}); servers.push(app.server);
    const conversation = app.conversations.create(); app.conversations.save(conversation);
    const first = await app.requestHumanHandoff(conversation.id, { reason: 'Quero atendimento humano.' }, 'request');
    expect(first).toMatchObject({ ok: true, data: { request: { id: expect.any(String), status: 'requested' } } });
    expect(await app.requestHumanHandoff(conversation.id, { reason: 'Outro motivo' }, 'accepted_offer')).toEqual(first);
    expect((await app.server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
