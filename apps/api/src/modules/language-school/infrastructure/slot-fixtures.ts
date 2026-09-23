import type { Slot, TrialClass } from '@supportflow/contracts/language-school';
import { schoolFixture } from './catalog-fixtures.js';

// Datas fixas; os cenários de passado/futuro usam 2030-06-10T12:00:00Z nos testes.
// A composição normal usa o relógio real e nunca desloca/gera horários.
export const slotFixtures: readonly Slot[] = [
  { slotId: 'slot_english_b', courseId: 'course_english_travel', startsAt: '2030-06-12T14:00:00-03:00', timezone: schoolFixture.timezone },
  { slotId: 'slot_english_past', courseId: 'course_english_travel', startsAt: '2030-06-09T10:00:00-03:00', timezone: schoolFixture.timezone },
  { slotId: 'slot_french_a', courseId: 'course_french_intro', startsAt: '2030-06-11T11:00:00-03:00', timezone: schoolFixture.timezone },
  { slotId: 'slot_english_a', courseId: 'course_english_travel', startsAt: '2030-06-11T10:00:00-03:00', timezone: schoolFixture.timezone },
  { slotId: 'slot_english_occupied', courseId: 'course_english_travel', startsAt: '2030-06-11T09:00:00-03:00', timezone: schoolFixture.timezone },
  { slotId: 'slot_spanish_past', courseId: 'course_spanish_conversation', startsAt: '2030-06-09T15:00:00-03:00', timezone: schoolFixture.timezone },
];

// Ocupação fictícia para injeção nos testes. A aplicação começa sem reservas.
export const trialClassFixtures: readonly TrialClass[] = [{
  id: 'trial_demo_occupied', leadId: 'lead_demo_occupied', courseId: 'course_english_travel',
  slotId: 'slot_english_occupied', startsAt: '2030-06-11T09:00:00-03:00',
  timezone: schoolFixture.timezone, status: 'confirmed',
}];
