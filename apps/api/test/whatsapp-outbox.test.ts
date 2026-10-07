import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import type { WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { splitWhatsAppText } from '../src/channels/whatsapp/presentation.js';
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
const correction = { contact: { type: 'email' as const, value: 'ana.novo@example.com' } };
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

function application(script: JourneyScript) {
  const model = createJourneyModel(script);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const sent: Publication[] = [];
  const resultFor = vi.fn<(publication: Publication) => Promise<WhatsAppSendResult>>(async ({ messageId }) => ({ status: 'accepted', messageId }));
  const send = vi.fn<WhatsAppTransport['send']>(async (request) => {
    const publication = { request: structuredClone(request), messageId: `outbound-${sent.length + 1}` };
    sent.push(publication);
    return resultFor(publication);
  });
  const app = createApplication(environment, { model, leadRepository, trialClassRepository, now, whatsappTransport: { send } });
  assert(app.whatsappInbox && app.whatsappOutbox && app.whatsappBindings && app.whatsappConfirmationReferences);
  const inbox = app.whatsappInbox;
  const outbox = app.whatsappOutbox;
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  const message = vi.spyOn(app.conversationService, 'sendMessage');
  const current = vi.spyOn(app.conversationService, 'getCurrentPendingAction');
  const create = vi.spyOn(leadRepository, 'createForConversation');
  const update = vi.spyOn(leadRepository, 'updateForConversation');
  const reserve = vi.spyOn(trialClassRepository, 'reserveSlot');
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  async function post(messages: unknown[]) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages })])));
    const response = await app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
    expect(response.statusCode).toBe(200);
  }
  async function deliver(event: unknown) {
    const start = sent.length;
    await post([event]); await inbox.drain();
    expect(inbox.activeQueueCount).toBe(0); expect(outbox.activeQueueCount).toBe(0);
    return sent.slice(start);
  }
  const text = (id: string, body: string, from = sender) => deliver(metaText({ id, from, text: { body } }));
  const click = (id: string, publication: Publication) => deliver(clickEvent(id, publication));
  function response(messageId: string) {
    const record = inbox.get(key(messageId)); assert(record?.state === 'processed');
    return record.response;
  }
  return { ...app, inbox, outbox, model, leadRepository, trialClassRepository, sent, send, resultFor,
    confirm, message, current, create, update, reserve, post, deliver, text, click, response };
}
type App = ReturnType<typeof application>;
function button(publications: Publication[]) {
  const publication = publications.filter(({ request }) => request.message.type === 'reply_buttons').at(-1);
  assert(publication?.request.message.type === 'reply_buttons');
  return publication;
}
function clickEvent(id: string, publication: Publication) {
  assert(publication.request.message.type === 'reply_buttons');
  const control = publication.request.message.buttons[0]!;
  return metaButton({ id, from: publication.request.recipientId, context: { id: publication.messageId },
    interactive: { type: 'button_reply', button_reply: { id: control.id, title: control.title } } });
}
function output(publications: Publication[]) { return publications.map(({ request }) => request.message.body).join('\n'); }
function calls(app: App) {
  return { model: app.model.calls.length, context: app.model.contextCalls.length, message: app.message.mock.calls.length,
    confirm: app.confirm.mock.calls.length, create: app.create.mock.calls.length, update: app.update.mock.calls.length,
    reserve: app.reserve.mock.calls.length };
}
async function prepareTrial(app: App) {
  const lead = button(await app.text('lead', introduction));
  await app.click('register', lead);
  return button(await app.text('trial', 'Quero agendar 11/06/2030 às 10h.'));
}
const rejection: WhatsAppSendResult = { status: 'rejected', reason: 'provider_rejection' };
const unknown: WhatsAppSendResult = { status: 'unknown', reason: 'timeout' };

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

