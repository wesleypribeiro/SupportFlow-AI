import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import type { WhatsAppEvent } from '../src/channels/whatsapp/events.js';
import { WHATSAPP_STATUS_BUFFER_LIMIT, WHATSAPP_STATUS_BUFFER_TTL_MS } from '../src/channels/whatsapp/outbox.js';
import type { WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { handoffOffer } from '../src/modules/language-school/domain/handoff-intent.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { createJourneyModel, dialogue, handoffTurn, leadTurn, query, scheduleTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const sender = 'demo-recipient';
const otherSender = 'other-recipient';
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: sender };
const key = (messageId: string) => ({ ...identity, messageId });
const instant = new Date('2030-06-10T12:00:00Z').getTime();
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: `${sender},${otherSender}`,
};
const student = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' };
const introduction = 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.';
const slotA = { slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } };
type Publication = { request: WhatsAppSendRequest; messageId: string };
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

function application(script: JourneyScript, maxMessages = 10_000) {
  let clock = instant;
  const model = createJourneyModel(script);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const handoffRepository = new InMemoryHandoffRepository();
  const sent: Publication[] = [];
  const resultFor = vi.fn<(publication: Publication) => Promise<WhatsAppSendResult>>(async ({ messageId }) => ({ status: 'accepted', messageId }));
  const send = vi.fn<WhatsAppTransport['send']>(async (request) => {
    const publication = { request: structuredClone(request), messageId: `outbound-${sent.length + 1}` };
    sent.push(publication);
    return resultFor(publication);
  });
  const app = createApplication(environment, { model, leadRepository, trialClassRepository, handoffRepository,
    now: () => new Date(instant), whatsappNow: () => new Date(clock), whatsappTransport: { send }, whatsappInboxLimits: { maxMessages } });
  assert(app.whatsappInbox && app.whatsappOutbox && app.whatsappBindings);
  const inbox = app.whatsappInbox;
  const outbox = app.whatsappOutbox;
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  const message = vi.spyOn(app.conversationService, 'sendMessage');
  const create = vi.spyOn(leadRepository, 'createForConversation');
  const reserve = vi.spyOn(trialClassRepository, 'reserveSlot');
  const handoff = vi.spyOn(handoffRepository, 'requestForConversation');
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  async function post(messages: unknown[] = [], statuses: unknown[] = [], statusCode = 200) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages, statuses })])));
    const response = await app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
    expect(response.statusCode).toBe(statusCode);
  }
  async function deliver(event: unknown) {
    const start = sent.length;
    await post([event]); await inbox.drain();
    return sent.slice(start);
  }
  const text = (id: string, body: string, extras: Record<string, unknown> = {}) => deliver(metaText({ id, text: { body }, ...extras }));
  const status = (publication: Publication, value: string, extras: Record<string, unknown> = {}) =>
    post([], [metaStatus({ id: publication.messageId, recipient_id: publication.request.recipientId, status: value, ...extras })]);
  function response(messageId: string) {
    const record = inbox.get(key(messageId)); assert(record?.state === 'processed');
    return record.response;
  }
  return { ...app, inbox, outbox, model, leadRepository, trialClassRepository, handoffRepository, sent, send, resultFor,
    confirm, message, create, reserve, handoff, post, deliver, text, status, response, advance: (ms: number) => { clock += ms; } };
}
type App = ReturnType<typeof application>;
function calls(app: App) {
  return { model: app.model.calls.length, context: app.model.contextCalls.length, message: app.message.mock.calls.length,
    confirm: app.confirm.mock.calls.length, create: app.create.mock.calls.length,
    reserve: app.reserve.mock.calls.length, handoff: app.handoff.mock.calls.length, send: app.send.mock.calls.length };
}
function last(publications: Publication[]) { const publication = publications.at(-1); assert(publication); return publication; }
function click(id: string, publication: Publication) {
  assert(publication.request.message.type === 'reply_buttons');
  return metaButton({ id, context: { id: publication.messageId }, interactive: {
    type: 'button_reply', button_reply: { id: publication.request.message.buttons[0]!.id, title: 'Decorativo' },
  } });
}
const offerTurn = () => dialogue(new AIMessage(handoffOffer));

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

