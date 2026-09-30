import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AIMessage } from '@langchain/core/messages';
import type { FastifyInstance } from 'fastify';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { loadWhatsAppConfig } from '../src/channels/whatsapp/config.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const secrets = {
  META_APP_SECRET: 'APP_SECRET_SHOULD_NEVER_APPEAR',
  META_ACCESS_TOKEN: 'ACCESS_TOKEN_SHOULD_NEVER_APPEAR',
  META_WEBHOOK_VERIFY_TOKEN: 'VERIFY_TOKEN_SHOULD_NEVER_APPEAR',
};
const settings = {
  ...secrets,
  META_WABA_ID: '00090071992547409931234',
  META_PHONE_NUMBER_ID: 'opaque-demo-number-id',
  META_GRAPH_API_VERSION: 'v26.0',
  WHATSAPP_DEMO_RECIPIENTS: 'demo-participant-a,demo-participant-b',
};
const enabledEnvironment = { WHATSAPP_ENABLED: 'true', ...settings };

function captureError(environment: NodeJS.ProcessEnv): Error {
  try {
    createApplication(environment);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('O teste esperava falha de configuração.');
}

function expectNoSecrets(value: string) {
  for (const secret of Object.values(secrets)) expect(value).not.toContain(secret);
}

describe('configuração opcional do WhatsApp', () => {
  it.each([undefined, '', ' \t ', 'false'])('desabilita com enabled=%s sem credenciais', (enabled) => {
    expect(loadWhatsAppConfig({ WHATSAPP_ENABLED: enabled })).toEqual({ enabled: false });
  });

  it('ignora configuração parcial/inválida quando desabilitado', () => {
    expect(loadWhatsAppConfig({
      WHATSAPP_ENABLED: 'false', META_APP_SECRET: '', META_GRAPH_API_VERSION: 'latest',
      WHATSAPP_DEMO_RECIPIENTS: ',,', META_ACCESS_TOKEN: secrets.META_ACCESS_TOKEN,
    })).toEqual({ enabled: false });
  });

  it('não lê nenhum campo Meta quando desabilitado', () => {
    const environment: NodeJS.ProcessEnv = { WHATSAPP_ENABLED: 'false' };
    for (const key of Object.keys(settings)) {
      Object.defineProperty(environment, key, { get() { throw new Error('Campo Meta não deve ser lido'); } });
    }
    expect(loadWhatsAppConfig(environment)).toEqual({ enabled: false });
  });

  it.each(['1', '0', 'yes', 'TRUE', 'TRUE123', 'False', ' true ', ' false '])(
    'rejeita booleano não literal %s no startup', (WHATSAPP_ENABLED) => {
      expect(captureError({ ...enabledEnvironment, WHATSAPP_ENABLED }).message)
        .toBe('Configuração WhatsApp inválida: WHATSAPP_ENABLED.');
    },
  );

  it('habilita somente com configuração completa e conserva IDs opacos', () => {
    const config = loadWhatsAppConfig(enabledEnvironment);
    expect(config).toEqual({
      enabled: true, provider: 'meta', appSecret: secrets.META_APP_SECRET,
      accessToken: secrets.META_ACCESS_TOKEN, webhookVerifyToken: secrets.META_WEBHOOK_VERIFY_TOKEN,
      wabaId: settings.META_WABA_ID, phoneNumberId: settings.META_PHONE_NUMBER_ID,
      graphApiVersion: 'v26.0', demoRecipients: ['demo-participant-a', 'demo-participant-b'],
    });
  });

  for (const key of Object.keys(settings)) {
    it.each([undefined, '', ' \t '])(`recusa ${key} ausente/vazio no startup (%s) sem valores`, (value) => {
      const error = captureError({ ...enabledEnvironment, [key]: value });
      expect(error.message).toBe(`Configuração WhatsApp inválida: ${key}.`);
      expect(error.cause).toBeUndefined();
      expectNoSecrets(`${error.stack}\n${JSON.stringify(error)}`);
    });
  }

  it.each(['latest', '26.0', 'v26', 'V26.0', 'v026.0', 'v26.0/', 'v26.0?token=secret', 'v99.0', 'v25.0', ' v26.0 '])(
    'recusa versão inválida ou não verificada %s', (META_GRAPH_API_VERSION) => {
      expect(captureError({ ...enabledEnvironment, META_GRAPH_API_VERSION }).message)
        .toBe('Configuração WhatsApp inválida: META_GRAPH_API_VERSION.');
    },
  );

  it('remove somente espaços externos dos segredos e IDs, como no restante da API', () => {
    const config = loadWhatsAppConfig({
      ...enabledEnvironment, META_APP_SECRET: '  secret Com Espacos  ',
      META_WEBHOOK_VERIFY_TOKEN: '\tverify-Case\n', META_ACCESS_TOKEN: '  access-Case  ',
      META_WABA_ID: '  000123  ', META_PHONE_NUMBER_ID: '  Number_ID  ',
    });
    expect(config).toMatchObject({
      appSecret: 'secret Com Espacos', webhookVerifyToken: 'verify-Case',
      accessToken: 'access-Case', wabaId: '000123', phoneNumberId: 'Number_ID',
    });
  });

  it('interpreta CSV com whitespace estrutural e deduplica sem normalizar os IDs', () => {
    const config = loadWhatsAppConfig({
      ...enabledEnvironment,
      WHATSAPP_DEMO_RECIPIENTS: '  000123 , Recipient_A,000123,\tRecipient_A ,recipient_a, opaque participant ',
    });
    expect(config).toMatchObject({ demoRecipients: ['000123', 'Recipient_A', 'recipient_a', 'opaque participant'] });
  });

  it.each([',', 'demo-a,', ',demo-a', 'demo-a,,demo-b', 'demo-a, \t ,demo-b'])('recusa item vazio no CSV (%s)', (WHATSAPP_DEMO_RECIPIENTS) => {
    expect(captureError({ ...enabledEnvironment, WHATSAPP_DEMO_RECIPIENTS }).message)
      .toBe('Configuração WhatsApp inválida: WHATSAPP_DEMO_RECIPIENTS.');
  });

  it('configuração e allowlist não retêm referências mutáveis', () => {
    const environment = { ...enabledEnvironment };
    const config = loadWhatsAppConfig(environment);
    if (!config.enabled) throw new Error('Configuração deveria estar habilitada');
    environment.META_WABA_ID = 'other';
    environment.WHATSAPP_DEMO_RECIPIENTS = 'other';
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.demoRecipients)).toBe(true);
    expect(config.wabaId).toBe(settings.META_WABA_ID);
    expect(config.demoRecipients).toEqual(['demo-participant-a', 'demo-participant-b']);
  });

  it('não publica sentinelas mesmo quando aparecem em campos inválidos', () => {
    for (const secret of Object.values(secrets)) {
      const error = captureError({ ...enabledEnvironment, WHATSAPP_ENABLED: secret });
      expectNoSecrets(`${error.stack}\n${JSON.stringify(error)}`);
      const versionError = captureError({ ...enabledEnvironment, META_GRAPH_API_VERSION: secret });
      expectNoSecrets(`${versionError.stack}\n${JSON.stringify(versionError)}`);
    }
  });

  it('logs reais do startup inválido não contêm segredos nem snapshot de configuração', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { PATH: process.env.PATH, ...enabledEnvironment, META_GRAPH_API_VERSION: 'latest' },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('Não foi possível iniciar a API. Verifique a configuração e a porta.');
    expectNoSecrets(result.stdout + result.stderr);
  });
});

