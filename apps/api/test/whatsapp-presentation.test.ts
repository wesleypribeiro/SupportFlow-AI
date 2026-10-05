import { describe, expect, it, vi } from 'vitest';
import {
  languageSchoolChatResponseSchema, toolErrorCodeSchema,
  type CreateLeadInput, type LanguageSchoolChatResponse, type LanguageSchoolPendingAction,
  type LanguageSchoolToolResult, type LeadPendingAction, type TrialClassPendingAction,
} from '@supportflow/contracts/language-school';
import { splitWhatsAppText, WHATSAPP_TEXT_LIMIT } from '../src/channels/whatsapp/presentation.js';
import { getSchoolInfo, getCourses, getCourseDetails } from '../src/modules/language-school/application/catalog-queries.js';
import { getAvailableSlots } from '../src/modules/language-school/application/get-available-slots.js';
import { confirmLeadRegistration, prepareLeadRegistration } from '../src/modules/language-school/application/create-lead.js';
import { confirmTrialClassReservation } from '../src/modules/language-school/application/confirm-trial-class.js';
import { prepareTrialClassProposal } from '../src/modules/language-school/application/prepare-trial-class.js';
import { transferToHuman } from '../src/modules/language-school/application/transfer-to-human.js';
import { createConversationContext } from '../src/modules/language-school/domain/conversation-context.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { slotFixtures, trialClassFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { presentLanguageSchoolWhatsApp } from '../src/modules/language-school/infrastructure/whatsapp-presentation.js';

const courseId = 'course_english_travel';
const input: CreateLeadInput = { name: 'Ana Demonstração', contact: { type: 'email', value: 'ana@example.com' }, courseId, goal: 'Viagens' };
const divergentReply = 'PROSA_DIVERGENTE: preço R$ 999,00; cadastro e aula concluídos amanhã; atendente conectado em 5 minutos.';
function envelope(results: LanguageSchoolToolResult[] = [], pendingAction: LanguageSchoolPendingAction | null = null): LanguageSchoolChatResponse {
  return languageSchoolChatResponseSchema.parse({ conversationId: 'conversation-demo', reply: divergentReply, results, pendingAction });
}
function text(response: LanguageSchoolChatResponse): string {
  return presentLanguageSchoolWhatsApp(response).messages.map(({ body }) => body).join('');
}
function unnumber(parts: string[]): string {
  return parts.map((body) => body.replace(/^\[\d+\/\d+\]\n/u, '')).join('');
}
function dependencies() {
  return {
    schoolRepository: new InMemorySchoolRepository(schoolFixture, courseFixtures),
    leadRepository: new InMemoryLeadRepository(),
    trialClassRepository: new InMemoryTrialClassRepository(slotFixtures, trialClassFixtures),
    handoffRepository: new InMemoryHandoffRepository(),
    now: () => new Date('2030-06-10T12:00:00Z'),
  };
}
async function registration(deps = dependencies()) {
  const scope = { conversationId: 'conversation-demo', context: { ...createConversationContext(), ...input, slotId: 'slot_english_a' } };
  const proposal = await prepareLeadRegistration(deps, scope, input);
  if (!proposal.ok) throw new Error('Prévia de cadastro esperada.');
  const pending: LeadPendingAction = { actionId: 'action-lead', kind: 'create_lead', preview: proposal.preview };
  const created = await confirmLeadRegistration(deps, scope, input);
  if (!created.ok) throw new Error('Cadastro esperado.');
  scope.context.leadId = created.data.lead.id;
  return { deps, scope, pending, created };
}
async function reservation() {
  const setup = await registration();
  const args = { leadId: setup.created.data.lead.id, slotId: 'slot_english_a' };
  const proposal = await prepareTrialClassProposal(setup.deps, setup.scope, args);
  if (!proposal.ok || proposal.decision !== 'prepare') throw new Error('Prévia de aula esperada.');
  const pending: TrialClassPendingAction = { actionId: 'action-trial', kind: 'schedule_trial_class', preview: proposal.preview };
  return { ...setup, args, pending };
}

