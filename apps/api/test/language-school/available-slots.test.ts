import { describe, expect, it, vi } from 'vitest';
import { getAvailableSlotsResultSchema, languageSchoolToolResultSchema, slotSchema } from '@supportflow/contracts/language-school';
import type { ActiveCourse, Slot, TrialClass } from '@supportflow/contracts/language-school';
import { getAvailableSlots } from '../../src/modules/language-school/application/get-available-slots.js';
import { createAvailableSlotsTool } from '../../src/modules/language-school/infrastructure/available-slots-tool.js';
import { courseFixtures, schoolFixture } from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryTrialClassRepository } from '../../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures, trialClassFixtures } from '../../src/modules/language-school/infrastructure/slot-fixtures.js';

const courseId = 'course_english_travel';
const now = () => new Date('2030-06-10T12:00:00Z');
const availableEnglish = ['slot_english_a', 'slot_english_b'].map((id) => slotFixtures.find((slot) => slot.slotId === id)!);
function composition(slots: readonly Slot[] = slotFixtures, bookings: readonly TrialClass[] = trialClassFixtures) {
  return {
    schoolRepository: new InMemorySchoolRepository(schoolFixture, courseFixtures),
    trialClassRepository: new InMemoryTrialClassRepository(slots, bookings), now,
  };
}
function slot(slotId: string, startsAt: string): Slot {
  return { slotId, courseId, startsAt, timezone: schoolFixture.timezone };
}

describe('disponibilidade determinística por curso e instante', () => {
  it('retorna somente slots futuros livres, em ordem cronológica, preservando todos os valores', async () => {
    const dependencies = composition();
    const clock = vi.fn(now);
    const result = await getAvailableSlots({ ...dependencies, now: clock }, courseId);
    expect(result).toEqual({ ok: true, data: { courseId, slots: availableEnglish } });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(getAvailableSlotsResultSchema.parse(result)).toEqual(result);
    if (!result.ok) throw new Error('Esperado sucesso.');
    result.data.slots.forEach((entry) => expect(slotSchema.parse(entry)).toEqual(entry));
    expect(dependencies.now().toISOString()).toBe('2030-06-10T12:00:00.000Z');
  });

  it('ordena por instante, não texto, respeita offsets e exclui passado e igualdade com now', async () => {
    const earlierFuture = slot('earlier', '2030-06-10T13:00:00Z');
    const laterFuture = slot('later', '2030-06-10T11:00:00-03:00'); // 14h UTC, apesar de 11 < 13 no texto.
    const slots = [laterFuture, slot('equal_offset', '2030-06-10T09:00:00-03:00'),
      slot('past', '2030-06-10T08:59:59-03:00'), earlierFuture, slot('equal_z', '2030-06-10T12:00:00Z')];
    const result = await getAvailableSlots(composition(slots, []), courseId);
    expect(result).toEqual({ ok: true, data: { courseId, slots: [earlierFuture, laterFuture] } });
  });

  it('não depende da ordem física das fixtures e não altera essa ordem no repository', async () => {
    const dependencies = composition([...slotFixtures].reverse());
    const before = await dependencies.trialClassRepository.listSlotsByCourseId(courseId);
    expect(await getAvailableSlots(dependencies, courseId))
      .toEqual({ ok: true, data: { courseId, slots: availableEnglish } });
    expect(await dependencies.trialClassRepository.listSlotsByCourseId(courseId)).toEqual(before);
  });

  it.each(['no-slots', 'only-past', 'only-occupied'] as const)('curso ativo sem vaga é sucesso: %s', async (scenario) => {
    const dependencies = scenario === 'no-slots' ? composition([], [])
      : scenario === 'only-occupied' ? composition(slotFixtures.filter((entry) => entry.slotId === 'slot_english_occupied'))
        : composition();
    const requested = scenario === 'only-past' ? 'course_spanish_conversation' : courseId;
    expect(await getAvailableSlots(dependencies, requested)).toEqual({ ok: true, data: { courseId: requested, slots: [] } });
  });

  it('outro curso retorna apenas os seus horários', async () => {
    const french = 'course_french_intro';
    expect(await getAvailableSlots(composition(), french)).toEqual({
      ok: true, data: { courseId: french, slots: slotFixtures.filter((entry) => entry.courseId === french) },
    });
  });

  it.each(['course_missing', 'course_german_foundations'])('recusa curso %s antes de ler a agenda', async (requested) => {
    const dependencies = composition([
      ...slotFixtures, { ...availableEnglish[0]!, courseId: 'course_german_foundations', slotId: 'slot_inactive_course' },
    ]);
    const listing = vi.spyOn(dependencies.trialClassRepository, 'listSlotsByCourseId');
    const occupancy = vi.spyOn(dependencies.trialClassRepository, 'findConfirmedBySlotId');
    const clock = vi.fn(now);
    const result = await createAvailableSlotsTool({ ...dependencies, now: clock })({ courseId: requested });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(listing).not.toHaveBeenCalled(); expect(occupancy).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  });

  it('mesmo se o repository misturar cursos, a consulta não publica slots estrangeiros', async () => {
    const dependencies = composition();
    vi.spyOn(dependencies.trialClassRepository, 'listSlotsByCourseId').mockResolvedValue([...slotFixtures]);
    expect(await getAvailableSlots(dependencies, courseId)).toEqual({ ok: true, data: { courseId, slots: availableEnglish } });
  });

  it('consultas repetidas preservam slots livres, reservas e IDs; alteração do retorno não afeta estado', async () => {
    const dependencies = composition();
    const tool = createAvailableSlotsTool(dependencies);
    const before = await Promise.all(slotFixtures.map((entry) => dependencies.trialClassRepository.findConfirmedBySlotId(entry.slotId)));
    const first = await tool({ courseId });
    const second = await tool({ courseId });
    expect(second).toEqual(first);
    expect(second).toEqual({ ok: true, data: { courseId, slots: availableEnglish } });
    if (!first.ok) throw new Error('Esperado sucesso.');
    first.data.slots[0]!.startsAt = '2040-01-01T00:00:00Z';
    expect(await tool({ courseId })).toEqual(second);
    const after = await Promise.all(slotFixtures.map((entry) => dependencies.trialClassRepository.findConfirmedBySlotId(entry.slotId)));
    expect(after).toEqual(before);
    expect(after.filter((booking) => booking !== null)).toEqual(trialClassFixtures);
    for (const entry of availableEnglish) expect(await dependencies.trialClassRepository.findConfirmedBySlotId(entry.slotId)).toBeNull();
  });
});

