import { describe, expect, it } from 'vitest';
import {
  activeCourseSchema,
  activeCourseSummarySchema,
  courseSchema,
  schoolSchema,
} from '@supportflow/contracts/language-school';
import {
  courseFixtures,
  schoolFixture,
} from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';

describe('fixtures fictícias do catálogo escolar', () => {
  it('atende aos schemas aprovados sem transformar os dados cadastrados', () => {
    expect(schoolSchema.parse(schoolFixture)).toEqual(schoolFixture);
    expect(courseFixtures.map((course) => courseSchema.parse(course))).toEqual(courseFixtures);
  });

  it('mantém o curso inativo nos dados internos', () => {
    expect(courseFixtures.find((course) => course.id === 'course_german_foundations'))
      .toMatchObject({ active: false });
  });
});

describe('InMemorySchoolRepository', () => {
  const createRepository = () => new InMemorySchoolRepository(schoolFixture, courseFixtures);

  it('obtém exatamente os dados da única escola configurada', async () => {
    const school = await createRepository().getSchool();

    expect(school).toEqual(schoolFixture);
    expect(school).not.toBe(schoolFixture);
  });

  it('lista somente os resumos dos cursos ativos sem expor o curso inativo', async () => {
    const courses = await createRepository().listActiveCourses();

    expect(courses).toEqual([
      {
        id: 'course_english_travel', name: 'Inglês para viagens', language: 'Inglês',
        modality: 'online', active: true,
      },
      {
        id: 'course_spanish_conversation', name: 'Conversação em espanhol', language: 'Espanhol',
        modality: 'in_person', active: true,
      },
      {
        id: 'course_french_intro', name: 'Introdução ao francês', language: 'Francês',
        modality: 'online', active: true,
      },
    ]);
    for (const course of courses) {
      expect(activeCourseSummarySchema.safeParse(course).success).toBe(true);
    }
  });

  it.each(courseFixtures.filter((course) => course.active))(
    'preserva todos os detalhes cadastrados do curso ativo $id',
    async (fixture) => {
      const course = await createRepository().findActiveCourseById(fixture.id);

      expect(course).toEqual(fixture);
      expect(activeCourseSchema.safeParse(course).success).toBe(true);
    },
  );

  it.each([
    ['course_english_travel', { amountCents: 35000, currency: 'BRL', billingPeriod: 'month' }],
    ['course_spanish_conversation', null],
    ['course_french_intro', { amountCents: 0, currency: 'BRL', billingPeriod: 'course' }],
  ] as const)('preserva preço, moeda e periodicidade de %s', async (courseId, price) => {
    const course = await createRepository().findActiveCourseById(courseId);

    expect(course?.price).toEqual(price);
  });

  it.each(['course_missing', 'course_german_foundations'])(
    'retorna null para curso inexistente ou inativo: %s',
    async (courseId) => {
      expect(await createRepository().findActiveCourseById(courseId)).toBeNull();
    },
  );

  it('aceita um catálogo sem cursos', async () => {
    const repository = new InMemorySchoolRepository(schoolFixture, []);

    expect(await repository.listActiveCourses()).toEqual([]);
  });

  it('retorna oferta vazia quando todos os cursos cadastrados estão inativos', async () => {
    const repository = new InMemorySchoolRepository(
      schoolFixture, courseFixtures.filter((course) => !course.active),
    );

    expect(await repository.listActiveCourses()).toEqual([]);
  });

  it('isola o estado interno de mudanças nos objetos fornecidos ao construtor', async () => {
    const school = structuredClone(schoolFixture);
    const courses = structuredClone([...courseFixtures]);
    const repository = new InMemorySchoolRepository(school, courses);
    const firstCourse = courses[0];
    if (!firstCourse?.price) throw new Error('A fixture deve conter o curso com preço conhecido.');

    school.name = 'Nome alterado fora do repositório';
    firstCourse.name = 'Curso alterado fora do repositório';
    firstCourse.price.amountCents = 1;
    courses.length = 0;

    expect(await repository.getSchool()).toEqual(schoolFixture);
    expect(await repository.findActiveCourseById('course_english_travel')).toEqual(courseFixtures[0]);
    expect(await repository.listActiveCourses()).toHaveLength(3);
  });

  it('isola o estado interno de mudanças nos dados devolvidos pelas consultas', async () => {
    const repository = createRepository();
    const school = await repository.getSchool();
    const courses = await repository.listActiveCourses();
    const course = await repository.findActiveCourseById('course_english_travel');
    const firstSummary = courses[0];
    if (!course?.price || !firstSummary) throw new Error('A fixture deve conter o curso ativo.');

    school.address = 'Endereço alterado fora do repositório';
    firstSummary.name = 'Resumo alterado fora do repositório';
    courses.length = 0;
    course.name = 'Detalhes alterados fora do repositório';
    course.price.amountCents = 1;

    expect(await repository.getSchool()).toEqual(schoolFixture);
    expect(await repository.findActiveCourseById('course_english_travel')).toEqual(courseFixtures[0]);
    const unchangedCourses = await repository.listActiveCourses();
    expect(unchangedCourses).toHaveLength(3);
    expect(unchangedCourses[0]?.name).toBe('Inglês para viagens');
  });
});