describe('apresentação escolar oficial no WhatsApp', () => {
  it('apresenta escola e catálogo oficiais sem curso inativo, fatos ou oferta de handoff da prosa', async () => {
    const { schoolRepository } = dependencies();
    const response = envelope([
      { tool: 'get_school_info', result: await getSchoolInfo(schoolRepository) },
      { tool: 'get_courses', result: await getCourses(schoolRepository) },
    ]);
    response.reply += ' Posso registrar uma solicitação local de atendimento humano nesta demonstração?';
    const rendered = text(response);
    for (const value of Object.values(schoolFixture)) expect(rendered).toContain(value);
    for (const course of courseFixtures.filter((entry) => entry.active)) {
      for (const value of [course.id, course.name, course.language]) expect(rendered).toContain(value);
    }
    expect(rendered).toContain('Modalidade: Online');
    expect(rendered).toContain('Modalidade: Presencial');
    expect(rendered).not.toContain('course_german_foundations');
    expect(rendered).not.toContain('PROSA_DIVERGENTE');
    expect(rendered).not.toContain('Posso registrar');
    expect(presentLanguageSchoolWhatsApp(response).confirmation).toBeNull();
  });

  it.each([
    ['course_english_travel', 'Preço: R$ 350,00 por mês'],
    ['course_spanish_conversation', 'Preço indisponível (não informado).'],
    ['course_french_intro', 'Preço: R$ 0,00 por curso'],
  ])('preserva detalhes, moeda e periodicidade de %s', async (id, expected) => {
    const result = await getCourseDetails(dependencies().schoolRepository, id);
    if (!result.ok) throw new Error('Curso esperado.');
    const rendered = text(envelope([{ tool: 'get_course_details', result }]));
    expect(rendered).toContain(expected);
    expect(rendered).toContain(result.data.course.name);
    expect(rendered).toContain(result.data.course.description);
    expect(rendered).not.toContain('999');
    if (result.data.course.price === null) expect(rendered).not.toMatch(/R\$|gratuit|desconto/i);
    else expect(rendered).not.toContain('indisponível');
  });

  it('apresenta somente os horários oficiais retornados e pede data/hora explícitas', async () => {
    const result = await getAvailableSlots(dependencies(), courseId);
    const rendered = text(envelope([{ tool: 'get_available_slots', result }]));
    expect(rendered).toContain('11/06/2030 às 10:00');
    expect(rendered).toContain('12/06/2030 às 14:00');
    expect(rendered).toContain('Fuso: America/Sao_Paulo');
    expect(rendered).toContain('Informe explicitamente a data e a hora');
    expect(rendered).toContain('Consultar não reserva a vaga');
    expect(rendered).not.toMatch(/slot_english_past|slot_english_occupied|slot_french_a|amanhã|PROSA_DIVERGENTE/);
  });

  it.each([
    ['America/Sao_Paulo', '2030-06-12T01:30:00Z', '11/06/2030 às 22:30'],
    ['Asia/Tokyo', '2030-06-11T23:30:00-03:00', '12/06/2030 às 11:30'],
    ['UTC', '2030-06-11T00:00:00Z', '11/06/2030 às 00:00'],
  ])('usa o fuso oficial %s, não o offset textual nem o fuso do processo', (timezone, startsAt, expected) => {
    const rendered = text(envelope([{ tool: 'get_available_slots', result: {
      ok: true, data: { courseId, slots: [{ courseId, slotId: 'opaque-slot', startsAt, timezone }] },
    } }]));
    expect(rendered).toContain(expected);
    expect(rendered).toContain(`Fuso: ${timezone}`);
  });

  it('informa catálogo e horários vazios sem inventar alternativas', async () => {
    const deps = dependencies();
    const courses = await getCourses(new InMemorySchoolRepository(schoolFixture, []));
    const slots = await getAvailableSlots(deps, 'course_spanish_conversation');
    const rendered = text(envelope([{ tool: 'get_courses', result: courses }, { tool: 'get_available_slots', result: slots }]));
    expect(rendered).toContain('Não há cursos disponíveis');
    expect(rendered).toContain('Não há horários disponíveis');
    expect(rendered).not.toMatch(/Inglês|\d{2}\/\d{2}\/\d{4}|PROSA_DIVERGENTE/);
  });

  it('distingue created, existing e updated do cadastro e conserva o recibo histórico', async () => {
    const { deps, scope, created } = await registration();
    const existing = await confirmLeadRegistration(deps, scope, input);
    const corrected: CreateLeadInput = { ...input, contact: { type: 'phone', value: '+55 (11) 99999-0000' }, goal: null };
    scope.context = { ...scope.context, ...corrected, revision: 1 };
    const updated = await confirmLeadRegistration(deps, scope, corrected);
    const createdText = text(envelope([{ tool: 'create_lead', result: created }]));
    expect(createdText).toContain('Cadastro realizado.');
    expect(createdText).toContain(created.data.lead.id);
    expect(createdText).toContain('Contato (e-mail): ana@example.com');
    expect(createdText).toContain('Objetivo: Viagens');
    expect(createdText).not.toContain('99999-0000');
    expect(text(envelope([{ tool: 'create_lead', result: existing }]))).toContain('Dados já cadastrados.');
    const updatedText = text(envelope([{ tool: 'create_lead', result: updated }]));
    expect(updatedText).toContain('Cadastro atualizado.');
    expect(updatedText).toContain('Contato (telefone): +55 (11) 99999-0000');
    expect(updatedText).toContain('Objetivo: Não informado');
    expect(updatedText).toContain(created.data.lead.id);
    expect(updatedText).not.toContain('PROSA_DIVERGENTE');
  });

  it('apresenta created/existing da aula com IDs, data, fuso e sucesso mesmo se reply afirma falha', async () => {
    const { deps, scope, args } = await reservation();
    const created = await confirmTrialClassReservation(deps, scope, args);
    const existing = await confirmTrialClassReservation(deps, scope, args);
    if (!created.ok) throw new Error('Reserva esperada.');
    const response = envelope([{ tool: 'schedule_trial_class', result: created }]);
    response.reply = 'FALHA_INVENTADA: não foi possível reservar. Tente gravar novamente.';
    const rendered = text(response);
    expect(rendered).toContain('Aula experimental confirmada.');
    for (const value of [created.data.booking.id, args.leadId, args.slotId, courseId, '11/06/2030 às 10:00', 'America/Sao_Paulo']) {
      expect(rendered).toContain(value);
    }
    expect(rendered).toContain('Status: Confirmado');
    expect(rendered).toContain('Agenda interna demonstrativa, sem calendário externo.');
    expect(rendered).not.toContain('FALHA_INVENTADA');
    const existingText = text(envelope([{ tool: 'schedule_trial_class', result: existing }]));
    expect(existingText).toContain('Esta aula experimental já estava confirmada.');
    expect(existingText).toContain(created.data.booking.id);
  });

  it('apresenta SLOT_UNAVAILABLE oficial sem recibo de sucesso ou botão', async () => {
    const { deps, scope, args } = await reservation();
    await deps.trialClassRepository.reserveSlot({ leadId: 'another-lead', slotId: args.slotId }, deps.now());
    const result = await confirmTrialClassReservation(deps, scope, args);
    expect(result).toMatchObject({ ok: false, error: { code: 'SLOT_UNAVAILABLE' } });
    const response = envelope([{ tool: 'schedule_trial_class', result }]);
    expect(text(response)).toContain('Este horário não está mais disponível.');
    expect(text(response)).toContain('Consulte os horários novamente.');
    expect(text(response)).not.toMatch(/Aula experimental confirmada|Identificador da reserva|PROSA_DIVERGENTE/);
    expect(presentLanguageSchoolWhatsApp(response).confirmation).toBeNull();
  });

  it('mostra requested local, protocolo e motivo originais, sem botão de handoff ou prazo', async () => {
    const { handoffRepository } = dependencies();
    const scope = { conversationId: 'without-lead', visitorIntent: 'request' as const };
    const first = await transferToHuman(handoffRepository, scope, { reason: 'Dúvida sobre matrícula' });
    const repeated = await transferToHuman(handoffRepository, scope, { reason: 'Motivo substituto' });
    expect(repeated).toEqual(first);
    if (!first.ok) throw new Error('Solicitação esperada.');
    const response = envelope([{ tool: 'transfer_to_human', result: repeated }]);
    const rendered = text(response);
    expect(rendered).toContain(first.data.request.id);
    expect(rendered).toContain('Motivo: Dúvida sobre matrícula');
    expect(rendered).toContain('Status: Solicitado');
    expect(rendered).toContain('não inicia atendimento humano ao vivo nem envia notificações a uma equipe externa');
    expect(rendered).not.toMatch(/Motivo substituto|5 minutos|conectado|PROSA_DIVERGENTE/);
    expect(presentLanguageSchoolWhatsApp(response).confirmation).toBeNull();
  });

  it.each(Object.keys({ get_school_info: 1, get_courses: 1, get_course_details: 1, get_available_slots: 1, create_lead: 1, schedule_trial_class: 1, transfer_to_human: 1 }) as LanguageSchoolToolResult['tool'][])(
    'apresenta todos os códigos de falha de %s sem construir sucesso', (tool) => {
      for (const code of toolErrorCodeSchema.options) {
        const response = envelope([{ tool, result: { ok: false, error: { code, message: 'Orientação controlada do backend.' } } }]);
        const rendered = text(response);
        expect(rendered).toContain('Orientação controlada do backend.');
        if (code === 'CONFIRMATION_REQUIRED') expect(rendered).toContain('Aguardando confirmação');
        if (code === 'SLOT_UNAVAILABLE') expect(rendered).toContain('Consulte os horários novamente');
        expect(rendered).not.toMatch(/Cadastro realizado|Aula experimental confirmada|Protocolo:|PROSA_DIVERGENTE/);
        expect(presentLanguageSchoolWhatsApp(response).confirmation).toBeNull();
      }
    },
  );

  it('usa reply somente no diálogo sem results nem prévia, sem gerar confirmação', () => {
    const response = envelope();
    response.reply = 'Olá! 👋 Como posso ajudar? <b>Texto literal</b>';
    expect(presentLanguageSchoolWhatsApp(response)).toEqual({ messages: [{ type: 'text', body: response.reply }], confirmation: null });
  });
});

