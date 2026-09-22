import type { ActiveCourse, ActiveCourseSummary, School } from '@supportflow/contracts/language-school';

// Uma instância representa a escola configurada no backend, sem seleção pelo cliente.
export interface SchoolRepository {
  getSchool(): Promise<School>;
  listActiveCourses(): Promise<ActiveCourseSummary[]>;
  findActiveCourseById(courseId: string): Promise<ActiveCourse | null>;
}
