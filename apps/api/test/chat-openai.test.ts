import { ChatOpenAI } from '@langchain/openai';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { courseFixtures } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';

describe('POST /api/chat com SDK OpenAI e transporte simulado', () => {
  const externalFetch = vi.fn(() => { throw new Error('Rede externa proibida nos testes.'); });

  beforeEach(() => {
    vi.stubGlobal('fetch', externalFetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });

  afterEach(() => {
    expect(externalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('envia tools na seleção e finaliza sem tools nem tool_choice, preservando o resultado oficial', async () => {
    const requests: Record<string, unknown>[] = [];
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);

      // Reproduz a rejeição real do provedor que o modelo simulado não valida.
      if (request.tool_choice !== undefined && request.tools === undefined) {
        return new Response(JSON.stringify({
          error: {
            message: 'tool_choice requires tools.',
            type: 'invalid_request_error',
            param: 'tool_choice',
            code: null,
          },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }

      const selecting = requests.length === 1;
      return new Response(JSON.stringify({
        id: `chatcmpl_mock_${requests.length}`,
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{
          index: 0,
          finish_reason: selecting ? 'tool_calls' : 'stop',
          message: selecting
            ? {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_catalog_openai',
                type: 'function',
                function: { name: 'get_courses', arguments: '{}' },
              }],
            }
            : { role: 'assistant', content: 'Consultei os cursos disponíveis da escola.' },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const model = new ChatOpenAI({
      apiKey: 'fake-key-for-offline-test',
      model: 'gpt-4o-mini',
      maxRetries: 0,
      configuration: { fetch: providerFetch },
    });
    const { server } = createApplication({}, { model });

    try {
      const response = await server.inject({
        method: 'POST', url: '/api/chat', payload: { message: 'Quais cursos vocês oferecem?' },
      });

      expect(response.statusCode).toBe(200);
      const body = languageSchoolChatResponseSchema.parse(response.json());
      const officialResult = {
        tool: 'get_courses',
        result: {
          ok: true,
          data: {
            courses: courseFixtures.filter((course) => course.active)
              .map(({ id, name, language, modality, active }) => ({ id, name, language, modality, active })),
          },
        },
      };
      expect(body.reply).toBe('Consultei os cursos disponíveis da escola.');
      expect(body.results).toEqual([officialResult]);
      expect(body.pendingAction).toBeNull();
      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(requests[0]?.tools).toEqual([
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_school_info' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_courses' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_course_details' }) }),
      ]);
      expect(requests[1]).not.toHaveProperty('tools');
      expect(requests[1]).not.toHaveProperty('tool_choice');
      expect(requests[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [{
            id: 'call_catalog_openai',
            type: 'function',
            function: { name: 'get_courses', arguments: '{}' },
          }],
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call_catalog_openai',
          content: JSON.stringify(officialResult),
        }),
      ]));
    } finally {
      await server.close();
    }
  });
});
