import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { languageSchoolPendingActionSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryWhatsAppConfirmationReferences } from '../src/channels/whatsapp/confirmation-references.js';
import { InMemoryWhatsAppConversationBindings } from '../src/channels/whatsapp/conversation-bindings.js';
import type { WhatsAppConversationIdentity } from '../src/channels/whatsapp/conversation-bindings.js';
import type { WhatsAppEvent } from '../src/channels/whatsapp/events.js';
import { projectMetaWebhook } from '../src/channels/whatsapp/meta/webhook-projection.js';
import type { WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { createJourneyModel, dialogue, leadTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaText } from './helpers/meta-webhook.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const identity: WhatsAppConversationIdentity = {
  provider: 'meta', accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: 'demo-recipient',
};
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient,other-recipient',
};
const preview = { name: 'Nome privado fictício', contact: { type: 'email' as const, value: 'private@example.com' },
  courseId: 'course_english_travel', goal: 'Objetivo privado fictício' };
const denied = { ok: false, code: 'INVALID_CONFIRMATION' };
const cleanups: (() => Promise<void>)[] = [];

function button(reference: string, replyToMessageId = 'outbound-preview'): WhatsAppEvent {
  return { ...identity, type: 'button_reply', messageId: 'inbound-click', occurredAt: now().getTime(), reference, replyToMessageId };
}
function request(reference: string): WhatsAppSendRequest {
  return { recipientId: identity.senderId, message: {
    type: 'reply_buttons', body: 'Prévia de teste', buttons: [{ id: reference, title: 'Confirmar cadastro' }],
  } };
}
function application(script: JourneyScript = []) {
  const model = createJourneyModel(script);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const send = vi.fn<WhatsAppTransport['send']>(async () => ({ status: 'accepted', messageId: 'outbound-text' }));
  const app = createApplication(environment, { model, leadRepository, trialClassRepository, now, whatsappTransport: { send } });
  cleanups.push(async () => { await app.whatsappInbox!.drain(); await app.server.close(); });
  assert(app.whatsappBindings && app.whatsappConfirmationReferences && app.whatsappInbox);
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  async function post(messages: unknown[]) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages })])));
    const result = await app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
    await app.whatsappInbox!.drain();
    return result;
  }
  return { ...app, bindings: app.whatsappBindings, references: app.whatsappConfirmationReferences, inbox: app.whatsappInbox,
    model, leadRepository, trialClassRepository, confirm, send, post };
}
type App = ReturnType<typeof application>;

