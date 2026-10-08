import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { scheduleTrialClassResultSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationContext } from '../src/modules/language-school/domain/conversation-context.js';
import { handoffOffer } from '../src/modules/language-school/domain/handoff-intent.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { catalogTurn, courseTurn, decidedStudentScript, dialogue, handoffTurn, leadTurn, query, scheduleTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaText } from './helpers/meta-webhook.js';
import { button, clickEvent, createWhatsAppJourney, identity, inboxKey, journeyStart, otherSender, output, sender } from './helpers/whatsapp-journey.js';

const student = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' };
const introduction = 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.';
const goalCorrection = { goal: 'entrevistas de emprego' };
const contactCorrection = { contact: { type: 'email' as const, value: 'ana.novo@example.com' } };
const slotA = { slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } };
const slotB = { slotReference: { slotId: 'slot_english_b', evidence: '12/06/2030 às 14h' } };
const kinds = ['create_lead', 'schedule_trial_class'] as const;
type Kind = typeof kinds[number];
type App = ReturnType<typeof createWhatsAppJourney>;
const applications: App[] = [];
const releases: (() => void)[] = [];
function application(script: JourneyScript, startedAt = journeyStart) {
  const app = createWhatsAppJourney(script, startedAt); applications.push(app); return app;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
function preparationScript(kind: Kind = 'schedule_trial_class'): JourneyScript {
  return [leadTurn(student), ...(kind === 'schedule_trial_class' ? [scheduleTurn(slotA)] : [])];
}
async function prepare(app: App, kind: Kind = 'schedule_trial_class', from = sender) {
  const lead = button(await app.text(`lead-${from}`, introduction, from));
  const proposal = app.response(`lead-${from}`);
  expect(proposal.pendingAction?.kind).toBe('create_lead');
  expect(await app.leadRepository.findByConversationId(proposal.conversationId)).toBeNull();
  if (kind === 'create_lead') return lead;
  await app.click(`register-${from}`, lead);
  expect(app.response(`register-${from}`).results[0]).toMatchObject({
    tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } },
  });
  expect(await app.bookings()).toEqual([]);
  const trial = button(await app.text(`trial-${from}`, 'Quero agendar 11/06/2030 às 10h.', from));
  expect(app.response(`trial-${from}`).pendingAction?.kind).toBe('schedule_trial_class');
  return trial;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida na jornada.'); }));
  vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  try {
    await Promise.all(applications.splice(0).map((app) => app.close()));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});

