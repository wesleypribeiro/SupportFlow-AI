import { describe, expect, it, vi } from 'vitest';
import {
  getCourseDetailsResultSchema,
  getCoursesResultSchema,
  getSchoolInfoResultSchema,
  languageSchoolToolResultSchema,
} from '@supportflow/contracts/language-school';
import type {
  ActiveCourse,
  ActiveCourseSummary,
  School,
} from '@supportflow/contracts/language-school';
import {
  getCourseDetails,
  getCourses,
  getSchoolInfo,
} from '../../src/modules/language-school/application/catalog-queries.js';
import {
  courseFixtures,
  schoolFixture,
} from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { createCatalogTools } from '../../src/modules/language-school/infrastructure/catalog-tools.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';

function createRepository() {
  return new InMemorySchoolRepository(schoolFixture, courseFixtures);
}

const activeCourses = courseFixtures.filter((course) => course.active);
const activeSummaries = activeCourses.map(({ id, name, language, modality, active }) => ({
  id, name, language, modality, active,
}));

describe('consultas determinísticas do catálogo', () => {
  it('obtém exatamente os dados cadastrados da escola', async () => {
    await expect(getSchoolInfo(createRepository())).resolves.toEqual({
      ok: true, data: { school: schoolFixture },
    });
  });

  it('lista somente os resumos cadastrados dos cursos ativos', async () => {
    await expect(getCourses(createRepository())).resolves.toEqual({
      ok: true, data: { courses: activeSummaries },
    });
  });

  it('aceita catálogo sem cursos ativos como sucesso', async () => {
    const repository = new InMemorySchoolRepository(
      schoolFixture, courseFixtures.filter((course) => !course.active),
    );
    await expect(getCourses(repository)).resolves.toEqual({ ok: true, data: { courses: [] } });
  });

  it.each(activeCourses)('preserva os detalhes e o preço cadastrado de $id', async (course) => {
    await expect(getCourseDetails(createRepository(), course.id)).resolves.toEqual({
      ok: true, data: { course },
    });
  });

  it.each(['course_missing', 'course_german_foundations'])(
    'retorna NOT_FOUND explícito para curso inexistente ou inativo: %s', async (courseId) => {
      await expect(getCourseDetails(createRepository(), courseId)).resolves.toEqual({
        ok: false,
        error: { code: 'NOT_FOUND', message: expect.any(String) },
      });
    },
  );
});

