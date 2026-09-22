import { createLeadInputSchema, createLeadResultSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput, CreateLeadResult } from '@supportflow/contracts/language-school';
import { leadFailure, prepareLeadRegistration } from '../application/create-lead.js';
import type { LeadScope } from '../application/create-lead.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';

export function createLeadTool(composition: {
  schoolRepository: SchoolRepository;
  leadRepository: LeadRepository;
  prepareAction: (scope: LeadScope, preview: CreateLeadInput) => void;
}) {
  // O escopo é um parâmetro do backend separado dos argumentos da tool.
  return async function create_lead(input: unknown, scope: LeadScope): Promise<CreateLeadResult> {
    const parsed = createLeadInputSchema.safeParse(input);
    if (!parsed.success) return createLeadResultSchema.parse(leadFailure('INVALID_INPUT'));
    try {
      const prepared = await prepareLeadRegistration(composition, scope, parsed.data);
      if (!prepared.ok) return createLeadResultSchema.parse(prepared);
      composition.prepareAction(scope, prepared.preview);
      return createLeadResultSchema.parse(leadFailure('CONFIRMATION_REQUIRED'));
    } catch {
      return createLeadResultSchema.parse(leadFailure('OPERATION_FAILED'));
    }
  };
}
