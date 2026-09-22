import { ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages';
import {
  getCourseDetailsInputSchema,
  getCoursesInputSchema,
  getSchoolInfoInputSchema,
  languageSchoolToolResultSchema,
} from '@supportflow/contracts/language-school';
import { describe, expect, it, vi } from 'vitest';
import {
  courseFixtures,
  schoolFixture,
} from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { createCatalogTools } from '../../src/modules/language-school/infrastructure/catalog-tools.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { createLangChainCatalogTools } from '../../src/modules/language-school/infrastructure/langchain-catalog-tools.js';

function setup() {
  const repository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const catalogTools = createCatalogTools(repository);
  return { repository, catalogTools, adapter: createLangChainCatalogTools(catalogTools) };
}

describe('adaptação LangChain das consultas de catálogo', () => {
  it('disponibiliza somente as três consultas com seus schemas públicos originais', () => {
    const { adapter } = setup();

    expect(adapter.tools.map(({ name, schema }) => ({ name, schema }))).toEqual([
      { name: 'get_school_info', schema: getSchoolInfoInputSchema },
      { name: 'get_courses', schema: getCoursesInputSchema },
      { name: 'get_course_details', schema: getCourseDetailsInputSchema },
    ]);
  });

  it.each([
    { name: 'get_school_info', args: {} },
    { name: 'get_courses', args: {} },
    { name: 'get_course_details', args: { courseId: 'course_english_travel' } },
    { name: 'get_course_details', args: { courseId: 'course_spanish_conversation' } },
    { name: 'get_course_details', args: { courseId: 'course_french_intro' } },
  ] as const)('$name preserva o resultado oficial e associa a mensagem à chamada: $args', async ({ name, args }) => {
    const { adapter, catalogTools } = setup();
    const expected = { tool: name, result: await catalogTools[name](args) };
    const { message, result } = await adapter.execute({ name, args, id: 'call_catalog' });

    expect(message).toBeInstanceOf(ToolMessage);
    expect(message.name).toBe(name);
    expect(message.tool_call_id).toBe('call_catalog');
    expect(message.content).toBe(JSON.stringify(expected));
    expect(message.artifact).toEqual(expected);
    expect(result).toEqual(expected);
    expect(languageSchoolToolResultSchema.safeParse(result).success).toBe(true);
    expect(result).not.toBe(message.artifact);
    expect(result.result).not.toBe(message.artifact.result);
  });

  it.each([
    { name: 'get_school_info', args: { schoolId: 'other_school' } },
    { name: 'get_courses', args: { extra: true } },
    { name: 'get_course_details', args: {} },
    { name: 'get_course_details', args: { courseId: 123 } },
    { name: 'get_course_details', args: { courseId: 'course_english_travel', confirmed: true } },
  ] as const)('$name transforma argumentos inválidos em ToolMessage correlacionada: $args', async ({ name, args }) => {
    const { adapter, catalogTools } = setup();
    const handler = vi.spyOn(catalogTools, name);
    const { message, result } = await adapter.execute({ name, args, id: 'call_invalid' });

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({
      tool: name,
      result: {
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'Entrada inválida para a consulta de catálogo.' },
      },
    });
    expect(message.tool_call_id).toBe('call_invalid');
    expect(message.status).toBe('error');
    expect(message.content).toBe(JSON.stringify(result));
    expect(message.artifact).toEqual(result);
    expect(message.content).not.toContain('Zod');
  });

  it('mantém NOT_FOUND como resultado normal da consulta', async () => {
    const { adapter } = setup();
    const { message, result } = await adapter.execute({
      name: 'get_course_details', args: { courseId: 'course_missing' }, id: 'call_missing',
    });

    expect(result).toMatchObject({
      tool: 'get_course_details', result: { ok: false, error: { code: 'NOT_FOUND' } },
    });
    expect(message.tool_call_id).toBe('call_missing');
    expect(message.content).toBe(JSON.stringify(result));
  });

  it.each([
    { name: 'create_lead', args: {}, id: 'call_unknown' },
    { name: 'get_courses', args: {} },
    { name: 'get_courses', args: {}, id: '' },
  ] satisfies ToolCall[])('rejeita nome indisponível ou chamada sem ID: %j', async (call) => {
    const { adapter, repository } = setup();
    const query = vi.spyOn(repository, 'listActiveCourses');

    await expect(adapter.execute(call)).rejects.toThrow('Não foi possível executar a consulta do atendimento.');
    expect(query).not.toHaveBeenCalled();
  });

  it('eleva OPERATION_FAILED para o tratamento de falha do chat sem expor a exceção', async () => {
    const { adapter, repository } = setup();
    vi.spyOn(repository, 'listActiveCourses').mockRejectedValue(new Error('INTERNAL_SECRET'));

    await expect(adapter.execute({ name: 'get_courses', args: {}, id: 'call_failed' }))
      .rejects.toThrow(/^Não foi possível executar a consulta do atendimento\.$/);
  });

  it('sanitiza exceção inesperada do handler', async () => {
    const { adapter, catalogTools } = setup();
    vi.spyOn(catalogTools, 'get_school_info').mockRejectedValue(new Error('INTERNAL_SECRET'));

    await expect(adapter.execute({ name: 'get_school_info', args: {}, id: 'call_failed' }))
      .rejects.toThrow(/^Não foi possível executar a consulta do atendimento\.$/);
  });

  it('não publica artifact incompatível com o schema público', async () => {
    const { adapter } = setup();
    const selected = adapter.tools.find((candidate) => candidate.name === 'get_courses');
    expect(selected).toBeDefined();
    vi.spyOn(selected!, 'invoke').mockResolvedValue(new ToolMessage({
      tool_call_id: 'call_bad_output',
      content: 'INTERNAL_SECRET',
      artifact: {
        tool: 'get_courses', result: { ok: true, data: { courses: [], internalSecret: 'INTERNAL_SECRET' } },
      },
    }));

    await expect(adapter.execute({ name: 'get_courses', args: {}, id: 'call_bad_output' }))
      .rejects.toThrow(/^Não foi possível executar a consulta do atendimento\.$/);
  });
});