describe('composição opcional sem transporte Meta', () => {
  let server: FastifyInstance | undefined;
  beforeEach(() => {
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { label: 'sem Meta', environment: {} },
    { label: 'desabilitado com lixo parcial', environment: { WHATSAPP_ENABLED: 'false', META_GRAPH_API_VERSION: 'latest' } },
    { label: 'habilitado completo', environment: enabledEnvironment },
  ])('$label mantém health/chat, registro condicional do webhook e ausência de request externo', async ({ environment }) => {
    const fetch = vi.fn(() => { throw new Error('Rede proibida'); });
    vi.stubGlobal('fetch', fetch);
    const model = new ScriptedChatModel([new AIMessage('Olá!')]);
    const app = createApplication(environment, { model });
    server = app.server;
    expect(model.calls).toHaveLength(0);
    expect(model.contextCalls).toHaveLength(0);
    expect((await server.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    const response = await server.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Olá' } });
    expect(response.statusCode).toBe(200);
    expect(languageSchoolChatResponseSchema.parse(response.json())).toEqual({
      conversationId: expect.any(String), reply: 'Olá!', results: [], pendingAction: null,
    });
    expect(app.conversations.get(response.json().conversationId)?.context).toEqual({
      goal: null, name: null, contact: null, courseId: null, slotId: null, leadId: null, revision: 0,
    });
    const routes = server.printRoutes();
    if (app.config.whatsapp.enabled) expect(routes).toContain('webhooks/whatsapp/meta');
    else expect(routes).not.toMatch(/whatsapp|meta|webhook/i);
    expect(fetch).not.toHaveBeenCalled();
    expectNoSecrets(response.body);
  });

  it('preserva requests públicos estritos sem campos do canal', async () => {
    const app = createApplication(enabledEnvironment);
    server = app.server;
    for (const extra of [{ channel: 'whatsapp' }, { provider: 'meta' }, { phoneNumber: 'demo' }, { whatsappId: 'demo' }]) {
      for (const [url, body] of [
        ['/api/chat', { message: 'Olá' }],
        ['/api/chat/confirm', { conversationId: 'conv_test', actionId: 'action_test' }],
      ] as const) {
        const response = await server.inject({ method: 'POST', url, payload: { ...body, ...extra } });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
        expectNoSecrets(response.body);
      }
    }
  });
});
