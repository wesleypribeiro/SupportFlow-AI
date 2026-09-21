import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApplication } from '../src/app.js';
import { loadCoreConfig } from '../src/core/config.js';
import { loadLanguageSchoolConfig } from '../src/modules/language-school/config.js';

describe('fundação do backend', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllGlobals();
  });

  it('inicializa e responde ao healthcheck sem credenciais nem chamadas à LLM', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Chamadas externas não são permitidas neste teste.');
    });
    vi.stubGlobal('fetch', fetch);
    const app = createApplication({});
    server = app.server;

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(app.config.llm).toBeNull();
    expect(app.config.school.schoolId).toBe('school_demo');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mantém configuração de escola e provedor fora da resposta pública', async () => {
    const app = createApplication({
      SCHOOL_ID: 'school_test',
      OPENAI_API_KEY: 'test-only-secret',
      OPENAI_MODEL: 'test-only-model',
    });
    server = app.server;

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(app.config.school.schoolId).toBe('school_test');
    expect(app.config.llm).toEqual({
      provider: 'openai', apiKey: 'test-only-secret', model: 'test-only-model',
    });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('configuração explícita do processo', () => {
  it('aplica endereço e porta locais e aceita configuração explícita', () => {
    expect(loadCoreConfig({}).http).toEqual({ host: '127.0.0.1', port: 3001 });
    expect(loadCoreConfig({ HOST: 'localhost', PORT: '4001' }).http)
      .toEqual({ host: 'localhost', port: 4001 });
  });

  it.each(['abc', '0', '65536'])('recusa porta inválida: %s', (port) => {
    expect(() => loadCoreConfig({ PORT: port })).toThrow('Configuração inválida: PORT');
  });

  it('recusa identificador de escola vazio', () => {
    expect(() => loadLanguageSchoolConfig({ SCHOOL_ID: ' ' })).toThrow('SCHOOL_ID');
  });

  it.each([
    { OPENAI_API_KEY: 'test-only-secret' },
    { OPENAI_MODEL: 'test-only-model' },
  ])('recusa configuração parcial do provedor sem revelar valores', (environment) => {
    expect(() => loadCoreConfig(environment))
      .toThrow('Configure OPENAI_API_KEY e OPENAI_MODEL juntos no backend.');
  });
});
