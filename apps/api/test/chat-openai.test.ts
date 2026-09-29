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

  it('interpreta contexto, consulta tools e finaliza sem tools nem tool_choice, preservando o resultado oficial', async () => {
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

      const interpreting = requests.length === 1;
      const selecting = requests.length === 2;
      return new Response(JSON.stringify({
        id: `chatcmpl_mock_${requests.length}`,
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{
          index: 0,
          finish_reason: interpreting || selecting ? 'tool_calls' : 'stop',
          message: interpreting || selecting
            ? {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: interpreting ? 'call_context_openai' : 'call_catalog_openai',
                type: 'function',
                function: interpreting
                  ? {
                    name: 'interpret_context_patch',
                    arguments: JSON.stringify({ goal: null, name: null, contact: null, courseReference: null, slotReference: null }),
                  }
                  : { name: 'get_courses', arguments: '{}' },
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
      expect(providerFetch).toHaveBeenCalledTimes(3);
      expect(requests[0]?.tools).toEqual([
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'interpret_context_patch',
            parameters: expect.objectContaining({
              type: 'object',
              additionalProperties: false,
              required: ['goal', 'name', 'contact', 'courseReference', 'slotReference'],
            }),
          }),
        }),
      ]);
      expect(requests[0]?.tool_choice).toEqual({
        type: 'function', function: { name: 'interpret_context_patch' },
      });
      expect(requests[1]?.tools).toEqual([
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_school_info' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_courses' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_course_details' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_available_slots' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'create_lead' }) }),
        expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'schedule_trial_class' }) }),
      ]);
      expect(requests[2]).not.toHaveProperty('tools');
      expect(requests[2]).not.toHaveProperty('tool_choice');
      expect(requests[2]?.messages).toEqual(expect.arrayContaining([
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
      expect(JSON.stringify(requests[1]?.messages)).not.toContain('call_context_openai');
      expect(JSON.stringify(requests[2]?.messages)).not.toContain('call_context_openai');
    } finally {
      await server.close();
    }
  });
});