describe('6.2 — status correlacionado sem efeito comercial', () => {
  it('status isolado não abre conversa nem chama modelo ou transporte', async () => {
    const app = application([]);
    const before = calls(app);
    await app.post([], ['sent', 'delivered', 'read', 'failed'].map((status) => metaStatus({ status })));
    expect(app.whatsappBindings!.get(identity)).toBeUndefined();
    expect(app.outbox.bufferedStatusCount).toBe(0); expect(calls(app)).toEqual(before);
  });

  it('accepted não comprova entrega; sent/delivered/read preservam evidências sem regressão nem novos turnos', async () => {
    const app = application([offerTurn()]);
    const publication = last(await app.text('offer', 'Tenho uma dúvida.'));
    expect(app.outbox.get(key('offer'))?.parts[0]).toMatchObject({ state: 'accepted', deliveries: [{ messageId: publication.messageId, evidence: {} }] });
    const before = calls(app);
    const conversation = app.conversations.get(app.response('offer').conversationId);
    for (const state of ['sent', 'delivered', 'read']) {
      await app.status(publication, state);
      expect(app.outbox.get(key('offer'))?.parts[0]?.state).toBe(state);
    }
    const snapshot = app.outbox.get(key('offer'));
    for (const state of ['sent', 'delivered', 'read', 'read']) await app.status(publication, state, { timestamp: '1907323202' });
    expect(app.outbox.get(key('offer'))).toEqual(snapshot);
    await app.status(publication, 'failed');
    expect(app.outbox.get(key('offer'))?.parts[0]).toMatchObject({ state: 'read', deliveries: [{ evidence: {
      sent: instant + 1_000, delivered: instant + 1_000, read: instant + 1_000, failed: instant + 1_000,
    } }] });
    expect(calls(app)).toEqual(before);
    expect(app.conversations.get(conversation!.id)).toEqual(conversation);
    expect(app.inbox.get(key(publication.messageId))).toBeUndefined();
    snapshot!.parts[0]!.deliveries![0]!.evidence.read = 0;
    expect(app.outbox.get(key('offer'))?.parts[0]?.deliveries?.[0]?.evidence.read).toBe(instant + 1_000);
  });

  it.each(['delivered', 'read'])('%s antes de sent/failed conserva entrega e não reenvia a parte', async (state) => {
    const app = application([offerTurn()]);
    const publication = last(await app.text('offer', 'Olá'));
    await app.status(publication, state);
    await app.status(publication, 'failed'); await app.status(publication, 'sent');
    expect(app.outbox.get(key('offer'))?.parts[0]?.state).toBe(state);
    expect(last(await app.text('retry', '/reenviar')).request.message.body).toContain('Não há resposta recuperável');
    expect(app.sent.filter(({ request }) => request.message.body === handoffOffer)).toHaveLength(1);
  });

  it('ignora ID/destinatário desconhecido ou de outra conversa; status sem destinatário usa vínculo conhecido', async () => {
    const app = application([offerTurn(), dialogue()]);
    const publication = last(await app.text('offer', 'Olá'));
    await app.text('other', 'Olá', { from: otherSender });
    const snapshot = app.outbox.get(key('offer'));
    const before = calls(app);
    for (const recipient_id of ['unknown-recipient', otherSender]) await app.status(publication, 'read', { recipient_id });
    await app.status(publication, 'read', { id: 'unknown-message' });
    // Fronteira normalizada também isola conta e número, além do preflight HTTP.
    const event: Extract<WhatsAppEvent, { type: 'status' }> = {
      ...identity, type: 'status', messageId: publication.messageId, status: 'read', occurredAt: instant,
    };
    app.outbox.receiveStatus({ ...event, accountId: 'foreign-account' });
    app.outbox.receiveStatus({ ...event, phoneNumberId: 'foreign-number' });
    expect(app.outbox.get(key('offer'))).toEqual(snapshot);
    expect(app.outbox.bufferedStatusCount).toBe(0);
    expect(app.whatsappBindings!.get({ ...identity, senderId: 'unknown-recipient' })).toBeUndefined();
    await app.status(publication, 'delivered', { recipient_id: undefined });
    expect(app.outbox.get(key('offer'))?.parts[0]?.state).toBe('delivered');
    expect(calls(app)).toEqual(before);
  });

  it.each(['sent', 'delivered', 'read', 'failed'])('concilia %s anterior ao HTTP somente após aceite do mesmo envio', async (state) => {
    const app = application([offerTurn()]);
    const sending = gate(); const release = gate();
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body === handoffOffer) { sending.release(); await release.promise; }
      return { status: 'accepted', messageId };
    });
    await app.post([metaText({ id: 'offer' })]); await sending.promise;
    const publication = last(app.sent);
    await app.status(publication, state);
    expect(app.outbox.get(key('offer'))?.parts[0]).toMatchObject({ state: 'sending' });
    expect(app.outbox.bufferedStatusCount).toBe(1);
    const before = calls(app);
    await app.status(publication, state);
    expect(app.outbox.bufferedStatusCount).toBe(1);
    release.release(); await app.inbox.drain();
    expect(app.outbox.get(key('offer'))?.parts[0]).toMatchObject({ state, deliveries: [{ evidence: { [state]: instant + 1_000 } }] });
    expect(app.outbox.bufferedStatusCount).toBe(0); expect(calls(app)).toEqual(before);
    expect(app.outbox.activeQueueCount).toBe(0);
  });

  it.each(['unknown', 'rejected', 'different_id', 'foreign_recipient'])('status antecipado não inventa vínculo quando retorno/destinatário é %s', async (mode) => {
    const app = application([offerTurn(), handoffTurn()]);
    const sending = gate(); const release = gate();
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body !== handoffOffer) return { status: 'accepted', messageId };
      sending.release(); await release.promise;
      if (mode === 'unknown') return { status: 'unknown', reason: 'timeout' };
      if (mode === 'rejected') return { status: 'rejected', reason: 'provider_rejection' };
      return { status: 'accepted', messageId: mode === 'different_id' ? 'different-message' : messageId };
    });
    await app.post([metaText({ id: 'offer' })]); await sending.promise;
    const publication = last(app.sent);
    await app.status(publication, 'read', mode === 'foreign_recipient' ? { recipient_id: otherSender } : {});
    release.release(); await app.inbox.drain();
    expect(app.outbox.bufferedStatusCount).toBe(0);
    expect(app.outbox.get(key('offer'))?.parts[0]?.state).not.toBe('read');
    await app.text('yes', 'Sim', mode === 'foreign_recipient' ? {} : { context: { id: publication.messageId } });
    expect(app.handoff).not.toHaveBeenCalled();
    expect(app.response('yes').results[0]?.result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('status em buffer de outro destinatário em envio concorrente não é atribuído pelo ID sozinho', async () => {
    const app = application([offerTurn(), offerTurn()]);
    const sendingA = gate(); const sendingB = gate(); const release = gate();
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body === handoffOffer) {
        (request.recipientId === sender ? sendingA : sendingB).release(); await release.promise;
      }
      return { status: 'accepted', messageId };
    });
    await app.post([metaText({ id: 'a' })]); await sendingA.promise;
    const publicationA = last(app.sent);
    await app.post([metaText({ id: 'b', from: otherSender })]); await sendingB.promise;
    const publicationB = last(app.sent);
    await app.status(publicationA, 'read', { recipient_id: otherSender });
    await app.status(publicationB, 'delivered');
    expect(app.outbox.bufferedStatusCount).toBe(2);
    release.release(); await app.inbox.drain();
    expect(app.outbox.get(key('a'))?.parts[0]?.state).toBe('accepted');
    expect(app.outbox.get(key('b'))?.parts[0]?.state).toBe('delivered');
    expect(app.outbox.bufferedStatusCount).toBe(0);
  });

  it('ID de envio reutilizado para outro destinatário não substitui o vínculo original', async () => {
    const app = application([offerTurn(), offerTurn()]);
    const first = last(await app.text('first', 'Olá'));
    app.resultFor.mockImplementation(async () => ({ status: 'accepted', messageId: first.messageId }));
    await app.text('other', 'Olá', { from: otherSender });
    expect(app.outbox.get(key('other'))?.parts[0]).toMatchObject({ state: 'unknown', result: { reason: 'invalid_response' } });
    await app.status(first, 'read', { recipient_id: otherSender });
    expect(app.outbox.get(key('first'))?.parts[0]?.state).toBe('accepted');
    await app.status(first, 'read');
    expect(app.outbox.get(key('first'))?.parts[0]?.state).toBe('read');
    expect(app.outbox.get(key('other'))?.parts[0]?.state).toBe('unknown');
  });

  it.each([WHATSAPP_STATUS_BUFFER_TTL_MS - 1, WHATSAPP_STATUS_BUFFER_TTL_MS])('buffer expira pelo clock local no limite (%i ms), sem renovar TTL em duplicata', async (elapsed) => {
    const app = application([offerTurn()]);
    const sending = gate(); const release = gate();
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body === handoffOffer) { sending.release(); await release.promise; }
      return { status: 'accepted', messageId };
    });
    await app.post([metaText({ id: 'offer' })]); await sending.promise;
    const publication = last(app.sent);
    await app.status(publication, 'read');
    app.advance(elapsed - 1); await app.status(publication, 'read'); app.advance(1);
    release.release(); await app.inbox.drain();
    expect(app.outbox.get(key('offer'))?.parts[0]?.state).toBe(elapsed < WHATSAPP_STATUS_BUFFER_TTL_MS ? 'read' : 'accepted');
    expect(app.outbox.bufferedStatusCount).toBe(0);
  });

  it('buffer limitado preserva evidência admitida, libera órfãos e não impede status de envio conhecido', async () => {
    const app = application([dialogue(), offerTurn()]);
    const known = last(await app.text('known', 'Olá'));
    const sending = gate(); const release = gate();
    app.resultFor.mockImplementation(async ({ messageId }) => { sending.release(); await release.promise; return { status: 'accepted', messageId }; });
    await app.post([metaText({ id: 'offer' })]); await sending.promise;
    const pending = last(app.sent);
    await app.status(pending, 'read');
    await app.post([], Array.from({ length: WHATSAPP_STATUS_BUFFER_LIMIT + 10 }, (_, i) => metaStatus({ id: `unlinked-${i}` })));
    expect(app.outbox.bufferedStatusCount).toBe(WHATSAPP_STATUS_BUFFER_LIMIT);
    await app.status(known, 'read');
    expect(app.outbox.get(key('known'))?.parts[0]?.state).toBe('read');
    release.release(); await app.inbox.drain();
    expect(app.outbox.get(key('offer'))?.parts[0]?.state).toBe('read');
    expect(app.outbox.bufferedStatusCount).toBe(0);
  });

  it('inbox cheia continua reconhecendo status e duplicatas sem abrir conversa', async () => {
    const app = application([offerTurn()], 1);
    const publication = last(await app.text('offer', 'Olá'));
    await app.post([metaText({ id: 'new', from: otherSender })], [], 503);
    await app.status(publication, 'read');
    const before = calls(app);
    await app.text('offer', 'Olá');
    expect(app.outbox.get(key('offer'))?.parts[0]?.state).toBe('read');
    expect(app.whatsappBindings!.get({ ...identity, senderId: otherSender })).toBeUndefined();
    expect(calls(app)).toEqual(before);
  });

  it('failed após reserva preserva booking/recibo e /reenviar recupera somente transporte; falha antiga não contamina novo aceite', async () => {
    const app = application([leadTurn(student), scheduleTurn(slotA), new AIMessage('Reserva registrada.')]);
    const lead = last(await app.text('lead', introduction));
    await app.deliver(click('register', lead));
    const trial = last(await app.text('trial', 'Quero agendar 11/06/2030 às 10h.'));
    const publication = last(await app.deliver(click('book', trial)));
    const receipt = app.response('book');
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    const conversation = app.conversations.get(receipt.conversationId);
    const before = calls(app);
    await app.status(publication, 'failed'); await app.status(publication, 'sent');
    expect(app.outbox.get(key('book'))?.parts[0]?.state).toBe('failed');
    expect(calls(app)).toEqual(before);
    const retry = last(await app.text('recover', '/reenviar'));
    expect(retry.request).toEqual(publication.request);
    expect(app.outbox.get(key('book'))?.parts[0]?.state).toBe('accepted');
    await app.status(publication, 'failed');
    expect(app.outbox.get(key('book'))?.parts[0]?.state).toBe('accepted');
    await app.status(publication, 'delivered'); await app.status(retry, 'failed');
    expect(app.outbox.get(key('book'))?.parts[0]?.state).toBe('delivered');
    expect(calls(app)).toEqual({ ...before, send: before.send + 1 });
    expect(app.response('book')).toEqual(receipt);
    expect(app.conversations.get(receipt.conversationId)).toEqual(conversation);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toEqual(booking);
    expect(app.reserve).toHaveBeenCalledTimes(1);
  });
});

