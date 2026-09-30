import { describe, expect, it } from 'vitest';
import { whatsappEventSchema } from '../src/channels/whatsapp/events.js';
import { projectMetaWebhook } from '../src/channels/whatsapp/meta/webhook-projection.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const source = { provider: 'meta', accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId };
const expectedText = {
  ...source, type: 'text', messageId: 'message-text', senderId: 'demo-recipient', occurredAt: 1_907_323_200_000, text: 'Olá 👋',
};
const expectedButton = {
  ...source, type: 'button_reply', messageId: 'message-button', senderId: 'demo-recipient', occurredAt: 1_907_323_200_000,
  reference: 'opaque-reference', replyToMessageId: 'outbound-preview',
};
const expectedStatus = {
  ...source, type: 'status', messageId: 'outbound-message', recipientId: 'demo-recipient', occurredAt: 1_907_323_201_000, status: 'delivered',
};
const noObservations = { INVALID_MESSAGE: 0, UNSUPPORTED_MESSAGE: 0, INVALID_STATUS: 0, UNSUPPORTED_STATUS: 0, UNSUPPORTED_CHANGE: 0 };
function projectItems(messages: unknown[], statuses: unknown[] = []) {
  const result = projectMetaWebhook(metaEnvelope([metaChange({ messages, statuses })]), metaOrigin);
  expect(result.status).toBe(200);
  if (result.status !== 200) throw new Error('Projeção deveria ser válida');
  return result;
}

describe('projeção Meta de lotes autorizados', () => {
  it('percorre todas as entradas/alterações/mensagens/status sem ordenar ou deduplicar', () => {
    const result = projectMetaWebhook(metaEnvelope([], { entry: [
      { id: metaOrigin.wabaId, changes: [
        metaChange({ messages: [metaText(), metaButton()], statuses: [metaStatus(), metaStatus({ status: 'sent' })] }),
        metaChange({ messages: [metaText({ id: 'second-change' })], statuses: [metaStatus({ status: 'read' })] }),
      ] },
      { id: metaOrigin.wabaId, changes: [metaChange({ messages: [metaText()], statuses: [metaStatus({ status: 'failed' })] })] },
    ] }), metaOrigin);
    expect(result).toEqual({ status: 200, observations: noObservations, events: [
      expectedText, expectedButton, expectedStatus, { ...expectedStatus, status: 'sent' },
      { ...expectedText, messageId: 'second-change' }, { ...expectedStatus, status: 'read' },
      expectedText, { ...expectedStatus, status: 'failed' },
    ] });
  });

  it.each([
    metaEnvelope([], { entry: [] }), metaEnvelope([]), metaEnvelope(),
    metaEnvelope([metaChange({ messages: [], statuses: [] })]),
  ])('reconhece lote vazio de estrutura válida', (input) => {
    expect(projectMetaWebhook(input, metaOrigin)).toEqual({ status: 200, events: [], observations: noObservations });
  });

  it('mantém IDs opacos, identidade somente de from e context.id apenas como correlação', () => {
    const id = '00090071992547409931234';
    const input = metaEnvelope([], { entry: [{ id, changes: [metaChange({ metadata: { phone_number_id: id }, messages: [metaText({
      id, from: 'Opaque Sender', context: { id, from: 'context-not-sender' },
    })], contacts: [{ wa_id: 'another-sender', profile: { name: 'Nome externo' } }] })] }] });
    const result = projectMetaWebhook(input, { wabaId: id, phoneNumberId: id });
    expect(result).toEqual({ status: 200, observations: noObservations, events: [{
      ...expectedText, accountId: id, phoneNumberId: id, senderId: 'Opaque Sender', messageId: id, replyToMessageId: id,
    }] });
  });

  it('descarta extensões e autoridade externa em todos os níveis, sem reter referências', () => {
    const extras = { conversationId: 'foreign-conversation', schoolId: 'foreign-school', actionId: 'foreign-action',
      confirmed: true, revision: 99, history: ['invented'], model: { apiKey: 'FAKE_KEY' }, context: { name: 'Nome', leadId: 'lead' } };
    const text = metaText({ ...extras, text: { body: 'Olá 👋', ...extras }, context: { id: 'reply-id', ...extras } });
    const button = metaButton({ ...extras, context: { id: 'outbound-preview', ...extras }, interactive: {
      type: 'button_reply', ...extras, button_reply: { id: 'opaque-reference', title: 'Reserva confirmada!', ...extras },
    } });
    const status = metaStatus({ ...extras, errors: [{ title: 'PRIVATE_ERROR', code: 123 }], conversation: { id: 'billing-conversation' }, pricing: { billable: true } });
    const input = metaEnvelope([], { ...extras, entry: [{ id: metaOrigin.wabaId, ...extras, changes: [metaChange({
      ...extras, metadata: { phone_number_id: metaOrigin.phoneNumberId, ...extras },
      contacts: [{ profile: { name: 'PROFILE_NAME' }, wa_id: 'profile-id' }], messages: [text, button], statuses: [status],
    }, extras)] }] });
    const result = projectMetaWebhook(input, metaOrigin);
    expect(result).toEqual({ status: 200, observations: noObservations, events: [
      { ...expectedText, replyToMessageId: 'reply-id' }, expectedButton, expectedStatus,
    ] });
    text.text.body = 'changed';
    expect(JSON.stringify(result)).not.toMatch(/foreign|invented|FAKE_KEY|PROFILE_NAME|billing-conversation|PRIVATE_ERROR|changed/);
  });

  it('preserva texto vazio, espaços e texto acima de 2.000 sem trim/truncamento para validação posterior do canal', () => {
    for (const body of ['', '   ', ' Olá 👋\n', 'a'.repeat(2_001), 'a'.repeat(4_096)]) {
      expect(projectItems([metaText({ text: { body } })]).events).toEqual([{ ...expectedText, text: body }]);
    }
  });

  it('aceita status sem destinatário sem inventar identidade a partir de contatos', () => {
    expect(projectItems([], [metaStatus({ recipient_id: undefined })]).events).toEqual([{
      ...source, type: 'status', messageId: 'outbound-message', occurredAt: 1_907_323_201_000, status: 'delivered',
    }]);
  });
});

