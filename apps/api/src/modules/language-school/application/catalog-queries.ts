import type {
  GetCourseDetailsResult,
  GetCoursesResult,
  GetSchoolInfoResult,
} from '@supportflow/contracts/language-school';
import type { SchoolRepository } from '../domain/school-repository.js';

export async function getSchoolInfo(repository: SchoolRepository): Promise<GetSchoolInfoResult> {
  return { ok: true, data: { school: await repository.getSchool() } };
}

export async function getCourses(repository: SchoolRepository): Promise<GetCoursesResult> {
  return { ok: true, data: { courses: await repository.listActiveCourses() } };
}

export async function getCourseDetails(
  repository: SchoolRepository,
  courseId: string,
): Promise<GetCourseDetailsResult> {
  const course = await repository.findActiveCourseById(courseId);

  if (course === null) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Curso não encontrado ou indisponível.' } };
  }

  return { ok: true, data: { course } };
}
