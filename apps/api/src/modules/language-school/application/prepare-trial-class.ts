import {
  getCourseDetailsResultSchema,
  leadSchema,
  schoolSchema,
  slotSchema,
  trialClassPendingActionSchema,
  trialClassSchema,
} from '@supportflow/contracts/language-school';
import type { ScheduleTrialClassInput, ToolFailure, TrialClassPendingAction } from '@supportflow/contracts/language-school';
import { conversationContextSchema } from '../domain/conversation-context.js';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { TrialClassRepository } from '../domain/trial-class-repository.js';
import { getCourseDetails } from './catalog-queries.js';

export type TrialClassScope = { conversationId: string; context: ConversationContext };
export type TrialClassPreview = TrialClassPendingAction['preview'];
export type TrialClassProposalDependencies = {
  schoolRepository: SchoolRepository;
  leadRepository: LeadRepository;
  trialClassRepository: TrialClassRepository;
  now: () => Date;
};

export function trialClassFailure(
  code: 'INVALID_INPUT' | 'NOT_FOUND' | 'SLOT_UNAVAILABLE' | 'CONFIRMATION_REQUIRED' | 'OPERATION_FAILED',
): ToolFailure {
  const messages = {
    INVALID_INPUT: 'Informe referências válidas e coerentes com o cadastro e a seleção atuais da conversa.',
    NOT_FOUND: 'Conversa, cadastro, curso ou horário não encontrado ou indisponível.',
    SLOT_UNAVAILABLE: 'Este horário não está disponível. Consulte os horários novamente.',
    CONFIRMATION_REQUIRED: 'Revise a prévia da aula experimental. A proposta exige confirmação específica e ainda não reserva a vaga.',
    OPERATION_FAILED: 'Não foi possível preparar a aula experimental. Nenhuma reserva foi confirmada.',
  };
  return { ok: false, error: { code, message: messages[code] } };
}

// Apenas leituras e validação. A proposta não autoriza nem ocupa a vaga.
export async function prepareTrialClassProposal(
  dependencies: TrialClassProposalDependencies, scope: TrialClassScope, input: ScheduleTrialClassInput,
): Promise<{ ok: true; preview: TrialClassPreview } | ToolFailure> {
  const { schoolRepository, leadRepository, trialClassRepository, now } = dependencies;
  const context = conversationContextSchema.parse(scope.context);
  if (context.leadId === null || input.leadId !== context.leadId) return trialClassFailure('NOT_FOUND');
  const lead = leadSchema.nullable().parse(await leadRepository.findByConversationId(scope.conversationId));
  if (lead === null) return trialClassFailure('NOT_FOUND');
  if (lead.id !== context.leadId) throw new Error('Vínculo interno de lead incompatível.');

  if (lead.name !== context.name || lead.contact.type !== context.contact?.type
    || lead.contact.value !== context.contact?.value || lead.courseId !== context.courseId || lead.goal !== context.goal) {
    return { ok: false, error: {
      code: 'INVALID_INPUT', message: 'Revise e confirme a atualização do cadastro antes de propor uma aula experimental.',
    } };
  }
  if (context.slotId !== null && input.slotId !== context.slotId) return trialClassFailure('INVALID_INPUT');

  const result = getCourseDetailsResultSchema.parse(await getCourseDetails(schoolRepository, lead.courseId));
  if (!result.ok) return result;
  const course = result.data.course;
  if (course.id !== lead.courseId) throw new Error('Referência de catálogo incompatível.');

  const slot = slotSchema.nullable().parse(await trialClassRepository.findSlotById(input.slotId));
  if (slot === null) return trialClassFailure('NOT_FOUND');
  if (slot.slotId !== input.slotId) throw new Error('Referência de horário incompatível.');
  if (slot.courseId !== course.id) return trialClassFailure('INVALID_INPUT');
  const school = schoolSchema.parse(await schoolRepository.getSchool());
  if (slot.timezone !== school.timezone) throw new Error('Fuso incompatível com a escola.');
  const currentInstant = now().getTime();
  const startsAt = Date.parse(slot.startsAt);
  if (!Number.isFinite(currentInstant) || !Number.isFinite(startsAt)) throw new Error('Instante inválido.');
  if (startsAt <= currentInstant) return trialClassFailure('SLOT_UNAVAILABLE');

  const booking = trialClassSchema.nullable().parse(await trialClassRepository.findConfirmedBySlotId(slot.slotId));
  if (booking !== null) {
    if (booking.slotId !== slot.slotId || booking.courseId !== course.id) throw new Error('Ocupação incompatível com o horário.');
    return trialClassFailure('SLOT_UNAVAILABLE');
  }

  // Projeção explícita do resumo oficial, sem preço/descrição extras no contrato.
  const preview = trialClassPendingActionSchema.shape.preview.parse({
    lead, course: { id: course.id, name: course.name, language: course.language, modality: course.modality, active: course.active }, slot,
  });
  return { ok: true, preview };
}