describe('origem e estrutura básica antes da projeção', () => {
  it.each([
    metaEnvelope([metaChange({ messages: [metaText()] })], { object: 'another-object' }),
    metaEnvelope([], { entry: [
      { id: metaOrigin.wabaId, changes: [metaChange({ messages: [metaText()] })] },
      { id: 'another-account', changes: [metaChange({ statuses: [metaStatus()] })] },
    ] }),
    metaEnvelope([metaChange({ messages: [metaText()] }), metaChange({ metadata: { phone_number_id: 'another-number' } })]),
  ])('origem estrangeira em qualquer posição recusa todo o lote sem eventos parciais', (input) => {
    expect(projectMetaWebhook(input, metaOrigin)).toEqual({ status: 403 });
  });

  it.each([
    null, [], true, {}, { object: 'whatsapp_business_account' },
    metaEnvelope([], { object: 1 }), metaEnvelope([], { entry: {} }),
    metaEnvelope([], { entry: [null] }), metaEnvelope([], { entry: [{ id: 123, changes: [] }] }),
    metaEnvelope([], { entry: [{ id: metaOrigin.wabaId, changes: {} }] }),
    metaEnvelope([metaChange({}, { value: null })]), metaEnvelope([metaChange({}, { field: 123 })]),
    metaEnvelope([metaChange({ metadata: {} })]), metaEnvelope([metaChange({ metadata: { phone_number_id: 123 } })]),
    metaEnvelope([metaChange({ messaging_product: 'other' })]),
    metaEnvelope([metaChange({ messages: {} })]), metaEnvelope([metaChange({ statuses: null })]),
  ])('estrutura básica inválida produz 400 sem coerção (%j)', (input) => {
    expect(projectMetaWebhook(input, metaOrigin)).toEqual({ status: 400 });
  });
});

