import assert from 'node:assert/strict';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { chatConfirmationRequestSchema, chatErrorResponseSchema, chatRequestSchema } from '@supportflow/contracts/chat';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import type { LanguageSchoolChatResponse, LanguageSchoolToolResult } from '@supportflow/contracts/language-school';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import {
  catalogTurn, courseTurn, createJourneyModel, decidedStudentScript, dialogue, handoffTurn,
  leadTurn, query, scheduleTurn, selectSlotTurn, slotsTurn, type JourneyScript,
} from './helpers/journey-script.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const englishId = 'course_english_travel';
const slotA = 'slot_english_a';
const slotB = 'slot_english_b';
type Body = LanguageSchoolChatResponse;
type ToolName = LanguageSchoolToolResult['tool'];
type ToolResult<Name extends ToolName> = Extract<LanguageSchoolToolResult, { tool: Name }>['result'];
type ToolData<Name extends ToolName> = Extract<ToolResult<Name>, { ok: true }>['data'];

// Estes helpers atravessam HTTP e validam contratos públicos. Não usam prepare*,
// conversations.save, createForConversation ou reserveSlot para montar jornadas.
function official<Name extends ToolName>(body: Body, tool: Name): ToolResult<Name> {
  const entries = body.results.filter((entry) => entry.tool === tool);
  expect(entries).toHaveLength(1);
  return entries[0]!.result as ToolResult<Name>;
}
function success<Name extends ToolName>(body: Body, tool: Name): ToolData<Name> {
  const result = official(body, tool);
  assert(result.ok, JSON.stringify(result));
  return result.data as ToolData<Name>;
}
function action<Kind extends NonNullable<Body['pendingAction']>['kind']>(body: Body, kind: Kind) {
  assert(body.pendingAction?.kind === kind);
  return body.pendingAction as Extract<NonNullable<Body['pendingAction']>, { kind: Kind }>;
}

