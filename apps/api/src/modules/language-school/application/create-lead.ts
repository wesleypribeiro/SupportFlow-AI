import {
  createLeadInputSchema,
  createLeadResultSchema,
  getCourseDetailsResultSchema,
} from '@supportflow/contracts/language-school';
import type { CreateLeadInput, CreateLeadResult, ToolFailure } from '@supportflow/contracts/language-school';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import { getCourseDetails } from './catalog-queries.js';

export type LeadScope = { conversationId: string; context: ConversationContext };
type Repositories = { schoolRepository: SchoolRepository; leadRepository: LeadRepository };

export function leadFailure(code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFIRMATION_REQUIRED' | 'OPERATION_FAILED'): ToolFailure {
  const messages = {
    INVALID_INPUT: 'Informe nome, contato e curso válidos e coerentes com os dados atuais da conversa.',
    NOT_FOUND: 'Conversa ou curso não encontrado ou indisponível.',
    CONFIRMATION_REQUIRED: 'Revise a prévia e confirme o cadastro antes de gravá-lo.',
    OPERATION_FAILED: 'Não foi possível concluir o cadastro. Nenhum sucesso foi confirmado.',
  };
  return { ok: false, error: { code, message: messages[code] } };
}

function alreadyRegistered(): ToolFailure {
  return { ok: false, error: {
    code: 'OPERATION_FAILED', message: 'Esta conversa já possui um cadastro. Nenhum dado foi alterado.',
  } };
}

// Produz somente uma prévia elegível. Não conhece armazenamento de ações, HTTP ou LLM.
export async function prepareLeadRegistration(
  repositories: Repositories, scope: LeadScope, input: CreateLeadInput,
): Promise<{ ok: true; preview: CreateLeadInput } | ToolFailure> {
  const { context, conversationId } = scope;
  const current = createLeadInputSchema.safeParse({
    name: context.name, contact: context.contact, courseId: context.courseId, goal: context.goal,
  });
  if (!current.success
    || input.name !== current.data.name
    || input.contact.type !== current.data.contact.type
    || input.contact.value !== current.data.contact.value
    || input.courseId !== current.data.courseId
    || input.goal !== current.data.goal) return leadFailure('INVALID_INPUT');

  const course = getCourseDetailsResultSchema.parse(
    await getCourseDetails(repositories.schoolRepository, current.data.courseId),
  );
  if (!course.ok) return course;
  if (course.data.course.id !== current.data.courseId) throw new Error('Referência de catálogo incompatível.');
  if (context.leadId !== null || await repositories.leadRepository.findByConversationId(conversationId)) {
    return alreadyRegistered();
  }
  return { ok: true, preview: current.data };
}

// Invocado somente pelo executor da confirmação. A política existing/updated fica para 4.3.
export async function createFirstLead(
  repositories: Repositories, scope: LeadScope, input: CreateLeadInput,
): Promise<CreateLeadResult> {
  const prepared = await prepareLeadRegistration(repositories, scope, input);
  if (!prepared.ok) return prepared;
  const lead = await repositories.leadRepository.createForConversation(scope.conversationId, prepared.preview);
  if (lead === null) return alreadyRegistered();
  return createLeadResultSchema.parse({ ok: true, data: { outcome: 'created', lead } });
}