describe('duas prévias oficiais e limites interativos', () => {
  it('cadastro inclui todos os argumentos e título próprio sem depender de results ou reply', async () => {
    const { pending } = await registration();
    const response = envelope([], pending);
    const rendered = presentLanguageSchoolWhatsApp(response);
    expect(rendered.messages).toEqual([]);
    expect(rendered.confirmation).toMatchObject({ actionId: pending.actionId, kind: 'create_lead', buttonTitle: 'Confirmar cadastro' });
    const body = rendered.confirmation!.body;
    for (const value of [input.name, input.contact.value, input.courseId, input.goal!]) expect(body).toContain(value);
    expect(body).toContain('aguardando confirmação');
    expect(body).not.toContain('PROSA_DIVERGENTE');
    expect(body).not.toContain(pending.actionId);
  });

  it('aula inclui aluno, contato, objetivo, curso, slot, data/fuso e agenda demonstrativa', async () => {
    const { pending } = await reservation();
    const response = envelope([{ tool: 'schedule_trial_class', result: {
      ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Revise a prévia oficial.' },
    } }], pending);
    const rendered = presentLanguageSchoolWhatsApp(response);
    expect(rendered.confirmation).toMatchObject({ actionId: pending.actionId, kind: 'schedule_trial_class', buttonTitle: 'Confirmar aula' });
    const body = rendered.confirmation!.body;
    for (const value of [input.name, input.contact.value, input.goal!, pending.preview.lead.id, courseId,
      pending.preview.course.name, pending.preview.slot.slotId, '11/06/2030 às 10:00', 'America/Sao_Paulo']) expect(body).toContain(value);
    expect(body).toContain('Agenda interna demonstrativa');
    expect(body).toContain('A vaga ainda não foi reservada');
    expect(body.length).toBeLessThanOrEqual(1024);
    expect(rendered.confirmation!.buttonTitle.length).toBeLessThanOrEqual(20);
    expect(text(response)).toContain('Aguardando confirmação');
    expect(JSON.stringify(rendered)).not.toMatch(/PROSA_DIVERGENTE|reply_buttons|"buttons"/);
  });

  it('handoff apresenta seu protocolo sem substituir ou confirmar a prévia escolar vigente', async () => {
    const { deps, scope, pending } = await reservation();
    const result = await transferToHuman(deps.handoffRepository, { conversationId: scope.conversationId, visitorIntent: 'request' }, { reason: 'Dúvida demonstrativa' });
    const output = presentLanguageSchoolWhatsApp(envelope([{ tool: 'transfer_to_human', result }], pending));
    expect(output.messages.map(({ body }) => body).join('')).toContain('Status: Solicitado');
    expect(output.confirmation).toEqual(presentLanguageSchoolWhatsApp(envelope([], pending)).confirmation);
    expect(pending.kind).toBe('schedule_trial_class');
    expect(await deps.trialClassRepository.findConfirmedBySlotId(pending.preview.slot.slotId)).toBeNull();
  });

  it.each(['create_lead', 'schedule_trial_class'] as const)('limite exato e excedido: %s nunca habilita revisão incompleta', async (kind) => {
    const action = kind === 'create_lead' ? (await registration()).pending : (await reservation()).pending;
    const holder = action.kind === 'create_lead' ? action.preview : action.preview.lead;
    holder.goal = 'x';
    const initial = presentLanguageSchoolWhatsApp(envelope([], action)).confirmation!;
    holder.goal = 'x'.repeat(1 + 1024 - initial.body.length);
    const exact = presentLanguageSchoolWhatsApp(envelope([], action));
    expect(exact.confirmation!.body.length).toBe(1024);
    expect(exact.confirmation!.buttonTitle.length).toBeLessThanOrEqual(20);
    holder.goal += 'x';
    const oversized = presentLanguageSchoolWhatsApp(envelope([], action));
    expect(oversized.confirmation).toBeNull();
    expect(oversized.messages.every((message) => message.type === 'text')).toBe(true);
    expect(unnumber(oversized.messages.map(({ body }) => body))).toContain(holder.goal);
    expect(unnumber(oversized.messages.map(({ body }) => body))).toContain('corrigir ou reduzir os dados');
  });

  it('prévia muito grande preserva todos os dados em partes Unicode sem botão incompleto', async () => {
    const { pending } = await reservation();
    pending.preview.lead.goal = 'Praticar com a família 👨‍👩‍👧‍👦 e pronúncia a\u0301. '.repeat(300);
    const output = presentLanguageSchoolWhatsApp(envelope([], pending));
    expect(output.confirmation).toBeNull();
    expect(output.messages.length).toBeGreaterThan(2);
    const restored = unnumber(output.messages.map(({ body }) => body));
    expect(restored).toContain(pending.preview.lead.goal);
    expect(restored).toContain('11/06/2030 às 10:00');
    expect(restored).toContain('Não há botão de confirmação');
    for (const part of output.messages) expect(part.body.length).toBeLessThanOrEqual(4096);
  });
});

