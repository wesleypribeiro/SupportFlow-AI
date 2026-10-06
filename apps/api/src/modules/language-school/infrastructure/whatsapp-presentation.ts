import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import type {
  ActiveCourseSummary, CreateLeadInput, LanguageSchoolPendingAction,
  LanguageSchoolToolResult, Price, Slot,
} from '@supportflow/contracts/language-school';
import {
  splitWhatsAppText, WHATSAPP_INTERACTIVE_BODY_LIMIT,
} from '../../../channels/whatsapp/presentation.js';
import type { WhatsAppMessage } from '../../../channels/whatsapp/transport.js';

export type LanguageSchoolWhatsAppPresentation = {
  messages: Extract<WhatsAppMessage, { type: 'text' }>[];
  // Apenas conteúdo para composição do botão pelo canal. Não é mensagem enviável,
  // referência interativa, autorização ou evidência de commit/entrega.
  confirmation: (Pick<LanguageSchoolPendingAction, 'actionId' | 'kind'> & {
    body: string;
    buttonTitle: string;
  }) | null;
};

function courseDetails(course: ActiveCourseSummary): string {
  return [
    `Curso: ${course.name}`, `Identificador do curso: ${course.id}`,
    `Idioma: ${course.language}`, `Modalidade: ${course.modality === 'online' ? 'Online' : 'Presencial'}`,
    'Ativo: sim',
  ].join('\n');
}

function priceDetails(price: Price | null): string {
  if (price === null) return 'Preço indisponível (não informado).';
  const amount = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: price.currency })
    .format(price.amountCents / 100).replaceAll('\u00a0', ' ');
  return `Preço: ${amount} ${price.billingPeriod === 'month' ? 'por mês' : 'por curso'}`;
}

