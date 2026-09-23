import { describe, expect, it } from 'vitest';
import { slotSchema, trialClassSchema } from '@supportflow/contracts/language-school';
import { courseFixtures, schoolFixture } from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemoryTrialClassRepository } from '../../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures, trialClassFixtures } from '../../src/modules/language-school/infrastructure/slot-fixtures.js';

describe('agenda em memória: somente leitura', () => {
  it('localiza slot por ID sem ocupá-lo e devolve cópia defensiva ou null', async () => {
    const slots = structuredClone([...slotFixtures]);
    const repository = new InMemoryTrialClassRepository(slots);
    const expected = structuredClone(slots[0]!);
    slots[0]!.timezone = 'UTC';
    const found = await repository.findSlotById(expected.slotId);
    expect(found).toEqual(expected);
    found!.startsAt = '2040-01-01T00:00:00Z';
    expect(await repository.findSlotById(expected.slotId)).toEqual(expected);
    expect(await repository.findSlotById('slot_missing')).toBeNull();
    expect(await repository.findConfirmedBySlotId(expected.slotId)).toBeNull();
  });

  it('fixtures têm contratos válidos, cursos existentes e o fuso da escola', () => {
    expect(slotSchema.array().parse(slotFixtures)).toEqual(slotFixtures);
    expect(trialClassSchema.array().parse(trialClassFixtures)).toEqual(trialClassFixtures);
    for (const slot of slotFixtures) {
      expect(courseFixtures.some((course) => course.id === slot.courseId)).toBe(true);
      expect(slot.timezone).toBe(schoolFixture.timezone);
    }
    for (const booking of trialClassFixtures) {
      expect(slotFixtures).toContainEqual({
        slotId: booking.slotId, courseId: booking.courseId,
        startsAt: booking.startsAt, timezone: booking.timezone,
      });
    }
  });

  it('isola slots por curso e devolve lista vazia para referência sem slots', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    for (const course of courseFixtures) {
      expect(await repository.listSlotsByCourseId(course.id))
        .toEqual(slotFixtures.filter((slot) => slot.courseId === course.id));
    }
    expect(await repository.listSlotsByCourseId('course_missing')).toEqual([]);
  });

  it('copia slots e reservas na construção e em cada leitura', async () => {
    const slots = structuredClone([...slotFixtures]);
    const bookings = structuredClone([...trialClassFixtures]);
    const repository = new InMemoryTrialClassRepository(slots, bookings);
    slots[0]!.startsAt = '2040-01-01T00:00:00Z';
    bookings[0]!.leadId = 'lead_modified';
    slots.splice(0); bookings.splice(0);
    const result = await repository.listSlotsByCourseId('course_english_travel');
    result[0]!.timezone = 'UTC';
    result.splice(1);
    const booking = await repository.findConfirmedBySlotId('slot_english_occupied');
    booking!.leadId = 'lead_modified_return';
    expect(await repository.listSlotsByCourseId('course_english_travel'))
      .toEqual(slotFixtures.filter((slot) => slot.courseId === 'course_english_travel'));
    expect(await repository.findConfirmedBySlotId('slot_english_occupied')).toEqual(trialClassFixtures[0]);
  });

  it('reconhece ocupação inicial e não ocupa vagas durante leituras repetidas', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures, trialClassFixtures);
    for (let query = 0; query < 2; query++) {
      expect(await repository.listSlotsByCourseId('course_english_travel'))
        .toEqual(slotFixtures.filter((slot) => slot.courseId === 'course_english_travel'));
      const bookings = await Promise.all(slotFixtures.map((slot) => repository.findConfirmedBySlotId(slot.slotId)));
      expect(bookings.filter((booking) => booking !== null)).toEqual(trialClassFixtures);
      expect(await repository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    }
  });

  it('inicia sem reservas quando a composição não fornece ocupação inicial', async () => {
    const repository = new InMemoryTrialClassRepository(slotFixtures);
    for (const slot of slotFixtures) expect(await repository.findConfirmedBySlotId(slot.slotId)).toBeNull();
    expect(await repository.findConfirmedBySlotId('slot_missing')).toBeNull();
  });
});