describe('divisão textual Unicode sem perda de fatos', () => {
  it.each([4095, 4096, 4097, 40890, 50000])('preserva texto de %i unidades e inclui numeração dentro do limite', (size) => {
    const original = 'a'.repeat(size);
    const parts = splitWhatsAppText(original);
    expect(unnumber(parts)).toBe(original);
    if (size <= WHATSAPP_TEXT_LIMIT) expect(parts).toEqual([original]);
    else parts.forEach((part, index) => expect(part).toMatch(new RegExp(`^\\[${index + 1}/${parts.length}\\]\\n`)));
    parts.forEach((part) => expect(part.length).toBeLessThanOrEqual(4096));
  });

  it.each(['😀', '👨‍👩‍👧‍👦', 'a\u0301', '🇧🇷', ' \u0301'])('não corta grafemas %s em sequências contínuas', (grapheme) => {
    const original = grapheme.repeat(5000);
    const parts = splitWhatsAppText(original);
    expect(unnumber(parts)).toBe(original);
    for (const part of parts) {
      const content = part.replace(/^\[\d+\/\d+\]\n/u, '');
      expect(content.replaceAll(grapheme, '')).toBe('');
      expect(part.length).toBeLessThanOrEqual(4096);
    }
  });

  it('prefere linhas completas para preservar preço, data, contato e identificador', () => {
    const facts = ['Preço: R$ 350,00 por mês', 'Data: 11/06/2030 às 10:00 · America/Sao_Paulo', 'Contato: ana@example.com', 'Protocolo: opaque-id-123'];
    const original = ('Descrição\n'.repeat(408)) + facts.join('\n');
    const parts = splitWhatsAppText(original);
    expect(unnumber(parts)).toBe(original);
    for (const fact of facts) expect(parts.some((part) => part.includes(fact))).toBe(true);
  });

  it('não perde conteúdo mesmo com um único grafema maior que o limite', () => {
    const original = 'a' + '\u0301'.repeat(10000);
    const parts = splitWhatsAppText(original);
    expect(unnumber(parts)).toBe(original);
    parts.forEach((part) => expect(part.length).toBeLessThanOrEqual(4096));
  });

  it('catálogo longo mantém todos os resultados, ordem, preços e descrições', async () => {
    const base = await getCourseDetails(dependencies().schoolRepository, courseId);
    if (!base.ok) throw new Error('Curso esperado.');
    const results: LanguageSchoolToolResult[] = Array.from({ length: 50 }, (_, i) => ({ tool: 'get_course_details', result: {
      ok: true, data: { course: { ...base.data.course, id: `course-${i}`, name: `Curso ${i} 👩🏽‍🎓`, description: `Descrição ${i} ` + 'Idiomas e pronúncia a\u0301. '.repeat(10) } },
    } }));
    const response = envelope(results);
    const output = presentLanguageSchoolWhatsApp(response);
    const rendered = unnumber(output.messages.map(({ body }) => body));
    const separately = results.map((result) => text(envelope([result]))).join('\n\n');
    expect(rendered).toBe(separately);
    expect(rendered.match(/R\$ 350,00 por mês/gu)).toHaveLength(50);
    output.messages.forEach(({ body }) => expect(body.length).toBeLessThanOrEqual(4096));
  });
});