describe('tools públicas de leitura do catálogo', () => {
  it('get_school_info aceita objeto vazio e publica apenas os dados cadastrados', async () => {
    const result = await createCatalogTools(createRepository()).get_school_info({});

    expect(result).toEqual({ ok: true, data: { school: schoolFixture } });
    expect(getSchoolInfoResultSchema.safeParse(result).success).toBe(true);
  });

  it('get_courses aceita objeto vazio e não oferece o curso inativo existente', async () => {
    const result = await createCatalogTools(createRepository()).get_courses({});

    expect(courseFixtures).toContainEqual(expect.objectContaining({
      id: 'course_german_foundations', active: false,
    }));
    expect(result).toEqual({ ok: true, data: { courses: activeSummaries } });
    expect(getCoursesResultSchema.safeParse(result).success).toBe(true);
  });

  it('get_courses retorna lista vazia válida quando todos os cursos estão inativos', async () => {
    const repository = new InMemorySchoolRepository(
      schoolFixture, courseFixtures.filter((course) => !course.active),
    );
    const result = await createCatalogTools(repository).get_courses({});

    expect(result).toEqual({ ok: true, data: { courses: [] } });
    expect(getCoursesResultSchema.safeParse(result).success).toBe(true);
  });

  it.each(activeCourses)('get_course_details preserva todos os dados de $id', async (course) => {
    const result = await createCatalogTools(createRepository()).get_course_details({
      courseId: course.id,
    });

    expect(result).toEqual({ ok: true, data: { course } });
    expect(getCourseDetailsResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    ['course_english_travel', { amountCents: 35000, currency: 'BRL', billingPeriod: 'month' }],
    ['course_spanish_conversation', null],
    ['course_french_intro', { amountCents: 0, currency: 'BRL', billingPeriod: 'course' }],
  ])('preserva preço conhecido, ausente ou zero sem substituição: %s', async (courseId, price) => {
    const result = await createCatalogTools(createRepository()).get_course_details({ courseId });

    expect(result).toMatchObject({ ok: true, data: { course: { price } } });
  });

  it.each(['course_missing', 'course_german_foundations'])(
    'get_course_details não publica detalhes indisponíveis: %s', async (courseId) => {
      const result = await createCatalogTools(createRepository()).get_course_details({ courseId });

      expect(result).toEqual({
        ok: false, error: { code: 'NOT_FOUND', message: expect.any(String) },
      });
      expect(getCourseDetailsResultSchema.safeParse(result).success).toBe(true);
    },
  );

  it.each([
    { tool: 'get_school_info', input: { schoolId: 'another_school' } },
    { tool: 'get_school_info', input: { extra: true } },
    { tool: 'get_school_info', input: null },
    { tool: 'get_courses', input: { schoolId: 'another_school' } },
    { tool: 'get_courses', input: { active: true } },
    { tool: 'get_courses', input: [] },
    { tool: 'get_course_details', input: {} },
    { tool: 'get_course_details', input: { courseId: 123 } },
    { tool: 'get_course_details', input: { courseId: '' } },
    { tool: 'get_course_details', input: { courseId: '   ' } },
    { tool: 'get_course_details', input: { courseId: 'course_english_travel', price: 0 } },
    { tool: 'get_course_details', input: { courseId: 'course_english_travel', schoolId: 'other' } },
  ] as const)('$tool rejeita entrada inválida antes de consultar o repository: $input', async ({ tool, input }) => {
    const repository = createRepository();
    const schoolQuery = vi.spyOn(repository, 'getSchool');
    const coursesQuery = vi.spyOn(repository, 'listActiveCourses');
    const detailsQuery = vi.spyOn(repository, 'findActiveCourseById');

    const result = await createCatalogTools(repository)[tool](input);

    expect(result).toEqual({
      ok: false, error: { code: 'INVALID_INPUT', message: expect.any(String) },
    });
    expect(languageSchoolToolResultSchema.safeParse({ tool, result }).success).toBe(true);
    expect(schoolQuery).not.toHaveBeenCalled();
    expect(coursesQuery).not.toHaveBeenCalled();
    expect(detailsQuery).not.toHaveBeenCalled();
  });

  it.each([
    { tool: 'get_school_info', method: 'getSchool', input: {} },
    { tool: 'get_courses', method: 'listActiveCourses', input: {} },
    { tool: 'get_course_details', method: 'findActiveCourseById', input: { courseId: 'course_english_travel' } },
  ] as const)('$tool converte falha inesperada sem expor a exceção interna', async ({ tool, method, input }) => {
    const repository = createRepository();
    const internalError = new Error('INTERNAL_ONLY: caminho privado /infra/catalog e credencial secreta');
    vi.spyOn(repository, method).mockRejectedValue(internalError);

    const result = await createCatalogTools(repository)[tool](input);

    expect(result).toEqual({
      ok: false, error: { code: 'OPERATION_FAILED', message: expect.any(String) },
    });
    expect(languageSchoolToolResultSchema.safeParse({ tool, result }).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('INTERNAL_ONLY');
    expect(JSON.stringify(result)).not.toContain('/infra/catalog');
    expect(JSON.stringify(result)).not.toContain('stack');
  });

  it.each([
    { name: 123 },
    { internalSecret: 'INTERNAL_ONLY' },
  ])('get_school_info rejeita dados internos incompatíveis: %j', async (patch) => {
    const repository = createRepository();
    vi.spyOn(repository, 'getSchool').mockResolvedValue({
      ...schoolFixture, ...patch,
    } as unknown as School);

    const result = await createCatalogTools(repository).get_school_info({});

    expect(result).toEqual({
      ok: false, error: { code: 'OPERATION_FAILED', message: expect.any(String) },
    });
    expect(getSchoolInfoResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    { active: false },
    { name: 123 },
    { internalSecret: 'INTERNAL_ONLY' },
  ])('get_courses rejeita oferta incompatível em vez de publicá-la: %j', async (patch) => {
    const repository = createRepository();
    vi.spyOn(repository, 'listActiveCourses').mockResolvedValue([
      { ...activeSummaries[0], ...patch } as unknown as ActiveCourseSummary,
    ]);

    const result = await createCatalogTools(repository).get_courses({});

    expect(result).toEqual({
      ok: false, error: { code: 'OPERATION_FAILED', message: expect.any(String) },
    });
    expect(getCoursesResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    { price: { amountCents: '35000', currency: 'BRL', billingPeriod: 'month' } },
    { active: false },
    { internalSecret: 'INTERNAL_ONLY' },
  ])('get_course_details rejeita detalhes incompatíveis sem normalizar valores: %j', async (patch) => {
    const repository = createRepository();
    vi.spyOn(repository, 'findActiveCourseById').mockResolvedValue({
      ...activeCourses[0], ...patch,
    } as unknown as ActiveCourse);

    const result = await createCatalogTools(repository).get_course_details({
      courseId: 'course_english_travel',
    });

    expect(result).toEqual({
      ok: false, error: { code: 'OPERATION_FAILED', message: expect.any(String) },
    });
    expect(getCourseDetailsResultSchema.safeParse(result).success).toBe(true);
  });
});
