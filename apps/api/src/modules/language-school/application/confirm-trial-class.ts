import { scheduleTrialClassResultSchema } from '@supportflow/contracts/language-school';
import type { ScheduleTrialClassInput, ScheduleTrialClassResult } from '@supportflow/contracts/language-school';
import { trialClassFailure, validateTrialClassReferences } from './prepare-trial-class.js';
import type { TrialClassProposalDependencies, TrialClassScope } from './prepare-trial-class.js';

export async function confirmTrialClassReservation(
  dependencies: TrialClassProposalDependencies, scope: TrialClassScope, input: ScheduleTrialClassInput,
): Promise<ScheduleTrialClassResult> {
  const validated = await validateTrialClassReferences(dependencies, scope, input);
  if (!validated.ok) return validated;
  const { lead, slot } = validated.preview;
  // Não fazer read-then-write de ocupação aqui. O repository decide atomicamente,
  // inclusive se outra conversa ocupou a vaga enquanto referências eram validadas.
  const reservation = await dependencies.trialClassRepository.reserveSlot(
    { leadId: lead.id, slotId: slot.slotId }, dependencies.now(),
  );
  if (reservation.outcome === 'not_found') return trialClassFailure('NOT_FOUND');
  if (reservation.outcome === 'unavailable') return trialClassFailure('SLOT_UNAVAILABLE');
  const result = scheduleTrialClassResultSchema.parse({ ok: true, data: reservation });
  if (result.ok && (result.data.booking.leadId !== lead.id || result.data.booking.slotId !== slot.slotId
    || result.data.booking.courseId !== slot.courseId)) throw new Error('Reserva incompatível com a ação confirmada.');
  return result;
}
