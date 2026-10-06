import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chatRequestSchema } from '@supportflow/contracts/chat';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryWhatsAppInbox } from '../src/channels/whatsapp/inbox.js';
import type { WhatsAppInboundMessage, WhatsAppInboxOptions } from '../src/channels/whatsapp/inbox.js';
import { registerMetaWebhookRoutes } from '../src/channels/whatsapp/meta/webhook-route.js';
import type { WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { createConversationContext } from '../src/modules/language-school/domain/conversation-context.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { createJourneyModel, dialogue, leadTurn, scheduleTurn, selectSlotTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaText } from './helpers/meta-webhook.js';

const start = Date.parse('2030-06-10T12:00:00Z');
const credentials = { ...metaOrigin, appSecret: 'FAKE_SECRET', webhookVerifyToken: 'FAKE_VERIFY' };
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: credentials.appSecret,
  META_WEBHOOK_VERIFY_TOKEN: credentials.webhookVerifyToken, META_ACCESS_TOKEN: 'FAKE_ACCESS',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  META_GRAPH_API_VERSION: 'v26.0', WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient',
};
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: 'demo-recipient' };
const key = (messageId: string) => ({ ...identity, messageId });
const event: WhatsAppInboundMessage = { ...identity, messageId: 'message', type: 'text', text: 'Olá', occurredAt: start };
const cleanups: (() => Promise<void>)[] = [];
function post(server: FastifyInstance, messages: unknown[]) {
  const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages })])));
  return server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', credentials.appSecret).update(payload).digest('hex')}`,
  } });
}
function application(options: {
  now?: () => Date;
  script?: JourneyScript;
  onNotice?: WhatsAppInboxOptions['onNotice'];
} = {}) {
  const model = createJourneyModel(options.script ?? []);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const handoffRepository = new InMemoryHandoffRepository();
  const notices: string[] = [];
  const transport: WhatsAppTransport = { send: vi.fn(async (request) => {
    notices.push(request.message.body);
    return { status: 'accepted' as const, messageId: `notice-${notices.length}` };
  }) };
  // Este harness isola o reinício/aviso. Sem roteiro, mantém só recepção/sessão;
  // a composição textual padrão é exercitada em whatsapp-text-channel.test.ts.
  const process = vi.fn(async (input: WhatsAppInboundMessage) => {
    assert(input.type === 'text');
    const binding = app.whatsappBindings!.get(input); assert(binding);
    return app.conversationService.sendMessage(chatRequestSchema.parse({ conversationId: binding.conversationId, message: input.text }));
  });
  const app = createApplication(environment, {
    model, leadRepository, trialClassRepository, handoffRepository,
    now: () => new Date(start), whatsappNow: options.now ?? (() => new Date(start)),
    whatsappProcessor: options.script ? process : null,
    whatsappTransport: { send: async () => ({ status: 'accepted', messageId: 'response' }) },
    whatsappOnNotice: options.onNotice ?? (async (input, notice) => {
      await transport.send({ recipientId: input.senderId, message: { type: 'text', body: notice.body } });
    }),
  });
  const inbox = app.whatsappInbox!; const bindings = app.whatsappBindings!;
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  return { ...app, inbox, bindings, model, process, transport, notices, leadRepository, trialClassRepository, handoffRepository };
}
function confirmation(response: LanguageSchoolChatResponse) {
  assert(response.pendingAction);
  return { conversationId: response.conversationId, actionId: response.pendingAction.actionId };
}

