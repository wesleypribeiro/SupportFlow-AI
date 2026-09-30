import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { AIMessage } from '@langchain/core/messages';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { verifyWebhookHandshake, verifyWebhookSignature } from '../src/channels/whatsapp/meta/webhook-security.js';
import * as projection from '../src/channels/whatsapp/meta/webhook-projection.js';
import { InMemoryPendingActions } from '../src/core/pending-actions.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';
import { createJourneyModel, leadTurn } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaStatus, metaText } from './helpers/meta-webhook.js';

const path = '/webhooks/whatsapp/meta';
const limit = 1_048_576;
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'APP_SECRET_SHOULD_NEVER_APPEAR',
  META_WEBHOOK_VERIFY_TOKEN: 'VERIFY_TOKEN_SHOULD_NEVER_APPEAR', META_ACCESS_TOKEN: 'ACCESS_TOKEN_SHOULD_NEVER_APPEAR',
  META_WABA_ID: 'demo-account', META_PHONE_NUMBER_ID: 'demo-number',
  META_GRAPH_API_VERSION: 'v26.0', WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient',
};
const query = { 'hub.mode': 'subscribe', 'hub.verify_token': environment.META_WEBHOOK_VERIFY_TOKEN, 'hub.challenge': '000123' };
const payload = Buffer.from(JSON.stringify(metaEnvelope()), 'utf8');
function sign(body: Buffer, secret = environment.META_APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
function handshakeUrl(values: Record<string, string> = query) {
  return `${path}?${new URLSearchParams(values)}`;
}
function bodyWithBytes(size: number) {
  const shell = Buffer.from(JSON.stringify(metaEnvelope(undefined, { text: '' })));
  const content = 'á'.repeat(Math.floor((size - shell.length) / 2)) + 'x'.repeat((size - shell.length) % 2);
  const body = Buffer.from(JSON.stringify(metaEnvelope(undefined, { text: content })));
  assert.equal(body.length, size);
  return body;
}

describe('segurança pura do webhook', () => {
  it.each([
    null, [], 'query', {},
    { ...query, 'hub.mode': ['subscribe'] },
    { ...query, 'hub.verify_token': ['token', 'token'] },
    { ...query, 'hub.challenge': ['000123'] },
    { ...query, 'hub.challenge': 123 },
    { ...query, 'hub.verify_token': null },
    { ...query, 'hub.mode': { value: 'subscribe' } },
  ])('recusa query que não contém três strings escalares: %j', (input) => {
    expect(verifyWebhookHandshake(input, environment.META_WEBHOOK_VERIFY_TOKEN)).toEqual({ status: 400 });
  });

  it('compara tokens pelos bytes UTF-8 e não apenas pelo comprimento da string', () => {
    expect(verifyWebhookHandshake({ ...query, 'hub.verify_token': 'é' }, 'aa')).toEqual({ status: 403 });
    expect(verifyWebhookHandshake({ ...query, 'hub.verify_token': 'é' }, 'é')).toEqual({ status: 200, challenge: '000123' });
    expect(verifyWebhookHandshake({ ...query, 'hub.verify_token': 'e' }, 'é')).toEqual({ status: 403 });
  });

  it.each([undefined, null, 123, [sign(payload)], `${sign(payload)}\n`, `${sign(payload)}\r\n`])(
    'recusa tipo múltiplo/inesperado ou quebra de linha no header (%j)', (header) => {
      expect(verifyWebhookSignature(payload, header, environment.META_APP_SECRET)).toBe(false);
    },
  );
});

const cleanups: (() => Promise<void>)[] = [];
function application(options: { model?: ScriptedChatModel; env?: NodeJS.ProcessEnv; observeOnly?: boolean } = {}) {
  const model = options.model ?? new ScriptedChatModel([]);
  const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const handoffRepository = new InMemoryHandoffRepository();
  const app = createApplication(options.env ?? environment, { model, schoolRepository, leadRepository, trialClassRepository, handoffRepository });
  // Spies observam implementações reais; nenhum retorno comercial é simulado.
  const observers = [
    ...(['getSchool', 'listActiveCourses', 'findActiveCourseById'] as const).map((key) => vi.spyOn(schoolRepository, key)),
    ...(['findByConversationId', 'createForConversation', 'updateForConversation'] as const).map((key) => vi.spyOn(leadRepository, key)),
    ...(['listSlotsByCourseId', 'findSlotById', 'findConfirmedBySlotId', 'reserveSlot'] as const).map((key) => vi.spyOn(trialClassRepository, key)),
    ...(['findOpenByConversationId', 'requestForConversation'] as const).map((key) => vi.spyOn(handoffRepository, key)),
    ...(['openConversation', 'sendMessage', 'confirmAction', 'getCurrentPendingAction'] as const).map((key) => vi.spyOn(app.conversationService, key)),
    ...(['create', 'get', 'save', 'runExclusive'] as const).map((key) => vi.spyOn(app.conversations, key)),
    ...(['prepare', 'stage', 'pending', 'invalidate', 'invalidateCurrent', 'confirm'] as const).map((key) => vi.spyOn(InMemoryPendingActions.prototype, key)),
  ];
  cleanups.push(async () => {
    await app.server.close();
    if (options.observeOnly ?? true) {
      for (const observer of observers) expect(observer).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(0);
      expect(model.contextCalls).toHaveLength(0);
    }
  });
  return { ...app, model };
}
type App = ReturnType<typeof application>;
function post(app: App, body = payload, signature: string | string[] | undefined = sign(body)) {
  return app.server.inject({
    method: 'POST', url: path, payload: body,
    headers: { 'content-type': 'application/json', ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }) },
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida'); }));
  vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
  vi.stubEnv('LANGSMITH_TRACING', 'false');
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('GET /webhooks/whatsapp/meta', () => {
  it.each([{}, { WHATSAPP_ENABLED: 'false' }])('não registra GET nem POST quando desabilitado (%j)', async (env) => {
    const app = application({ env });
    expect((await app.server.inject({ method: 'GET', url: handshakeUrl() })).statusCode).toBe(404);
    expect((await post(app)).statusCode).toBe(404);
  });

  it.each(['000123', ' challenge com espaços ', 'Olá 👋', '0123\n', '   ', '+%&='])('devolve challenge exato (%j) como texto, sem trim/JSON/newline adicional', async (challenge) => {
    const response = await application().server.inject({ method: 'GET', url: handshakeUrl({ ...query, 'hub.challenge': challenge }) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.body).toBe(challenge);
    expect(response.rawPayload).toEqual(Buffer.from(challenge));
  });

  it.each([
    { 'hub.mode': 'other' }, { 'hub.mode': '' }, { 'hub.mode': 'SUBSCRIBE' },
    { 'hub.verify_token': 'other' }, { 'hub.verify_token': '' },
    { 'hub.verify_token': 'x'.repeat(200) },
    { 'hub.verify_token': environment.META_APP_SECRET },
    { 'hub.verify_token': environment.META_ACCESS_TOKEN },
  ])('modo/token incorreto produz o mesmo 403 vazio (%j)', async (change) => {
    const response = await application().server.inject({ method: 'GET', url: handshakeUrl({ ...query, ...change }) });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('');
  });

  it.each(['hub.mode', 'hub.verify_token', 'hub.challenge'])('rejeita parâmetro ausente: %s', async (key) => {
    const values: Record<string, string> = { ...query };
    delete values[key];
    const response = await application().server.inject({ method: 'GET', url: handshakeUrl(values) });
    expect(response.statusCode).toBe(400); expect(response.body).toBe('');
  });

  it.each(['hub.mode', 'hub.verify_token', 'hub.challenge'])('rejeita parâmetro repetido: %s', async (key) => {
    const response = await application().server.inject({ method: 'GET', url: `${handshakeUrl()}&${key}=duplicate` });
    expect(response.statusCode).toBe(400); expect(response.body).toBe('');
  });

  it.each([
    handshakeUrl({ ...query, 'hub.challenge': '' }),
    `${handshakeUrl()}&extra=value`,
    `${handshakeUrl()}&hub.challenge%5B%5D=another`,
    `${handshakeUrl()}&hub%2Echallenge=duplicate`,
    handshakeUrl({ ...query, 'hub.challenge': 'marker' }).replace('marker', '%ZZ'),
    handshakeUrl({ ...query, 'hub.challenge': 'marker' }).replace('marker', '%C3%28'),
    path,
  ])('recusa formato vazio, extra, ambíguo ou mal codificado (%s)', async (url) => {
    const response = await application().server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400); expect(response.body).toBe('');
  });
});

describe('POST /webhooks/whatsapp/meta — bytes antes do JSON', () => {
  it('aceita assinatura correta e retorna somente 200 vazio', async () => {
    const response = await post(application());
    expect(response.statusCode).toBe(200); expect(response.body).toBe('');
  });

  it('header é case-insensitive; digest hexadecimal pode usar letras maiúsculas', async () => {
    const response = await application().server.inject({
      method: 'POST', url: path, payload,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Hub-Signature-256': `sha256=${sign(payload).slice(7).toUpperCase()}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    '', 'sha256=', `sha256=${'a'.repeat(63)}`, `sha256=${'a'.repeat(65)}`,
    `sha256=${'z'.repeat(64)}`, `sha1=${'a'.repeat(64)}`, `SHA256=${'a'.repeat(64)}`,
    `sha256= ${'a'.repeat(64)}`, ` ${sign(payload)}`, `${sign(payload)} `,
    `${sign(payload)}, ${sign(payload)}`, [sign(payload), sign(payload)],
    sign(payload, 'other-secret'), sign(payload, environment.META_WEBHOOK_VERIFY_TOKEN),
    sign(payload, environment.META_ACCESS_TOKEN),
  ])('recusa assinatura malformada, múltipla ou incorreta (%j)', async (signature) => {
    const response = await post(application(), payload, signature);
    expect(response.statusCode).toBe(403); expect(response.body).toBe('');
  });

  it('recusa header ausente antes de interpretar JSON inválido', async () => {
    const response = await application().server.inject({
      method: 'POST', url: path, headers: { 'content-type': 'application/json' }, payload: Buffer.from('{broken'),
    });
    expect(response.statusCode).toBe(403); expect(response.body).toBe('');
  });

  it('um único byte alterado invalida assinatura mantendo JSON utilizável', async () => {
    const original = Buffer.from('{"a":1}');
    const altered = Buffer.from(original);
    altered[5] = '2'.charCodeAt(0);
    expect((await post(application(), altered, sign(original))).statusCode).toBe(403);
  });

  it('JSON semanticamente igual com bytes diferentes exige outra assinatura', async () => {
    const app = application();
    const spaced = Buffer.from(JSON.stringify(metaEnvelope(), null, 2));
    expect(JSON.parse(payload.toString())).toEqual(JSON.parse(spaced.toString()));
    expect((await post(app, spaced, sign(payload))).statusCode).toBe(403);
    expect((await post(app, spaced)).statusCode).toBe(200);
  });

  it('ordem das chaves também pertence aos bytes assinados', async () => {
    const original = Buffer.from('{"a":1,"b":2}');
    const reordered = Buffer.from('{"b":2,"a":1}');
    expect((await post(application(), reordered, sign(original))).statusCode).toBe(403);
  });

  it('assina UTF-8 multibyte completo sem conversão antes da autenticação', async () => {
    const body = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages: [metaText()] })])));
    expect(body.length).toBeGreaterThan(body.toString().length);
    expect((await post(application(), body)).statusCode).toBe(200);
  });

  it.each(['', '{"object":', 'not JSON', 'null', '[]', '"text"', 'true', '42'])('assinatura correta e documento inválido → 400 (%j)', async (input) => {
    const response = await post(application(), Buffer.from(input));
    expect(response.statusCode).toBe(400); expect(response.body).toBe('');
  });

  it('UTF-8 inválido não é reparado silenciosamente depois da assinatura', async () => {
    const invalid = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect((await post(application(), invalid)).statusCode).toBe(400);
  });

  it.each(['{}', '{"object":"not-validated-yet","entry":"not-projected"}'])('objeto sem estrutura Meta válida agora é rejeitado (%s)', async (input) => {
    expect((await post(application(), Buffer.from(input))).statusCode).toBe(400);
  });

  it.each([limit - 1, limit])('aceita %i bytes, incluindo caracteres multibyte', async (size) => {
    expect((await post(application(), bodyWithBytes(size))).statusCode).toBe(200);
  });

  it('recusa 1 MiB + 1 byte antes de assinatura/JSON (mesmo com header inválido)', async () => {
    const body = bodyWithBytes(limit + 1);
    expect(body.toString().length).toBeLessThan(limit);
    const response = await post(application(), body, 'invalid');
    expect(response.statusCode).toBe(413); expect(response.body).toBe('');
  });

  it('aplica limite durante streaming sem depender de Content-Length declarado', async () => {
    const body = bodyWithBytes(limit + 1);
    const response = await application().server.inject({
      method: 'POST', url: path, payload: Readable.from([body.subarray(0, limit), body.subarray(limit)]),
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body), 'transfer-encoding': 'chunked' },
    });
    expect(response.statusCode).toBe(413); expect(response.body).toBe('');
  });

  it('erro de content-type não publica o tipo/valores recebidos', async () => {
    const response = await application().server.inject({ method: 'POST', url: path, payload,
      headers: { 'content-type': 'application/PRIVATE_CONTENT_TYPE', 'x-hub-signature-256': sign(payload) } });
    expect(response.statusCode).toBe(400); expect(response.body).toBe('');
  });

  it('não registra segredos, query, assinatura ou body nas respostas/logs de erro', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const app = application();
    const body = Buffer.from('{"PRIVATE_BODY":');
    const signature = sign(body);
    const responses = [
      await app.server.inject({ method: 'GET', url: handshakeUrl({ ...query, 'hub.mode': 'PRIVATE_QUERY' }) }),
      await post(app, body, signature),
      await post(app, body, 'PRIVATE_SIGNATURE'),
      await post(app, bodyWithBytes(limit + 1)),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([403, 400, 403, 413]);
    for (const response of responses) expect(response.body).toBe('');
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    const exposed = JSON.stringify(responses.map(({ body, headers }) => ({ body, headers }))) + JSON.stringify(logs.map((log) => log.mock.calls));
    for (const value of [environment.META_APP_SECRET, environment.META_WEBHOOK_VERIFY_TOKEN, environment.META_ACCESS_TOKEN,
      signature, 'PRIVATE_SIGNATURE', 'PRIVATE_QUERY', 'PRIVATE_BODY']) expect(exposed).not.toContain(value);
  });

  it('GET/POST concorrentes permanecem observacionais, sem fila, conversa ou deduplicação', async () => {
    const app = application();
    const responses = await Promise.all([post(app), post(app), app.server.inject({ method: 'GET', url: handshakeUrl() })]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    // afterEach verifica todas as leituras/escritas comerciais, serviço, modelo e runExclusive.
  });
});