describe('itens inválidos são isolados', () => {
  it.each([
    undefined, null, 1, -1, '', ' ', '-1', '+1', '1.5', '1e3', '0x10', 'NaN', 'Infinity',
    '1907323200 ', '1907323200\n', '2030-06-10T12:00:00Z', '8640000000001', '9007199254740993', '9'.repeat(100),
  ])('timestamp inválido em texto/botão/status não afeta irmãos (%j)', (timestamp) => {
    const result = projectItems([metaText(), metaText({ timestamp }), metaButton({ timestamp }), metaButton()], [metaStatus({ timestamp }), metaStatus()]);
    expect(result.events).toEqual([expectedText, expectedButton, expectedStatus]);
    expect(result.observations).toEqual({ ...noObservations, INVALID_MESSAGE: 2, INVALID_STATUS: 1 });
  });

  it.each([['0', 0], ['0001907323200', 1_907_323_200_000], ['8640000000000', 8_640_000_000_000_000]])(
    'converte explicitamente segundos inteiros válidos %s para milissegundos', (timestamp, occurredAt) => {
      expect(projectItems([metaText({ timestamp })]).events).toEqual([{ ...expectedText, occurredAt }]);
    },
  );

  it.each([
    null, [], 'malformed', {},
    metaText({ id: 123 }), metaText({ id: '' }), metaText({ from: null }), metaText({ from: '' }),
    metaText({ type: 1 }), metaText({ text: null }), metaText({ text: { body: 12 } }),
    metaText({ text: { body: 'x'.repeat(4_097) } }), metaText({ id: 'x'.repeat(1_025) }),
    metaText({ context: { id: 123 } }), metaText({ context: {} }),
    metaButton({ context: undefined }), metaButton({ context: { id: '' } }),
    metaButton({ interactive: {} }), metaButton({ interactive: { type: 'button_reply' } }),
    metaButton({ interactive: { type: 'button_reply', button_reply: { id: 123 } } }),
    metaButton({ interactive: { type: 'button_reply', button_reply: { id: '' } } }),
    metaButton({ interactive: { type: 'button_reply', button_reply: { id: 'x'.repeat(257) } } }),
  ])('descarta só a mensagem malformada com código e contagem sanitizados', (item) => {
    const result = projectItems([metaText(), item, metaButton()], [metaStatus()]);
    expect(result.events).toEqual([expectedText, expectedButton, expectedStatus]);
    expect(result.observations).toEqual({ ...noObservations, INVALID_MESSAGE: 1 });
  });

  it.each([null, [], {}, metaStatus({ id: 1 }), metaStatus({ id: '' }), metaStatus({ recipient_id: 1 }),
    metaStatus({ recipient_id: '' }), metaStatus({ status: null }), metaStatus({ timestamp: null }),
  ])('descarta só o status malformado, sem perder mensagens/status irmãos', (item) => {
    const result = projectItems([metaText()], [metaStatus(), item, metaStatus({ status: 'read' })]);
    expect(result.events).toEqual([expectedText, expectedStatus, { ...expectedStatus, status: 'read' }]);
    expect(result.observations).toEqual({ ...noObservations, INVALID_STATUS: 1 });
  });
});

describe('eventos não suportados e contratos internos', () => {
  it.each(['image', 'audio', 'video', 'document', 'sticker', 'reaction', 'location', 'contacts', 'button', 'unknown-future-type'])(
    'ignora %s sem promover legenda/payload/texto a evento conversacional', (type) => {
      const result = projectItems([metaText({ type, [type]: { id: 'media', url: 'https://example.invalid/private', caption: 'Confirme' },
        button: { payload: 'opaque-reference', text: 'sim' }, context: { id: 'outbound-preview' } })]);
      expect(result).toEqual({ status: 200, events: [], observations: { ...noObservations, UNSUPPORTED_MESSAGE: 1 } });
    },
  );

  it.each(['list_reply', 'nfm_reply', 'future_reply'])('ignora interactive.%s mesmo com button_reply injetado', (type) => {
    expect(projectItems([metaButton({ interactive: { type, button_reply: { id: 'opaque-reference' } } })])).toEqual({
      status: 200, events: [], observations: { ...noObservations, UNSUPPORTED_MESSAGE: 1 },
    });
  });

  it('ignora status e field desconhecidos, sem aceitar status internos do transporte', () => {
    const result = projectMetaWebhook(metaEnvelope([
      metaChange({ statuses: ['accepted', 'deleted', 'future'].map((status) => metaStatus({ status })) }),
      metaChange({ messages: [metaText()] }, { field: 'unknown-change' }),
    ]), metaOrigin);
    expect(result).toEqual({ status: 200, events: [], observations: { ...noObservations, UNSUPPORTED_STATUS: 3, UNSUPPORTED_CHANGE: 1 } });
  });

  it.each([expectedText, expectedButton, expectedStatus])('união interna rejeita extras e tipos cruzados em $type', (event) => {
    expect(whatsappEventSchema.parse(event)).toEqual(event);
    for (const extra of [{ confirmed: true }, { conversationId: 'foreign' }, { context: {} }, { schoolId: 'school' },
      { history: [] }, { actionId: 'action' }, { model: {} }, { title: 'confirmado' }]) {
      expect(whatsappEventSchema.safeParse({ ...event, ...extra }).success).toBe(false);
    }
    expect(whatsappEventSchema.safeParse({ ...event, occurredAt: '1907323200' }).success).toBe(false);
    expect(whatsappEventSchema.safeParse({ ...event, messageId: 123 }).success).toBe(false);
    expect(whatsappEventSchema.safeParse({ ...event, type: 'image' }).success).toBe(false);
  });
});