describe('fronteiras e pureza da apresentação', () => {
  it.each([
    { ...envelope(), extra: true },
    { ...envelope(), results: [{ tool: 'get_courses', result: { ok: true, data: { courses: [{ ...courseFixtures[0], active: false }] } } }] },
    { ...envelope(), pendingAction: { actionId: 'x', kind: 'create_lead', preview: { ...input, confirmed: true } } },
    { ...envelope(), results: [{ tool: 'get_course_details', result: { ok: true, data: { course: { ...courseFixtures[0], price: { amountCents: '35000', currency: 'BRL', billingPeriod: 'month' } } } } }] },
  ])('rejeita envelope inválido sem publicar dados ou erro Zod bruto', (response) => {
    expect(() => presentLanguageSchoolWhatsApp(response)).toThrowError('Resposta escolar inválida para apresentação WhatsApp.');
  });

  it('não consulta nem grava repositories e não modifica envelope, histórico ou prévia', async () => {
    const { deps, scope, pending, args } = await reservation();
    const result = await confirmTrialClassReservation(deps, scope, args);
    const response = envelope([{ tool: 'schedule_trial_class', result }], pending);
    const before = structuredClone(response);
    const spies = [
      vi.spyOn(deps.schoolRepository, 'getSchool'), vi.spyOn(deps.schoolRepository, 'listActiveCourses'), vi.spyOn(deps.schoolRepository, 'findActiveCourseById'),
      vi.spyOn(deps.leadRepository, 'findByConversationId'), vi.spyOn(deps.leadRepository, 'createForConversation'), vi.spyOn(deps.leadRepository, 'updateForConversation'),
      vi.spyOn(deps.trialClassRepository, 'listSlotsByCourseId'), vi.spyOn(deps.trialClassRepository, 'findSlotById'),
      vi.spyOn(deps.trialClassRepository, 'findConfirmedBySlotId'), vi.spyOn(deps.trialClassRepository, 'reserveSlot'),
      vi.spyOn(deps.handoffRepository, 'findOpenByConversationId'), vi.spyOn(deps.handoffRepository, 'requestForConversation'),
    ];
    const first = presentLanguageSchoolWhatsApp(response);
    expect(presentLanguageSchoolWhatsApp(response)).toEqual(first);
    first.messages.pop();
    first.confirmation!.body = 'alterado pelo consumidor';
    expect(response).toEqual(before);
    expect(presentLanguageSchoolWhatsApp(response).confirmation!.body).not.toBe('alterado pelo consumidor');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