describe('adapter get_available_slots', () => {
  it('aceita input estrito e publica envelope compatível com os schemas aprovados', async () => {
    const result = await createAvailableSlotsTool(composition())({ courseId });
    expect(getAvailableSlotsResultSchema.parse(result)).toEqual(result);
    expect(languageSchoolToolResultSchema.parse({ tool: 'get_available_slots', result }))
      .toEqual({ tool: 'get_available_slots', result: { ok: true, data: { courseId, slots: availableEnglish } } });
  });

  it.each([{}, { courseId: 42 }, { courseId: '' }, { courseId: ' ' }, null, { courseId, extra: true }, { courseId, schoolId: 'other' }])(
    'rejeita input inválido sem consulta: %j', async (input) => {
      const dependencies = composition();
      const catalog = vi.spyOn(dependencies.schoolRepository, 'findActiveCourseById');
      const agenda = vi.spyOn(dependencies.trialClassRepository, 'listSlotsByCourseId');
      expect(await createAvailableSlotsTool(dependencies)(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(catalog).not.toHaveBeenCalled(); expect(agenda).not.toHaveBeenCalled();
    },
  );

  it.each(['catalog', 'school', 'slots', 'occupancy', 'clock'] as const)('sanitiza falha de %s', async (source) => {
    const dependencies = composition();
    const error = new Error('INTERNAL_SECRET /infra/stack');
    if (source === 'catalog') vi.spyOn(dependencies.schoolRepository, 'findActiveCourseById').mockRejectedValue(error);
    if (source === 'school') vi.spyOn(dependencies.schoolRepository, 'getSchool').mockRejectedValue(error);
    if (source === 'slots') vi.spyOn(dependencies.trialClassRepository, 'listSlotsByCourseId').mockRejectedValue(error);
    if (source === 'occupancy') vi.spyOn(dependencies.trialClassRepository, 'findConfirmedBySlotId').mockRejectedValue(error);
    if (source === 'clock') dependencies.now = () => { throw error; };
    const result = await createAvailableSlotsTool(dependencies)({ courseId });
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(getAvailableSlotsResultSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/INTERNAL_SECRET|infra|stack/);
  });

  it.each([
    { startsAt: 'sem data' }, { startsAt: '2030-06-11T10:00:00' }, { timezone: 'Invalid/Zone' },
    { timezone: 'UTC' }, { slotId: 42 }, { secret: 'INTERNAL_SECRET' },
  ])('não publica resposta parcial quando um slot interno é inválido: %j', async (patch) => {
    const dependencies = composition();
    vi.spyOn(dependencies.trialClassRepository, 'listSlotsByCourseId').mockResolvedValue([
      availableEnglish[0]!, { ...availableEnglish[1], ...patch } as unknown as Slot,
    ]);
    const result = await createAvailableSlotsTool(dependencies)({ courseId });
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain('INTERNAL_SECRET');
  });

  it.each([{ status: 'pending' }, { slotId: 'other_slot' }, { courseId: 'other_course' }])('não trata ocupação inválida como vaga livre: %j', async (patch) => {
    const dependencies = composition();
    vi.spyOn(dependencies.trialClassRepository, 'findConfirmedBySlotId').mockResolvedValue({
      ...trialClassFixtures[0], ...patch,
    } as unknown as TrialClass);
    expect(await createAvailableSlotsTool(dependencies)({ courseId }))
      .toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
  });

  it.each([{ active: false }, { id: 'other_course' }])('não revela agenda se o catálogo devolver curso incompatível: %j', async (patch) => {
    const dependencies = composition();
    vi.spyOn(dependencies.schoolRepository, 'findActiveCourseById').mockResolvedValue({
      ...courseFixtures[0], ...patch,
    } as unknown as ActiveCourse);
    const agenda = vi.spyOn(dependencies.trialClassRepository, 'listSlotsByCourseId');
    expect(await createAvailableSlotsTool(dependencies)({ courseId })).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(agenda).not.toHaveBeenCalled();
  });

  it('clock inválido retorna falha, sem fabricar lista vazia de sucesso', async () => {
    expect(await createAvailableSlotsTool({ ...composition(), now: () => new Date('invalid') })({ courseId }))
      .toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
  });
});
