import type { ScheduleTrialClassInput, Slot, TrialClass } from '@supportflow/contracts/language-school';

export type SlotReservationResult =
  | { outcome: 'created' | 'existing'; booking: TrialClass }
  | { outcome: 'unavailable' | 'not_found' };

// Agenda da escola configurada. Leituras não reservam nem bloqueiam a vaga.
export interface TrialClassRepository {
  listSlotsByCourseId(courseId: string): Promise<Slot[]>;
  findSlotById(slotId: string): Promise<Slot | null>;
  findConfirmedBySlotId(slotId: string): Promise<TrialClass | null>;
  // Verifica e ocupa atomicamente; repetição do mesmo lead/slot recupera o registro.
  reserveSlot(input: ScheduleTrialClassInput, now: Date): Promise<SlotReservationResult>;
}