describe('6.1 — outbox e recuperação explícita sem repetir decisões', () => {
  it.each([rejection, unknown])('reserva concluída seguida de $status recupera mesmo receipt/booking sem modelo, confirmação ou escrita', async (failure) => {
    const app = application([leadTurn(student), scheduleTurn(slotA), new AIMessage('Prosa divergente: falhou.'), leadTurn(correction)]);
    const preview = await prepareTrial(app);
    app.resultFor.mockImplementationOnce(async () => {
      const receipt = app.response('book');
      expect(receipt.results[0]).toMatchObject({ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created' } } });
      expect(app.outbox.get(key('book'))).toMatchObject({ source: { response: receipt }, parts: [{ state: 'sending' }] });
      return failure;
    });
    const failed = await app.click('book', preview);
    const receipt = app.response('book');
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    expect(app.outbox.get(key('book'))?.parts[0]).toMatchObject({ state: failure.status === 'rejected' ? 'failed' : 'unknown', result: failure });
    expect(output(failed)).toContain(booking.id); expect(output(failed)).not.toContain('Prosa divergente');
    expect(app.reserve).toHaveBeenCalledTimes(1);
    const attempts = app.sent.length;
    await app.click('book', preview); // Duplicata de webhook não tenta transporte.
    expect(app.sent).toHaveLength(attempts);
    await app.text('correction', 'Meu email correto é ana.novo@example.com.');
    const conversation = app.conversations.get(receipt.conversationId);
    const before = calls(app);
    app.current.mockClear();
    const recovered = await app.text('recover', '/reenviar');
    expect(recovered.map(({ request }) => request)).toEqual(failed.map(({ request }) => request));
    expect(output(recovered)).toContain(booking.id);
    expect(app.outbox.get(key('book'))).toMatchObject({ source: { response: receipt }, parts: [{ state: 'accepted' }] });
    expect(app.inbox.get(key('recover'))).toMatchObject({ state: 'ignored', code: 'RESEND_REQUESTED' });
    expect(calls(app)).toEqual(before); expect(app.current).not.toHaveBeenCalled();
    expect(app.conversations.get(receipt.conversationId)).toEqual(conversation);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toEqual(booking);
    expect(app.response('book')).toEqual(receipt);
    const sent = app.sent.length;
    await app.text('recover', '/reenviar');
    expect(app.sent).toHaveLength(sent); expect(calls(app)).toEqual(before);
    expect(output(await app.text('nothing', '/reenviar'))).toContain('Não há resposta recuperável');
    expect(calls(app)).toEqual(before);
  });

  it('falha de redação após reserva e falha de transporte preservam contingência e recibo original', async () => {
    const app = application([leadTurn(student), scheduleTurn(slotA), new Error('PRIVATE_DRAFT_FAILURE')]);
    const preview = await prepareTrial(app);
    app.resultFor.mockResolvedValueOnce(unknown);
    const failed = await app.click('book', preview);
    const receipt = app.response('book');
    expect(receipt.reply).not.toContain('PRIVATE');
    expect(receipt.results[0]).toMatchObject({ result: { ok: true, data: { outcome: 'created' } } });
    const before = calls(app);
    expect((await app.text('recover', '/reenviar')).map(({ request }) => request)).toEqual(failed.map(({ request }) => request));
    expect(calls(app)).toEqual(before); expect(app.response('book')).toEqual(receipt);
    expect(app.reserve).toHaveBeenCalledTimes(1);
  });

  it.each([rejection, unknown])('preserva partes aceitas e numeração; $status interrompe lote até /reenviar', async (failure) => {
    const reply = 'Texto longo com 👩🏽‍💻 e valores preservados.\n'.repeat(400);
    const app = application([dialogue(new AIMessage(reply))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => request.message.body.startsWith('[2/')
      ? failure : { status: 'accepted', messageId });
    await app.text('long', 'Olá');
    const snapshot = app.outbox.get(key('long'))!;
    expect(snapshot.source).toMatchObject({ state: 'processed', response: { reply } });
    expect(snapshot.parts.map((part) => part.content.body)).toEqual(splitWhatsAppText(reply));
    expect(snapshot.parts.map((part) => part.state)).toEqual(['accepted', failure.status === 'rejected' ? 'failed' : 'unknown',
      ...snapshot.parts.slice(2).map(() => 'pending')]);
    expect(app.sent).toHaveLength(3); // Aviso, primeira parte, segunda parte.
    const before = calls(app);
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    const recovered = await app.text('recover', '/reenviar');
    expect(recovered.map(({ request }) => request.message.body)).toEqual(splitWhatsAppText(reply).slice(1));
    expect(app.outbox.get(key('long'))?.parts[0]).toEqual(snapshot.parts[0]);
    expect(app.outbox.get(key('long'))?.parts.every((part) => part.state === 'accepted')).toBe(true);
    expect(calls(app)).toEqual(before);
    // Unknown pode ter aparecido antes: o mesmo texto reaparece, sem novo turno.
    expect(app.sent.filter(({ request }) => request.message.body.startsWith('[2/'))).toHaveLength(2);
  });

  it('uma nova falha no reenvio fica recuperável, sem retry automático nem perda da parte aceita', async () => {
    const app = application([dialogue(new AIMessage('x '.repeat(3_000)))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => request.message.body.startsWith('[2/')
      ? unknown : { status: 'accepted', messageId });
    await app.text('long', 'Olá');
    const first = app.outbox.get(key('long'))!.parts[0];
    const before = calls(app);
    expect(await app.text('recover-fails', '/reenviar')).toHaveLength(1);
    expect(app.outbox.get(key('long'))?.parts[1]?.state).toBe('unknown');
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    expect(await app.text('recover-ok', '/reenviar')).toHaveLength(1);
    expect(app.outbox.get(key('long'))?.parts[0]).toEqual(first); expect(calls(app)).toEqual(before);
  });

  it.each([rejection, unknown])('prévia com envio $status substituída não é reenviada nem cria autorização', async (failure) => {
    const app = application([leadTurn(student), leadTurn(correction)]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => request.message.type === 'reply_buttons'
      ? failure : { status: 'accepted', messageId });
    const original = button(await app.text('lead', introduction));
    const saved = app.outbox.get(key('lead'))!;
    const old = app.response('lead');
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    const next = button(await app.text('correction', 'Meu email correto é ana.novo@example.com.'));
    expect(next.request).not.toEqual(original.request);
    const before = calls(app);
    const recovered = await app.text('recover', '/reenviar');
    expect(recovered.every(({ request }) => request.message.type === 'text')).toBe(true);
    expect(output(recovered)).toContain('revisar a prévia atual');
    expect(output(recovered)).not.toContain('ana@example.com');
    expect(app.outbox.get(key('lead'))?.parts[0]).toEqual(saved.parts[0]);
    expect(app.outbox.get(key('lead'))?.parts[1]?.state).toBe('superseded');
    expect(app.response('lead')).toEqual(old); expect(calls(app)).toEqual(before);
    expect(await app.leadRepository.findByConversationId(old.conversationId)).toBeNull();
  });

  it('unknown de prévia só permite confirmar a nova mensagem com aceite identificável', async () => {
    const app = application([leadTurn(student)]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => request.message.type === 'reply_buttons'
      ? unknown : { status: 'accepted', messageId });
    const original = button(await app.text('lead', introduction));
    assert(original.request.message.type === 'reply_buttons');
    const reference = original.request.message.buttons[0]!.id;
    expect(app.whatsappConfirmationReferences!.get(reference)?.messageIds).toEqual([]);
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    await app.click('unknown-click', original);
    expect(app.confirm).not.toHaveBeenCalled();
    expect(app.inbox.get(key('unknown-click'))).toMatchObject({ state: 'failed', code: 'NOT_FOUND' });
    const before = calls(app);
    const retry = button(await app.text('recover', '/reenviar'));
    expect(retry.request).toEqual(original.request); expect(retry.messageId).not.toBe(original.messageId);
    expect(app.whatsappConfirmationReferences!.get(reference)?.messageIds).toEqual([retry.messageId]);
    expect(calls(app)).toEqual(before); expect(app.create).not.toHaveBeenCalled();
    await app.click('still-unknown', original);
    expect(app.confirm).not.toHaveBeenCalled();
    await app.click('known', retry);
    expect(app.create).toHaveBeenCalledTimes(1); expect(app.reserve).not.toHaveBeenCalled();
  });

  it('sem estado, inclusive após reinício, informa indisponibilidade sem abrir conversa/modelo ou inventar recibo', async () => {
    const previous = application([dialogue(new AIMessage('Resposta da sessão perdida.'))]);
    previous.resultFor.mockResolvedValue(unknown);
    await previous.text('lost', 'Olá');
    const fresh = application([]);
    const outputText = output(await fresh.text('recover', '/reenviar'));
    expect(outputText).toContain('Não há resposta recuperável'); expect(outputText).toContain('reinício');
    expect(outputText).not.toContain('Resposta da sessão perdida');
    expect(fresh.whatsappBindings!.get(identity)).toBeUndefined();
    expect(calls(fresh)).toEqual({ model: 0, context: 0, message: 0, confirm: 0, create: 0, update: 0, reserve: 0 });
  });

  it('seleciona a última resposta elegível somente do próprio vínculo, mesmo após resposta mais recente aceita', async () => {
    const app = application([dialogue(new AIMessage('Primeira falha.')), dialogue(new AIMessage('Segunda falha.')),
      dialogue(new AIMessage('Resposta aceita.')), dialogue(new AIMessage('Conversa B.'))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => request.message.body.endsWith('falha.')
      ? rejection : { status: 'accepted', messageId });
    await app.text('first', 'Olá'); await app.text('second', 'Continue'); await app.text('accepted', 'Mais');
    await app.text('other', 'Olá', otherSender);
    const before = calls(app);
    expect(output(await app.text('foreign-recover', '/reenviar', otherSender))).toContain('Não há resposta recuperável');
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    expect(output(await app.text('recover-latest', '/reenviar'))).toBe('Segunda falha.');
    expect(output(await app.text('recover-older', '/reenviar'))).toBe('Primeira falha.');
    expect(calls(app)).toEqual(before);
  });

  it.each(['/REENVIAR', '/reenviar agora', ' /reenviar ', 'sim'])('somente comando exato usa recuperação; %j continua diálogo sem consentimento', async (text) => {
    const app = application([leadTurn(student), dialogue()]);
    await app.text('lead', introduction);
    const before = app.model.contextCalls.length;
    await app.text('ordinary', text);
    expect(app.model.contextCalls).toHaveLength(before + 1);
    expect(app.inbox.get(key('ordinary'))?.state).toBe('processed');
    expect(app.create).not.toHaveBeenCalled(); expect(app.confirm).not.toHaveBeenCalled();
  });

  it('envio lento não bloqueia correção por webhook; ordena I/O, suprime botão antigo e libera outro destinatário', async () => {
    const sending = gate(); const release = gate(); const corrected = gate();
    const app = application([leadTurn(student), leadTurn(correction), dialogue(new AIMessage('Resposta de B.'))]);
    const publish = app.outbox.publish.bind(app.outbox);
    vi.spyOn(app.outbox, 'publish').mockImplementation((record, presentation) => {
      const pending = publish(record, presentation);
      if (record.event.messageId === 'correction') corrected.release();
      return pending;
    });
    app.resultFor.mockImplementationOnce(async ({ messageId }) => {
      sending.release(); await release.promise; return { status: 'accepted', messageId };
    });
    await app.post([metaText({ id: 'lead', text: { body: introduction } })]);
    await sending.promise;
    const original = app.response('lead');
    expect(app.sent).toHaveLength(1); // Aviso ainda em curso.
    await app.post([metaText({ id: 'correction', text: { body: 'Meu email correto é ana.novo@example.com.' } })]);
    await corrected.promise;
    expect(app.response('correction').pendingAction?.actionId).not.toBe(original.pendingAction?.actionId);
    expect(app.conversations.get(original.conversationId)?.context.contact).toEqual(correction.contact);
    expect(app.sent).toHaveLength(1); // Mesmo destinatário não envia concorrentemente.
    await app.post([metaText({ id: 'other', from: otherSender, text: { body: 'Olá' } })]);
    await app.inbox.drain({ ...identity, senderId: otherSender });
    expect(output(app.sent)).toContain('Resposta de B.');
    expect(app.sent.filter(({ request }) => request.recipientId === sender)).toHaveLength(1);
    release.release(); await app.inbox.drain();
    const buttons = app.sent.filter(({ request }) => request.message.type === 'reply_buttons');
    expect(buttons).toHaveLength(1); expect(output(buttons)).toContain(correction.contact.value);
    expect(app.outbox.get(key('lead'))?.parts[1]?.state).toBe('superseded');
    expect(app.outbox.activeQueueCount).toBe(0); expect(app.inbox.activeQueueCount).toBe(0);
    expect(app.create).not.toHaveBeenCalled(); expect(app.reserve).not.toHaveBeenCalled();
  });

  it('comando durante envio lento observa falha ao chegar sua vez, sem repetir parte já aceita', async () => {
    const sending = gate(); const release = gate(); const recovering = gate();
    const app = application([dialogue(new AIMessage('Resposta salva.'))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body === 'Resposta salva.') {
        sending.release(); await release.promise; return unknown;
      }
      return { status: 'accepted', messageId };
    });
    const recover = app.outbox.recover.bind(app.outbox);
    vi.spyOn(app.outbox, 'recover').mockImplementation((event) => { const pending = recover(event); recovering.release(); return pending; });
    await app.post([metaText({ id: 'slow' })]); await sending.promise;
    await app.post([metaText({ id: 'recover', text: { body: '/reenviar' } })]); await recovering.promise;
    expect(app.inbox.get(key('recover'))).toMatchObject({ state: 'ignored', code: 'RESEND_REQUESTED' });
    expect(app.sent).toHaveLength(2);
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    release.release(); await app.inbox.drain();
    expect(app.sent).toHaveLength(3); expect(app.sent[2]?.request).toEqual(app.sent[1]?.request);
    expect(app.outbox.get(key('slow'))?.parts[0]?.state).toBe('accepted');
    expect(app.model.calls).toHaveLength(1); expect(app.model.contextCalls).toHaveLength(1);
  });

  it('snapshots são defensivos; exceção de transporte vira unknown sanitizado e resposta continua recuperável', async () => {
    const app = application([dialogue(new AIMessage('Resposta original.'))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body === 'Resposta original.') throw new Error('PRIVATE_TRANSPORT_SECRET');
      return { status: 'accepted', messageId };
    });
    await app.text('original', 'Olá');
    const snapshot = app.outbox.get(key('original'))!;
    expect(snapshot.parts[0]).toMatchObject({ state: 'unknown', result: { status: 'unknown', reason: 'network_error' } });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    snapshot.parts[0]!.content = { type: 'text', body: 'Adulterada' }; snapshot.parts[0]!.state = 'accepted';
    if (snapshot.source?.state === 'processed') snapshot.source.response.reply = 'Adulterada';
    snapshot.binding!.conversationId = 'foreign';
    app.resultFor.mockImplementation(async ({ messageId }) => ({ status: 'accepted', messageId }));
    expect(output(await app.text('recover', '/reenviar'))).toBe('Resposta original.');
    expect(app.outbox.get(key('original'))?.source).toMatchObject({ response: { reply: 'Resposta original.' } });
  });
});
