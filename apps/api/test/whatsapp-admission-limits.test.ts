import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryWhatsAppInbox } from '../src/channels/whatsapp/inbox.js';
import type { WhatsAppInboundMessage } from '../src/channels/whatsapp/inbox.js';
import { registerMetaWebhookRoutes } from '../src/channels/whatsapp/meta/webhook-route.js';
import type { WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const event: WhatsAppInboundMessage = {
  provider: 'meta', accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId,
  senderId: 'demo-recipient', messageId: 'message', type: 'text', text: 'Olá', occurredAt: now().getTime(),
};
const credentials = { ...metaOrigin, appSecret: 'FAKE_SECRET', webhookVerifyToken: 'FAKE_VERIFY' };
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
function post(server: FastifyInstance, messages: unknown[], statuses: unknown[] = []) {
  const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages, statuses })])));
  return server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', credentials.appSecret).update(payload).digest('hex')}`,
  } });
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

describe('3.3 — limites de admissão sem eviction', () => {
  it('limita a execução a 10.000 mensagens, preservando inclusive IDs ignorados após drenar', async () => {
    const inbox = new InMemoryWhatsAppInbox(undefined, { now });
    cleanups.push(() => inbox.drain());
    for (let index = 0; index < 10_000; index++) {
      expect(inbox.admit({ ...event, messageId: String(index), senderId: String(Math.floor(index / 100)) })).toBe('accepted');
    }
    expect(inbox.admit(event)).toBe('capacity');
    expect(inbox.get(event)).toBeUndefined();
    await inbox.drain();
    expect(inbox.activeQueueCount).toBe(0);
    expect(inbox.admit(event)).toBe('capacity');
    for (const index of [0, 4_999, 9_999]) {
      const previous = { ...event, messageId: String(index), senderId: String(Math.floor(index / 100)) };
      const record = inbox.get(previous);
      expect(record).toMatchObject({ state: 'ignored', code: 'PROCESSOR_UNAVAILABLE' });
      expect(inbox.admit(previous)).toBe('duplicate');
      expect(inbox.admit({ ...previous, text: 'Colisão' })).toBe('collision');
      expect(inbox.get(previous)).toEqual(record);
    }
  });

  it('permite 100 aguardando além da mensagem em processamento e libera capacidade por remetente ao drenar', async () => {
    const entered = gate(); const release = gate();
    const process = vi.fn(async (input: WhatsAppInboundMessage) => {
      if (input.messageId === event.messageId) { entered.release(); await release.promise; }
      return { ok: true as const, response: input.messageId };
    });
    const inbox = new InMemoryWhatsAppInbox(process, { now });
    cleanups.push(() => inbox.drain());
    expect(inbox.admit(event)).toBe('accepted'); await entered.promise;
    for (let index = 0; index < 100; index++) {
      expect(inbox.admit({ ...event, messageId: `waiting-${index}` })).toBe('accepted');
    }
    const refused = { ...event, messageId: 'refused' };
    expect(inbox.admit(refused)).toBe('capacity'); expect(inbox.get(refused)).toBeUndefined();
    expect(inbox.admit(event)).toBe('duplicate');
    const other = { ...event, senderId: 'independent', messageId: 'other' };
    expect(inbox.admit(other)).toBe('accepted'); await inbox.drain(other);
    expect(inbox.get(other)?.state).toBe('processed');
    expect(inbox.get(event)?.state).toBe('processing');
    release.release(); await inbox.drain();
    expect(inbox.activeQueueCount).toBe(0);
    expect(inbox.admit(refused)).toBe('accepted'); await inbox.drain();
    expect(process).toHaveBeenCalledTimes(103);
    expect(inbox.admit(event)).toBe('duplicate');
  });

  it('reserva capacidade sincronamente antes de começar e libera espera mesmo após rejeição', async () => {
    const process = vi.fn(async () => { throw new Error('PRIVATE_FAILURE'); });
    const limits = { maxMessages: 2, maxWaitingPerSender: 1 };
    const inbox = new InMemoryWhatsAppInbox(process, { now, limits });
    cleanups.push(() => inbox.drain());
    limits.maxWaitingPerSender = 10; // Configuração também é snapshot.
    const second = { ...event, messageId: 'second' };
    expect(inbox.admit(event)).toBe('accepted');
    expect(inbox.admit(second)).toBe('capacity');
    expect(process).not.toHaveBeenCalled();
    await inbox.drain();
    expect(inbox.admit(second)).toBe('accepted'); await inbox.drain();
    expect(inbox.admit({ ...event, messageId: 'third' })).toBe('capacity');
    expect(inbox.get(event)).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(inbox.admit(event)).toBe('duplicate'); expect(process).toHaveBeenCalledTimes(2);
    expect(inbox.activeQueueCount).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejeita limite inválido %s sem valores em mensagem de erro', (limit) => {
    for (const field of ['maxMessages', 'maxWaitingPerSender']) {
      expect(() => new InMemoryWhatsAppInbox(undefined, { now, limits: { [field]: limit } }))
        .toThrow('Configuração inválida da inbox WhatsApp.');
    }
  });

  it('503 conserva dedupe e resultado; duplicatas/status/antigos têm 200 mesmo com capacidade esgotada', async () => {
    const transport: WhatsAppTransport = { send: vi.fn(async () => ({ status: 'accepted' as const, messageId: 'known-outbound' })) };
    const process = vi.fn(async () => {
      await transport.send({ recipientId: event.senderId, message: { type: 'text', body: 'Resposta oficial' } });
      return { ok: true as const, response: { reply: 'Resposta oficial' } };
    });
    const inbox = new InMemoryWhatsAppInbox(process, { now, limits: { maxMessages: 1 } });
    const server = Fastify(); registerMetaWebhookRoutes(server, credentials, inbox);
    cleanups.push(async () => { await inbox.drain(); await server.close(); });
    const message = metaText({ id: event.messageId });
    expect((await post(server, [message])).statusCode).toBe(200); await inbox.drain();
    const original = inbox.get(event);
    const status = metaStatus({ id: 'known-outbound' });
    const late = metaText({ id: 'late', timestamp: '1907323199' });
    const refused = await post(server, [metaText({ id: 'new' }), message, late], [status, status]);
    expect(refused.statusCode).toBe(503); expect(refused.body).toBe('');
    expect((await post(server, [message, late], [status, status])).statusCode).toBe(200);
    expect((await post(server, [], [status])).statusCode).toBe(200);
    await inbox.drain();
    expect(inbox.get(event)).toEqual(original); expect(process).toHaveBeenCalledOnce();
    expect(transport.send).toHaveBeenCalledOnce();
    for (const messageId of ['new', 'late', 'known-outbound']) expect(inbox.get({ ...event, messageId })).toBeUndefined();
    expect(inbox.activeQueueCount).toBe(0);
  });

  it('lote parcialmente recusado ainda admite outro vínculo; retry deduplica irmãos já admitidos', async () => {
    const entered = gate(); const release = gate();
    const process = vi.fn(async (input: WhatsAppInboundMessage) => {
      if (input.messageId === 'running') { entered.release(); await release.promise; }
      return { ok: true as const, response: input.messageId };
    });
    const inbox = new InMemoryWhatsAppInbox(process, { now, limits: { maxWaitingPerSender: 1 } });
    const server = Fastify(); registerMetaWebhookRoutes(server, credentials, inbox);
    cleanups.push(async () => { await inbox.drain(); await server.close(); });
    await post(server, [metaText({ id: 'running' })]); await entered.promise;
    const messages = [metaText({ id: 'waiting' }), metaText({ id: 'refused' }), metaText({ id: 'other', from: 'other' })];
    expect((await post(server, messages)).statusCode).toBe(503);
    await inbox.drain({ ...event, senderId: 'other' });
    expect(inbox.get({ ...event, messageId: 'other' })?.state).toBe('processed');
    expect(inbox.get({ ...event, messageId: 'refused' })).toBeUndefined();
    release.release(); await inbox.drain();
    expect((await post(server, messages)).statusCode).toBe(200); await inbox.drain();
    expect(process.mock.calls.map(([input]) => input.messageId)).toEqual(['running', 'other', 'waiting', 'refused']);
  });

  it('requisições concorrentes não ultrapassam o limite total', async () => {
    const inbox = new InMemoryWhatsAppInbox(undefined, { now, limits: { maxMessages: 1 } });
    const server = Fastify(); registerMetaWebhookRoutes(server, credentials, inbox);
    cleanups.push(async () => { await inbox.drain(); await server.close(); });
    const responses = await Promise.all(['one', 'two'].map((id) => post(server, [metaText({ id })])));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 503]);
    const admitted = ['one', 'two'].filter((messageId) => inbox.get({ ...event, messageId }));
    expect(admitted).toHaveLength(1);
    expect((await post(server, [metaText({ id: admitted[0] })])).statusCode).toBe(200);
  });
});