describe('POST /webhooks/whatsapp/meta — projeção validada', () => {
  it('projeta o lote assinado completo; status/botão permanecem separados de texto', async () => {
    const project = vi.spyOn(projection, 'projectMetaWebhook');
    const input = metaEnvelope([], { entry: [
      { id: environment.META_WABA_ID, changes: [
        metaChange({ messages: [metaText(), metaButton()], statuses: [metaStatus(), metaStatus({ status: 'sent' })] }),
        metaChange({ messages: [metaText({ id: 'second-change' })] }),
      ] },
      { id: environment.META_WABA_ID, changes: [metaChange({ statuses: [metaStatus({ status: 'read' }), metaStatus({ status: 'failed' })] })] },
    ] });
    const response = await post(application(), Buffer.from(JSON.stringify(input)));
    expect(response.statusCode).toBe(200); expect(response.body).toBe('');
    expect(project).toHaveBeenCalledOnce();
    const result = project.mock.results[0]?.value as projection.MetaProjectionResult;
    expect(result.status).toBe(200);
    assert(result.status === 200);
    expect(result.events.map((event) => event.type)).toEqual(['text', 'button_reply', 'status', 'status', 'text', 'status', 'status']);
    expect(result.events.filter((event) => event.type === 'status').map((event) => event.status)).toEqual(['delivered', 'sent', 'read', 'failed']);
  });

  it.each([
    metaEnvelope(undefined, { object: 'foreign-object' }),
    metaEnvelope([], { entry: [
      { id: environment.META_WABA_ID, changes: [metaChange({ messages: [metaText()] })] },
      { id: 'foreign-account', changes: [metaChange({ messages: [metaButton()] })] },
    ] }),
    metaEnvelope([metaChange({ messages: [metaText()] }), metaChange({ metadata: { phone_number_id: 'foreign-number' }, statuses: [metaStatus()] })]),
  ])('rejeita origem divergente mesmo depois de itens válidos sem acessar conversas', async (input) => {
    const response = await post(application(), Buffer.from(JSON.stringify(input)));
    expect(response.statusCode).toBe(403); expect(response.body).toBe('');
  });

  it('só interpreta origem/itens após verificar assinatura', async () => {
    const project = vi.spyOn(projection, 'projectMetaWebhook');
    const response = await post(application(), Buffer.from(JSON.stringify(metaEnvelope(undefined, { object: 'foreign' }))), 'invalid');
    expect(response.statusCode).toBe(403);
    expect(project).not.toHaveBeenCalled();
  });

  it('isola itens inválidos e ignora mídia/tipos desconhecidos sem modelo, download ou negócio', async () => {
    const project = vi.spyOn(projection, 'projectMetaWebhook');
    const app = application();
    const observations = vi.fn();
    app.server.addHook('onRequest', async (request) => {
      vi.spyOn(request.log, 'info').mockImplementation(observations);
    });
    const unsupported = ['image', 'audio', 'video', 'document', 'sticker', 'reaction', 'button', 'future-type']
      .map((type) => metaText({ type, [type]: { id: 'media', url: 'https://example.invalid/no-download', caption: 'Confirme' } }));
    const input = metaEnvelope([metaChange({
      messages: [metaText(), null, metaText({ timestamp: 'NaN' }), ...unsupported,
        metaButton({ interactive: { type: 'list_reply', list_reply: { id: 'foreign' } } }), metaButton()],
      statuses: [metaStatus(), metaStatus({ id: 123 }), metaStatus({ status: 'deleted' })],
    })]);
    const response = await post(app, Buffer.from(JSON.stringify(input)));
    expect(response.statusCode).toBe(200); expect(response.body).toBe('');
    const result = project.mock.results[0]?.value as projection.MetaProjectionResult;
    assert(result.status === 200);
    expect(result.events.map((event) => event.type)).toEqual(['text', 'button_reply', 'status']);
    expect(result.observations).toEqual({ INVALID_MESSAGE: 2, INVALID_STATUS: 1, UNSUPPORTED_MESSAGE: 9, UNSUPPORTED_STATUS: 1, UNSUPPORTED_CHANGE: 0 });
    expect(observations).toHaveBeenCalledExactlyOnceWith({
      code: 'WHATSAPP_WEBHOOK_ITEMS_IGNORED',
      counts: { INVALID_MESSAGE: 2, INVALID_STATUS: 1, UNSUPPORTED_MESSAGE: 9, UNSUPPORTED_STATUS: 1, UNSUPPORTED_CHANGE: 0 },
    });
    // afterEach verifica fetch, modelo, repositories reais, serviço e ações.
  });
});

