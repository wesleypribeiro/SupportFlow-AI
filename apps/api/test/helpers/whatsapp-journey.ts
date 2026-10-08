import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { expect, vi } from 'vitest';
import { createApplication } from '../../src/app.js';
import { createMetaCloudApiClient } from '../../src/channels/whatsapp/meta/cloud-api-client.js';
import { InMemoryHandoffRepository } from '../../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { InMemoryLeadRepository } from '../../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../../src/modules/language-school/infrastructure/slot-fixtures.js';
import { createJourneyModel } from './journey-script.js';
import type { JourneyScript } from './journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './meta-webhook.js';

export const journeyStart = Date.parse('2030-06-10T12:00:00Z');
export const sender = 'demo-recipient';
export const otherSender = 'other-recipient';
export const identity = (senderId = sender) => ({
  provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId,
});
export const inboxKey = (messageId: string) => ({ ...identity(), messageId });
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_JOURNEY_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: `${sender},${otherSender}`,
};

// Captura o JSON realmente serializado pelo cliente Cloud API. Só o fetch externo
// é simulado: webhook, projeção, filas, motor, lifecycle e repositories são reais.
type GraphPayload = { messaging_product: 'whatsapp'; recipient_type: 'individual'; to: string } & (
  | { type: 'text'; text: { body: string; preview_url: false } }
  | { type: 'interactive'; interactive: { type: 'button'; body: { text: string };
    action: { buttons: { type: 'reply'; reply: { id: string; title: string } }[] } } }
);
export type Publication = { payload: GraphPayload; messageId: string };
export const output = (publications: Publication[]) => publications.map(({ payload }) =>
  payload.type === 'text' ? payload.text.body : payload.interactive.body.text).join('\n');
export function button(publications: Publication[]) {
  const publication = publications.filter(({ payload }) => payload.type === 'interactive').at(-1);
  assert(publication?.payload.type === 'interactive', 'A jornada deve publicar um botão real.');
  const control = publication.payload.interactive.action.buttons[0]; assert(control);
  return { ...publication, reference: control.reply.id, title: control.reply.title };
}
export type Button = ReturnType<typeof button>;
export function clickEvent(id: string, publication: Button, overrides: Record<string, unknown> = {}) {
  return metaButton({ id, from: publication.payload.to, context: { id: publication.messageId },
    interactive: { type: 'button_reply', button_reply: { id: publication.reference, title: publication.title } }, ...overrides });
}

export function createWhatsAppJourney(script: JourneyScript, startedAt = journeyStart) {
  const model = createJourneyModel(script);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const handoffRepository = new InMemoryHandoffRepository();
  const sent: Publication[] = [];
  const reply = vi.fn<(publication: Publication) => Promise<Response>>(async ({ messageId }) =>
    Response.json({ messaging_product: 'whatsapp', messages: [{ id: messageId }] }));
  const graphFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(`https://graph.facebook.com/v26.0/${metaOrigin.phoneNumberId}/messages`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${environment.META_ACCESS_TOKEN}` });
    assert(typeof init?.body === 'string');
    const payload = JSON.parse(init.body) as GraphPayload;
    expect(payload).toMatchObject({ messaging_product: 'whatsapp', recipient_type: 'individual' });
    expect([sender, otherSender]).toContain(payload.to);
    const publication = { payload, messageId: `outbound-${startedAt}-${sent.length + 1}` };
    sent.push(publication);
    return reply(publication);
  });
  const transport = createMetaCloudApiClient({ accessToken: environment.META_ACCESS_TOKEN,
    phoneNumberId: metaOrigin.phoneNumberId, graphApiVersion: 'v26.0' }, { fetch: graphFetch });
  const app = createApplication(environment, {
    model, leadRepository, trialClassRepository, handoffRepository,
    now: () => new Date(journeyStart), whatsappNow: () => new Date(startedAt), whatsappTransport: transport,
  });
  assert(app.whatsappInbox && app.whatsappOutbox && app.whatsappBindings && app.whatsappConfirmationReferences);
  const inbox = app.whatsappInbox;
  const outbox = app.whatsappOutbox;
  const bindings = app.whatsappBindings;
  const references = app.whatsappConfirmationReferences;
  // Spies observacionais: nenhum resultado comercial é fabricado.
  const create = vi.spyOn(leadRepository, 'createForConversation');
  const update = vi.spyOn(leadRepository, 'updateForConversation');
  const reserve = vi.spyOn(trialClassRepository, 'reserveSlot');
  const handoff = vi.spyOn(handoffRepository, 'requestForConversation');
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  const register = vi.spyOn(references, 'getOrCreate');
  const timestamp = String(startedAt / 1_000);
  async function post(messages: unknown[], options: { statuses?: unknown[]; validSignature?: boolean } = {}) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages, statuses: options.statuses ?? [] })])));
    const signature = createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex');
    return app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${options.validSignature === false ? '0'.repeat(64) : signature}`,
    } });
  }
  async function drain() {
    await inbox.drain();
    expect(inbox.activeQueueCount).toBe(0);
    expect(outbox.activeQueueCount).toBe(0);
  }
  async function deliver(event: unknown) {
    const start = sent.length;
    expect((await post([event])).statusCode).toBe(200);
    await drain();
    return sent.slice(start);
  }
  const text = (id: string, body: string, from = sender, overrides: Record<string, unknown> = {}) =>
    deliver(metaText({ id, from, timestamp, text: { body }, ...overrides }));
  const click = (id: string, publication: Button, overrides: Record<string, unknown> = {}) =>
    deliver(clickEvent(id, publication, { timestamp, ...overrides }));
  async function status(publication: Publication, state: string) {
    expect((await post([], { statuses: [metaStatus({ id: publication.messageId,
      recipient_id: publication.payload.to, timestamp, status: state })] })).statusCode).toBe(200);
    await drain();
  }
  function response(id: string) {
    const record = inbox.get(inboxKey(id)); assert(record?.state === 'processed', `Evento ${id} não foi processado.`);
    return languageSchoolChatResponseSchema.parse(record.response);
  }
  function calls() {
    return { model: model.calls.length, context: model.contextCalls.length, create: create.mock.calls.length,
      update: update.mock.calls.length, reserve: reserve.mock.calls.length, handoff: handoff.mock.calls.length,
      confirm: confirm.mock.calls.length };
  }
  async function bookings() {
    return (await Promise.all(slotFixtures.map(({ slotId }) => trialClassRepository.findConfirmedBySlotId(slotId)))).filter((booking) => booking !== null);
  }
  return { ...app, model, leadRepository, trialClassRepository, handoffRepository,
    inbox, outbox, bindings, references, sent, reply, graphFetch, create, update, reserve, handoff, confirm, register,
    post, drain, deliver, text, click, status, response, calls, bookings,
    close: async () => { await drain(); await app.server.close(); },
  };
}