describe('3.3 — marco de início e sessões demonstrativas perdidas', () => {
  const network = vi.fn(() => { throw new Error('Rede externa proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', network);
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((close) => close()));
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it.each([0, 1, 999])('captura o clock uma vez, arredonda para cima (%s ms) e admite exatamente no marco', async (fraction) => {
    let current = start + fraction;
    const clock = vi.fn(() => new Date(current));
    const process = vi.fn(async () => ({ ok: true as const, response: 'ok' }));
    const inbox = new InMemoryWhatsAppInbox(process, { now: clock });
    cleanups.push(() => inbox.drain());
    const expected = start + (fraction === 0 ? 0 : 1_000);
    expect(inbox.startedAt).toBe(expected); expect(clock).toHaveBeenCalledOnce();
    current += 90_000;
    const old = { ...event, occurredAt: expected - 1 };
    expect(inbox.admit(old)).toBe('before_start'); expect(inbox.admit(old)).toBe('before_start');
    expect(inbox.get(event)).toBeUndefined(); expect(inbox.activeQueueCount).toBe(0);
    expect(inbox.admit({ ...event, occurredAt: expected })).toBe('accepted');
    await inbox.drain();
    expect(process).toHaveBeenCalledOnce(); expect(clock).toHaveBeenCalledOnce();
    expect(inbox.startedAt).toBe(expected);
  });

  it('recusa clock de início inválido', () => {
    expect(() => new InMemoryWhatsAppInbox(undefined, { now: () => new Date(NaN) }))
      .toThrow('Configuração inválida da inbox WhatsApp.');
  });

  it('descarte de texto/botão antigo gera só contagem sanitizada, sem guardar payload nem ocupar capacidade', async () => {
    const lines: string[] = [];
    const server = Fastify({ logger: { stream: { write: (line) => { lines.push(line); } } } });
    const process = vi.fn(async () => ({ ok: true as const, response: 'ok' }));
    const inbox = new InMemoryWhatsAppInbox(process, { now: () => new Date(start + 1), limits: { maxMessages: 1 } });
    registerMetaWebhookRoutes(server, credentials, inbox);
    cleanups.push(async () => { await inbox.drain(); await server.close(); });
    const old = [metaText({ id: 'PRIVATE_ID', from: 'PRIVATE_SENDER', text: { body: 'PRIVATE_BODY' } }),
      metaButton({ id: 'PRIVATE_CLICK', interactive: { type: 'button_reply', button_reply: { id: 'PRIVATE_REFERENCE' } } })];
    const response = await post(server, old);
    expect(response.statusCode).toBe(200); expect(response.body).toBe('');
    expect((await post(server, old)).statusCode).toBe(200);
    expect(inbox.activeQueueCount).toBe(0); expect(process).not.toHaveBeenCalled();
    expect(inbox.get(key('PRIVATE_ID'))).toBeUndefined(); expect(inbox.get(key('PRIVATE_CLICK'))).toBeUndefined();
    const logs = lines.map((line) => JSON.parse(line));
    expect(logs.filter((line) => line.code === 'WHATSAPP_BEFORE_START_IGNORED').map((line) => line.count)).toEqual([2, 2]);
    expect(lines.join('')).not.toContain('PRIVATE');
    expect((await post(server, [metaText({ timestamp: '1907323201' })])).statusCode).toBe(200);
    await inbox.drain(); expect(process).toHaveBeenCalledOnce();
  });

  it('reinício perde autoridade comercial; reentrega e novo clique não recriam nada, e texto novo abre sessão vazia', async () => {
    const previous = application({ script: [
      leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' }),
      selectSlotTurn(), scheduleTurn(), new Error('Falha de redação posterior à reserva'),
    ] });
    const registration = metaText({ id: 'old-registration', text: { body: 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.' } });
    await post(previous.server, [registration]); await previous.inbox.drain();
    const proposal = previous.inbox.get(key('old-registration')); assert(proposal?.state === 'processed');
    const leadReceipt = await previous.conversationService.confirmAction(confirmation(proposal.response)); assert(leadReceipt.ok);
    const conversationId = proposal.response.conversationId;
    await post(previous.server, [metaText({ id: 'old-slot', text: { body: 'Escolho 11/06/2030 às 10h.' } }),
      metaText({ id: 'old-booking', text: { body: 'Quero reservar esse horário.' } })]);
    await previous.inbox.drain();
    const bookingProposal = previous.inbox.get(key('old-booking')); assert(bookingProposal?.state === 'processed');
    const command = confirmation(bookingProposal.response);
    const receipt = await previous.conversationService.confirmAction(command); assert(receipt.ok);
    expect(await previous.trialClassRepository.findConfirmedBySlotId('slot_english_a')).not.toBeNull();
    expect(await previous.leadRepository.findByConversationId(conversationId)).not.toBeNull();
    await previous.requestHumanHandoff(conversationId, { reason: 'Quero falar com alguém.' }, 'request');
    expect(await previous.handoffRepository.findOpenByConversationId(conversationId)).not.toBeNull();
    await previous.server.close();

    let current = start + 1_001;
    const fresh = application({ now: () => new Date(current) });
    current = start + 2_000;
    const create = vi.spyOn(fresh.conversations, 'create');
    const send = vi.spyOn(fresh.conversationService, 'sendMessage');
    const confirm = vi.spyOn(fresh.conversationService, 'confirmAction');
    const writeLead = vi.spyOn(fresh.leadRepository, 'createForConversation');
    const reserve = vi.spyOn(fresh.trialClassRepository, 'reserveSlot');
    const handoff = vi.spyOn(fresh.handoffRepository, 'requestForConversation');
    expect(fresh.inbox.startedAt).toBe(start + 2_000);
    expect(fresh.conversations.get(conversationId)).toBeUndefined();
    expect(fresh.bindings.get(identity)).toBeUndefined();
    expect(fresh.inbox.get(key('old-registration'))).toBeUndefined();
    expect((await post(fresh.server, [registration, metaButton({ id: 'old-click' })])).statusCode).toBe(200);
    // Um clique feito agora em uma prévia antiga tem timestamp novo, mas não
    // recupera vínculo/actionId do título, referência ou campos externos.
    const lost = metaButton({ id: 'lost', timestamp: '1907323202', conversationId, actionId: command.actionId, confirmed: true });
    expect((await post(fresh.server, [lost])).statusCode).toBe(200); await fresh.inbox.drain();
    expect(fresh.inbox.get(key('lost'))).toMatchObject({ state: 'ignored', code: 'SESSION_UNAVAILABLE', notice: { kind: 'session_unavailable' } });
    expect(fresh.bindings.get(identity)).toBeUndefined(); expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(fresh.model.calls).toHaveLength(0); expect(fresh.model.contextCalls).toHaveLength(0);
    expect(writeLead).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled();
    expect(await fresh.leadRepository.findByConversationId(conversationId)).toBeNull();
    expect(await fresh.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    expect(await fresh.handoffRepository.findOpenByConversationId(conversationId)).toBeNull();
    expect(await fresh.conversationService.confirmAction(command)).toEqual({ ok: false, code: 'NOT_FOUND' });

    const text = metaText({ id: 'new-session', timestamp: '1907323202' });
    await post(fresh.server, [text, text]); await fresh.inbox.drain();
    const binding = fresh.bindings.get(identity)!;
    expect(binding.conversationId).not.toBe(conversationId);
    expect(fresh.conversations.get(binding.conversationId)).toEqual({ id: binding.conversationId, history: [], context: createConversationContext() });
    expect(fresh.inbox.get(key('new-session'))).toMatchObject({ state: 'ignored', code: 'PROCESSOR_UNAVAILABLE', notice: { kind: 'new_session' } });
    expect(fresh.notices).toHaveLength(2);
    expect(fresh.notices[0]).toContain('confirmação está indisponível');
    expect(fresh.notices[1]).toContain('registros anteriores não foram recuperados');
    await post(fresh.server, [lost, text]); await fresh.inbox.drain();
    expect(fresh.transport.send).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce(); expect(writeLead).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(await fresh.conversationService.getCurrentPendingAction({ conversationId: binding.conversationId }))
      .toEqual({ ok: true, response: { pendingAction: null } });
  });

  it('publica aviso de perda sem criar vínculo e aviso da nova sessão uma vez, com transporte simulado', async () => {
    const app = application();
    const open = vi.spyOn(app.conversationService, 'openConversation');
    const button = metaButton();
    await post(app.server, [button, button]); await app.inbox.drain();
    expect(open).not.toHaveBeenCalled(); expect(app.bindings.get(identity)).toBeUndefined();
    expect(app.notices).toHaveLength(1);
    expect(app.notices[0]).toContain('confirmação está indisponível'); expect(app.notices[0]).toContain('nova mensagem de texto');
    await post(app.server, [metaText(), metaText({ id: 'next' })]); await app.inbox.drain();
    expect(open).toHaveBeenCalledOnce(); expect(app.notices).toHaveLength(2);
    expect(app.notices[1]).toContain('nova sessão demonstrativa'); expect(app.notices[1]).toContain('registros anteriores não foram recuperados');
    expect(app.transport.send).toHaveBeenLastCalledWith({ recipientId: identity.senderId, message: { type: 'text', body: app.notices[1] } });
    await post(app.server, [button, metaText()]); await app.inbox.drain();
    expect(app.transport.send).toHaveBeenCalledTimes(2);
    const record = app.inbox.get(key('message-text'))!; assert(record.notice);
    record.notice.body = 'modified';
    expect(app.inbox.get(key('message-text'))?.notice?.body).toBe(app.notices[1]);
  });

  it.each([86_399_999, 86_400_000, 86_400_001])('aviso de botão perdido verifica janela ao processar: idade %s ms', async (age) => {
    let current = start;
    const app = application({ now: () => new Date(current) });
    // Admitir antes, processar depois: sem esperar relógio real nem dormir.
    expect(app.inbox.admit({ ...identity, type: 'button_reply', reference: 'lost', replyToMessageId: 'old-preview',
      messageId: 'click', occurredAt: start })).toBe('accepted');
    current += age;
    await app.inbox.drain();
    expect(app.inbox.get(key('click'))).toMatchObject({ state: 'ignored', code: 'SESSION_UNAVAILABLE' });
    expect(app.transport.send).toHaveBeenCalledTimes(age < 86_400_000 ? 1 : 0);
    expect(app.bindings.get(identity)).toBeUndefined();
    expect(app.inbox.admit({ ...identity, type: 'button_reply', reference: 'lost', replyToMessageId: 'old-preview',
      messageId: 'click', occurredAt: start })).toBe('duplicate');
  });

  it.each(['', '   ', 'a'.repeat(2_001)])('texto inicial inválido não cria sessão', async (text) => {
    const app = application();
    await post(app.server, [metaText({ text: { body: text } })]); await app.inbox.drain();
    expect(app.bindings.get(identity)).toBeUndefined();
    expect(app.inbox.get(key('message-text'))).toMatchObject({ state: 'ignored', code: 'INVALID_INITIAL_TEXT' });
    expect(app.transport.send).not.toHaveBeenCalled();
  });

  it('falha de aviso não elimina resultado salvo, não reexecuta turno e não repete aviso na sessão', async () => {
    const onNotice = vi.fn(async () => { throw new Error('PRIVATE_NOTICE_ERROR'); });
    const app = application({ script: [dialogue(), dialogue()], onNotice });
    await post(app.server, [metaText()]); await app.inbox.drain();
    const record = app.inbox.get(key('message-text'));
    expect(record).toMatchObject({ state: 'processed', noticeError: 'NOTICE_ERROR', notice: { kind: 'new_session' } });
    expect(JSON.stringify(record)).not.toContain('PRIVATE');
    await post(app.server, [metaText(), metaText({ id: 'second' })]); await app.inbox.drain();
    expect(app.process).toHaveBeenCalledTimes(2); expect(onNotice).toHaveBeenCalledOnce();
    expect(app.inbox.get(key('message-text'))).toEqual(record);
    expect(app.inbox.activeQueueCount).toBe(0);
  });

  it('falha do primeiro turno mantém sessão vazia, aviso de reinício e dedupe', async () => {
    const app = application({ script: [dialogue(new Error('PRIVATE_MODEL_ERROR'), { goal: 'viagem' }), dialogue()] });
    const message = metaText({ text: { body: 'Quero estudar para viagem.' } });
    await post(app.server, [message]); await app.inbox.drain();
    const binding = app.bindings.get(identity)!;
    expect(app.conversations.get(binding.conversationId)).toEqual({ id: binding.conversationId, history: [], context: createConversationContext() });
    expect(app.inbox.get(key('message-text'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR', notice: { kind: 'new_session' } });
    expect(app.notices).toHaveLength(1);
    await post(app.server, [message, metaText({ id: 'next' })]); await app.inbox.drain();
    expect(app.process).toHaveBeenCalledTimes(2); expect(app.notices).toHaveLength(1);
    expect(app.bindings.get(identity)).toEqual(binding);
    expect(app.conversations.get(binding.conversationId)?.history).toHaveLength(2);
  });

  it('falha ao abrir sessão não publica vínculo/aviso; nova mensagem pode abrir sem repetir a falha', async () => {
    const app = application();
    vi.spyOn(app.conversations, 'save').mockImplementationOnce(() => { throw new Error('PRIVATE_OPEN_ERROR'); });
    await post(app.server, [metaText()]); await app.inbox.drain();
    expect(app.bindings.get(identity)).toBeUndefined(); expect(app.notices).toEqual([]);
    expect(app.inbox.get(key('message-text'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    await post(app.server, [metaText(), metaText({ id: 'next' })]); await app.inbox.drain();
    expect(app.bindings.get(identity)).toBeDefined(); expect(app.notices).toHaveLength(1);
    expect(app.inbox.get(key('message-text'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(app.inbox.activeQueueCount).toBe(0);
  });
});
