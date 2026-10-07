import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryWhatsAppServiceWindow } from '../src/channels/whatsapp/service-window.js';
import type { WhatsAppInboundMessage } from '../src/channels/whatsapp/inbox.js';
import type { WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { splitWhatsAppText } from '../src/channels/whatsapp/presentation.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { createJourneyModel, dialogue, leadTurn, scheduleTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const instant = Date.parse('2030-06-10T12:00:00Z');
const day = 86_400_000;
const sender = 'demo-recipient';
const other = 'other-recipient';
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: sender };
const key = (messageId: string) => ({ ...identity, messageId });
const timestamp = (time: number) => String(Math.floor(time / 1_000));
const event: WhatsAppInboundMessage = { ...identity, type: 'text', messageId: 'original', occurredAt: instant, text: 'Olá' };
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: `${sender},${other}`,
};
const student = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' };
const introduction = 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.';
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
  const sent: Publication[] = [];
  const resultFor = vi.fn<(publication: Publication) => Promise<WhatsAppSendResult>>(async ({ messageId }) => ({ status: 'accepted', messageId }));
  const send = vi.fn<WhatsAppTransport['send']>(async (request) => {
    const publication = { request: structuredClone(request), messageId: `outbound-${sent.length + 1}` };
    sent.push(publication);
    return resultFor(publication);
  });
  const app = createApplication(environment, { model, leadRepository, trialClassRepository,
    now: () => new Date(instant), whatsappNow: () => new Date(clock), whatsappTransport: { send }, whatsappInboxLimits: { maxMessages } });
  assert(app.whatsappInbox && app.whatsappOutbox && app.whatsappBindings);
  const inbox = app.whatsappInbox;
  const outbox = app.whatsappOutbox;
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  const message = vi.spyOn(app.conversationService, 'sendMessage');
  const create = vi.spyOn(leadRepository, 'createForConversation');
  const reserve = vi.spyOn(trialClassRepository, 'reserveSlot');
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  async function post(messages: unknown[] = [], statuses: unknown[] = [], statusCode = 200) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages, statuses })])));
    const response = await app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
    expect(response.statusCode).toBe(statusCode);
  }
  async function deliver(input: unknown) {
    const start = sent.length;
    await post([input]); await inbox.drain();
    expect(inbox.activeQueueCount).toBe(0); expect(outbox.activeQueueCount).toBe(0);
    return sent.slice(start);
  }
  const text = (id: string, body: string, time = clock, from = sender) =>
    deliver(metaText({ id, from, timestamp: timestamp(time), text: { body } }));
  function response(messageId: string) {
    const record = inbox.get(key(messageId)); assert(record?.state === 'processed');
    return record.response;
  }
  return { ...app, inbox, outbox, model, leadRepository, trialClassRepository, sent, resultFor,
    confirm, message, create, reserve, post, deliver, text, response, setTime: (time: number) => { clock = time; } };
}
type App = ReturnType<typeof application>;
function calls(app: App) {
  return { model: app.model.calls.length, context: app.model.contextCalls.length, message: app.message.mock.calls.length,
    confirm: app.confirm.mock.calls.length, create: app.create.mock.calls.length, reserve: app.reserve.mock.calls.length };
}
function button(publications: Publication[]) {
  const publication = publications.find(({ request }) => request.message.type === 'reply_buttons');
  assert(publication); return publication;
}
function click(id: string, publication: Publication, time = instant) {
  assert(publication.request.message.type === 'reply_buttons');
  return metaButton({ id, timestamp: timestamp(time), context: { id: publication.messageId },
    interactive: { type: 'button_reply', button_reply: { id: publication.request.message.buttons[0]!.id, title: 'Confirmar' } } });
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

describe('6.3 — janela por identidade e timestamp autenticado', () => {
  it.each(['accountId', 'phoneNumberId', 'senderId'] as const)('isola %s, conserva máximo e não retém objetos mutáveis', (field) => {
    let now = instant;
    const window = new InMemoryWhatsAppServiceWindow(() => new Date(now));
    expect(window.isOpen(identity)).toBe(false);
    const original = { ...event };
    expect(window.admit(original)).toBe(true);
    original.occurredAt += day; original.senderId = 'modified';
    now += day;
    expect(window.isOpen(identity)).toBe(false);
    expect(window.admit({ ...event, [field]: 'other', occurredAt: now })).toBe(true);
    expect(window.isOpen(identity)).toBe(false);
    expect(window.isOpen({ ...identity, [field]: 'other' })).toBe(true);
    expect(window.admit({ ...event, occurredAt: now - 1_000 })).toBe(true);
    expect(window.admit(event)).toBe(true);
    expect(window.isOpen(identity)).toBe(true); // O evento atrasado não reduz o máximo.
    now += day - 1_000;
    expect(window.isOpen(identity)).toBe(false);
  });

  it('timestamp futuro não ganha janela quando o clock avança; recuo/invalidez do clock bloqueia', () => {
    let now = instant;
    const window = new InMemoryWhatsAppServiceWindow(() => new Date(now));
    expect(window.admit({ ...event, occurredAt: instant + 1_000 })).toBe(false);
    now += 1_000;
    expect(window.isOpen(identity)).toBe(false);
    expect(window.admit({ ...event, occurredAt: now })).toBe(true);
    now = instant;
    expect(window.isOpen(identity)).toBe(false);
    now = NaN;
    expect(window.isOpen(identity)).toBe(false);
    expect(window.admit(event)).toBe(false);
  });

  it.each([day - 1, day, day + 1])('primeira entrega atrasada usa idade original %s ms, sem template', async (age) => {
    const app = application([dialogue(new AIMessage('Resposta salva.'))]);
    app.setTime(instant + age);
    const sent = await app.text('original', 'Olá', instant);
    expect(app.response('original').reply).toBe('Resposta salva.');
    expect(app.inbox.get(key('original'))?.event.occurredAt).toBe(instant);
    expect(app.outbox.get(key('original'))).toMatchObject({ event: { occurredAt: instant },
      parts: [{ state: age < day ? 'accepted' : 'blocked_window' }] });
    expect(sent).toHaveLength(age < day ? 2 : 0); // Aviso e resposta, quando permitido.
    expect(sent.every(({ request }) => request.message.type === 'text')).toBe(true);
    if (age >= day) expect(app.outbox.get(key('original'))?.parts[0]?.request).toBeUndefined();
  });

  it('recusa futuro antes de abrir conversa e processa irmão válido do lote sem ampliar sua janela', async () => {
    const app = application([dialogue(new AIMessage('Resposta válida.'))]);
    await app.post([metaText({ id: 'future', from: other, timestamp: timestamp(instant + day) }), metaText({ id: 'valid' })]);
    await app.inbox.drain();
    expect(app.inbox.get(key('future'))).toBeUndefined();
    expect(app.whatsappBindings!.get({ ...identity, senderId: other })).toBeUndefined();
    expect(app.model.calls).toHaveLength(1);
    app.setTime(instant + day);
    await app.outbox.sendNotice({ ...event, messageId: 'local-notice' }, 'Aviso local.');
    expect(app.outbox.get(key('local-notice'), 'notice')?.parts[0]?.state).toBe('blocked_window');
    expect(app.sent).toHaveLength(2);
  });

  it('reentrega, colisão de timestamp, status e saída não renovam janela nem repetem processamento', async () => {
    const app = application([dialogue(new AIMessage('Resposta original.'))]);
    const original = metaText({ id: 'original' });
    await app.deliver(original);
    const inbox = app.inbox.get(key('original'));
    const before = calls(app);
    app.setTime(instant + day - 1_000);
    await app.outbox.sendNotice({ ...event, messageId: 'outgoing' }, 'Saída perto do limite.');
    app.setTime(instant + day);
    await app.deliver(original);
    await app.post([metaText({ id: 'original', timestamp: timestamp(instant + day) })], [], 409);
    const accepted = app.sent[1]!;
    await app.post([], ['sent', 'delivered', 'read'].map((status) => metaStatus({
      id: accepted.messageId, status, timestamp: timestamp(instant + day),
    })));
    await app.outbox.sendNotice({ ...event, messageId: 'closed' }, 'Não deve sair.');
    expect(app.outbox.get(key('closed'), 'notice')?.parts[0]?.state).toBe('blocked_window');
    expect(app.sent).toHaveLength(3); expect(calls(app)).toEqual(before);
    expect(app.inbox.get(key('original'))).toEqual(inbox);
    expect(app.outbox.get(key('original'))).toMatchObject({ event: { occurredAt: instant }, parts: [{ state: 'read' }] });
  });

  it('mídia, mensagem malformada, remetente não permitido e admissão recusada não abrem janela', async () => {
    const app = application([dialogue()], 1);
    await app.text('original', 'Olá');
    app.setTime(instant + day);
    await app.post([
      metaText({ id: 'media', timestamp: timestamp(instant + day), type: 'image' }),
      metaText({ id: 'invalid', timestamp: 'invalid' }),
      metaText({ id: 'unlisted', from: 'unlisted', timestamp: timestamp(instant + day) }),
      metaText({ id: 'capacity', timestamp: timestamp(instant + day) }),
    ], [], 503);
    await app.outbox.sendNotice({ ...event, messageId: 'closed' }, 'Não deve sair.');
    expect(app.outbox.get(key('closed'), 'notice')?.parts[0]?.state).toBe('blocked_window');
    expect(app.sent).toHaveLength(2); expect(app.model.calls).toHaveLength(1);
  });
});

describe('6.3 — verificar cada parte e recuperar somente apresentação', () => {
  it('expiração durante o modelo salva resposta, bloqueia transporte e libera a fila', async () => {
    const entered = gate(); const release = gate();
    const app = application([dialogue(async () => { entered.release(); await release.promise; return new AIMessage('Resposta tardia.'); })]);
    await app.post([metaText({ id: 'slow' })]); await entered.promise;
    app.setTime(instant + day); release.release(); await app.inbox.drain();
    expect(app.response('slow').reply).toBe('Resposta tardia.');
    expect(app.outbox.get(key('slow'))?.parts[0]?.state).toBe('blocked_window');
    expect(app.sent).toHaveLength(0);
    expect(app.inbox.activeQueueCount).toBe(0); expect(app.outbox.activeQueueCount).toBe(0);
  });

  it('aviso lento expira antes da resposta enfileirada, sem usar a hora de aceite como renovação', async () => {
    const entered = gate(); const release = gate();
    const app = application([dialogue(new AIMessage('Resposta enfileirada.'))]);
    app.resultFor.mockImplementationOnce(async ({ messageId }) => { entered.release(); await release.promise; return { status: 'accepted', messageId }; });
    await app.post([metaText({ id: 'queued' })]); await entered.promise;
    app.setTime(instant + day); release.release(); await app.inbox.drain();
    expect(app.sent).toHaveLength(1);
    expect(app.outbox.get(key('queued'), 'notice')?.parts[0]?.state).toBe('accepted');
    expect(app.outbox.get(key('queued'))?.parts[0]?.state).toBe('blocked_window');
  });

  it('expira entre partes; texto novo renova e /reenviar preserva aceites, conteúdo e timestamp original', async () => {
    const reply = 'Texto longo com 👩🏽‍💻 e valores preservados.\n'.repeat(250);
    const app = application([dialogue(new AIMessage(reply)), dialogue(new AIMessage('Bem-vinda de volta.'))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => {
      if (request.message.body.startsWith('[1/')) app.setTime(instant + day);
      return { status: 'accepted', messageId };
    });
    await app.text('long', 'Olá');
    const original = app.outbox.get(key('long'))!;
    expect(original.parts.map((part) => part.state)).toEqual(['accepted', 'blocked_window',
      ...original.parts.slice(2).map(() => 'pending')]);
    expect(app.sent).toHaveLength(2);
    const before = calls(app);
    await app.text('old-retry', '/reenviar', instant); // Comando atrasado não renova.
    expect(app.sent).toHaveLength(2); expect(calls(app)).toEqual(before);
    expect(app.outbox.get(key('long'))).toEqual(original);
    app.setTime(instant + day + 1_000);
    await app.text('new-text', 'Voltei');
    expect(app.outbox.get(key('long'))).toEqual(original); // Sem recuperação automática.
    const afterText = calls(app);
    const recovered = await app.text('retry', '/reenviar');
    expect(recovered.map(({ request }) => request.message.body)).toEqual(splitWhatsAppText(reply).slice(1));
    expect(app.outbox.get(key('long'))).toMatchObject({ event: original.event, source: original.source });
    expect(app.outbox.get(key('long'))?.parts[0]).toEqual(original.parts[0]);
    expect(app.outbox.get(key('long'))?.parts.every((part) => part.state === 'accepted')).toBe(true);
    expect(calls(app)).toEqual(afterText);
  });

  it.each(['rejected', 'unknown'] as const)('reenvio de %s checa janela novamente, inclusive entre suas partes', async (status) => {
    const reply = 'Resposta longa. '.repeat(700);
    const app = application([dialogue(new AIMessage(reply))]);
    app.resultFor.mockImplementation(async ({ request, messageId }) => request.message.body.startsWith('[1/')
      ? status === 'unknown' ? { status, reason: 'timeout' } : { status, reason: 'provider_rejection' }
      : { status: 'accepted', messageId });
    await app.text('original', 'Olá');
    const original = app.outbox.get(key('original'))!;
    const before = calls(app);
    app.setTime(instant + day);
    expect(await app.text('expired-retry', '/reenviar', instant)).toHaveLength(0);
    expect(app.outbox.get(key('original'))?.parts[0]?.state).toBe('blocked_window');
    app.resultFor.mockImplementation(async ({ messageId }) => {
      app.setTime(instant + 2 * day);
      return { status: 'accepted', messageId };
    });
    expect(await app.text('fresh-retry', '/reenviar')).toHaveLength(1);
    expect(app.outbox.get(key('original'))?.parts.map((part) => part.state)).toEqual(['accepted', 'blocked_window',
      ...original.parts.slice(2).map(() => 'pending')]);
    expect(app.outbox.get(key('original'))).toMatchObject({ event: original.event, source: original.source });
    expect(calls(app)).toEqual(before);
  });

  it('renova por máximo na admissão mesmo com modelo anterior em andamento; texto atrasado não reduz janela', async () => {
    const entered = gate(); const release = gate();
    const app = application([dialogue(async () => { entered.release(); await release.promise; return new AIMessage('Primeira resposta.'); }), dialogue(), dialogue()]);
    await app.post([metaText({ id: 'original' })]); await entered.promise;
    app.setTime(instant + day);
    await app.post([metaText({ id: 'new', timestamp: timestamp(instant + day) }), metaText({ id: 'late' })]);
    release.release(); await app.inbox.drain();
    for (const id of ['original', 'new', 'late']) expect(app.outbox.get(key(id))?.parts[0]?.state).toBe('accepted');
    expect(app.outbox.get(key('original'), 'notice')?.parts[0]?.state).toBe('accepted');
    expect(app.inbox.get(key('late'))?.event.occurredAt).toBe(instant);
    app.setTime(instant + 2 * day);
    await app.outbox.sendNotice({ ...event, messageId: 'closed' }, 'Não deve sair.');
    expect(app.outbox.get(key('closed'), 'notice')?.parts[0]?.state).toBe('blocked_window');
  });

  it('relê clock depois de aguardar prévia; botão bloqueado é recuperado sem cadastrar', async () => {
    const app = application([leadTurn(student)]);
    const current = app.conversationService.getCurrentPendingAction.bind(app.conversationService);
    vi.spyOn(app.conversationService, 'getCurrentPendingAction').mockImplementationOnce(async (request) => {
      const result = await current(request);
      app.setTime(instant + day);
      return result;
    });
    await app.text('lead', introduction);
    const original = app.outbox.get(key('lead'))!;
    expect(original.parts.map((part) => part.state)).toEqual(['accepted', 'blocked_window']);
    expect(app.sent.every(({ request }) => request.message.type === 'text')).toBe(true);
    const before = calls(app);
    const recovered = await app.text('retry', '/reenviar');
    expect(recovered).toHaveLength(1); expect(button(recovered).request.message.body).toBe(original.parts[1]!.content.body);
    expect(calls(app)).toEqual(before); expect(app.create).not.toHaveBeenCalled();
    expect(app.outbox.get(key('lead'))?.event.occurredAt).toBe(instant);
  });

  it('botão válido renova janela, mas redação tardia bloqueia recibo de reserva até novo /reenviar', async () => {
    const app = application([leadTurn(student), scheduleTurn({ slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } }),
      () => { app.setTime(instant + 2 * day); return new AIMessage('Prosa divergente.'); }]);
    const lead = button(await app.text('lead', introduction));
    await app.deliver(click('register', lead));
    const trial = button(await app.text('trial', 'Quero agendar 11/06/2030 às 10h.'));
    app.setTime(instant + day);
    await app.deliver(click('book', trial, instant + day));
    const receipt = app.response('book');
    const booking = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'); assert(booking);
    expect(receipt.results[0]).toMatchObject({ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created', booking } } });
    expect(app.outbox.get(key('book'))?.parts[0]?.state).toBe('blocked_window');
    const before = calls(app);
    const saved = app.outbox.get(key('book'))!;
    expect(await app.deliver(click('book', trial, instant + day))).toHaveLength(0);
    expect(await app.text('old-retry', '/reenviar', instant + day)).toHaveLength(0);
    const recovered = await app.text('new-retry', '/reenviar');
    expect(recovered).toHaveLength(1); expect(recovered[0]!.request.message.body).toContain(booking.id);
    expect(app.outbox.get(key('book'))).toMatchObject({ event: saved.event, source: saved.source, parts: [{ state: 'accepted' }] });
    expect(app.response('book')).toEqual(receipt);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toEqual(booking);
    expect(app.reserve).toHaveBeenCalledTimes(1); expect(calls(app)).toEqual(before);
  });

  it('novo clique válido renova pelo timestamp do botão e envia recibo sem chamar modelo', async () => {
    const app = application([leadTurn(student)]);
    const preview = button(await app.text('lead', introduction));
    const modelCalls = app.model.calls.length;
    app.setTime(instant + day);
    const receipt = await app.deliver(click('register', preview, instant + day));
    expect(receipt).toHaveLength(1);
    expect(app.outbox.get(key('register'))).toMatchObject({ event: { occurredAt: instant + day }, parts: [{ state: 'accepted' }] });
    expect(app.response('register').results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } } });
    expect(app.model.calls).toHaveLength(modelCalls); expect(app.create).toHaveBeenCalledTimes(1);
    app.setTime(instant + 2 * day);
    await app.outbox.sendNotice({ ...event, messageId: 'closed' }, 'Não deve sair.');
    expect(app.outbox.get(key('closed'), 'notice')?.parts[0]?.state).toBe('blocked_window');
  });

  it('novo botão perdido permite somente aviso local dentro da janela, sem criar conversa', async () => {
    const app = application([]);
    app.setTime(instant + day);
    await app.deliver(metaButton({ id: 'lost', timestamp: timestamp(instant + day) }));
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]!.request.message.body).toContain('confirmação está indisponível');
    expect(app.whatsappBindings!.get(identity)).toBeUndefined();
    expect(calls(app)).toEqual({ model: 0, context: 0, message: 0, confirm: 0, create: 0, reserve: 0 });
  });
});
