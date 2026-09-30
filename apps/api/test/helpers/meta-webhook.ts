// Dados fictícios no formato do provider; sem chamadas ou credenciais reais.
export const metaOrigin = { wabaId: 'demo-account', phoneNumberId: 'demo-number' };
export function metaText(overrides: Record<string, unknown> = {}) {
  return { id: 'message-text', from: 'demo-recipient', timestamp: '1907323200', type: 'text', text: { body: 'Olá 👋' }, ...overrides };
}
export function metaButton(overrides: Record<string, unknown> = {}) {
  return {
    ...metaText(), id: 'message-button', type: 'interactive', context: { id: 'outbound-preview' },
    interactive: { type: 'button_reply', button_reply: { id: 'opaque-reference', title: 'Confirmar aula' } }, ...overrides,
  };
}
export function metaStatus(overrides: Record<string, unknown> = {}) {
  return { id: 'outbound-message', recipient_id: 'demo-recipient', timestamp: '1907323201', status: 'delivered', ...overrides };
}
export function metaChange(value: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    field: 'messages',
    value: { messaging_product: 'whatsapp', metadata: { phone_number_id: metaOrigin.phoneNumberId }, ...value },
    ...overrides,
  };
}
export function metaEnvelope(changes = [metaChange()], overrides: Record<string, unknown> = {}) {
  return { object: 'whatsapp_business_account', entry: [{ id: metaOrigin.wabaId, changes }], ...overrides };
}
