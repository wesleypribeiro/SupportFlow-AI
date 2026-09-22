import type {
  ActiveCourse,
  ActiveCourseSummary,
  Course,
  School,
} from '@supportflow/contracts/language-school';
import type { SchoolRepository } from '../domain/school-repository.js';

export class InMemorySchoolRepository implements SchoolRepository {
  private readonly school: School;
  private readonly courses: readonly Course[];

  constructor(school: School, courses: readonly Course[]) {
    this.school = structuredClone(school);
    this.courses = structuredClone(courses);
  }

  async getSchool(): Promise<School> {
    return structuredClone(this.school);
  }

  async listActiveCourses(): Promise<ActiveCourseSummary[]> {
    return this.courses
      .filter((course): course is ActiveCourse => course.active === true)
      .map(({ id, name, language, modality, active }) => ({
        id, name, language, modality, active,
      }));
  }

  async findActiveCourseById(courseId: string): Promise<ActiveCourse | null> {
    const course = this.courses.find(
      (candidate): candidate is ActiveCourse => candidate.id === courseId && candidate.active === true,
    );
    return course ? structuredClone(course) : null;
  }
}