function slotDetails(slot: Pick<Slot, 'startsAt' | 'timezone'>): string {
  const instant = new Date(slot.startsAt);
  const date = new Intl.DateTimeFormat('pt-BR', {
    timeZone: slot.timezone, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('pt-BR', {
    timeZone: slot.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant);
  return `Data e hora: ${date} às ${time}\nFuso: ${slot.timezone}`;
}

function leadDetails(lead: CreateLeadInput): string {
  return [
    `Nome: ${lead.name}`, `Contato (${lead.contact.type === 'email' ? 'e-mail' : 'telefone'}): ${lead.contact.value}`,
    `Curso: ${lead.courseId}`, `Objetivo: ${lead.goal ?? 'Não informado'}`,
  ].join('\n');
}

const resultLabels: Record<LanguageSchoolToolResult['tool'], string> = {
  get_school_info: 'Informações oficiais da escola', get_courses: 'Catálogo oficial',
  get_course_details: 'Detalhes oficiais do curso', get_available_slots: 'Horários oficiais',
  create_lead: 'Cadastro', schedule_trial_class: 'Aula experimental', transfer_to_human: 'Solicitação de atendimento humano',
};

function presentResult(entry: LanguageSchoolToolResult): string {
  if (!entry.result.ok) {
    const { code, message } = entry.result.error;
    const guidance = code === 'CONFIRMATION_REQUIRED' ? '\nAguardando confirmação. Revise a prévia atual.'
      : code === 'SLOT_UNAVAILABLE' ? '\nEste horário não está mais disponível. Consulte os horários novamente.' : '';
    return `${resultLabels[entry.tool]}\n${message}${guidance}`;
  }
  // O switch mantém a associação da tool ao contrato específico de sucesso.
  switch (entry.tool) {
    case 'get_school_info': {
      if (!entry.result.ok) break;
      const { school } = entry.result.data;
      return [
        'Informações oficiais da escola', school.name, school.description,
        `Identificador da escola: ${school.id}`, `Endereço: ${school.address}`,
        `Contato: ${school.contact}`, `Funcionamento: ${school.openingHours}`, `Fuso: ${school.timezone}`,
      ].join('\n');
    }
    case 'get_courses': {
      if (!entry.result.ok) break;
      const { courses } = entry.result.data;
      return courses.length === 0 ? 'Não há cursos disponíveis no catálogo consultado.'
        : ['Catálogo oficial', ...courses.map(courseDetails)].join('\n\n');
    }
    case 'get_course_details': {
      if (!entry.result.ok) break;
      const { course } = entry.result.data;
      return [courseDetails(course), course.description, priceDetails(course.price)].join('\n');
    }
    case 'get_available_slots': {
      if (!entry.result.ok) break;
      const { courseId, slots } = entry.result.data;
      return [
        `Horários oficiais · agenda demonstrativa\nCurso: ${courseId}`,
        ...slots.map((slot) => `Horário: ${slot.slotId}\nCurso: ${slot.courseId}\n${slotDetails(slot)}`),
        slots.length === 0 ? 'Não há horários disponíveis no momento.'
          : 'Informe explicitamente a data e a hora desejadas (DD/MM/YYYY às HH:mm). Consultar não reserva a vaga.',
      ].join('\n\n');
    }
    case 'create_lead': {
      if (!entry.result.ok) break;
      const { outcome, lead } = entry.result.data;
      const title = { created: 'Cadastro realizado.', existing: 'Dados já cadastrados.', updated: 'Cadastro atualizado.' }[outcome];
      return `${title}\n${leadDetails(lead)}\nIdentificador do cadastro: ${lead.id}`;
    }
    case 'schedule_trial_class': {
      if (!entry.result.ok) break;
      const { outcome, booking } = entry.result.data;
      return [
        outcome === 'created' ? 'Aula experimental confirmada.' : 'Esta aula experimental já estava confirmada.',
        `Identificador da reserva: ${booking.id}`, `Aluno (cadastro): ${booking.leadId}`,
        `Curso: ${booking.courseId}`, `Horário: ${booking.slotId}`, slotDetails(booking),
        'Status: Confirmado', 'Agenda interna demonstrativa, sem calendário externo.',
      ].join('\n');
    }
    case 'transfer_to_human': {
      if (!entry.result.ok) break;
      const { request } = entry.result.data;
      return [
        'Solicitação de atendimento humano registrada localmente nesta demonstração.',
        `Protocolo: ${request.id}`, `Motivo: ${request.reason}`, 'Status: Solicitado',
        'Este registro não inicia atendimento humano ao vivo nem envia notificações a uma equipe externa.',
      ].join('\n');
    }
  }
  throw new Error('Resultado escolar inválido para apresentação WhatsApp.');
}

function presentPreview(action: LanguageSchoolPendingAction): { body: string; buttonTitle: string } {
  if (action.kind === 'create_lead') {
    return {
      buttonTitle: 'Confirmar cadastro',
      body: ['Revisar cadastro · aguardando confirmação', leadDetails(action.preview),
        'O cadastro depende de confirmação. Para corrigir os dados, envie uma mensagem.'].join('\n'),
    };
  }
  const { lead, course, slot } = action.preview;
  return {
    buttonTitle: 'Confirmar aula',
    body: [
      'Revisar aula experimental · aguardando confirmação', leadDetails(lead),
      `Identificador do cadastro: ${lead.id}`, courseDetails(course),
      `Horário: ${slot.slotId}`, `Curso do horário: ${slot.courseId}`, slotDetails(slot),
      'Agenda interna demonstrativa. A vaga ainda não foi reservada e pode ficar indisponível. Para corrigir, envie uma mensagem.',
    ].join('\n'),
  };
}

// Função pura: apenas envelope oficial, sem consultas, relógio ou escrita.
export function presentLanguageSchoolWhatsApp(input: unknown): LanguageSchoolWhatsAppPresentation {
  const parsed = languageSchoolChatResponseSchema.safeParse(input);
  if (!parsed.success) throw new Error('Resposta escolar inválida para apresentação WhatsApp.');
  const { results, pendingAction, reply } = parsed.data;
  const blocks = results.map(presentResult);
  let confirmation: LanguageSchoolWhatsAppPresentation['confirmation'] = null;
  if (pendingAction) {
    const preview = presentPreview(pendingAction);
    if (preview.body.length <= WHATSAPP_INTERACTIVE_BODY_LIMIT) {
      confirmation = { actionId: pendingAction.actionId, kind: pendingAction.kind, ...preview };
    } else {
      blocks.push(preview.body, 'A prévia completa excede o limite de confirmação do WhatsApp. '
        + 'Não há botão de confirmação para esta prévia. Envie uma mensagem para corrigir ou reduzir os dados e revisar uma nova prévia.');
    }
  }
  if (results.length === 0 && pendingAction === null) blocks.push(reply);
  return { messages: splitWhatsAppText(blocks.join('\n\n')).map((body) => ({ type: 'text', body })), confirmation };
}
