import {
  createLeadInputSchema,
  createLeadResultSchema,
  getCourseDetailsResultSchema,
  leadSchema,
} from '@supportflow/contracts/language-school';
import type { CreateLeadInput, CreateLeadResult, Lead, ToolFailure } from '@supportflow/contracts/language-school';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import { getCourseDetails } from './catalog-queries.js';

export type LeadScope = { conversationId: string; context: ConversationContext };
type Repositories = { schoolRepository: SchoolRepository; leadRepository: LeadRepository };
type LeadPlan =
  | { ok: true; decision: 'create'; preview: CreateLeadInput; lead: null }
  | { ok: true; decision: 'existing' | 'update'; preview: CreateLeadInput; lead: Lead }
  | ToolFailure;

export function leadFailure(code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFIRMATION_REQUIRED' | 'OPERATION_FAILED'): ToolFailure {
  const messages = {
    INVALID_INPUT: 'Informe nome, contato e curso válidos e coerentes com os dados atuais da conversa.',
    NOT_FOUND: 'Conversa ou curso não encontrado ou indisponível.',
    CONFIRMATION_REQUIRED: 'Revise a prévia e confirme o cadastro antes de gravá-lo.',
    OPERATION_FAILED: 'Não foi possível concluir o cadastro. Nenhum sucesso foi confirmado.',
  };
  return { ok: false, error: { code, message: messages[code] } };
}

function sameLeadData(left: CreateLeadInput, right: CreateLeadInput): boolean {
  return left.name === right.name
    && left.contact.type === right.contact.type
    && left.contact.value === right.contact.value
    && left.courseId === right.courseId
    && left.goal === right.goal;
}

// Decide sem escrever. Não conhece armazenamento de ações, HTTP ou LLM.
export async function prepareLeadRegistration(
  repositories: Repositories, scope: LeadScope, input: CreateLeadInput,
): Promise<LeadPlan> {
  const { context, conversationId } = scope;
  const current = createLeadInputSchema.safeParse({
    name: context.name, contact: context.contact, courseId: context.courseId, goal: context.goal,
  });
  if (!current.success || !sameLeadData(input, current.data)) return leadFailure('INVALID_INPUT');

  const stored = await repositories.leadRepository.findByConversationId(conversationId);
  const lead = stored === null ? null : leadSchema.parse(stored);
  if ((lead?.id ?? null) !== context.leadId) {
    throw new Error('Vínculo interno de lead incompatível com a conversa.');
  }

  const course = getCourseDetailsResultSchema.parse(
    await getCourseDetails(repositories.schoolRepository, current.data.courseId),
  );
  if (!course.ok) return course;
  if (course.data.course.id !== current.data.courseId) throw new Error('Referência de catálogo incompatível.');
  if (!lead) return { ok: true, decision: 'create', preview: current.data, lead: null };
  return { ok: true, decision: sameLeadData(lead, current.data) ? 'existing' : 'update', preview: current.data, lead };
}

// Somente o executor de confirmação pode aplicar o plano que exige escrita.
export async function confirmLeadRegistration(
  repositories: Repositories, scope: LeadScope, input: CreateLeadInput,
): Promise<CreateLeadResult> {
  const plan = await prepareLeadRegistration(repositories, scope, input);
  if (!plan.ok) return plan;
  if (plan.decision === 'existing') {
    return createLeadResultSchema.parse({ ok: true, data: { outcome: 'existing', lead: plan.lead } });
  }
  const lead = plan.decision === 'create'
    ? await repositories.leadRepository.createForConversation(scope.conversationId, plan.preview)
    : await repositories.leadRepository.updateForConversation(scope.conversationId, plan.preview);
  if (lead === null || (plan.lead !== null && lead.id !== plan.lead.id)) {
    throw new Error('Registro de lead incompatível com a operação confirmada.');
  }
  return createLeadResultSchema.parse({
    ok: true, data: { outcome: plan.decision === 'create' ? 'created' : 'updated', lead },
  });
}