describe('parser web preservado após registro do webhook', () => {
  it('POST /api/chat ainda interpreta JSON, mantém schema estrito e erros públicos', async () => {
    const app = application({ observeOnly: false, model: new ScriptedChatModel([new AIMessage('Olá!')]) });
    const response = await app.server.inject({ method: 'POST', url: '/api/chat',
      headers: { 'content-type': 'application/json' }, payload: Buffer.from('{"message":"Olá"}') });
    expect(response.statusCode).toBe(200);
    expect(languageSchoolChatResponseSchema.parse(response.json()).reply).toBe('Olá!');
    for (const input of ['{', '{"message":"Olá","confirmed":true}', '[]', '{}']) {
      const invalid = await app.server.inject({ method: 'POST', url: '/api/chat',
        headers: { 'content-type': 'application/json' }, payload: input });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Requisição de chat inválida.' } });
    }
    expect(app.model.calls).toHaveLength(1);
  });

  it('POST /api/chat/confirm interpreta IDs JSON e confirma cadastro real, preservando rejeições', async () => {
    const model = createJourneyModel([leadTurn({
      name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, goal: 'viagem', courseReference: 'inglês',
    })]);
    const app = application({ observeOnly: false, model });
    const prepared = await app.server.inject({ method: 'POST', url: '/api/chat', payload: {
      message: 'Quero inglês para viagem. Meu nome é Ana. Meu email é ana@example.com. Quero me cadastrar.',
    } });
    expect(prepared.statusCode).toBe(200);
    const data = languageSchoolChatResponseSchema.parse(prepared.json());
    assert(data.pendingAction?.kind === 'create_lead');
    const ids = { conversationId: data.conversationId, actionId: data.pendingAction.actionId };
    const confirmed = await app.server.inject({ method: 'POST', url: '/api/chat/confirm',
      headers: { 'content-type': 'application/json' }, payload: Buffer.from(JSON.stringify(ids)) });
    expect(confirmed.statusCode).toBe(200);
    expect(languageSchoolChatResponseSchema.parse(confirmed.json()).results).toMatchObject([
      { tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: { name: 'Ana' } } } },
    ]);
    for (const input of ['{', '{}', JSON.stringify({ ...ids, confirmed: true })]) {
      const invalid = await app.server.inject({ method: 'POST', url: '/api/chat/confirm',
        headers: { 'content-type': 'application/json' }, payload: input });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('INVALID_REQUEST');
    }
    const missing = await app.server.inject({ method: 'POST', url: '/api/chat/confirm',
      payload: { conversationId: 'not_found', actionId: 'not_found' } });
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe('NOT_FOUND');
  });
});
