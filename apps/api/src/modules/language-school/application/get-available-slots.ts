import {
  getCourseDetailsResultSchema,
  schoolSchema,
  slotSchema,
  trialClassSchema,
} from '@supportflow/contracts/language-school';
import type { GetAvailableSlotsResult, Slot } from '@supportflow/contracts/language-school';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { TrialClassRepository } from '../domain/trial-class-repository.js';
import { getCourseDetails } from './catalog-queries.js';

export async function getAvailableSlots(composition: {
  schoolRepository: SchoolRepository;
  trialClassRepository: TrialClassRepository;
  now: () => Date;
}, courseId: string): Promise<GetAvailableSlotsResult> {
  const { schoolRepository, trialClassRepository, now } = composition;
  // Reutiliza a consulta de curso ativo antes de acessar qualquer dado da agenda.
  const course = getCourseDetailsResultSchema.parse(await getCourseDetails(schoolRepository, courseId));
  if (!course.ok) return course;
  if (course.data.course.id !== courseId) throw new Error('Referência de curso incompatível.');

  const school = schoolSchema.parse(await schoolRepository.getSchool());
  const currentInstant = now().getTime();
  if (!Number.isFinite(currentInstant)) throw new Error('Relógio inválido.');
  const slots = slotSchema.array().parse(await trialClassRepository.listSlotsByCourseId(courseId));
  const available: Slot[] = [];
  for (const slot of slots) {
    if (slot.courseId !== courseId) continue;
    if (slot.timezone !== school.timezone) throw new Error('Fuso incompatível com a escola.');
    // Date.parse respeita o offset; o ISO oficial não é convertido no resultado.
    const startsAt = Date.parse(slot.startsAt);
    if (!Number.isFinite(startsAt)) throw new Error('Instante do slot inválido.');
    if (startsAt <= currentInstant) continue;

    const booking = trialClassSchema.nullable().parse(await trialClassRepository.findConfirmedBySlotId(slot.slotId));
    if (booking !== null) {
      if (booking.slotId !== slot.slotId || booking.courseId !== courseId) {
        throw new Error('Ocupação incompatível com o slot.');
      }
      continue;
    }
    available.push(slot);
  }
  available.sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt));
  return { ok: true, data: { courseId, slots: available } };
}
