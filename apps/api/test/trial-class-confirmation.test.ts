import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languageSchoolChatResponseSchema, leadPendingActionSchema, scheduleTrialClassResultSchema, trialClassPendingActionSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput } from '@supportflow/contracts/language-school';
import { createApplication } from '../src/app.js';
import { conversationContextSchema } from '../src/modules/language-school/domain/conversation-context.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const slotId = 'slot_english_a';
const fixedInstant = '2030-06-10T12:00:00Z';
const data = (name = 'Ana'): CreateLeadInput => ({
  name, contact: { type: 'email', value: `${name.toLowerCase()}@example.com` }, courseId: 'course_english_travel', goal: 'viagem',
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('confirmação determinística de aula e recibos históricos', () => {
  const servers: FastifyInstance[] = [];
  const models: ScriptedChatModel[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    for (const model of models.splice(0)) {
      expect(model.calls).toHaveLength(0); expect(model.contextCalls).toHaveLength(0);
    }
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  function application() {
    const model = new ScriptedChatModel([]);
    const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
    const time = { value: fixedInstant };
    const now = () => new Date(time.value);
    const app = createApplication({}, { model, schoolRepository, leadRepository, trialClassRepository, now });
    servers.push(app.server); models.push(model);
    return { ...app, model, schoolRepository, leadRepository, trialClassRepository, now, time };
  }

  async function registered(app: ReturnType<typeof application>, name = 'Ana') {
    const conversation = app.conversations.create();
    const input = data(name);
    const lead = (await app.leadRepository.createForConversation(conversation.id, input))!;
    conversation.context = { ...conversation.context, ...input, leadId: lead.id, slotId, revision: 8 };
    app.conversations.save(conversation);
    return { conversation, lead };
  }

  async function proposal(app: ReturnType<typeof application>, conversationId: string) {
    const context = app.conversations.get(conversationId)!.context;
    const prepared = await app.prepareTrialClass(conversationId, { leadId: context.leadId, slotId: context.slotId });
    expect(prepared.result).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    return trialClassPendingActionSchema.parse(prepared.pendingAction);
  }

  function confirm(app: ReturnType<typeof application>, conversationId: string, actionId: string, extra = {}) {
    return app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId, actionId, ...extra } });
  }

  async function noVacancy(app: ReturnType<typeof application>) {
    const available = await app.getAvailableSlots({ courseId: data().courseId });
    if (!available.ok) throw new Error('Consulta válida esperada.');
    expect(available.data.slots.map((slot) => slot.slotId)).not.toContain(slotId);
  }

  it('created grava dados do slot oficial; retry conserva created e nova chamada retorna existing', async () => {
    const app = application();
    const { conversation, lead } = await registered(app);
    const action = await proposal(app, conversation.id);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const response = await confirm(app, conversation.id, action.actionId);
    expect(response.statusCode).toBe(200);
    const receipt = languageSchoolChatResponseSchema.parse(response.json());
    const booking = await app.trialClassRepository.findConfirmedBySlotId(slotId);
    expect(booking).toEqual({ ...slotFixtures.find((s) => s.slotId === slotId), leadId: lead.id, id: expect.any(String), status: 'confirmed' });
    expect(receipt.results).toEqual([{ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created', booking } } }]);
    expect(receipt.pendingAction).toBeNull();
    expect(receipt.reply).toContain('agenda de demonstração');
    expect(app.conversations.get(conversation.id)).toEqual(conversation);
    expect((await confirm(app, conversation.id, action.actionId)).json()).toEqual(receipt);
    expect(reserve).toHaveBeenCalledTimes(1);
    const repeated = await app.prepareTrialClass(conversation.id, { leadId: lead.id, slotId });
    expect(repeated).toEqual({ result: { ok: true, data: { outcome: 'existing', booking } }, pendingAction: null });
    expect(reserve).toHaveBeenCalledTimes(1);
    await noVacancy(app);
  });

  it('executor retorna existing se o mesmo lead já ocupou a vaga após a proposta', async () => {
    const app = application();
    const { conversation, lead } = await registered(app);
    const action = await proposal(app, conversation.id);
    const created = await app.trialClassRepository.reserveSlot({ leadId: lead.id, slotId }, app.now());
    if (!('booking' in created)) throw new Error('Reserva esperada.');
    const response = await confirm(app, conversation.id, action.actionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([{ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'existing', booking: created.booking } } }]);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toEqual(created.booking);
    await noVacancy(app);
  });

  it('duas conversas alcançam a reserva juntas: uma created, outra SLOT_UNAVAILABLE; retries não reexecutam', async () => {
    const app = application();
    const a = await registered(app, 'Ana');
    const b = await registered(app, 'Bruno');
    const actions = await Promise.all([proposal(app, a.conversation.id), proposal(app, b.conversation.id)]);
    const bothArrived = deferred();
    const release = deferred();
    const atomicReserve = app.trialClassRepository.reserveSlot.bind(app.trialClassRepository);
    let arrivals = 0;
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot').mockImplementation(async (...args) => {
      if (++arrivals === 2) bothArrived.resolve();
      await release.promise;
      return atomicReserve(...args); // a operação real continua sem await entre check/write
    });
    const contenders = [a, b];
    const confirmations = contenders.map((entry, index) => confirm(app, entry.conversation.id, actions[index]!.actionId));
    await bothArrived.promise; // Prova que filas por conversa não bloqueiam uma à outra.
    expect(arrivals).toBe(2);
    release.resolve();
    const responses = await Promise.all(confirmations);
    const receipts = responses.map((response) => {
      expect(response.statusCode).toBe(200);
      return languageSchoolChatResponseSchema.parse(response.json());
    });
    const results = receipts.map((receipt) => scheduleTrialClassResultSchema.parse(receipt.results[0]!.result));
    expect(results.map((result) => result.ok ? result.data.outcome : result.error.code).sort()).toEqual(['SLOT_UNAVAILABLE', 'created']);
    const winner = results.findIndex((result) => result.ok);
    const loser = 1 - winner;
    const booking = await app.trialClassRepository.findConfirmedBySlotId(slotId);
    expect(booking?.leadId).toBe(contenders[winner]!.lead.id);
    const bookings = await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)));
    expect(bookings.filter(Boolean)).toEqual([booking]);
    for (const [index, entry] of contenders.entries()) {
      expect(receipts[index]!.pendingAction).toBeNull();
      expect((await confirm(app, entry.conversation.id, actions[index]!.actionId)).json()).toEqual(receipts[index]);
    }
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(await app.prepareTrialClass(contenders[winner]!.conversation.id, { leadId: contenders[winner]!.lead.id, slotId }))
      .toEqual({ result: { ok: true, data: { outcome: 'existing', booking } }, pendingAction: null });
    expect(await app.prepareTrialClass(contenders[loser]!.conversation.id, { leadId: contenders[loser]!.lead.id, slotId }))
      .toMatchObject({ result: { ok: false, error: { code: 'SLOT_UNAVAILABLE' } }, pendingAction: null });
    expect(reserve).toHaveBeenCalledTimes(2);
    await noVacancy(app);
  });

  it('falha técnica anterior ao commit não conclui action; retry tenta gravar e depois usa recibo', async () => {
    const app = application();
    const { conversation } = await registered(app);
    const action = await proposal(app, conversation.id);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot').mockRejectedValueOnce(new Error('INTERNAL_ONLY: write failed'));
    const failed = await confirm(app, conversation.id, action.actionId);
    expect(failed.statusCode).toBe(500); expect(failed.json().error.code).toBe('CHAT_ERROR');
    expect(failed.body).not.toContain('INTERNAL_ONLY');
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
    const retried = await confirm(app, conversation.id, action.actionId);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().results[0].result.data.outcome).toBe('created');
    expect((await confirm(app, conversation.id, action.actionId)).json()).toEqual(retried.json());
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  it('falha de transporte após recibo salvo não repete a escrita', async () => {
    const app = application();
    let failOnce = true;
    app.server.addHook('onSend', async (request, reply, payload) => {
      if (request.url === '/api/chat/confirm' && reply.statusCode === 200 && failOnce) {
        failOnce = false;
        throw new Error('Falha de envio depois do recibo.');
      }
      return payload;
    });
    const { conversation } = await registered(app);
    const action = await proposal(app, conversation.id);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    expect((await confirm(app, conversation.id, action.actionId)).statusCode).toBe(500);
    const saved = await app.trialClassRepository.findConfirmedBySlotId(slotId);
    expect(saved).not.toBeNull();
    const retry = await confirm(app, conversation.id, action.actionId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().results[0].result).toEqual({ ok: true, data: { outcome: 'created', booking: saved } });
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['lead-missing', 'NOT_FOUND'], ['context-lead-missing', 'NOT_FOUND'], ['input-lead-different', 'NOT_FOUND'],
    ['foreign-lead', 'NOT_FOUND'], ['name', 'INVALID_INPUT'], ['contact', 'INVALID_INPUT'],
    ['goal', 'INVALID_INPUT'], ['course', 'INVALID_INPUT'], ['inactive-course', 'NOT_FOUND'],
    ['missing-course', 'NOT_FOUND'], ['slot-missing', 'NOT_FOUND'], ['slot-course', 'INVALID_INPUT'],
    ['slot-selection', 'INVALID_INPUT'], ['timezone', 'INVALID_INPUT'], ['past', 'SLOT_UNAVAILABLE'], ['exact-now', 'SLOT_UNAVAILABLE'],
  ])('revalida %s na confirmação, recusando sem escrita com %s', async (scenario, code) => {
    const app = application();
    const { conversation, lead } = await registered(app);
    const action = await proposal(app, conversation.id);
    const before = app.conversations.get(conversation.id)!;
    if (scenario === 'lead-missing') vi.spyOn(app.leadRepository, 'findByConversationId').mockResolvedValue(null);
    if (scenario === 'context-lead-missing') before.context.leadId = null;
    if (scenario === 'input-lead-different') before.context.leadId = 'lead_other';
    if (scenario === 'foreign-lead') {
      const other = await registered(app, 'Bruno');
      const forged = await app.prepareAction(conversation.id, { kind: action.kind, preview: { ...action.preview, lead: other.lead } });
      action.actionId = forged.actionId;
    }
    if (scenario === 'name') before.context.name = 'Maria';
    if (scenario === 'contact') before.context.contact = { type: 'phone', value: '+5511999999999' };
    if (scenario === 'goal') before.context.goal = 'entrevistas';
    if (scenario === 'course') before.context.courseId = 'course_french_intro';
    if (scenario === 'slot-selection') before.context.slotId = 'slot_english_b';
    if (scenario === 'inactive-course' || scenario === 'missing-course') {
      const courses = courseFixtures.map((course) => ({ ...course, active: course.id === lead.courseId ? false : course.active }));
      const changed = new InMemorySchoolRepository(schoolFixture, scenario === 'inactive-course' ? courses : []);
      vi.spyOn(app.schoolRepository, 'findActiveCourseById').mockImplementation((id) => changed.findActiveCourseById(id));
    }
    if (scenario === 'slot-missing') vi.spyOn(app.trialClassRepository, 'findSlotById').mockResolvedValue(null);
    if (scenario === 'slot-course') vi.spyOn(app.trialClassRepository, 'findSlotById').mockResolvedValue({ ...action.preview.slot, courseId: 'course_french_intro' });
    if (scenario === 'timezone') vi.spyOn(app.trialClassRepository, 'findSlotById').mockResolvedValue({ ...action.preview.slot, timezone: 'UTC' });
    if (scenario === 'past') app.time.value = '2030-06-11T13:00:01Z';
    if (scenario === 'exact-now') app.time.value = '2030-06-11T13:00:00Z';
    // Sem mudar revision neste teste: demonstra defesa de negócio além do lifecycle.
    app.conversations.save(before);
    const response = await confirm(app, conversation.id, action.actionId);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    expect(body.results).toMatchObject([{ tool: 'schedule_trial_class', result: { ok: false, error: { code } } }]);
    expect(body.pendingAction).toBeNull();
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
  });

  it('valida snapshot de retorno e sanitiza resultado interno inválido sem marcar sucesso', async () => {
    const app = application();
    const { conversation } = await registered(app);
    const action = await proposal(app, conversation.id);
    vi.spyOn(app.trialClassRepository, 'reserveSlot').mockResolvedValueOnce({ outcome: 'created', booking: {} as never });
    const response = await confirm(app, conversation.id, action.actionId);
    expect(response.statusCode).toBe(500); expect(response.json().error.code).toBe('CHAT_ERROR');
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
    expect((await confirm(app, conversation.id, action.actionId)).json().results[0].result.data.outcome).toBe('created');
  });

  it('arguments armazenados resistem à mutação e o browser só pode enviar IDs', async () => {
    const app = application();
    const { conversation, lead } = await registered(app);
    const input = { leadId: lead.id, slotId };
    const prepared = await app.prepareTrialClass(conversation.id, input);
    const action = trialClassPendingActionSchema.parse(prepared.pendingAction);
    input.leadId = 'lead_forged'; input.slotId = 'slot_english_b';
    action.preview.slot.slotId = 'slot_english_b';
    expect((await confirm(app, conversation.id, action.actionId, { args: input, confirmed: true })).statusCode).toBe(400);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
    const result = await confirm(app, conversation.id, action.actionId);
    expect(result.statusCode).toBe(200);
    expect(result.json().results[0].result.data.booking).toMatchObject({ leadId: lead.id, slotId });
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_b')).toBeNull();
  });

  it('dispatcher mantém create_lead; atualização posterior do lead/contexto não modifica reserva nem recibo', async () => {
    const app = application();
    const conversation = app.conversations.create();
    conversation.context = { ...conversation.context, ...data(), slotId, revision: 1 };
    app.conversations.save(conversation);
    const leadAction = leadPendingActionSchema.parse((await app.prepareLead(conversation.id, data())).pendingAction);
    const registration = await confirm(app, conversation.id, leadAction.actionId);
    expect(registration.statusCode).toBe(200);
    expect(registration.json().results).toMatchObject([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } } }]);
    const lead = (await app.leadRepository.findByConversationId(conversation.id))!;
    expect(app.conversations.get(conversation.id)?.context.leadId).toBe(lead.id);
    const action = await proposal(app, conversation.id);
    const confirmed = await confirm(app, conversation.id, action.actionId);
    const originalReceipt = confirmed.json();
    const saved = await app.trialClassRepository.findConfirmedBySlotId(slotId);
    const updatedInput: CreateLeadInput = {
      name: 'Ana Silva', contact: { type: 'email', value: 'ana.novo@example.com' }, courseId: 'course_french_intro', goal: 'entrevistas',
    };
    await app.conversations.runExclusive(conversation.id, () => {
      const current = app.conversations.get(conversation.id)!;
      app.conversations.save({ ...current, context: conversationContextSchema.parse({ ...current.context, ...updatedInput, slotId: null, revision: 2 }) });
    });
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toEqual(saved);
    const updateAction = leadPendingActionSchema.parse((await app.prepareLead(conversation.id, updatedInput)).pendingAction);
    const update = await confirm(app, conversation.id, updateAction.actionId);
    expect(update.json().results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'updated', lead: { ...updatedInput, id: lead.id } } } });
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotId)).toEqual(saved);
    expect((await confirm(app, conversation.id, action.actionId)).json()).toEqual(originalReceipt);
    expect((await confirm(app, conversation.id, leadAction.actionId)).json().results).toEqual(registration.json().results);
    const existing = await app.prepareLead(conversation.id, updatedInput);
    expect(existing).toMatchObject({ result: { ok: true, data: { outcome: 'existing', lead: { id: lead.id } } }, pendingAction: null });
  });

  it('recibo de aula anterior não autoriza outro horário pendente', async () => {
    const app = application();
    const { conversation } = await registered(app);
    const first = await proposal(app, conversation.id);
    const original = await confirm(app, conversation.id, first.actionId);
    const current = app.conversations.get(conversation.id)!;
    current.context = { ...current.context, slotId: 'slot_english_b', revision: 9 };
    app.conversations.save(current);
    const next = await proposal(app, conversation.id);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const retry = await confirm(app, conversation.id, first.actionId);
    expect(retry.json()).toMatchObject({ reply: original.json().reply, results: original.json().results, pendingAction: next });
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_b')).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
  });
});