describe('6.2 — evidência de apresentação para aceitação de handoff', () => {
  it('oferta entregue aceita handoff preservando ação pendente e revisão, sem autorização de cadastro', async () => {
    const app = application([dialogue(new AIMessage(handoffOffer), student), handoffTurn()]);
    const offer = last(await app.text('offer', introduction));
    const conversationId = app.response('offer').conversationId;
    const context = app.conversations.get(conversationId)!.context;
    const prepared = await app.prepareLead(conversationId, {
      name: student.name, contact: student.contact, courseId: context.courseId, goal: student.goal,
    });
    assert(prepared.pendingAction);
    await app.status(offer, 'delivered');
    await app.text('yes', 'Sim');
    expect(app.handoff).toHaveBeenCalledTimes(1);
    expect(app.response('yes').pendingAction).toEqual(prepared.pendingAction);
    expect(app.conversations.get(conversationId)!.context).toEqual(context);
    expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled(); expect(app.confirm).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'read', 'reply'])('aceita oferta com %s, sem cadastrar/reservar; status do protocolo preserva requested', async (evidence) => {
    const app = application([offerTurn(), handoffTurn()]);
    const offer = last(await app.text('offer', 'Tenho uma dúvida.'));
    const conversationId = app.response('offer').conversationId;
    const context = app.conversations.get(conversationId)!.context;
    if (evidence !== 'reply') await app.status(offer, evidence);
    const protocol = last(await app.text('yes', 'Sim, por favor.', evidence === 'reply' ? { context: { id: offer.messageId } } : {}));
    expect(app.message.mock.calls.at(-1)?.[1]).toEqual({ previousPresentation: handoffOffer });
    const request = await app.handoffRepository.findOpenByConversationId(conversationId); assert(request);
    expect(app.response('yes').results[0]?.result).toMatchObject({ ok: true, data: { request } });
    expect(protocol.request.message.body).toContain(request.id);
    expect(protocol.request.message.body).toContain('não inicia atendimento humano ao vivo');
    if (evidence === 'reply') {
      expect(app.outbox.get(key('offer'))?.parts[0]).toMatchObject({ state: 'accepted', deliveries: [{ evidence: {} }] });
    }
    const before = calls(app);
    for (const state of ['failed', 'delivered', 'read', 'failed']) await app.status(protocol, state);
    expect(await app.handoffRepository.findOpenByConversationId(conversationId)).toEqual({ ...request, status: 'requested' });
    expect(calls(app)).toEqual(before);
    expect(app.conversations.get(conversationId)!.context).toEqual(context);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'sent', 'failed', 'unknown', 'rejected', 'omitted'])('rejeita sim para oferta %s sem evidência, preservando pedido explícito independente', async (mode) => {
    const app = application([mode === 'omitted' ? query('get_courses', {}, {}, new AIMessage(handoffOffer)) : offerTurn(), handoffTurn(), handoffTurn()]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body === handoffOffer && mode === 'unknown') return { status: 'unknown', reason: 'timeout' };
      if (request.message.body === handoffOffer && mode === 'rejected') return { status: 'rejected', reason: 'provider_rejection' };
      return { status: 'accepted', messageId };
    });
    const offer = last(await app.text('offer', 'Tenho uma dúvida.'));
    const conversationId = app.response('offer').conversationId;
    expect(app.response('offer').reply).toBe(handoffOffer);
    if (mode === 'sent' || mode === 'failed') await app.status(offer, mode);
    if (mode === 'omitted') {
      expect(offer.request.message.body).not.toContain(handoffOffer);
      await app.status(offer, 'read');
    }
    await app.text('yes', 'Sim', { previousPresentation: handoffOffer,
      context: { id: mode === 'omitted' ? offer.messageId : 'invented-id', previousPresentation: handoffOffer } });
    expect(app.response('yes').results[0]?.result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(app.handoff).not.toHaveBeenCalled();
    expect(await app.handoffRepository.findOpenByConversationId(conversationId)).toBeNull();
    await app.text('explicit', 'Quero falar com alguém.');
    expect(app.response('explicit').results[0]?.result.ok).toBe(true);
    expect(app.handoff).toHaveBeenCalledTimes(1);
    expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled(); expect(app.confirm).not.toHaveBeenCalled();
  });

  it('context.id de oferta aceita de outro remetente não autoriza handoff nem substitui texto confiável', async () => {
    const app = application([offerTurn(), dialogue(), handoffTurn()]);
    const offer = last(await app.text('offer', 'Olá'));
    await app.status(offer, 'read');
    await app.text('other', 'Olá', { from: otherSender });
    await app.text('yes', 'Sim', { from: otherSender, context: { id: offer.messageId }, previousPresentation: handoffOffer });
    expect(app.handoff).not.toHaveBeenCalled();
    expect(app.message.mock.calls.at(-1)?.[1]).toEqual({ previousPresentation: null });
  });

  it('resposta posterior sem oferta impede usar oferta antiga, mesmo entregue e referenciada', async () => {
    const app = application([offerTurn(), dialogue(new AIMessage('Qual curso você deseja?')), handoffTurn()]);
    const offer = last(await app.text('offer', 'Olá'));
    await app.status(offer, 'read');
    const next = last(await app.text('next', 'Vamos falar dos cursos.'));
    await app.status(next, 'delivered');
    await app.text('yes', 'Sim', { context: { id: offer.messageId } });
    expect(app.message.mock.calls.at(-1)?.[1]).toEqual({ previousPresentation: next.request.message.body });
    expect(app.handoff).not.toHaveBeenCalled();
  });

  it('oferta omitida por prévia, ainda que lida, não confirma ação; pedido explícito preserva pending e revisão', async () => {
    const app = application([leadTurn(student), offerTurn(), handoffTurn(), handoffTurn()]);
    await app.text('lead', introduction);
    const preview = app.response('lead').pendingAction;
    const offer = last(await app.text('offer', 'Tenho uma dúvida.'));
    const conversationId = app.response('offer').conversationId;
    const context = app.conversations.get(conversationId)!.context;
    expect(offer.request.message.type).toBe('reply_buttons');
    expect(offer.request.message.body).not.toContain(handoffOffer);
    await app.status(offer, 'read');
    await app.text('yes', 'Sim', { context: { id: offer.messageId } });
    expect(app.handoff).not.toHaveBeenCalled();
    await app.text('explicit', 'Quero falar com alguém.');
    expect(app.handoff).toHaveBeenCalledTimes(1);
    expect(app.response('explicit').pendingAction).toEqual(preview);
    expect(app.conversations.get(conversationId)!.context).toEqual(context);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled();
  });
});