// Ação realmente commitada no lifecycle; a task 5.1 não publica botões nem
// conecta o resultado da resolução a confirmAction (tasks 5.2/5.3).
async function prepare(app: App, sender = identity) {
  const opened = await app.bindings.getOrCreate(sender); assert(opened.ok);
  const binding = opened.response;
  const action = await app.prepareAction(binding.conversationId, { kind: 'create_lead', preview });
  const record = app.references.getOrCreate(binding, action);
  return { binding, action, record, reference: record.reference };
}
function accept(app: App, reference: string, messageId = 'outbound-preview') {
  expect(app.references.recordSendResult(reference, request(reference), { status: 'accepted', messageId })).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida.'); }));
  vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('5.1 — referências privadas de confirmação WhatsApp', () => {
  it('compõe somente com o canal habilitado e gera referência aleatória sem PII, args ou IDs internos codificados', async () => {
    const disabled = createApplication({}); cleanups.push(() => disabled.server.close());
    expect(disabled.whatsappConfirmationReferences).toBeUndefined();
    const app = application();
    const { binding, action, reference } = await prepare(app);
    const supplied = { ...action, reference: 'external-reference', args: preview, confirmed: true, revision: 999 };
    const record = app.references.getOrCreate(binding, supplied);
    expect(record).toEqual({ reference, binding, actionId: action.actionId, kind: 'create_lead', messageIds: [] });
    expect(reference).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(reference, 'base64url')).toHaveLength(32);
    for (const value of [preview.name, preview.contact.value, preview.courseId, preview.goal, binding.conversationId,
      action.actionId, action.kind, identity.senderId, 'external-reference']) expect(reference).not.toContain(value);
    const next = await prepare(app);
    expect(next.reference).not.toBe(reference);
    expect(app.references.get(reference)).toEqual(record);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.model.calls).toHaveLength(0);
    expect(await app.leadRepository.findByConversationId(binding.conversationId)).toBeNull();
  });

  it('só resolve depois do aceite identificável do botão, sem tratar aceite como entrega ou confirmação', async () => {
    const app = application(); const { reference, binding, action } = await prepare(app);
    const outbound = request(reference);
    const transport: WhatsAppTransport = { send: async () => {
      expect(app.references.resolve(button(reference))).toEqual(denied);
      expect(app.references.get(reference)?.messageIds).toEqual([]);
      return { status: 'accepted', messageId: 'outbound-preview' };
    } };
    const result = await transport.send(outbound);
    expect(app.references.recordSendResult(reference, outbound, result)).toBe(true);
    expect(app.references.resolve(button(reference))).toEqual({ ok: true, target: {
      conversationId: binding.conversationId, actionId: action.actionId, kind: 'create_lead',
    } });
    expect(app.references.get(reference)?.messageIds).toEqual(['outbound-preview']);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.model.calls).toHaveLength(0);
    expect(await app.leadRepository.findByConversationId(binding.conversationId)).toBeNull();
  });

  it.each<WhatsAppSendResult>([
    { status: 'rejected', reason: 'provider_rejection' },
    { status: 'unknown', reason: 'timeout' },
    { status: 'unknown', reason: 'network_error' },
    { status: 'unknown', reason: 'invalid_response' },
  ])('$status/$reason não permite promover context.id externo a mensagem conhecida', async (result) => {
    const app = application(); const { reference } = await prepare(app);
    expect(app.references.recordSendResult(reference, request(reference), result)).toBe(false);
    expect(app.references.resolve(button(reference))).toEqual(denied);
    expect(app.references.get(reference)?.messageIds).toEqual([]);
    accept(app, reference, 'identifiable-retry');
    expect(app.references.resolve(button(reference))).toEqual(denied);
    expect(app.references.resolve(button(reference, 'identifiable-retry')).ok).toBe(true);
  });

  it.each([undefined, null, '', '  ', 123, 'x'.repeat(1_025)])('recusa aceite sem messageId válido (%j)', async (messageId) => {
    const app = application(); const { reference } = await prepare(app);
    const malformed = { status: 'accepted', messageId } as WhatsAppSendResult;
    expect(app.references.recordSendResult(reference, request(reference), malformed)).toBe(false);
    expect(app.references.resolve(button(reference))).toEqual(denied);
  });

  it('não associa texto, destinatário diferente, outro botão ou referência inexistente ao aceite', async () => {
    const app = application(); const { reference } = await prepare(app);
    const result: WhatsAppSendResult = { status: 'accepted', messageId: 'outbound-preview' };
    for (const outbound of [
      { ...request(reference), message: { type: 'text' as const, body: reference } },
      { ...request(reference), recipientId: 'other-recipient' }, request('another-reference'),
    ]) expect(app.references.recordSendResult(reference, outbound, result)).toBe(false);
    expect(app.references.recordSendResult('unknown', request('unknown'), result)).toBe(false);
    expect(app.references.resolve(button(reference))).toEqual(denied);
    expect(app.references.get(reference)?.messageIds).toEqual([]);
  });

  it('preserva todos os IDs aceitos da mesma prévia, sem duplicatas, trim ou conversão', async () => {
    const app = application(); const { reference } = await prepare(app);
    const ids = ['00090071992547409931234', ' Message:Id ', 'message:id'];
    for (const id of [...ids, ids[0]!]) accept(app, reference, id);
    expect(app.references.get(reference)?.messageIds).toEqual(ids);
    for (const id of ids) expect(app.references.resolve(button(reference, id)).ok).toBe(true);
    for (const id of ['90071992547409931234', 'Message:Id', 'MESSAGE:ID', 'inbound-click']) {
      expect(app.references.resolve(button(reference, id))).toEqual(denied);
    }
  });

  it('usa cópias defensivas e projeção explícita; nenhum retorno ou argumento altera o vínculo armazenado', async () => {
    const app = application(); const { binding, action, reference, record } = await prepare(app);
    const expected = structuredClone(record);
    binding.conversationId = 'foreign-conversation'; binding.identity.senderId = 'other-recipient';
    action.actionId = 'foreign-action'; action.kind = 'schedule_trial_class';
    record.binding.identity.accountId = 'foreign-account'; record.kind = 'schedule_trial_class';
    record.messageIds.push('invented'); record.actionId = 'invented';
    expect(app.references.get(reference)).toEqual(expected);
    const read = app.references.get(reference)!; read.messageIds.push('invented'); read.binding.conversationId = 'invented';
    expect(app.references.resolve(button(reference, 'invented'))).toEqual(denied);
    accept(app, reference);
    const resolved = app.references.resolve(button(reference)); assert(resolved.ok);
    resolved.target.actionId = 'changed'; resolved.target.kind = 'changed'; resolved.target.conversationId = 'changed';
    expect(app.references.resolve(button(reference))).toEqual({ ok: true, target: {
      conversationId: expected.binding.conversationId, actionId: expected.actionId, kind: expected.kind,
    } });
    expect(expected.messageIds).toEqual([]);
  });

  it('recusa registro com conversa estrangeira ou kind substituído, preservando a referência original', async () => {
    const app = application(); const { binding, action, reference, record } = await prepare(app);
    const other = await prepare(app, { ...identity, senderId: 'other-recipient' });
    for (const candidate of [
      { ...binding, conversationId: other.binding.conversationId },
      { ...binding, identity: { ...identity, senderId: 'unknown-sender' } },
    ]) expect(() => app.references.getOrCreate(candidate, action)).toThrow('Vínculo de confirmação indisponível.');
    expect(() => app.references.getOrCreate(binding, { ...action, kind: 'schedule_trial_class' }))
      .toThrow('Vínculo de confirmação indisponível.');
    expect(app.references.get(reference)).toEqual(record);
    expect(app.references.getOrCreate(binding, action)).toEqual(record);
  });

  it.each(['provider', 'accountId', 'phoneNumberId', 'senderId'] as const)('recusa referência estrangeira por %s sem revelar seu proprietário', async (field) => {
    const app = application(); const { reference, binding } = await prepare(app); accept(app, reference);
    const foreign = { ...identity, [field]: `foreign-${field}` };
    if (field !== 'provider') await app.bindings.getOrCreate(foreign);
    expect(app.references.resolve({ ...button(reference), ...foreign })).toEqual(denied);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.model.calls).toHaveLength(0);
    expect(await app.leadRepository.findByConversationId(binding.conversationId)).toBeNull();
  });

  it('recusa referência desconhecida/manipulada e troca de mensagem entre prévias; não redireciona para a ação atual', async () => {
    const app = application(); const first = await prepare(app); accept(app, first.reference, 'first-preview');
    const second = await prepare(app); accept(app, second.reference, 'second-preview');
    for (const reference of ['unknown', `${first.reference}!`, ` ${first.reference}`, first.action.actionId, first.binding.conversationId]) {
      expect(app.references.resolve(button(reference, 'first-preview'))).toEqual(denied);
    }
    expect(app.references.resolve(button(first.reference, 'second-preview'))).toEqual(denied);
    expect(app.references.resolve(button(second.reference, 'first-preview'))).toEqual(denied);
    expect(app.references.resolve(button(first.reference, 'first-preview'))).toEqual({ ok: true, target: {
      conversationId: first.binding.conversationId, actionId: first.action.actionId, kind: first.action.kind,
    } });
    expect(app.references.resolve(button(second.reference, 'second-preview'))).toEqual({ ok: true, target: {
      conversationId: second.binding.conversationId, actionId: second.action.actionId, kind: second.action.kind,
    } });
    expect(app.confirm).not.toHaveBeenCalled();
  });

  it('mantém cadastro e aula ligados aos respectivos actionId/kind e mensagens, sem reutilizar a referência', async () => {
    const app = application([leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
      courseReference: 'inglês', goal: 'viagem' })]);
    const opened = await app.bindings.getOrCreate(identity); assert(opened.ok);
    const binding = opened.response;
    const proposed = await app.conversationService.sendMessage({ conversationId: binding.conversationId,
      message: 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.' });
    assert(proposed.ok && proposed.response.pendingAction);
    const lead = app.references.getOrCreate(binding, proposed.response.pendingAction); accept(app, lead.reference, 'lead-preview');
    // Preparação da fixture de aula pelo serviço/caso de uso já existente.
    const confirmed = await app.conversationService.confirmAction({ conversationId: binding.conversationId, actionId: lead.actionId });
    assert(confirmed.ok);
    const conversation = app.conversations.get(binding.conversationId)!;
    conversation.context.slotId = 'slot_english_a'; app.conversations.save(conversation);
    const proposal = await app.prepareTrialClass(binding.conversationId, { leadId: conversation.context.leadId, slotId: 'slot_english_a' });
    const trial = app.references.getOrCreate(binding, languageSchoolPendingActionSchema.parse(proposal.pendingAction));
    accept(app, trial.reference, 'trial-preview'); app.confirm.mockClear();
    const calls = app.model.calls.length;
    expect(trial.reference).not.toBe(lead.reference); expect(trial.actionId).not.toBe(lead.actionId);
    for (const [record, messageId, kind] of [[lead, 'lead-preview', 'create_lead'], [trial, 'trial-preview', 'schedule_trial_class']] as const) {
      expect(app.references.resolve(button(record.reference, messageId))).toEqual({ ok: true, target: {
        conversationId: binding.conversationId, actionId: record.actionId, kind,
      } });
    }
    expect(app.references.resolve(button(lead.reference, 'trial-preview'))).toEqual(denied);
    expect(app.references.resolve(button(trial.reference, 'lead-preview'))).toEqual(denied);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.model.calls).toHaveLength(calls);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
  });

  it('recusa vínculo perdido ou reassociado a outra conversa, sem criar sessão; reinício não recupera referência', async () => {
    const app = application(); const { binding, action } = await prepare(app);
    let currentBindings = app.bindings;
    const references = new InMemoryWhatsAppConfirmationReferences({ get: (sender) => currentBindings.get(sender) });
    const { reference } = references.getOrCreate(binding, action);
    references.recordSendResult(reference, request(reference), { status: 'accepted', messageId: 'outbound-preview' });
    currentBindings = new InMemoryWhatsAppConversationBindings(app.conversationService);
    const open = vi.spyOn(app.conversationService, 'openConversation');
    expect(references.resolve(button(reference))).toEqual(denied); expect(open).not.toHaveBeenCalled();
    const replacement = await currentBindings.getOrCreate(identity); assert(replacement.ok);
    expect(replacement.response.conversationId).not.toBe(binding.conversationId);
    expect(references.resolve(button(reference))).toEqual(denied);
    const restarted = new InMemoryWhatsAppConfirmationReferences(app.bindings);
    expect(restarted.resolve(button(reference))).toEqual(denied);
  });

  it.each(['Confirmar cadastro', 'Confirmar aula', 'sim', undefined, { confirmed: true }])('título %j não muda o alvo nem concede autoridade', async (title) => {
    const app = application(); const { reference, action, binding } = await prepare(app); accept(app, reference);
    for (const suppliedReference of [reference, 'unknown']) {
      const projected = projectMetaWebhook(metaEnvelope([metaChange({ messages: [metaButton({
        conversationId: 'foreign', actionId: 'foreign', kind: 'schedule_trial_class', confirmed: true,
        context: { id: 'outbound-preview', from: 'foreign-sender' },
        interactive: { type: 'button_reply', button_reply: { id: suppliedReference, title, args: preview, revision: 999 } },
      })] })]), metaOrigin);
      assert(projected.status === 200); expect(projected.events).toHaveLength(1);
      expect(projected.events[0]).not.toHaveProperty('title');
      expect(app.references.resolve(projected.events[0])).toEqual(suppliedReference === reference
        ? { ok: true, target: { conversationId: binding.conversationId, actionId: action.actionId, kind: 'create_lead' } }
        : denied);
    }
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.model.calls).toHaveLength(0);
  });

  it.each(['reference', 'replyToMessageId', 'senderId', 'messageId', 'accountId', 'phoneNumberId', 'provider', 'occurredAt'])(
    'evento interno incompleto sem %s é recusado', async (field) => {
      const app = application(); const { reference } = await prepare(app); accept(app, reference);
      const incomplete: Record<string, unknown> = { ...button(reference) }; delete incomplete[field];
      expect(app.references.resolve(incomplete)).toEqual(denied);
    });

  it('webhook assinado descarta respostas interativas incompletas antes da inbox/modelo/confirmação', async () => {
    const app = application(); const { reference, binding } = await prepare(app); accept(app, reference);
    const messages = [
      { context: undefined }, { context: {} }, { context: { id: '' } }, { context: { id: 123 } },
      { interactive: undefined }, { interactive: { button_reply: { id: reference } } },
      { interactive: { type: 'button_reply' } },
      ...[undefined, '', 123].map((id) => ({ interactive: { type: 'button_reply', button_reply: { id, title: reference } } })),
    ].map((overrides, index) => metaButton({ id: `incomplete-${index}`,
      interactive: { type: 'button_reply', button_reply: { id: reference, title: 'Confirmar cadastro' } }, ...overrides }));
    expect((await app.post(messages)).statusCode).toBe(200);
    for (const message of messages) expect(app.inbox.get({ ...identity, messageId: message.id })).toBeUndefined();
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    expect(app.confirm).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled();
    expect(app.conversations.get(binding.conversationId)?.history).toEqual([]);
    expect(await app.leadRepository.findByConversationId(binding.conversationId)).toBeNull();
  });

  it('IDs e JSON digitados, mesmo respondendo à prévia aceita, nunca chamam confirmação', async () => {
    const app = application([leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
      courseReference: 'inglês', goal: 'viagem' }), ...Array.from({ length: 6 }, () => dialogue())]);
    expect((await app.post([metaText({ id: 'lead', text: { body: 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.' } })])).statusCode).toBe(200);
    const record = app.inbox.get({ ...identity, messageId: 'lead' }); assert(record?.state === 'processed');
    const { pendingAction: action, conversationId } = record.response; assert(action);
    const binding = app.bindings.get(identity)!;
    const { reference } = app.references.getOrCreate(binding, action); accept(app, reference);
    const before = app.conversations.get(conversationId)!.context;
    const texts = [reference, action.actionId, conversationId, 'outbound-preview', 'sim',
      JSON.stringify({ conversationId, actionId: action.actionId, reference, confirmed: true, kind: 'create_lead' })];
    for (const [index, text] of texts.entries()) {
      const event: WhatsAppEvent = { ...identity, type: 'text', messageId: `typed-${index}`, occurredAt: now().getTime(),
        text, replyToMessageId: 'outbound-preview' };
      expect(app.references.resolve(event)).toEqual(denied);
      expect((await app.post([metaText({ id: event.messageId, text: { body: text }, context: { id: event.replyToMessageId },
        reference, actionId: action.actionId, conversationId, confirmed: true })])).statusCode).toBe(200);
      expect(app.inbox.get(event)).toMatchObject({ state: 'processed', response: { pendingAction: action } });
    }
    expect(app.confirm).not.toHaveBeenCalled();
    expect(app.conversations.get(conversationId)!.context).toEqual(before);
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    expect(app.model.contextCalls).toHaveLength(7);
  });
});
