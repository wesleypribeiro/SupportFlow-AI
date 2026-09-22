import {
  getCourseDetailsInputSchema,
  getCourseDetailsResultSchema,
  getCoursesInputSchema,
  getCoursesResultSchema,
  getSchoolInfoInputSchema,
  getSchoolInfoResultSchema,
  toolFailureSchema,
} from '@supportflow/contracts/language-school';
import type {
  GetCourseDetailsResult,
  GetCoursesResult,
  GetSchoolInfoResult,
  ToolFailure,
} from '@supportflow/contracts/language-school';
import { getCourseDetails, getCourses, getSchoolInfo } from '../application/catalog-queries.js';
import type { SchoolRepository } from '../domain/school-repository.js';

function catalogFailure(code: 'INVALID_INPUT' | 'OPERATION_FAILED'): ToolFailure {
  return toolFailureSchema.parse({
    ok: false,
    error: {
      code,
      message: code === 'INVALID_INPUT'
        ? 'Entrada inválida para a consulta de catálogo.'
        : 'Não foi possível consultar o catálogo.',
    },
  });
}

// Adaptadores de leitura comuns: nenhum SDK de agente ou acesso direto aos registros.
export function createCatalogTools(repository: SchoolRepository) {
  return {
    async get_school_info(input: unknown): Promise<GetSchoolInfoResult> {
      if (!getSchoolInfoInputSchema.safeParse(input).success) {
        return catalogFailure('INVALID_INPUT');
      }

      try {
        const output = getSchoolInfoResultSchema.safeParse(await getSchoolInfo(repository));
        return output.success ? output.data : catalogFailure('OPERATION_FAILED');
      } catch {
        return catalogFailure('OPERATION_FAILED');
      }
    },

    async get_courses(input: unknown): Promise<GetCoursesResult> {
      if (!getCoursesInputSchema.safeParse(input).success) {
        return catalogFailure('INVALID_INPUT');
      }

      try {
        const output = getCoursesResultSchema.safeParse(await getCourses(repository));
        return output.success ? output.data : catalogFailure('OPERATION_FAILED');
      } catch {
        return catalogFailure('OPERATION_FAILED');
      }
    },

    async get_course_details(input: unknown): Promise<GetCourseDetailsResult> {
      const parsed = getCourseDetailsInputSchema.safeParse(input);
      if (!parsed.success) {
        return catalogFailure('INVALID_INPUT');
      }

      try {
        const output = getCourseDetailsResultSchema.safeParse(
          await getCourseDetails(repository, parsed.data.courseId),
        );
        return output.success ? output.data : catalogFailure('OPERATION_FAILED');
      } catch {
        return catalogFailure('OPERATION_FAILED');
      }
    },
  };
}
