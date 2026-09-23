import { scheduleTrialClassInputSchema, scheduleTrialClassResultSchema } from '@supportflow/contracts/language-school';
import type { ScheduleTrialClassResult } from '@supportflow/contracts/language-school';
import { prepareTrialClassProposal, trialClassFailure } from '../application/prepare-trial-class.js';
import type { TrialClassPreview, TrialClassProposalDependencies, TrialClassScope } from '../application/prepare-trial-class.js';

export function createScheduleTrialClassTool(composition: TrialClassProposalDependencies & {
  prepareAction: (scope: TrialClassScope, preview: TrialClassPreview) => void;
  clearPendingAction: (scope: TrialClassScope) => void;
}) {
  // Escopo oficial separado da entrada pública. Ainda sem registro no LangChain.
  return async function schedule_trial_class(input: unknown, scope: TrialClassScope): Promise<ScheduleTrialClassResult> {
    const parsed = scheduleTrialClassInputSchema.safeParse(input);
    if (!parsed.success) return scheduleTrialClassResultSchema.parse(trialClassFailure('INVALID_INPUT'));
    try {
      const proposal = await prepareTrialClassProposal(composition, scope, parsed.data);
      if (!proposal.ok) return scheduleTrialClassResultSchema.parse(proposal);
      if (proposal.decision === 'existing') {
        const result = scheduleTrialClassResultSchema.parse({ ok: true, data: { outcome: 'existing', booking: proposal.booking } });
        composition.clearPendingAction(scope);
        return result;
      }
      const result = scheduleTrialClassResultSchema.parse(trialClassFailure('CONFIRMATION_REQUIRED'));
      composition.prepareAction(scope, proposal.preview);
      return result;
    } catch {
      return scheduleTrialClassResultSchema.parse(trialClassFailure('OPERATION_FAILED'));
    }
  };
}