describe('homologação integrada 7.1 — API real, LangChain e repositories em memória', () => {
  const servers: FastifyInstance[] = [];
  const network = vi.fn(() => { throw new Error('Rede externa proibida na homologação.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', network); vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(network).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function application(script: JourneyScript) {
    const model = createJourneyModel(script);
    const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
    const handoffRepository = new InMemoryHandoffRepository();
    const app = createApplication({}, { model, schoolRepository, leadRepository, trialClassRepository, handoffRepository, now });
    servers.push(app.server);
    return { ...app, model, schoolRepository, leadRepository, trialClassRepository, handoffRepository };
  }
  type App = ReturnType<typeof application>;
  async function send(app: App, message: string, conversationId?: string): Promise<Body> {
    const payload = chatRequestSchema.parse({ message, ...(conversationId ? { conversationId } : {}) });
    const response = await app.server.inject({ method: 'POST', url: '/api/chat', payload });
    expect(response.statusCode, response.body).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    if (conversationId) expect(body.conversationId).toBe(conversationId);
    return body;
  }
  function confirmRaw(app: App, conversationId: string, actionId: string) {
    const payload = chatConfirmationRequestSchema.parse({ conversationId, actionId });
    expect(Object.keys(payload).sort()).toEqual(['actionId', 'conversationId']);
    return app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload });
  }
  async function confirm(app: App, body: Body): Promise<Body> {
    assert(body.pendingAction);
    const response = await confirmRaw(app, body.conversationId, body.pendingAction.actionId);
    expect(response.statusCode, response.body).toBe(200);
    return languageSchoolChatResponseSchema.parse(response.json());
  }
  async function stale(app: App, body: Body) {
    assert(body.pendingAction);
    const response = await confirmRaw(app, body.conversationId, body.pendingAction.actionId);
    expect(response.statusCode).toBe(409);
    expect(chatErrorResponseSchema.parse(response.json()).error.code).toBe('ACTION_STALE');
  }
  const context = (app: App, id: string) => {
    const conversation = app.conversations.get(id); assert(conversation); return conversation.context;
  };
  async function bookings(app: App) {
    return (await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId))))
      .filter((booking) => booking !== null);
  }
  async function noWrites(app: App, id: string) {
    expect(await app.leadRepository.findByConversationId(id)).toBeNull();
    expect(await bookings(app)).toEqual([]);
  }

  // Cinco mensagens reais desde a conversa vazia, até a prévia (ainda sem escrita).
  async function decidedStudent(app: App, name = 'Ana', email = 'ana@example.com') {
    const catalog = await send(app, 'Quais cursos vocês oferecem?');
    const id = catalog.conversationId;
    expect(id).toEqual(expect.any(String)); expect(id.trim()).not.toBe('');
    expect(success(catalog, 'get_courses').courses).toEqual(await app.schoolRepository.listActiveCourses());
    expect(await app.leadRepository.findByConversationId(id)).toBeNull();
    expect(await bookings(app)).toEqual([]);
    const details = await send(app, 'Quero inglês para viagem.', id);
    expect(success(details, 'get_course_details').course).toEqual(await app.schoolRepository.findActiveCourseById(englishId));
    expect(context(app, id)).toMatchObject({ courseId: englishId, goal: 'viagem', revision: 1 });
    const availability = await send(app, 'Quais horários estão disponíveis?', id);
    const expectedSlots = slotFixtures.filter((slot) => slot.courseId === englishId && Date.parse(slot.startsAt) > now().getTime())
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    expect(success(availability, 'get_available_slots').slots).toEqual(expectedSlots);
    expect(await bookings(app)).toEqual([]);
    const selected = await send(app, 'Escolho 11/06/2030 às 10h.', id);
    expect(context(app, id)).toMatchObject({ slotId: slotA, revision: 2 });
    expect(selected.pendingAction).toBeNull();
    expect(await bookings(app)).toEqual([]);
    const registration = await send(app, `Meu nome é ${name}. Meu email é ${email}. Quero prosseguir com o cadastro.`, id);
    expect(official(registration, 'create_lead')).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(action(registration, 'create_lead').preview).toEqual({ name, contact: { type: 'email', value: email }, courseId: englishId, goal: 'viagem' });
    expect(context(app, id)).toMatchObject({ name, contact: { type: 'email', value: email }, revision: 3 });
    expect(await app.leadRepository.findByConversationId(id)).toBeNull();
    return { catalog, details, availability, selected, registration, id };
  }
  async function register(app: App, registration: Body) {
    const receipt = await confirm(app, registration);
    const data = success(receipt, 'create_lead');
    expect(data.outcome).toBe('created');
    expect(data.lead).toEqual(await app.leadRepository.findByConversationId(registration.conversationId));
    expect(context(app, registration.conversationId).leadId).toBe(data.lead.id);
    expect(context(app, registration.conversationId).revision).toBe(3);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    return { receipt, lead: data.lead };
  }

  it('aluno decidido percorre catálogo → escolha → horários → cadastro → reserva, sem pular etapas', async () => {
    const app = application([...decidedStudentScript(), scheduleTurn(), new AIMessage('Não consegui registrar.'), slotsTurn()]);
    const journey = await decidedStudent(app);
    await noWrites(app, journey.id);
    expect(journey.details.reply).toBe('O curso custa R$ 999.');
    expect(success(journey.details, 'get_course_details').course.price?.amountCents).toBe(35000);
    const { lead } = await register(app, journey.registration);
    expect(await bookings(app)).toEqual([]);
    expect(journey.registration.reply).toBe('Cadastro realizado.');
    const proposed = await send(app, 'Quero agendar no horário selecionado.', journey.id);
    const preview = action(proposed, 'schedule_trial_class').preview;
    expect(proposed.reply).toBe('Sua aula está confirmada.');
    expect(official(proposed, 'schedule_trial_class')).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(preview.lead).toEqual(lead);
    expect(preview.course).toEqual((await app.schoolRepository.listActiveCourses()).find((course) => course.id === englishId));
    expect(preview.slot).toEqual(slotFixtures.find((slot) => slot.slotId === slotA));
    expect(await bookings(app)).toEqual([]);
    const confirmed = await confirm(app, proposed);
    const data = success(confirmed, 'schedule_trial_class');
    expect(data.outcome).toBe('created'); expect(confirmed.reply).toBe('Não consegui registrar.');
    expect(data.booking).toEqual({ ...preview.slot, id: expect.any(String), leadId: lead.id, status: 'confirmed' });
    expect(await bookings(app)).toEqual([data.booking]);
    const available = await send(app, 'Quais horários ainda estão disponíveis?', journey.id);
    expect(success(available, 'get_available_slots').slots.some((slot) => slot.slotId === slotA)).toBe(false);
    expect(app.conversations.get(journey.id)?.history.filter((message) => message.type === 'human').map((message) => message.text)).toHaveLength(7);
    expect(app.model.calls.some((call) => call.messages.some((message) => ToolMessage.isInstance(message)))).toBe(true);
    expect(await app.handoffRepository.findOpenByConversationId(journey.id)).toBeNull();
  });

  it('corrige objetivo e contato antes do cadastro; lead desatualizado bloqueia reserva até nova confirmação', async () => {
    const app = application([...decidedStudentScript(), leadTurn({ goal: 'entrevistas' }),
      leadTurn({ contact: { type: 'email', value: 'ana.novo@example.com' } }),
      scheduleTurn({ contact: { type: 'email', value: 'ana.final@example.com' } }), leadTurn(), scheduleTurn(), new AIMessage('Aula registrada.')]);
    const journey = await decidedStudent(app);
    const goal = await send(app, 'Na verdade, meu objetivo é entrevistas.', journey.id);
    expect(context(app, journey.id).revision).toBe(4);
    expect(action(goal, 'create_lead').preview.goal).toBe('entrevistas');
    await stale(app, journey.registration); await noWrites(app, journey.id);
    const contact = await send(app, 'Meu novo email é ana.novo@example.com.', journey.id);
    expect(context(app, journey.id).revision).toBe(5);
    expect(action(contact, 'create_lead').preview).toMatchObject({ goal: 'entrevistas', contact: { value: 'ana.novo@example.com' } });
    await stale(app, goal); await noWrites(app, journey.id);
    const registered = success(await confirm(app, contact), 'create_lead');
    expect(registered.outcome).toBe('created');
    expect(registered.lead).toMatchObject({ goal: 'entrevistas', contact: { value: 'ana.novo@example.com' } });
    expect(context(app, journey.id).leadId).toBe(registered.lead.id);
    const blocked = await send(app, 'Corrigindo: ana.final@example.com. Quero agendar a aula.', journey.id);
    expect(official(blocked, 'schedule_trial_class')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('atualização do cadastro') } });
    expect(blocked.pendingAction).toBeNull(); expect(context(app, journey.id).revision).toBe(6);
    expect(await app.leadRepository.findByConversationId(journey.id)).toEqual(registered.lead);
    expect(await bookings(app)).toEqual([]);
    const update = await send(app, 'Quero atualizar meu cadastro.', journey.id);
    expect(action(update, 'create_lead').preview.contact.value).toBe('ana.final@example.com');
    expect(await app.leadRepository.findByConversationId(journey.id)).toEqual(registered.lead);
    const updated = success(await confirm(app, update), 'create_lead');
    expect(updated).toMatchObject({ outcome: 'updated', lead: { id: registered.lead.id, goal: 'entrevistas', contact: { value: 'ana.final@example.com' } } });
    const reservation = await send(app, 'Agora quero agendar.', journey.id);
    expect(action(reservation, 'schedule_trial_class').preview.lead).toEqual(updated.lead);
    expect(success(await confirm(app, reservation), 'schedule_trial_class').outcome).toBe('created');
    await stale(app, journey.registration); await stale(app, goal);
    expect(await app.leadRepository.findByConversationId(journey.id)).toEqual(updated.lead);
  });

  it('evidência A com ID B não muda ação; seleção válida de B invalida A e reserva somente B', async () => {
    const app = application([...decidedStudentScript(), scheduleTurn(),
      query('schedule_trial_class', (context) => ({ leadId: context.leadId, slotId: slotB }),
        { slotReference: { slotId: slotB, evidence: '11/06/2030 às 10h' } }),
      scheduleTurn({ slotReference: { slotId: slotB, evidence: '12/06/2030 às 14h' } }), new AIMessage('Aula confirmada.')]);
    const journey = await decidedStudent(app); await register(app, journey.registration);
    const first = await send(app, 'Quero agendar a aula selecionada.', journey.id);
    const before = context(app, journey.id);
    const mismatched = await send(app, 'Escolho 11/06/2030 às 10h.', journey.id);
    expect(context(app, journey.id)).toEqual(before);
    expect(mismatched.pendingAction).toEqual(first.pendingAction);
    expect(official(mismatched, 'schedule_trial_class')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await bookings(app)).toEqual([]);
    const changed = await send(app, 'Prefiro 12/06/2030 às 14h.', journey.id);
    expect(context(app, journey.id)).toMatchObject({ slotId: slotB, revision: before.revision + 1 });
    expect(action(changed, 'schedule_trial_class').preview.slot.slotId).toBe(slotB);
    expect(changed.pendingAction?.actionId).not.toBe(first.pendingAction?.actionId);
    await stale(app, first); expect(await bookings(app)).toEqual([]);
    const receipt = await confirm(app, changed);
    expect(success(receipt, 'schedule_trial_class').booking.slotId).toBe(slotB);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    expect(await bookings(app)).toEqual([success(receipt, 'schedule_trial_class').booking]);
  });

  it('duas jornadas disputam a mesma vaga; só uma vence, e retry do conflito recupera recibo histórico', async () => {
    const app = application([...decidedStudentScript(), scheduleTurn(), ...decidedStudentScript('Bruno', 'bruno@example.com'), scheduleTurn(),
      new AIMessage('Consulte o recibo.'), new AIMessage('Consulte o recibo.'), slotsTurn(), slotsTurn(), scheduleTurn(), scheduleTurn()]);
    const a = await decidedStudent(app); const leadA = await register(app, a.registration);
    const actionA = await send(app, 'Quero agendar.', a.id);
    const b = await decidedStudent(app, 'Bruno', 'bruno@example.com'); const leadB = await register(app, b.registration);
    const actionB = await send(app, 'Quero agendar.', b.id);
    expect(a.id).not.toBe(b.id); expect(leadA.lead.id).not.toBe(leadB.lead.id);
    expect(context(app, a.id).name).toBe('Ana'); expect(context(app, b.id).name).toBe('Bruno');
    expect(app.conversations.get(b.id)?.history.filter((message) => message.type === 'human').map((message) => message.text).join(' ')).not.toContain('ana@example.com');
    expect(await bookings(app)).toEqual([]);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot'); // Observação, sem substituir a implementação.
    const receipts = await Promise.all([confirm(app, actionA), confirm(app, actionB)]);
    const winner = receipts.find((receipt) => official(receipt, 'schedule_trial_class').ok)!;
    const loser = receipts.find((receipt) => !official(receipt, 'schedule_trial_class').ok)!;
    expect(success(winner, 'schedule_trial_class').outcome).toBe('created');
    expect(official(loser, 'schedule_trial_class')).toMatchObject({ ok: false, error: { code: 'SLOT_UNAVAILABLE' } });
    const saved = success(winner, 'schedule_trial_class').booking;
    expect(await bookings(app)).toEqual([saved]);
    expect(saved.leadId).toBe(context(app, winner.conversationId).leadId);
    expect((await bookings(app)).filter((booking) => booking.leadId === context(app, loser.conversationId).leadId)).toEqual([]);
    expect(reserve).toHaveBeenCalledTimes(2);
    // As primeiras respostas foram descartadas pelo cliente. Reenvio dos mesmos
    // IDs recupera ambos os snapshots, inclusive SLOT_UNAVAILABLE, sem reexecução.
    const callCount = app.model.calls.length;
    expect(await confirm(app, actionA)).toEqual(receipts[0]);
    expect(await confirm(app, actionB)).toEqual(receipts[1]);
    expect(reserve).toHaveBeenCalledTimes(2); expect(app.model.calls).toHaveLength(callCount);
    for (const id of [a.id, b.id]) {
      const available = await send(app, 'Quais horários ainda estão disponíveis?', id);
      expect(success(available, 'get_available_slots').slots.some((slot) => slot.slotId === slotA)).toBe(false);
    }
    const againWinner = await send(app, 'Quero a mesma aula.', winner.conversationId);
    expect(success(againWinner, 'schedule_trial_class')).toEqual({ outcome: 'existing', booking: saved });
    expect(againWinner.pendingAction).toBeNull();
    const againLoser = await send(app, 'Quero a mesma aula.', loser.conversationId);
    expect(official(againLoser, 'schedule_trial_class')).toMatchObject({ ok: false, error: { code: 'SLOT_UNAVAILABLE' } });
    expect(againLoser.pendingAction).toBeNull(); expect(await bookings(app)).toEqual([saved]);
  });

  it('falha exclusivamente textual após reserva real retorna HTTP 200, contingência e recibo recuperável', async () => {
    const app = application([...decidedStudentScript(), scheduleTurn(), new Error('Falha simulada após a escrita')]);
    const journey = await decidedStudent(app); await register(app, journey.registration);
    const proposed = await send(app, 'Quero agendar a aula.', journey.id);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const receipt = await confirm(app, proposed);
    expect(receipt.reply).toBe('Aula experimental confirmada na agenda de demonstração.');
    expect(success(receipt, 'schedule_trial_class').outcome).toBe('created');
    expect(await bookings(app)).toEqual([success(receipt, 'schedule_trial_class').booking]);
    const callCount = app.model.calls.length;
    expect(await confirm(app, proposed)).toEqual(receipt);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(app.model.calls).toHaveLength(callCount);
  });

  it.each([false, true])('reserva real seguida de resposta perdida, com falha da redação=%s; retry conserva created', async (failNarration) => {
    const app = application([...decidedStudentScript(), scheduleTurn(), failNarration ? new Error('Falha simulada da redação') : new AIMessage('Não consegui registrar.')]);
    let loseAction: string | undefined;
    let deliveredReceipt: Body | undefined;
    // Falha somente no transporte, após lifecycle/executor reais. O conteúdo
    // capturado serve à asserção; não substitui resultado de nenhum caso de uso.
    app.server.addHook('onSend', async (request, _reply, payload) => {
      if (request.url === '/api/chat/confirm' && loseAction && typeof payload === 'string') {
        const parsed = languageSchoolChatResponseSchema.safeParse(JSON.parse(payload));
        if (parsed.success && (request.body as { actionId: string }).actionId === loseAction) {
          deliveredReceipt = parsed.data; loseAction = undefined;
          throw new Error('Falha simulada de envio após o recibo salvo.');
        }
      }
      return payload;
    });
    const journey = await decidedStudent(app); await register(app, journey.registration);
    const proposed = await send(app, 'Quero agendar a aula.', journey.id);
    loseAction = action(proposed, 'schedule_trial_class').actionId;
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const failedDelivery = await confirmRaw(app, journey.id, loseAction);
    expect(failedDelivery.statusCode).toBe(500);
    expect(chatErrorResponseSchema.parse(failedDelivery.json()).error.code).toBe('CHAT_ERROR');
    assert(deliveredReceipt);
    const booking = success(deliveredReceipt, 'schedule_trial_class').booking;
    expect(await bookings(app)).toEqual([booking]);
    if (failNarration) expect(deliveredReceipt.reply).toBe('Aula experimental confirmada na agenda de demonstração.');
    const callCount = app.model.calls.length;
    const retry = await confirm(app, proposed);
    expect(retry).toEqual(deliveredReceipt);
    expect(success(retry, 'schedule_trial_class').outcome).toBe('created');
    expect(reserve).toHaveBeenCalledTimes(1); expect(app.model.calls).toHaveLength(callCount);
    expect(retry.pendingAction).toBeNull();
  });

  it('alterações posteriores de contato/objetivo/curso/horário e lead confirmado preservam booking e recibos antigos', async () => {
    const app = application([...decidedStudentScript(), scheduleTurn(), new AIMessage('Aula confirmada.'),
      dialogue(new AIMessage('Informações recebidas.'), { goal: 'entrevistas', contact: { type: 'email', value: 'ana.novo@example.com' } }),
      courseTurn('francês', null), slotsTurn(), selectSlotTurn('slot_french_a', '11/06/2030 às 11h'), leadTurn()]);
    const journey = await decidedStudent(app); const registration = await register(app, journey.registration);
    const proposal = await send(app, 'Quero agendar.', journey.id);
    const originalReceipt = await confirm(app, proposal);
    const original = structuredClone(success(originalReceipt, 'schedule_trial_class').booking);
    await send(app, 'Meu novo email é ana.novo@example.com e meu objetivo agora é entrevistas.', journey.id);
    expect(await app.leadRepository.findByConversationId(journey.id)).toEqual(registration.lead);
    await send(app, 'Agora prefiro francês.', journey.id);
    expect(context(app, journey.id).slotId).toBeNull();
    const available = await send(app, 'Quais horários do francês estão disponíveis?', journey.id);
    expect(success(available, 'get_available_slots').slots.map((slot) => slot.slotId)).toEqual(['slot_french_a']);
    await send(app, 'Escolho 11/06/2030 às 11h.', journey.id);
    expect(context(app, journey.id)).toMatchObject({ goal: 'entrevistas', contact: { value: 'ana.novo@example.com' }, courseId: 'course_french_intro', slotId: 'slot_french_a', revision: 6 });
    expect(await bookings(app)).toEqual([original]);
    const update = await send(app, 'Quero atualizar meu cadastro.', journey.id);
    expect(await app.leadRepository.findByConversationId(journey.id)).toEqual(registration.lead);
    const receipt = await confirm(app, update);
    expect(success(receipt, 'create_lead')).toMatchObject({ outcome: 'updated', lead: {
      id: registration.lead.id, goal: 'entrevistas', courseId: 'course_french_intro', contact: { value: 'ana.novo@example.com' },
    } });
    expect(await bookings(app)).toEqual([original]);
    expect(await confirm(app, proposal)).toEqual(originalReceipt);
    expect(await confirm(app, journey.registration)).toEqual(registration.receipt);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_french_a')).toBeNull();
  });

  it('interrompe a jornada antes do cadastro; falha da redação preserva handoff e repetição conserva protocolo', async () => {
    const app = application([catalogTurn(), courseTurn(), handoffTurn('Prefiro falar com alguém.', new Error('Falha simulada após registro')), handoffTurn('Outra dúvida')]);
    const catalog = await send(app, 'Quais cursos vocês oferecem?');
    await send(app, 'Quero inglês para viagem.', catalog.conversationId);
    const before = context(app, catalog.conversationId);
    const handoff = await send(app, 'Não quero me cadastrar agora. Prefiro falar com alguém.', catalog.conversationId);
    const request = success(handoff, 'transfer_to_human').request;
    expect(request).toEqual(await app.handoffRepository.findOpenByConversationId(catalog.conversationId));
    expect(request.status).toBe('requested'); expect(handoff.pendingAction).toBeNull();
    expect(handoff.reply).toBe(`Sua solicitação de atendimento humano foi registrada nesta demonstração. Protocolo: ${request.id}. Isso não inicia atendimento ao vivo nem envia notificações externas.`);
    expect(context(app, catalog.conversationId)).toEqual(before);
    expect(app.conversations.get(catalog.conversationId)?.history.at(-1)?.text).toBe(handoff.reply);
    await noWrites(app, catalog.conversationId);
    const repeated = await send(app, 'Preciso falar com um atendente sobre outro assunto.', catalog.conversationId);
    expect(success(repeated, 'transfer_to_human').request).toEqual(request);
    await noWrites(app, catalog.conversationId);
  });

  it.each(['create_lead', 'schedule_trial_class'] as const)('handoff durante prévia %s não autoriza cadastro ou reserva', async (kind) => {
    const app = application([...decidedStudentScript(), ...(kind === 'schedule_trial_class' ? [scheduleTurn()] : []), handoffTurn(), handoffTurn('Outra dúvida')]);
    const journey = await decidedStudent(app);
    const pending = kind === 'create_lead' ? journey.registration : await (async () => {
      await register(app, journey.registration); return send(app, 'Quero agendar.', journey.id);
    })();
    const before = context(app, journey.id);
    const lead = await app.leadRepository.findByConversationId(journey.id);
    const handoff = await send(app, 'Antes disso, quero falar com uma pessoa.', journey.id);
    expect(handoff.pendingAction).toEqual(pending.pendingAction);
    expect(context(app, journey.id)).toEqual(before);
    expect(await app.leadRepository.findByConversationId(journey.id)).toEqual(lead);
    expect(await bookings(app)).toEqual([]);
    expect(success(handoff, 'transfer_to_human').request.status).toBe('requested');
    const repeated = await send(app, 'Quero falar com alguém.', journey.id);
    expect(repeated.pendingAction).toEqual(pending.pendingAction);
    expect(repeated.results).toEqual(handoff.results);
    expect(await bookings(app)).toEqual([]);
  });
});
