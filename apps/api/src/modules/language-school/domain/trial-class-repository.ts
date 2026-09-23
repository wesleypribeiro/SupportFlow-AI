import type { Slot, TrialClass } from '@supportflow/contracts/language-school';

// Agenda da escola configurada. Leituras não reservam nem bloqueiam a vaga.
// A futura reserva atômica usará o mesmo estado de slots e ocupação.
export interface TrialClassRepository {
  listSlotsByCourseId(courseId: string): Promise<Slot[]>;
  findSlotById(slotId: string): Promise<Slot | null>;
  findConfirmedBySlotId(slotId: string): Promise<TrialClass | null>;
}
