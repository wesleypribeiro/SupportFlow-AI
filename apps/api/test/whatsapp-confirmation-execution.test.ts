import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { languageSchoolChatResponseSchema, scheduleTrialClassResultSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import type { WhatsAppSendRequest, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { createJourneyModel, dialogue, leadTurn, scheduleTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaText } from './helpers/meta-webhook.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const sender = 'demo-recipient';
const otherSender = 'other-recipient';
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: sender };
const key = (messageId: string) => ({ ...identity, messageId });
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: `${sender},${otherSender}`,
};
const student = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' };
const introduction = 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.';
const correctedContact = { contact: { type: 'email' as const, value: 'ana.novo@example.com' } };
const slotA = { slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } };
const slotB = { slotReference: { slotId: 'slot_english_b', evidence: '12/06/2030 às 14h' } };
const kinds = ['create_lead', 'schedule_trial_class'] as const;
type Kind = typeof kinds[number];
type Publication = { request: WhatsAppSendRequest; messageId: string };
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

function application(script: JourneyScript) {
  const model = createJourneyModel(script);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const sent: Publication[] = [];
  const send = vi.fn<WhatsAppTransport['send']>(async (request) => {
    const messageId = `outbound-${sent.length + 1}`;
    sent.push({ request: structuredClone(request), messageId });
    return { status: 'accepted', messageId };
  });
  const app = createApplication(environment, { model, leadRepository, trialClassRepository, now, whatsappTransport: { send } });
  assert(app.whatsappInbox && app.whatsappBindings && app.whatsappConfirmationReferences);
  const inbox = app.whatsappInbox;
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  const message = vi.spyOn(app.conversationService, 'sendMessage');
  const current = vi.spyOn(app.conversationService, 'getCurrentPendingAction');
  const create = vi.spyOn(leadRepository, 'createForConversation');
  const update = vi.spyOn(leadRepository, 'updateForConversation');
  const reserve = vi.spyOn(trialClassRepository, 'reserveSlot');
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  async function post(messages: unknown[], origin = metaOrigin) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([], {
      entry: [{ id: origin.wabaId, changes: [metaChange({ messages, metadata: { phone_number_id: origin.phoneNumberId } })] }],
    })));
    return app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
  }
  async function deliver(event: unknown) {
    const start = sent.length;
    expect((await post([event])).statusCode).toBe(200);
    await inbox.drain();
    return sent.slice(start);
  }
  const text = (id: string, body: string, from = sender) => deliver(metaText({ id, from, text: { body } }));
  const click = (id: string, publication: Button, overrides: Record<string, unknown> = {}) => deliver(clickEvent(id, publication, overrides));
  function response(messageId: string) {
    const record = inbox.get(key(messageId)); assert(record?.state === 'processed');
    return languageSchoolChatResponseSchema.parse(record.response);
  }
  return { ...app, inbox, model, leadRepository, trialClassRepository, sent, send, confirm, message, current,
    create, update, reserve, post, deliver, text, click, response };
}
type App = ReturnType<typeof application>;
function button(publications: Publication[]) {
  const publication = publications.filter(({ request }) => request.message.type === 'reply_buttons').at(-1);
  assert(publication?.request.message.type === 'reply_buttons');
  const control = publication.request.message.buttons[0]; assert(control);
  return { ...publication, reference: control.id, title: control.title };
}
type Button = ReturnType<typeof button>;
function clickEvent(id: string, publication: Button, overrides: Record<string, unknown> = {}) {
  return metaButton({ id, from: publication.request.recipientId, context: { id: publication.messageId },
    interactive: { type: 'button_reply', button_reply: { id: publication.reference, title: publication.title } }, ...overrides });
}
function output(publications: Publication[]) { return publications.map(({ request }) => request.message.body).join('\n'); }
function scriptFor(kind: Kind): JourneyScript {
  return [leadTurn(student), ...(kind === 'schedule_trial_class' ? [scheduleTurn(slotA)] : [])];
}
async function prepare(app: App, kind: Kind, from = sender) {
  const leadButton = button(await app.text(`lead-${from}`, introduction, from));
  let publication = leadButton;
  let response = app.response(`lead-${from}`);
  if (kind === 'schedule_trial_class') {
    await app.click(`register-${from}`, leadButton);
    expect(app.response(`register-${from}`).results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } } });
    publication = button(await app.text(`trial-${from}`, 'Quero agendar 11/06/2030 às 10h.', from));
    response = app.response(`trial-${from}`);
  }
  assert(response.pendingAction?.kind === kind);
  return { ...response, pendingAction: response.pendingAction, publication, leadButton };
}
function calls(app: App) {
  return { model: app.model.calls.length, context: app.model.contextCalls.length, message: app.message.mock.calls.length,
    create: app.create.mock.calls.length, update: app.update.mock.calls.length, reserve: app.reserve.mock.calls.length };
}
async function bookings(app: App) {
  return Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida.'); }));
  vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(cleanups.splice(0).map((close) => close()));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('5.3 — clique WhatsApp e confirmação compartilhada', () => {
  it('resolve somente os dois IDs internos, cadastra sem reservar e salva o recibo antes de enviar; duplicata não reexecuta', async () => {
    const app = application(scriptFor('create_lead'));
    const prepared = await prepare(app, 'create_lead');
    const before = app.conversations.get(prepared.conversationId)!;
    const previousCalls = calls(app);
    const originalSend = app.send.getMockImplementation()!;
    app.send.mockImplementation(async (request) => {
      expect(app.response('confirm').results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } } });
      return originalSend(request);
    });
    // Título e extras Meta não mudam kind/args/IDs resolvidos pelo backend.
    const event = clickEvent('confirm', prepared.publication, {
      interactive: { type: 'button_reply', button_reply: { id: prepared.publication.reference, title: 'Confirmar aula' } },
      conversationId: 'foreign', actionId: 'foreign', kind: 'schedule_trial_class', confirmed: true,
    });
    app.current.mockClear();
    const sent = await app.deliver(event);
    const receipt = app.response('confirm');
    const lead = await app.leadRepository.findByConversationId(prepared.conversationId);
    expect(receipt).toMatchObject({ pendingAction: null, results: [{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead } } }] });
    expect(app.confirm).toHaveBeenCalledExactlyOnceWith({ conversationId: prepared.conversationId, actionId: prepared.pendingAction.actionId });
    expect(app.current).not.toHaveBeenCalled();
    expect(calls(app)).toEqual({ ...previousCalls, create: 1 });
    expect(app.conversations.get(prepared.conversationId)).toEqual({ ...before, context: { ...before.context, leadId: lead!.id } });
    expect(await bookings(app)).toEqual(slotFixtures.map(() => null));
    expect(output(sent)).toContain('Cadastro realizado');
    expect(app.inbox.get(key('confirm'))).not.toHaveProperty('presentationError');
    const after = calls(app); const sends = app.send.mock.calls.length;
    await app.deliver(event);
    expect(app.confirm).toHaveBeenCalledTimes(1); expect(app.send).toHaveBeenCalledTimes(sends);
    await app.click('retry', prepared.publication);
    expect(app.response('retry')).toEqual(receipt);
    expect(app.confirm).toHaveBeenCalledTimes(2); expect(calls(app)).toEqual(after);
    expect(app.current).not.toHaveBeenCalled();
  });

  it('cadastro updated preserva o ID; pedido idêntico e nova ação idêntica retornam existing sem gravar', async () => {
    const app = application([leadTurn(student), leadTurn(correctedContact), leadTurn(), dialogue()]);
    const first = await prepare(app, 'create_lead');
    await app.click('created', first.publication);
    const saved = await app.leadRepository.findByConversationId(first.conversationId); assert(saved);
    const corrected = button(await app.text('correction', 'Meu email correto é ana.novo@example.com.'));
    expect(await app.leadRepository.findByConversationId(first.conversationId)).toEqual(saved);
    await app.click('updated', corrected);
    const updated = { ...saved, ...correctedContact };
    expect(app.response('updated').results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'updated', lead: updated } } });
    await app.text('same', 'Pode cadastrar os mesmos dados.');
    expect(app.response('same')).toMatchObject({ pendingAction: null, results: [{ tool: 'create_lead', result: { ok: true, data: { outcome: 'existing', lead: updated } } }] });
    // Fixture interna de ação idêntica, como no teste do executor. O clique
    // continua usando referência realmente publicada e lifecycle/repository reais.
    const action = await app.prepareAction(first.conversationId, { kind: 'create_lead', preview: {
      name: updated.name, contact: updated.contact, courseId: updated.courseId, goal: updated.goal,
    } });
    const repeated = button(await app.text('preview', 'Mostre a prévia.'));
    const before = calls(app);
    await app.click('existing', repeated);
    expect(app.confirm).toHaveBeenLastCalledWith({ conversationId: first.conversationId, actionId: action.actionId });
    expect(app.response('existing').results).toEqual(app.response('same').results);
    expect(calls(app)).toEqual(before);
    await app.click('retry-existing', repeated);
    expect(app.response('retry-existing')).toEqual(app.response('existing'));
    expect(calls(app)).toEqual(before);
    expect(app.create).toHaveBeenCalledTimes(1); expect(app.update).toHaveBeenCalledTimes(1);
    expect(await app.leadRepository.findByConversationId(first.conversationId)).toEqual(updated);
    expect(await bookings(app)).toEqual(slotFixtures.map(() => null));
  });

  it('confirma aula como created, mantém cadastro separado e nova solicitação retorna existing sem reservar novamente', async () => {
    const app = application([...scriptFor('schedule_trial_class'), new AIMessage('Recibo oficial.'), scheduleTurn()]);
    const prepared = await prepare(app, 'schedule_trial_class');
    const before = app.conversations.get(prepared.conversationId);
    const registration = app.response(`register-${sender}`);
    const pending = prepared.pendingAction;
    await app.click('lead-again', prepared.leadButton);
    expect(app.response('lead-again')).toEqual({ ...registration, pendingAction: pending });
    expect(app.reserve).not.toHaveBeenCalled();
    const beforeBooking = calls(app);
    app.current.mockClear();
    const sent = await app.click('book', prepared.publication);
    const receipt = app.response('book');
    const result = scheduleTrialClassResultSchema.parse(receipt.results[0]!.result); assert(result.ok);
    expect(result.data).toEqual({ outcome: 'created', booking: await app.trialClassRepository.findConfirmedBySlotId('slot_english_a') });
    expect(receipt.pendingAction).toBeNull(); expect(app.current).not.toHaveBeenCalled();
    expect(app.confirm).toHaveBeenLastCalledWith({ conversationId: prepared.conversationId, actionId: pending.actionId });
    expect(app.reserve).toHaveBeenCalledExactlyOnceWith({ leadId: before!.context.leadId, slotId: 'slot_english_a' }, now());
    expect(calls(app)).toEqual({ ...beforeBooking, model: beforeBooking.model + 1, reserve: 1 });
    expect(app.model.calls.at(-1)!.messages.find((message) => message.name === 'official_receipt')?.text)
      .toBe(JSON.stringify(receipt.results));
    expect(app.model.calls.at(-1)!.options.tools).toBeUndefined();
    expect(app.conversations.get(prepared.conversationId)).toEqual(before);
    expect(output(sent)).toContain(result.data.booking.id); expect(output(sent)).toContain('11/06/2030 às 10:00');
    await app.text('same', 'Pode agendar o mesmo horário.');
    expect(app.response('same')).toMatchObject({ pendingAction: null, results: [{ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'existing', booking: result.data.booking } } }] });
    expect(app.reserve).toHaveBeenCalledTimes(1);
    const previousCalls = calls(app);
    await app.click('retry', prepared.publication);
    expect(app.response('retry')).toEqual(receipt); expect(calls(app)).toEqual(previousCalls);
  });

  it('clique retorna existing quando o mesmo lead já ocupou o slot após a prévia', async () => {
    const app = application([...scriptFor('schedule_trial_class'), new AIMessage('Recibo oficial.')]);
    const prepared = await prepare(app, 'schedule_trial_class');
    assert(prepared.pendingAction.kind === 'schedule_trial_class');
    const input = { leadId: prepared.pendingAction.preview.lead.id, slotId: 'slot_english_a' };
    // Estado real entre proposta e execução, sem simular o retorno do repository.
    const reserved = await app.trialClassRepository.reserveSlot(input, now()); assert(reserved.outcome === 'created');
    await app.click('existing', prepared.publication);
    expect(app.response('existing').results).toEqual([{ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'existing', booking: reserved.booking } } }]);
    const previousCalls = calls(app);
    await app.click('retry', prepared.publication);
    expect(app.response('retry')).toEqual(app.response('existing')); expect(calls(app)).toEqual(previousCalls);
    expect((await bookings(app)).filter(Boolean)).toEqual([reserved.booking]);
  });

  it.each(kinds.flatMap((kind) => [false, true].map((hasPending) => ({ kind, hasPending }))))(
    'recupera created de $kind após revisão e lead novos, com pending atual = $hasPending', async ({ kind, hasPending }) => {
      const app = application([...scriptFor(kind), ...(kind === 'schedule_trial_class' ? [new AIMessage('Recibo original.')] : []),
        leadTurn(correctedContact), ...(hasPending ? [leadTurn({ goal: 'entrevistas' })] : [])]);
      const prepared = await prepare(app, kind);
      await app.click('original', prepared.publication);
      const original = app.response('original');
      const revision = app.conversations.get(prepared.conversationId)!.context.revision;
      const corrected = button(await app.text('correction', 'Meu email correto é ana.novo@example.com.'));
      await app.click('update', corrected);
      expect(app.response('update').results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'updated' } } });
      if (hasPending) await app.text('next', 'Meu objetivo agora é entrevistas.');
      const pending = hasPending ? app.response('next').pendingAction : null;
      expect(app.conversations.get(prepared.conversationId)!.context.revision).toBeGreaterThan(revision);
      const conversation = app.conversations.get(prepared.conversationId);
      const lead = await app.leadRepository.findByConversationId(prepared.conversationId);
      const storedBookings = await bookings(app);
      const previousCalls = calls(app);
      const readLead = vi.spyOn(app.leadRepository, 'findByConversationId');
      const readSlot = vi.spyOn(app.trialClassRepository, 'findSlotById');
      app.current.mockClear();
      await app.click('retry', prepared.publication);
      expect(app.response('retry')).toEqual({ ...original, pendingAction: pending });
      expect(calls(app)).toEqual(previousCalls);
      expect(readLead).not.toHaveBeenCalled(); expect(readSlot).not.toHaveBeenCalled();
      if (!hasPending) expect(app.current).not.toHaveBeenCalled();
      expect(app.conversations.get(prepared.conversationId)).toEqual(conversation);
      expect(await app.leadRepository.findByConversationId(prepared.conversationId)).toEqual(lead);
      expect(await bookings(app)).toEqual(storedBookings);
      expect(await app.conversationService.getCurrentPendingAction({ conversationId: prepared.conversationId }))
        .toEqual({ ok: true, response: { pendingAction: pending } });
    });

  it('duas conversas disputam uma vaga atomicamente; SLOT_UNAVAILABLE fica histórico com outra ação pendente ou sem prévia', async () => {
    const app = application([...scriptFor('schedule_trial_class'), ...scriptFor('schedule_trial_class'),
      new AIMessage('Recibo oficial.'), new AIMessage('Recibo oficial.'), scheduleTurn(slotB),
      dialogue(new AIMessage('Objetivo atualizado.'), { goal: 'entrevistas' })]);
    const first = await prepare(app, 'schedule_trial_class');
    const second = await prepare(app, 'schedule_trial_class', otherSender);
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(app.conversations.get(first.conversationId)!.context.leadId)
      .not.toBe(app.conversations.get(second.conversationId)!.context.leadId);
    const ready = gate(); const proceed = gate();
    const reserve = InMemoryTrialClassRepository.prototype.reserveSlot.bind(app.trialClassRepository);
    app.reserve.mockImplementation(async (...args) => {
      if (app.reserve.mock.calls.length === 2) ready.release();
      await proceed.promise;
      return reserve(...args);
    });
    expect((await app.post([clickEvent('first', first.publication), clickEvent('second', second.publication)])).statusCode).toBe(200);
    await ready.promise;
    expect(app.inbox.get(key('first'))?.state).toBe('processing');
    expect(app.inbox.get(key('second'))?.state).toBe('processing');
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    proceed.release(); await app.inbox.drain();
    const contenders = [first, second];
    const receipts = [app.response('first'), app.response('second')];
    const results = receipts.map((receipt) => scheduleTrialClassResultSchema.parse(receipt.results[0]!.result));
    expect(results.map((result) => result.ok ? result.data.outcome : result.error.code).sort()).toEqual(['SLOT_UNAVAILABLE', 'created']);
    const winner = results.findIndex((result) => result.ok);
    const loser = 1 - winner;
    const unavailable = contenders[loser]!;
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    expect(booking.leadId).toBe(app.conversations.get(contenders[winner]!.conversationId)!.context.leadId);
    expect((await bookings(app)).filter(Boolean)).toEqual([booking]);
    const previousCalls = calls(app);
    for (let index = 0; index < contenders.length; index++) {
      await app.click(`retry-${index}`, contenders[index]!.publication);
      expect(app.response(`retry-${index}`)).toEqual(receipts[index]);
    }
    expect(calls(app)).toEqual(previousCalls);
    const from = unavailable.publication.request.recipientId;
    await app.text('next-slot', 'Agora escolho 12/06/2030 às 14h.', from);
    const next = app.response('next-slot').pendingAction; assert(next?.kind === 'schedule_trial_class');
    const afterCorrection = calls(app);
    await app.click('conflict-with-pending', unavailable.publication);
    expect(app.response('conflict-with-pending')).toEqual({ ...receipts[loser], pendingAction: next });
    expect(calls(app)).toEqual(afterCorrection);
    await app.text('new-revision', 'Meu objetivo agora é entrevistas.', from);
    expect(app.response('new-revision').pendingAction).toBeNull();
    const afterRevision = calls(app); app.current.mockClear();
    await app.click('conflict-without-pending', unavailable.publication);
    expect(app.response('conflict-without-pending')).toEqual(receipts[loser]);
    expect(calls(app)).toEqual(afterRevision); expect(app.current).not.toHaveBeenCalled();
    expect(app.reserve).toHaveBeenCalledTimes(2);
    expect((await bookings(app)).filter(Boolean)).toEqual([booking]);
    expect(app.inbox.activeQueueCount).toBe(0);
  });

  it.each(kinds)('recusa referências estrangeiras/manipuladas de %s antes do serviço e não vaza dados', async (kind) => {
    const app = application([...scriptFor(kind), dialogue(), ...(kind === 'schedule_trial_class' ? [new AIMessage('Recibo oficial.')] : [])]);
    const prepared = await prepare(app, kind);
    await app.text('other', 'Olá!', otherSender);
    const own = app.conversations.get(prepared.conversationId);
    const foreignId = app.whatsappBindings!.get({ ...identity, senderId: otherSender })!.conversationId;
    const foreign = app.conversations.get(foreignId);
    const previousCalls = calls(app); app.confirm.mockClear();
    for (const [label, overrides] of [
      ['sender', { from: otherSender }],
      ['message', { context: { id: 'unrelated-outbound' } }],
      ['reference', { interactive: { type: 'button_reply', button_reply: { id: `${prepared.publication.reference}x`, title: 'Confirmar' } } }],
    ] as const) {
      const sent = await app.click(label, prepared.publication, overrides);
      expect(app.inbox.get(key(label))).toMatchObject({ state: 'failed', code: 'NOT_FOUND' });
      expect(output(sent)).toContain('revisar a prévia atual');
      for (const value of ['Ana', 'ana@example.com', prepared.conversationId, prepared.pendingAction.actionId, prepared.publication.reference]) {
        expect(output(sent)).not.toContain(value);
      }
      expect(sent.every(({ request }) => request.recipientId === ('from' in overrides ? overrides.from : sender))).toBe(true);
    }
    for (const origin of [{ ...metaOrigin, wabaId: 'foreign-account' }, { ...metaOrigin, phoneNumberId: 'foreign-number' }]) {
      expect((await app.post([clickEvent('foreign-origin', prepared.publication)], origin)).statusCode).toBe(403);
      expect(app.inbox.get(key('foreign-origin'))).toBeUndefined();
    }
    expect(app.confirm).not.toHaveBeenCalled(); expect(calls(app)).toEqual(previousCalls);
    expect(app.conversations.get(prepared.conversationId)).toEqual(own);
    expect(app.conversations.get(foreignId)).toEqual(foreign);
    expect(await app.leadRepository.findByConversationId(foreignId)).toBeNull();
    expect(await bookings(app)).toEqual(slotFixtures.map(() => null));
    await app.click('valid', prepared.publication);
    expect(app.confirm).toHaveBeenCalledExactlyOnceWith({ conversationId: prepared.conversationId, actionId: prepared.pendingAction.actionId });
    expect(app.response('valid').results[0]).toMatchObject({ tool: kind, result: { ok: true, data: { outcome: 'created' } } });
    const afterConfirmation = calls(app);
    const rejectedReceipt = await app.click('foreign-receipt', prepared.publication, { from: otherSender });
    expect(app.inbox.get(key('foreign-receipt'))).toMatchObject({ state: 'failed', code: 'NOT_FOUND' });
    expect(output(rejectedReceipt)).not.toContain('ana@example.com');
    expect(app.confirm).toHaveBeenCalledTimes(1); expect(calls(app)).toEqual(afterConfirmation);
  });

  it.each(kinds)('correção admitida antes do clique de %s produz ACTION_STALE sem executar a ação antiga', async (kind) => {
    const app = application([...scriptFor(kind), leadTurn(correctedContact)]);
    const prepared = await prepare(app, kind);
    const previousCalls = calls(app); app.confirm.mockClear();
    expect((await app.post([
      metaText({ id: 'correction', text: { body: 'Meu email correto é ana.novo@example.com.' } }),
      clickEvent('stale', prepared.publication),
    ])).statusCode).toBe(200);
    await app.inbox.drain();
    expect(app.inbox.get(key('stale'))).toMatchObject({ state: 'failed', code: 'ACTION_STALE' });
    expect(app.confirm).toHaveBeenCalledExactlyOnceWith({ conversationId: prepared.conversationId, actionId: prepared.pendingAction.actionId });
    expect(output(app.sent.slice(-1))).toContain('revisar a prévia atual');
    expect(app.response('correction').pendingAction?.actionId).not.toBe(prepared.pendingAction.actionId);
    expect(calls(app)).toEqual({ ...previousCalls, model: previousCalls.model + 2, context: previousCalls.context + 1, message: previousCalls.message + 1 });
    expect(app.inbox.activeQueueCount).toBe(0);
    expect(await bookings(app)).toEqual(slotFixtures.map(() => null));
  });

  it.each(['rejected', 'unknown'] as const)('envio do recibo %s preserva a reserva; novo clique recupera o mesmo resultado sem modelo ou escrita', async (status) => {
    const app = application([...scriptFor('schedule_trial_class'), new Error('PRIVATE_DRAFT_FAILURE')]);
    const prepared = await prepare(app, 'schedule_trial_class');
    const originalSend = app.send.getMockImplementation()!;
    app.send.mockImplementationOnce(async () => {
      expect(app.response('confirmed').results[0]).toMatchObject({ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created' } } });
      return status === 'unknown' ? { status, reason: 'timeout' } : { status, reason: 'provider_rejection' };
    });
    await app.click('confirmed', prepared.publication);
    const receipt = app.response('confirmed');
    expect(receipt.reply).toContain('agenda de demonstração'); expect(receipt.reply).not.toContain('PRIVATE');
    expect(app.inbox.get(key('confirmed'))).toMatchObject({ state: 'processed', presentationError: 'PRESENTATION_ERROR' });
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    const previousCalls = calls(app);
    app.send.mockImplementation(originalSend);
    const sent = await app.click('retry', prepared.publication);
    expect(app.response('retry')).toEqual(receipt); expect(calls(app)).toEqual(previousCalls);
    expect(output(sent)).toContain(booking.id);
    expect(app.reserve).toHaveBeenCalledTimes(1);
    expect((await bookings(app)).filter(Boolean)).toEqual([booking]);
  });
});