// Task 7.1: toda escrita/recuperação é provocada por webhook assinado. Leituras
// diretas e spies somente observam o estado real; não preparam ações nem recibos.
describe('7.1 — jornada integrada WhatsApp: webhook assinado → motor real → Cloud API simulada → clique → recibo', () => {
  it('percorre catálogo, curso, horários, seleção explícita, cadastro e aula com confirmações separadas e recibo oficial', async () => {
    const app = application([...decidedStudentScript(), scheduleTurn(), new AIMessage('A reserva falhou, nenhum agendamento existe.')]);
    const first = metaText({ id: 'catalog', text: { body: 'Quais cursos vocês oferecem?' },
      contacts: [{ profile: { name: 'Perfil não é cadastro' } }], conversationId: 'external-conversation', confirmed: true });
    const catalog = await app.deliver(first);
    const conversationId = app.response('catalog').conversationId;
    expect(conversationId).not.toBe('external-conversation');
    expect(app.conversations.get(conversationId)?.context).toEqual(createConversationContext());
    expect(app.response('catalog').results[0]).toEqual({ tool: 'get_courses', result: { ok: true, data: {
      courses: courseFixtures.filter(({ active }) => active).map(({ id, name, language, modality, active }) => ({ id, name, language, modality, active })),
    } } });
    expect(output(catalog)).toContain('/reenviar');
    expect(output(catalog)).not.toContain('Fundamentos de alemão');
    const beforeDuplicate = app.calls();
    expect(await app.deliver(first)).toEqual([]);
    expect(app.calls()).toEqual(beforeDuplicate);

    const details = await app.text('course', 'Quero inglês para viagem.');
    expect(app.response('course').results[0]).toEqual({ tool: 'get_course_details', result: { ok: true, data: { course: courseFixtures[0] } } });
    expect(output(details)).toMatch(/350,00.*mês/u); expect(output(details)).not.toContain('999');
    const slots = await app.text('slots', 'Quais horários estão disponíveis?');
    expect(app.response('slots').results[0]).toEqual({ tool: 'get_available_slots', result: { ok: true, data: {
      courseId: 'course_english_travel', slots: ['slot_english_occupied', 'slot_english_a', 'slot_english_b']
        .map((id) => slotFixtures.find((slot) => slot.slotId === id)),
    } } });
    expect(output(slots)).toContain('11/06/2030 às 10:00'); expect(output(slots)).toContain(schoolFixture.timezone);
    expect(output(slots)).not.toContain('09/06/2030');
    await app.text('selection', 'Escolho 11/06/2030 às 10h.');
    expect(app.conversations.get(conversationId)?.context.slotId).toBe('slot_english_a');
    expect(await app.bookings()).toEqual([]);

    const lead = button(await app.text('lead', 'Meu nome é Ana, meu email é ana@example.com. Quero me cadastrar.'));
    expect(lead.title).toBe('Confirmar cadastro');
    expect(output([lead])).toContain('ana@example.com'); expect(output([lead])).toContain('viagem');
    expect(app.response('lead').results[0]?.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    await app.click('register', lead);
    const savedLead = await app.leadRepository.findByConversationId(conversationId); assert(savedLead);
    expect(app.response('register').results[0]).toEqual({ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: savedLead } } });
    expect(await app.bookings()).toEqual([]);

    const trial = button(await app.text('trial', 'Quero agendar o horário selecionado.'));
    expect(trial.title).toBe('Confirmar aula'); expect(trial.reference).not.toBe(lead.reference);
    expect(output([trial])).toContain('11/06/2030 às 10:00'); expect(output([trial])).toContain(schoolFixture.timezone);
    expect(app.response('trial').results[0]?.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    await app.click('lead-again', lead);
    expect(app.response('lead-again')).toEqual({ ...app.response('register'), pendingAction: app.response('trial').pendingAction });
    expect(await app.bookings()).toEqual([]);
    const receiptOutput = await app.click('book', trial);
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    expect(app.response('book')).toMatchObject({ pendingAction: null, results: [{ tool: 'schedule_trial_class', result: {
      ok: true, data: { outcome: 'created', booking },
    } }] });
    expect(output(receiptOutput)).toContain(booking.id); expect(output(receiptOutput)).not.toContain('A reserva falhou');
    expect(await app.bookings()).toEqual([booking]);
    const beforeRetry = app.calls();
    expect(await app.click('book', trial)).toEqual([]);
    await app.click('receipt-again', trial);
    expect(app.response('receipt-again')).toEqual(app.response('book'));
    expect(app.calls()).toEqual({ ...beforeRetry, confirm: beforeRetry.confirm + 1 });
    expect(app.create).toHaveBeenCalledTimes(1); expect(app.reserve).toHaveBeenCalledTimes(1);
  });

  it('corrige objetivo, contato e horário, recusa botões antigos e preserva reserva e recibos após atualizar o lead', async () => {
    const app = application([leadTurn(student), leadTurn(goalCorrection), leadTurn(contactCorrection),
      scheduleTurn(slotA), scheduleTurn(slotB), new AIMessage('Recibo.'),
      leadTurn({ contact: student.contact }), leadTurn({ goal: 'trabalho' })]);
    const original = await prepare(app, 'create_lead');
    const conversationId = app.response(`lead-${sender}`).conversationId;
    const goal = button(await app.text('goal', 'Na verdade, quero principalmente entrevistas de emprego.'));
    const contact = button(await app.text('contact', 'Meu email correto é ana.novo@example.com.'));
    expect(new Set([original.reference, goal.reference, contact.reference]).size).toBe(3);
    expect(app.response('contact').pendingAction).toMatchObject({ preview: { ...goalCorrection, ...contactCorrection } });
    expect(output([contact])).toContain('entrevistas de emprego'); expect(output([contact])).toContain('ana.novo@example.com');
    for (const [id, previous] of [['old-goal', original], ['old-contact', goal]] as const) {
      expect(output(await app.click(id, previous))).toContain('revisar a prévia atual');
      expect(app.inbox.get(inboxKey(id))).toMatchObject({ state: 'failed', code: 'ACTION_STALE' });
    }
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    await app.click('register', contact);
    const registered = app.response('register');
    const lead = await app.leadRepository.findByConversationId(conversationId); assert(lead);
    expect(lead).toMatchObject({ ...goalCorrection, ...contactCorrection });
    const trialA = button(await app.text('trial-a', 'Escolho 11/06/2030 às 10h. Quero agendar.'));
    // Correção e clique entram no mesmo lote: a fila deve aplicar a revisão antes da confirmação.
    expect((await app.post([metaText({ id: 'trial-b', text: { body: 'Agora escolho 12/06/2030 às 14h.' } }),
      clickEvent('old-slot', trialA)])).statusCode).toBe(200);
    await app.drain();
    const trialB = button(app.sent);
    expect(app.inbox.get(inboxKey('old-slot'))).toMatchObject({ state: 'failed', code: 'ACTION_STALE' });
    expect(output([trialB])).toContain('12/06/2030 às 14:00');
    expect(trialB.reference).not.toBe(trialA.reference);
    expect(await app.bookings()).toEqual([]);
    await app.click('book', trialB);
    const receipt = app.response('book');
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_b'); assert(booking);
    const revision = app.conversations.get(conversationId)!.context.revision;
    const update = button(await app.text('update', 'Volte meu email para ana@example.com.'));
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual(lead);
    await app.click('updated', update);
    expect(app.response('updated').results[0]).toMatchObject({ result: { ok: true, data: {
      outcome: 'updated', lead: { ...lead, contact: student.contact },
    } } });
    expect(app.conversations.get(conversationId)!.context.revision).toBeGreaterThan(revision);
    for (const withPending of [false, true]) {
      if (withPending) await app.text('next-goal', 'Meu objetivo agora é trabalho.');
      const pendingAction = withPending ? app.response('next-goal').pendingAction : null;
      if (withPending) expect(pendingAction?.kind).toBe('create_lead');
      const before = app.calls();
      await app.click(`historical-lead-${withPending}`, contact);
      await app.click(`historical-booking-${withPending}`, trialB);
      expect(app.response(`historical-lead-${withPending}`)).toEqual({ ...registered, pendingAction });
      expect(app.response(`historical-booking-${withPending}`)).toEqual({ ...receipt, pendingAction });
      expect(app.calls()).toEqual({ ...before, confirm: before.confirm + 2 });
      expect(await app.bookings()).toEqual([booking]);
    }
    expect(app.create).toHaveBeenCalledTimes(1); expect(app.update).toHaveBeenCalledTimes(1); expect(app.reserve).toHaveBeenCalledTimes(1);
  });

  it('dois remetentes disputam a mesma vaga; duplicatas em andamento e retries preservam created e SLOT_UNAVAILABLE', async () => {
    const app = application([...preparationScript(), ...preparationScript(),
      new AIMessage('Recibo da disputa.'), new AIMessage('Recibo da disputa.'), scheduleTurn(slotB),
      dialogue(new AIMessage('Objetivo atualizado.'), { goal: 'trabalho' })]);
    const first = await prepare(app);
    const second = await prepare(app, 'schedule_trial_class', otherSender);
    const firstId = app.response(`lead-${sender}`).conversationId;
    const secondId = app.response(`lead-${otherSender}`).conversationId;
    expect(firstId).not.toBe(secondId);
    const leads = await Promise.all([firstId, secondId].map((id) => app.leadRepository.findByConversationId(id)));
    expect(leads[0]?.contact).toEqual(leads[1]?.contact); expect(leads[0]?.id).not.toBe(leads[1]?.id);

    const ready = gate(); const proceed = gate();
    const originalReserve = InMemoryTrialClassRepository.prototype.reserveSlot.bind(app.trialClassRepository);
    // Apenas controla a chegada à fronteira atômica. A implementação original
    // consulta/decide/grava e devolve o resultado; não há retorno simulado.
    app.reserve.mockImplementation(async (...args) => {
      if (app.reserve.mock.calls.length === 2) ready.release();
      await proceed.promise;
      return originalReserve(...args);
    });
    const events = [clickEvent('contender-a', first), clickEvent('contender-b', second)];
    expect((await app.post(events)).statusCode).toBe(200);
    await ready.promise;
    expect(app.inbox.get(inboxKey('contender-a'))?.state).toBe('processing');
    expect(app.inbox.get(inboxKey('contender-b'))?.state).toBe('processing');
    expect(await app.bookings()).toEqual([]);
    const beforeDuplicates = app.calls(); const sends = app.sent.length;
    expect((await app.post(events)).statusCode).toBe(200);
    expect(app.calls()).toEqual(beforeDuplicates); expect(app.sent).toHaveLength(sends);
    proceed.release(); await app.drain();
    // Restaurar somente o agendamento do spy, mantendo seu histórico de chamadas.
    app.reserve.mockImplementation(originalReserve);
    const receipts = [app.response('contender-a'), app.response('contender-b')];
    const results = receipts.map(({ results }) => scheduleTrialClassResultSchema.parse(results[0]!.result));
    expect(results.map((result) => result.ok ? result.data.outcome : result.error.code).sort()).toEqual(['SLOT_UNAVAILABLE', 'created']);
    const winner = results.findIndex((result) => result.ok); const loser = 1 - winner;
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    expect(booking.leadId).toBe(leads[winner]?.id); expect(await app.bookings()).toEqual([booking]);
    const before = app.calls(); const sent = app.sent.length;
    expect((await app.post(events)).statusCode).toBe(200); await app.drain();
    expect(app.calls()).toEqual(before); expect(app.sent).toHaveLength(sent);
    const buttons = [first, second];
    for (let index = 0; index < buttons.length; index++) {
      const published = buttons[index]!;
      const recovered = await app.click(`retry-${index}`, published);
      expect(app.response(`retry-${index}`)).toEqual(receipts[index]);
      expect(recovered.every(({ payload }) => payload.to === published.payload.to)).toBe(true);
      if (index === winner) expect(output(recovered)).toContain(booking.id);
      else expect(output(recovered)).not.toContain(booking.id);
    }
    expect(app.calls()).toEqual({ ...before, confirm: before.confirm + 2 });
    const lost = buttons[loser]!;
    await app.text('other-slot', 'Agora escolho 12/06/2030 às 14h.', lost.payload.to);
    const pendingAction = app.response('other-slot').pendingAction;
    expect(pendingAction?.kind).toBe('schedule_trial_class');
    await app.click('historical-conflict', lost);
    expect(app.response('historical-conflict')).toEqual({ ...receipts[loser], pendingAction });
    await app.text('new-revision', 'Meu objetivo agora é trabalho.', lost.payload.to);
    expect(app.response('new-revision').pendingAction).toBeNull();
    const afterRevision = app.calls();
    await app.click('historical-conflict-no-pending', lost);
    expect(app.response('historical-conflict-no-pending')).toEqual(receipts[loser]);
    expect(app.calls()).toEqual({ ...afterRevision, confirm: afterRevision.confirm + 1 });
    expect(app.reserve).toHaveBeenCalledTimes(2); expect(await app.bookings()).toEqual([booking]);
  });

  it.each(kinds)('recusa assinatura inválida, botão estrangeiro e correlação adulterada de %s sem escrita ou exposição', async (kind) => {
    const app = application([...preparationScript(kind), dialogue(),
      ...(kind === 'schedule_trial_class' ? [new AIMessage('Recibo.')] : [])]);
    const published = await prepare(app, kind);
    await app.text('other', 'Olá', otherSender);
    const ownId = app.response(`lead-${sender}`).conversationId;
    const otherId = app.response('other').conversationId;
    const own = app.conversations.get(ownId); const foreign = app.conversations.get(otherId);
    const before = app.calls(); const sent = app.sent.length;
    expect((await app.post([clickEvent('invalid-signature', published)], { validSignature: false })).statusCode).toBe(403);
    await app.drain();
    expect(app.inbox.get(inboxKey('invalid-signature'))).toBeUndefined(); expect(app.sent).toHaveLength(sent);
    for (const [id, overrides] of [
      ['foreign', { from: otherSender }],
      ['wrong-message', { context: { id: 'unrelated-message' } }],
      ['wrong-reference', { interactive: { type: 'button_reply', button_reply: { id: `${published.reference}x`, title: published.title } } }],
    ] as const) {
      const rejected = await app.click(id, published, overrides);
      expect(app.inbox.get(inboxKey(id))).toMatchObject({ state: 'failed', code: 'NOT_FOUND' });
      expect(output(rejected)).toContain('revisar a prévia atual');
      for (const value of [student.name, student.contact.value, ownId, published.reference]) expect(output(rejected)).not.toContain(value);
      expect(rejected.every(({ payload }) => payload.to === ('from' in overrides ? overrides.from : sender))).toBe(true);
    }
    expect(app.calls()).toEqual(before);
    expect(app.conversations.get(ownId)).toEqual(own); expect(app.conversations.get(otherId)).toEqual(foreign);
    expect(await app.leadRepository.findByConversationId(otherId)).toBeNull(); expect(await app.bookings()).toEqual([]);
    await app.click('valid', published);
    expect(app.response('valid').results[0]?.result).toMatchObject({ ok: true, data: { outcome: 'created' } });
  });

  it.each(kinds)('“sim” com tool call de %s não substitui clique específico', async (kind) => {
    const app = application([...preparationScript(kind), kind === 'create_lead' ? leadTurn() : scheduleTurn(),
      ...(kind === 'schedule_trial_class' ? [new AIMessage('Recibo.')] : [])]);
    await prepare(app, kind);
    const before = app.calls();
    const publication = button(await app.text('yes', 'sim'));
    expect(app.response('yes').results[0]?.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(app.calls()).toMatchObject({ create: before.create, update: before.update, reserve: 0, confirm: before.confirm });
    expect(await app.bookings()).toEqual([]);
    await app.click('valid', publication);
    expect(app.response('valid').results[0]?.result).toMatchObject({ ok: true, data: { outcome: 'created' } });
  });

  it.each(kinds)('falha de redação antes do commit de %s mantém contexto/ação anterior e não publica botão órfão', async (kind) => {
    const failure = kind === 'create_lead' ? leadTurn(contactCorrection) : scheduleTurn(slotB);
    failure.responses[1] = new Error('PRIVATE_DRAFT_FAILURE');
    const app = application([...preparationScript(kind), failure,
      ...(kind === 'schedule_trial_class' ? [new AIMessage('Recibo da ação preservada.')] : [])]);
    const published = await prepare(app, kind);
    const id = kind === 'create_lead' ? `lead-${sender}` : `trial-${sender}`;
    const previous = app.response(id);
    const conversation = app.conversations.get(previous.conversationId);
    const registrations = app.register.mock.calls.length; const before = app.calls();
    const failed = await app.text('failed-draft', kind === 'create_lead'
      ? 'Meu email correto é ana.novo@example.com.' : 'Agora escolho 12/06/2030 às 14h.');
    expect(app.inbox.get(inboxKey('failed-draft'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(app.conversations.get(previous.conversationId)).toEqual(conversation);
    expect(app.register).toHaveBeenCalledTimes(registrations);
    expect(failed.every(({ payload }) => payload.type === 'text')).toBe(true);
    expect(output(failed)).not.toContain('PRIVATE_DRAFT_FAILURE');
    expect(app.calls()).toMatchObject({ create: before.create, update: before.update, reserve: before.reserve });
    expect(await app.bookings()).toEqual([]);
    await app.click('preserved-action', published);
    expect(app.response('preserved-action').results[0]?.result).toMatchObject({ ok: true, data: { outcome: 'created' } });
    if (kind === 'create_lead') expect(await app.leadRepository.findByConversationId(previous.conversationId)).toMatchObject({ contact: student.contact });
    else expect((await app.bookings())[0]?.slotId).toBe('slot_english_a');
  });

  it.each(['draft', 'rejected', 'unknown', 'draft-and-unknown', 'delivery-failed'] as const)(
    'preserva reserva/recibo após %s; /reenviar e novo clique não repetem modelo nem escrita', async (failure) => {
      const app = application([...preparationScript(), failure.startsWith('draft')
        ? new Error('PRIVATE_RECEIPT_DRAFT_FAILURE') : new AIMessage('A reserva falhou, tente reservar novamente.')]);
      const published = await prepare(app);
      if (failure === 'rejected' || failure.includes('unknown')) app.reply.mockImplementationOnce(async () => {
        const receipt = app.response('book');
        expect(receipt.results[0]?.result).toMatchObject({ ok: true, data: { outcome: 'created' } });
        expect(app.outbox.get(inboxKey('book'))).toMatchObject({ source: { response: receipt }, parts: [{ state: 'sending' }] });
        expect(await app.bookings()).toHaveLength(1);
        return failure === 'rejected'
          ? Response.json({ error: { code: 100, type: 'TestError', message: 'FAKE_PROVIDER_ERROR' } }, { status: 400 })
          : Response.json({}); // Possível aceite sem ID: o cliente real classifica como unknown.
      });
      const attempted = await app.click('book', published);
      const receipt = app.response('book');
      const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
      expect(receipt.results[0]).toEqual({ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created', booking } } });
      expect(output(attempted)).toContain(booking.id); expect(output(attempted)).not.toContain('A reserva falhou');
      expect(output(attempted)).not.toContain('PRIVATE');
      if (failure.startsWith('draft')) expect(receipt.reply).toContain('agenda de demonstração');
      if (failure === 'delivery-failed') await app.status(attempted[0]!, 'failed');
      const expectedState = failure.includes('unknown') ? 'unknown' : failure === 'draft' ? 'accepted' : 'failed';
      expect(app.outbox.get(inboxKey('book'))?.parts[0]?.state).toBe(expectedState);
      const before = app.calls();
      expect(await app.click('book', published)).toEqual([]);
      expect(app.calls()).toEqual(before);
      if (failure !== 'draft') {
        const recovered = await app.text('resend', '/reenviar');
        expect(recovered.map(({ payload }) => payload)).toEqual(attempted.map(({ payload }) => payload));
        expect(app.calls()).toEqual(before);
        expect(app.outbox.get(inboxKey('book'))).toMatchObject({ source: { response: receipt }, parts: [{ state: 'accepted' }] });
        for (const state of ['read', 'delivered', 'sent', 'read']) await app.status(recovered[0]!, state);
        expect(app.outbox.get(inboxKey('book'))?.parts[0]?.state).toBe('read');
        expect(app.calls()).toEqual(before);
      }
      await app.click('historical-receipt', published);
      expect(app.response('historical-receipt')).toEqual(receipt);
      expect(app.calls()).toEqual({ ...before, confirm: before.confirm + 1 });
      expect(app.reserve).toHaveBeenCalledTimes(1); expect(await app.bookings()).toEqual([booking]);
    },
  );

  it('handoff explícito sem lead preserva prévia/revisão, protocolo original e contingência após falha de redação', async () => {
    const app = application([leadTurn(student), handoffTurn('Quero falar com alguém.', new Error('PRIVATE_HANDOFF_DRAFT_FAILURE')),
      handoffTurn('Quero falar com um atendente por outro motivo.')]);
    const published = await prepare(app, 'create_lead');
    const previous = app.response(`lead-${sender}`);
    const context = app.conversations.get(previous.conversationId)!.context;
    const protocol = await app.text('handoff', 'Quero falar com alguém.');
    const request = await app.handoffRepository.findOpenByConversationId(previous.conversationId); assert(request);
    expect(app.response('handoff')).toMatchObject({ pendingAction: previous.pendingAction,
      results: [{ tool: 'transfer_to_human', result: { ok: true, data: { request } } }] });
    expect(output(protocol)).toContain(request.id); expect(output(protocol)).toContain('não inicia atendimento humano ao vivo');
    expect(output(protocol)).not.toContain('PRIVATE'); expect(output(protocol)).not.toContain('Um atendente assumiu');
    expect(request.status).toBe('requested');
    expect(app.conversations.get(previous.conversationId)!.context).toEqual(context);
    expect(button(protocol).reference).toBe(published.reference); // Apenas reapresenta a prévia de cadastro.
    expect(await app.leadRepository.findByConversationId(previous.conversationId)).toBeNull();
    expect(await app.bookings()).toEqual([]); expect(app.confirm).not.toHaveBeenCalled();
    await app.text('handoff-again', 'Quero falar com um atendente por outro motivo.');
    expect(app.response('handoff-again').results).toEqual(app.response('handoff').results);
    expect(await app.handoffRepository.findOpenByConversationId(previous.conversationId)).toEqual(request);
    expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled();
    // O handoff não consome a autorização de cadastro: o botão original segue válido.
    await app.click('register-after-handoff', published);
    expect(app.response('register-after-handoff').results[0]?.result).toMatchObject({ ok: true, data: { outcome: 'created' } });
  });

  it.each(['omitted', 'rejected', 'accepted-only'] as const)('oferta %s não autoriza “sim”; pedido explícito continua independente', async (mode) => {
    const offerTurn = mode === 'omitted' ? query('get_courses', {}, {}, new AIMessage(handoffOffer)) : dialogue(new AIMessage(handoffOffer));
    const app = application([offerTurn, handoffTurn(), handoffTurn()]);
    if (mode === 'rejected') app.reply.mockImplementation(async ({ payload, messageId }) =>
      payload.type === 'text' && payload.text.body === handoffOffer
        ? Response.json({ error: { code: 100, type: 'TestError', message: 'FAKE_REJECTION' } }, { status: 400 })
        : Response.json({ messaging_product: 'whatsapp', messages: [{ id: messageId }] }));
    const presentation = await app.text('offer', 'Quais cursos vocês oferecem?');
    const last = presentation.at(-1)!;
    const conversationId = app.response('offer').conversationId;
    expect(app.response('offer').reply).toBe(handoffOffer);
    if (mode === 'omitted') {
      expect(output(presentation)).not.toContain(handoffOffer);
      await app.status(last, 'read');
    }
    await app.text('yes', 'Sim', sender, { context: { id: mode === 'omitted' ? last.messageId : 'invented-message' }, previousPresentation: handoffOffer });
    expect(app.response('yes').results[0]?.result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await app.handoffRepository.findOpenByConversationId(conversationId)).toBeNull();
    expect(app.handoff).not.toHaveBeenCalled();
    await app.text('explicit', 'Quero falar com alguém.');
    const request = await app.handoffRepository.findOpenByConversationId(conversationId); assert(request);
    expect(app.response('explicit').results[0]?.result).toEqual({ ok: true, data: { request } });
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull(); expect(await app.bookings()).toEqual([]);
  });

  it.each(['delivered', 'correlated-reply'] as const)('oferta com %s permite handoff sem cadastro e mantém requested após entrega', async (evidence) => {
    const app = application([dialogue(new AIMessage(handoffOffer)), handoffTurn()]);
    const offer = (await app.text('offer', 'Olá')).at(-1)!;
    if (evidence === 'delivered') await app.status(offer, 'delivered');
    const context = app.conversations.get(app.response('offer').conversationId)!.context;
    const protocol = (await app.text('yes', 'Sim, por favor.', sender,
      evidence === 'correlated-reply' ? { context: { id: offer.messageId } } : {})).at(-1)!;
    const conversationId = app.response('yes').conversationId;
    const request = await app.handoffRepository.findOpenByConversationId(conversationId); assert(request);
    expect(output([protocol])).toContain(request.id);
    const before = app.calls(); await app.status(protocol, 'read');
    expect(app.calls()).toEqual(before);
    expect(await app.handoffRepository.findOpenByConversationId(conversationId)).toEqual({ ...request, status: 'requested' });
    expect(app.conversations.get(conversationId)!.context).toEqual(context);
    expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled(); expect(app.confirm).not.toHaveBeenCalled();
  });

  it('reinício perde estado demonstrativo; reentrega e clique antigo não recriam negócios, e texto novo abre sessão vazia', async () => {
    const previous = application([...preparationScript(), new AIMessage('Recibo.'), handoffTurn()]);
    const published = await prepare(previous);
    await previous.click('old-book', published);
    await previous.text('old-handoff', 'Quero falar com alguém.');
    const receipt = previous.response('old-book');
    const conversationId = receipt.conversationId;
    expect(await previous.bookings()).toHaveLength(1);
    expect(await previous.leadRepository.findByConversationId(conversationId)).not.toBeNull();
    expect(await previous.handoffRepository.findOpenByConversationId(conversationId)).not.toBeNull();
    await previous.close();

    const fresh = application([dialogue(new AIMessage('Olá, como posso ajudar?')), catalogTurn()], journeyStart + 2_000);
    const oldEvents = [metaText({ id: `lead-${sender}`, text: { body: introduction } }),
      clickEvent('old-book', published), metaText({ id: 'old-handoff', text: { body: 'Quero falar com alguém.' } })];
    expect((await fresh.post(oldEvents)).statusCode).toBe(200); await fresh.drain();
    expect(fresh.sent).toEqual([]);
    for (const event of oldEvents) expect(fresh.inbox.get(inboxKey(event.id))).toBeUndefined();
    expect(fresh.bindings.get(identity())).toBeUndefined();
    expect(fresh.conversations.get(conversationId)).toBeUndefined();
    expect(fresh.outbox.get(inboxKey('old-book'))).toBeUndefined();
    const lost = await fresh.click('lost-button', published);
    expect(output(lost)).toContain('confirmação está indisponível'); expect(output(lost)).not.toContain(receipt.reply);
    expect(fresh.inbox.get(inboxKey('lost-button'))).toMatchObject({ state: 'ignored', code: 'SESSION_UNAVAILABLE' });
    expect(fresh.bindings.get(identity())).toBeUndefined();
    expect(output(await fresh.text('recover-lost', '/reenviar'))).toContain('Não há resposta recuperável');
    expect(fresh.bindings.get(identity())).toBeUndefined();
    expect(fresh.calls()).toEqual({ model: 0, context: 0, create: 0, update: 0, reserve: 0, handoff: 0, confirm: 0 });
    expect(await fresh.leadRepository.findByConversationId(conversationId)).toBeNull();
    expect(await fresh.handoffRepository.findOpenByConversationId(conversationId)).toBeNull(); expect(await fresh.bookings()).toEqual([]);

    const welcome = await fresh.text('new-session', 'Olá');
    const newId = fresh.response('new-session').conversationId;
    expect(newId).not.toBe(conversationId);
    expect(output(welcome)).toContain('registros anteriores não foram recuperados');
    expect(fresh.conversations.get(newId)!.context).toEqual(createConversationContext());
    expect(fresh.response('new-session')).toMatchObject({ results: [], pendingAction: null });
    expect(output(await fresh.click('lost-after-new-session', published))).toContain('revisar a prévia atual');
    expect(fresh.inbox.get(inboxKey('lost-after-new-session'))).toMatchObject({ state: 'failed', code: 'NOT_FOUND' });
    await fresh.text('catalog', 'Quais cursos vocês oferecem?');
    expect(fresh.response('catalog').results[0]?.tool).toBe('get_courses');
    expect(fresh.create).not.toHaveBeenCalled(); expect(fresh.reserve).not.toHaveBeenCalled(); expect(fresh.handoff).not.toHaveBeenCalled();
    expect(fresh.confirm).not.toHaveBeenCalled(); expect(await fresh.bookings()).toEqual([]);
  });

  it('preserva preços null/zero e horários vazios das fixtures apesar da prosa divergente', async () => {
    const app = application([courseTurn('espanhol'), query('get_available_slots', { courseId: 'course_spanish_conversation' }), courseTurn('francês')]);
    const missing = await app.text('spanish', 'Quero espanhol para viagem.');
    expect(app.response('spanish').results[0]).toMatchObject({ result: { ok: true, data: { course: { price: null } } } });
    expect(output(missing)).toContain('não informado'); expect(output(missing)).not.toContain('999'); expect(output(missing)).not.toContain('0,00');
    const empty = await app.text('no-slots', 'Há horários disponíveis?');
    expect(app.response('no-slots').results[0]).toMatchObject({ result: { ok: true, data: { slots: [] } } });
    expect(output(empty)).toContain('Não há horários disponíveis');
    const zero = await app.text('french', 'Quero francês para viagem.');
    expect(app.response('french').results[0]).toMatchObject({ result: { ok: true, data: { course: { price: { amountCents: 0, billingPeriod: 'course' } } } } });
    expect(output(zero)).toContain('0,00'); expect(output(zero)).not.toContain('999');
    expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled();
  });
});
