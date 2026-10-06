import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetaCloudApiClient } from '../src/channels/whatsapp/meta/cloud-api-client.js';
import type { WhatsAppMessage, WhatsAppSendRequest } from '../src/channels/whatsapp/transport.js';

const config = {
  accessToken: 'FAKE_BACKEND_ACCESS_TOKEN',
  phoneNumberId: '00090071992547409931234',
  graphApiVersion: 'v26.0' as const,
};
const recipientId = '00090071992547409935678';
const text: WhatsAppMessage = { type: 'text', body: ' Olá! Curso: R$ 350,00.\n😀 https://example.com ' };
const buttons: WhatsAppMessage = {
  type: 'reply_buttons', body: 'Nome: Ana\nContato: ana@example.com\nRevise todos os dados.',
  buttons: [{ id: 'opaque-backend-reference', title: 'Confirmar cadastro' }],
};
const acceptedBody = {
  messaging_product: 'whatsapp', contacts: [{ input: recipientId, wa_id: recipientId }],
  messages: [{ id: 'wamid.accepted-test' }],
};
const errorBody = {
  error: { code: 100, type: 'OAuthException', message: 'FAKE_PROVIDER_PRIVATE_MESSAGE',
    error_data: { details: 'FAKE_PRIVATE_PREVIEW' }, fbtrace_id: 'FAKE_PRIVATE_TRACE' },
};
function setup(response: () => Response = () => Response.json(acceptedBody)) {
  const providerFetch = vi.fn<typeof fetch>(async () => response());
  return { providerFetch, client: createMetaCloudApiClient(config, { fetch: providerFetch }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('cliente Meta Cloud API com fetch simulado', () => {
  const externalFetch = vi.fn(() => { throw new Error('Rede externa proibida nos testes.'); });
  beforeEach(() => { vi.stubGlobal('fetch', externalFetch); });
  afterEach(() => {
    expect(externalFetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { message: text, payload: { type: 'text', text: { body: text.body, preview_url: false } } },
    { message: buttons, payload: {
      type: 'interactive', interactive: {
        type: 'button', body: { text: buttons.body },
        action: { buttons: [{ type: 'reply', reply: { id: 'opaque-backend-reference', title: 'Confirmar cadastro' } }] },
      },
    } },
  ])('envia $message.type ao destinatário exato com versão fixa e Bearer backend', async ({ message, payload }) => {
    const { providerFetch, client } = setup();
    expect(providerFetch).not.toHaveBeenCalled();
    const request = { recipientId, message };
    const original = structuredClone(request);
    expect(await client.send(request)).toEqual({ status: 'accepted', messageId: 'wamid.accepted-test' });
    expect(providerFetch).toHaveBeenCalledExactlyOnceWith(
      `https://graph.facebook.com/v26.0/${config.phoneNumberId}/messages`,
      {
        method: 'POST', headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipientId, ...payload }),
        signal: expect.any(AbortSignal), redirect: 'error',
      },
    );
    expect(request).toEqual(original);
    expect(providerFetch.mock.calls[0]?.[1]?.body).not.toContain(config.accessToken);
  });

  it('mantém IDs opacos, codifica o segmento da URL e captura a configuração na criação', async () => {
    const backendConfig = { ...config, phoneNumberId: 'business/opaque?query#fragment' };
    const providerFetch = vi.fn<typeof fetch>(async () => Response.json({ ...acceptedBody, messages: [{ id: '00090071992547409939999' }] }));
    const client = createMetaCloudApiClient(backendConfig, { fetch: providerFetch });
    backendConfig.accessToken = 'CHANGED_TOKEN';
    backendConfig.phoneNumberId = 'CHANGED_NUMBER';
    const result = await client.send({ recipientId: 'opaque:visitor@example', message: text });
    expect(result).toEqual({ status: 'accepted', messageId: '00090071992547409939999' });
    expect(providerFetch.mock.calls[0]?.[0]).toBe('https://graph.facebook.com/v26.0/business%2Fopaque%3Fquery%23fragment/messages');
    expect(providerFetch.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(providerFetch.mock.calls[0]?.[1]?.body)).to).toBe('opaque:visitor@example');
  });

  it.each<WhatsAppMessage>([
    { type: 'text', body: '😀'.repeat(2048) },
    { type: 'reply_buttons', body: '😀'.repeat(512), buttons: [
      { id: 'i'.repeat(256), title: 't'.repeat(20) },
      { id: 'second', title: 'Confirmar aula' },
      { id: 'third', title: 'Confirmar cadastro' },
    ] },
  ])('aceita limites exatos de $type sem truncar Unicode, corpo, títulos ou referências', async (message) => {
    const { providerFetch, client } = setup();
    expect(await client.send({ recipientId, message })).toEqual({ status: 'accepted', messageId: 'wamid.accepted-test' });
    const payload = JSON.parse(String(providerFetch.mock.calls[0]?.[1]?.body));
    if (message.type === 'text') expect(payload.text.body).toBe(message.body);
    else {
      expect(payload.interactive.body.text).toBe(message.body);
      expect(payload.interactive.action.buttons).toEqual(message.buttons.map((reply) => ({ type: 'reply', reply })));
    }
  });

  const invalidRequests: { name: string; request: unknown }[] = [
    { name: 'request ausente', request: undefined },
    { name: 'request nulo', request: null },
    { name: 'destinatário vazio', request: { recipientId: '', message: text } },
    { name: 'destinatário em branco', request: { recipientId: ' \n', message: text } },
    { name: 'destinatário numérico', request: { recipientId: 123, message: text } },
    { name: 'destinatário acima do limite local', request: { recipientId: 'i'.repeat(1025), message: text } },
    { name: 'credencial no request', request: { recipientId, message: text, accessToken: 'UNTRUSTED_TOKEN' } },
    { name: 'versão no request', request: { recipientId, message: text, graphApiVersion: 'latest' } },
    { name: 'destinatário alternativo', request: { recipientId, message: text, to: 'other' } },
    ...[
      { name: 'texto vazio', message: { type: 'text', body: '' } },
      { name: 'texto em branco', message: { type: 'text', body: ' \n\t' } },
      { name: 'texto não textual', message: { type: 'text', body: 123 } },
      { name: 'texto excedido por um', message: { type: 'text', body: 'a'.repeat(4097) } },
      { name: 'texto Unicode excedido', message: { type: 'text', body: '😀'.repeat(2048) + 'a' } },
      { name: 'tipo não suportado', message: { type: 'template', body: 'Template' } },
      { name: 'campo extra no texto', message: { ...text, preview_url: true } },
      { name: 'prévia vazia', message: { ...buttons, body: '' } },
      { name: 'prévia em branco', message: { ...buttons, body: ' \n' } },
      { name: 'prévia excedida por um', message: { ...buttons, body: 'a'.repeat(1025) } },
      { name: 'prévia Unicode excedida', message: { ...buttons, body: '😀'.repeat(512) + 'a' } },
      { name: 'sem botões', message: { ...buttons, buttons: [] } },
      { name: 'quatro botões', message: { ...buttons, buttons: Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, title: `Title ${i}` })) } },
      { name: 'IDs repetidos', message: { ...buttons, buttons: [{ id: 'same', title: 'One' }, { id: 'same', title: 'Two' }] } },
      { name: 'títulos repetidos', message: { ...buttons, buttons: [{ id: 'one', title: 'Same' }, { id: 'two', title: 'Same' }] } },
      ...[
        { id: '', title: 'Confirmar' }, { id: ' ', title: 'Confirmar' }, { id: 'i'.repeat(257), title: 'Confirmar' },
        { id: 123, title: 'Confirmar' }, { id: 'opaque', title: '' }, { id: 'opaque', title: ' ' },
        { id: 'opaque', title: 't'.repeat(21) }, { id: 'opaque', title: 123 },
        { id: '😀'.repeat(128) + 'a', title: 'Confirmar' },
        { id: 'opaque', title: '😀'.repeat(10) + 'a' },
        { id: 'opaque', title: 'Confirmar', confirmed: true },
      ].map((button, index) => ({ name: `botão inválido ${index + 1}`, message: { ...buttons, buttons: [button] } })),
    ].map(({ name, message }) => ({ name, request: { recipientId, message } })),
  ];
  it.each(invalidRequests)('rejeita $name antes de fetch, sem truncamento ou divisão silenciosa', async ({ request }) => {
    const { providerFetch, client } = setup();
    expect(await client.send(request as WhatsAppSendRequest)).toEqual({ status: 'rejected', reason: 'invalid_request' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([200, 201, 202])('HTTP %i com messageId válido é somente accepted mesmo com alegações extras de entrega', async (status) => {
    const { client } = setup(() => Response.json({ ...acceptedBody, status: 'delivered', delivered: true,
      messages: [{ id: 'wamid.accepted-test', message_status: 'read' }] }, { status }));
    expect(await client.send({ recipientId, message: buttons })).toEqual({ status: 'accepted', messageId: 'wamid.accepted-test' });
  });

  it.each([
    { status: 400, reason: 'provider_rejection' }, { status: 401, reason: 'unauthorized' },
    { status: 403, reason: 'unauthorized' }, { status: 429, reason: 'rate_limited' },
    { status: 500, reason: 'provider_rejection' },
  ])('HTTP $status com rejeição explícita devolve $reason sanitizado sem retry', async ({ status, reason }) => {
    const { providerFetch, client } = setup(() => Response.json(errorBody, { status }));
    expect(await client.send({ recipientId, message: text })).toEqual({ status: 'rejected', reason });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'JSON nulo', body: null }, { name: 'array', body: [] }, { name: 'objeto vazio', body: {} },
    { name: 'sem produto', body: { messages: [{ id: 'wamid.test' }] } },
    { name: 'outro produto', body: { ...acceptedBody, messaging_product: 'other' } },
    { name: 'sem messages', body: { messaging_product: 'whatsapp' } },
    { name: 'messages vazio', body: { ...acceptedBody, messages: [] } },
    { name: 'dois IDs', body: { ...acceptedBody, messages: [{ id: 'a' }, { id: 'b' }] } },
    ...[undefined, null, 123, '', ' \n', 'i'.repeat(1025)].map((id, i) => ({ name: `ID inválido ${i}`, body: { ...acceptedBody, messages: [{ id }] } })),
    { name: 'erro em HTTP de sucesso', body: errorBody },
    { name: 'aceite e erro contraditórios', body: { ...acceptedBody, ...errorBody } },
  ])('resposta de sucesso com $name é unknown sem falso aceite ou entrega', async ({ body }) => {
    const { providerFetch, client } = setup(() => Response.json(body));
    expect(await client.send({ recipientId, message: text })).toEqual({ status: 'unknown', reason: 'invalid_response' });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'JSON quebrado', response: () => new Response('{invalid', { status: 200 }) },
    { name: 'corpo ausente', response: () => new Response(null, { status: 204 }) },
    { name: 'erro HTML de proxy', response: () => new Response('<html>Private details</html>', { status: 502 }) },
    { name: 'HTTP 401 sem erro Meta', response: () => Response.json({}, { status: 401 }) },
    { name: 'código de erro textual', response: () => Response.json({ error: { ...errorBody.error, code: '100' } }, { status: 400 }) },
    { name: 'erro sem tipo', response: () => Response.json({ error: { code: 100, message: 'Private' } }, { status: 400 }) },
    { name: 'aceite em HTTP de falha', response: () => Response.json(acceptedBody, { status: 500 }) },
    { name: 'erro e aceite em HTTP de falha', response: () => Response.json({ ...acceptedBody, ...errorBody }, { status: 400 }) },
    { name: 'redirecionamento', response: () => Response.json(acceptedBody, { status: 307, headers: { location: 'https://example.com' } }) },
  ])('$name permanece unknown', async ({ response }) => {
    const { client } = setup(response);
    expect(await client.send({ recipientId, message: text })).toEqual({ status: 'unknown', reason: 'invalid_response' });
  });

  it.each(['sync', 'async'])('captura erro de rede %s sem expor exceção/segredos nem fazer retry', async (mode) => {
    const privateError = new Error(`FAKE_SECRET ${config.accessToken} ${recipientId} ${buttons.body}`, {
      cause: { headers: { authorization: config.accessToken }, url: 'https://example.com?secret=FAKE', body: buttons },
    });
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const providerFetch = vi.fn<typeof fetch>(() => {
      if (mode === 'sync') throw privateError;
      return Promise.reject(privateError);
    });
    const client = createMetaCloudApiClient(config, { fetch: providerFetch });
    expect(await client.send({ recipientId, message: buttons })).toEqual({ status: 'unknown', reason: 'network_error' });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('timeout aborta uma vez mesmo se fetch ignorar signal e depois %s', async (settlement) => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const providerFetch = vi.fn<typeof fetch>(() => pending.promise);
    const client = createMetaCloudApiClient(config, { fetch: providerFetch, timeoutMs: 50 });
    const sending = client.send({ recipientId, message: text });
    const signal = providerFetch.mock.calls[0]?.[1]?.signal;
    const finished = vi.fn();
    void sending.then(finished);
    await vi.advanceTimersByTimeAsync(49);
    expect(finished).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sending).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
    if (settlement === 'resolve') pending.resolve(Response.json(acceptedBody));
    else pending.reject(new Error('FAKE_LATE_PRIVATE_ERROR'));
    await vi.runAllTimersAsync();
    expect(finished).toHaveBeenCalledExactlyOnceWith({ status: 'unknown', reason: 'timeout' });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mantém timeout como motivo quando o fetch rejeita ao receber abort', async () => {
    vi.useFakeTimers();
    const providerFetch = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('FAKE_ABORT_ERROR')), { once: true });
    }));
    const client = createMetaCloudApiClient(config, { fetch: providerFetch });
    const sending = client.send({ recipientId, message: text });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await sending).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeout também cobre corpo pendente após receber headers HTTP 200', async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const response = Response.json(acceptedBody);
    const json = vi.spyOn(response, 'json').mockImplementation(() => body.promise);
    const providerFetch = vi.fn<typeof fetch>(async () => response);
    const client = createMetaCloudApiClient(config, { fetch: providerFetch, timeoutMs: 50 });
    const sending = client.send({ recipientId, message: buttons });
    await vi.advanceTimersByTimeAsync(49);
    expect(json).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sending).toEqual({ status: 'unknown', reason: 'timeout' });
    expect(providerFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    body.reject(new Error('FAKE_PRIVATE_BODY_ERROR'));
    await vi.runAllTimersAsync();
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['accepted', 'rejected', 'invalid_response', 'network_error'])('libera timer após %s sem abortar uma tentativa finalizada', async (outcome) => {
    vi.useFakeTimers();
    const { providerFetch, client } = setup(() => outcome === 'rejected'
      ? Response.json(errorBody, { status: 400 }) : Response.json(outcome === 'accepted' ? acceptedBody : {}));
    if (outcome === 'network_error') providerFetch.mockRejectedValue(new Error('FAKE_NETWORK_ERROR'));
    await client.send({ recipientId, message: text });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(providerFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejeita timeout inválido %s com erro fixo antes de I/O', (timeoutMs) => {
    const providerFetch = vi.fn<typeof fetch>();
    expect(() => createMetaCloudApiClient(config, { fetch: providerFetch, timeoutMs }))
      .toThrow('Configuração do cliente Meta inválida.');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    { graphApiVersion: 'latest' }, { graphApiVersion: 'v25.0' },
    { accessToken: '' }, { accessToken: 'FAKE\r\nHEADER' }, { accessToken: 'FAKE\n' },
    { phoneNumberId: '' }, { phoneNumberId: '..' }, { phoneNumberId: '\uD800' },
  ])('configuração inválida não faz I/O nem publica valores: %j', (patch) => {
    const providerFetch = vi.fn<typeof fetch>();
    expect(() => createMetaCloudApiClient({ ...config, ...patch } as typeof config, { fetch: providerFetch }))
      .toThrow('Configuração do cliente Meta inválida.');
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
