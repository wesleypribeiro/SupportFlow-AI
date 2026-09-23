import { scheduleTrialClassInputSchema, scheduleTrialClassResultSchema } from '@supportflow/contracts/language-school';
import type { ScheduleTrialClassResult } from '@supportflow/contracts/language-school';
import { prepareTrialClassProposal, trialClassFailure } from '../application/prepare-trial-class.js';
import type { TrialClassPreview, TrialClassProposalDependencies, TrialClassScope } from '../application/prepare-trial-class.js';

export function createScheduleTrialClassTool(composition: TrialClassProposalDependencies & {
  prepareAction: (scope: TrialClassScope, preview: TrialClassPreview) => void;
}) {
  // Escopo oficial separado da entrada pública. Ainda sem registro no LangChain.
  return async function schedule_trial_class(input: unknown, scope: TrialClassScope): Promise<ScheduleTrialClassResult> {
    const parsed = scheduleTrialClassInputSchema.safeParse(input);
    if (!parsed.success) return scheduleTrialClassResultSchema.parse(trialClassFailure('INVALID_INPUT'));
    try {
      const proposal = await prepareTrialClassProposal(composition, scope, parsed.data);
      if (!proposal.ok) return scheduleTrialClassResultSchema.parse(proposal);
      const result = scheduleTrialClassResultSchema.parse(trialClassFailure('CONFIRMATION_REQUIRED'));
      composition.prepareAction(scope, proposal.preview);
      return result;
    } catch {
      return scheduleTrialClassResultSchema.parse(trialClassFailure('OPERATION_FAILED'));
    }
  };
}
