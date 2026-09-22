import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Price } from './entities.js';
import {
  createLeadInputSchema,
  createLeadResultSchema,
  getAvailableSlotsInputSchema,
  getAvailableSlotsResultSchema,
  getCourseDetailsInputSchema,
  getCourseDetailsResultSchema,
  getCoursesInputSchema,
  getCoursesResultSchema,
  getSchoolInfoInputSchema,
  getSchoolInfoResultSchema,
  languageSchoolToolResultSchema,
  scheduleTrialClassInputSchema,
  scheduleTrialClassResultSchema,
  toolErrorCodeSchema,
  transferToHumanInputSchema,
  transferToHumanResultSchema,
} from './tools.js';

const school = {
  id: 'escola-demo',
  name: 'Escola Exemplo',
  description: 'Escola fictícia de idiomas.',
  address: 'Rua Exemplo, 100',
  contact: 'contato@example.com',
  openingHours: 'Segunda a sexta, das 09h às 18h',
  timezone: 'America/Sao_Paulo',
};
const courseSummary = {
  id: 'ingles-demo',
  name: 'Inglês',
  language: 'en',
  modality: 'online',
  active: true,
};
const course = { ...courseSummary, description: 'Inglês para viagens.', price: null };
const leadInput = {
  name: 'Ana Exemplo',
  contact: { type: 'email', value: 'ana@example.com' },
  courseId: course.id,
  goal: null,
};
const lead = { id: 'lead-demo', ...leadInput };
const slot = {
  slotId: 'slot-demo',
  courseId: course.id,
  startsAt: '2030-10-21T14:30:00-03:00',
  timezone: 'America/Sao_Paulo',
};
const booking = { id: 'reserva-demo', leadId: lead.id, ...slot, status: 'confirmed' };
const request = { id: 'solicitacao-demo', reason: 'Quero falar com uma pessoa.', status: 'requested' };
const failure = { ok: false, error: { code: 'OPERATION_FAILED', message: 'Operação indisponível.' } };

const tools = [
  {
    tool: 'get_school_info', inputSchema: getSchoolInfoInputSchema,
    resultSchema: getSchoolInfoResultSchema, input: {}, data: { school },
  },
  {
    tool: 'get_courses', inputSchema: getCoursesInputSchema,
    resultSchema: getCoursesResultSchema, input: {}, data: { courses: [courseSummary] },
  },
  {
    tool: 'get_course_details', inputSchema: getCourseDetailsInputSchema,
    resultSchema: getCourseDetailsResultSchema, input: { courseId: course.id }, data: { course },
  },
  {
    tool: 'get_available_slots', inputSchema: getAvailableSlotsInputSchema,
    resultSchema: getAvailableSlotsResultSchema, input: { courseId: course.id },
    data: { courseId: course.id, slots: [slot] },
  },
  {
    tool: 'create_lead', inputSchema: createLeadInputSchema,
    resultSchema: createLeadResultSchema, input: leadInput, data: { outcome: 'created', lead },
  },
  {
    tool: 'schedule_trial_class', inputSchema: scheduleTrialClassInputSchema,
    resultSchema: scheduleTrialClassResultSchema, input: { leadId: lead.id, slotId: slot.slotId },
    data: { outcome: 'created', booking },
  },
  {
    tool: 'transfer_to_human', inputSchema: transferToHumanInputSchema,
    resultSchema: transferToHumanResultSchema, input: { reason: request.reason }, data: { request },
  },
];

describe('contratos das sete ferramentas', () => {
  it.each(tools)('valida entrada, sucesso e envelope de $tool', ({ tool, inputSchema, resultSchema, input, data }) => {
    expect(inputSchema.parse(input)).toEqual(input);
    const result = { ok: true, data };
    expect(resultSchema.parse(result)).toEqual(result);
    expect(languageSchoolToolResultSchema.parse({ tool, result })).toEqual({ tool, result });
  });

  it.each(tools)('aceita erro estruturado para $tool', ({ tool, resultSchema }) => {
    expect(resultSchema.parse(failure)).toEqual(failure);
    expect(languageSchoolToolResultSchema.parse({ tool, result: failure }))
      .toEqual({ tool, result: failure });
  });

  it.each(tools)('rejeita autoridade interna e campos gerados em argumentos de $tool', ({ inputSchema, input }) => {
    for (const field of ['schoolId', 'conversationId', 'internalContext', 'id', 'confirmed']) {
      expect(inputSchema.safeParse({ ...input, [field]: true }).success).toBe(false);
    }
  });

  it.each(tools)('mantém resultado, data e envelope estritos para $tool', ({ tool, resultSchema, data }) => {
    const result = { ok: true, data };
    expect(resultSchema.safeParse({ ...result, metadata: {} }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, data: { ...data, metadata: {} } }).success)
      .toBe(false);
    expect(languageSchoolToolResultSchema.safeParse({ tool, result, context: {} }).success)
      .toBe(false);
  });

  it('exige os argumentos obrigatórios das operações parametrizadas', () => {
    for (const schema of [
      getCourseDetailsInputSchema, getAvailableSlotsInputSchema, createLeadInputSchema,
      scheduleTrialClassInputSchema, transferToHumanInputSchema,
    ]) {
      expect(schema.safeParse({}).success).toBe(false);
    }
    expect(createLeadInputSchema.safeParse({ ...leadInput, goal: undefined }).success).toBe(false);
    expect(scheduleTrialClassInputSchema.safeParse({ leadId: lead.id }).success).toBe(false);
  });

  it('não converte números, booleanos ou textos para suprir tipos incorretos', () => {
    expect(getCourseDetailsInputSchema.safeParse({ courseId: 123 }).success).toBe(false);
    expect(getAvailableSlotsInputSchema.safeParse({ courseId: false }).success).toBe(false);
    expect(createLeadInputSchema.safeParse({ ...leadInput, name: 123 }).success).toBe(false);
    expect(transferToHumanInputSchema.safeParse({ reason: true }).success).toBe(false);
    expect(getCoursesInputSchema.safeParse('')).toMatchObject({ success: false });
    expect(getSchoolInfoInputSchema.safeParse(null)).toMatchObject({ success: false });
  });

  it('rejeita extras nos contatos de entrada e nas entidades retornadas', () => {
    expect(createLeadInputSchema.safeParse({
      ...leadInput, contact: { ...leadInput.contact, verified: true },
    }).success).toBe(false);
    expect(createLeadResultSchema.safeParse({
      ok: true, data: { outcome: 'created', lead: { ...lead, conversationId: 'interna' } },
    }).success).toBe(false);
    expect(getAvailableSlotsResultSchema.safeParse({
      ok: true, data: { courseId: course.id, slots: [{ ...slot, occupied: false }] },
    }).success).toBe(false);
  });

  it('não oferece cursos inativos em resultados comerciais', () => {
    expect(getCoursesResultSchema.safeParse({
      ok: true, data: { courses: [{ ...courseSummary, active: false }] },
    }).success).toBe(false);
    expect(getCourseDetailsResultSchema.safeParse({
      ok: true, data: { course: { ...course, active: false } },
    }).success).toBe(false);
  });

  it('aceita catálogo e disponibilidade vazios como sucessos', () => {
    expect(getCoursesResultSchema.parse({ ok: true, data: { courses: [] } }).ok).toBe(true);
    expect(getAvailableSlotsResultSchema.parse({
      ok: true, data: { courseId: course.id, slots: [] },
    }).ok).toBe(true);
  });

  it('restringe os resultados de escrita aos desfechos previstos', () => {
    for (const outcome of ['created', 'updated', 'existing']) {
      expect(createLeadResultSchema.safeParse({ ok: true, data: { outcome, lead } }).success)
        .toBe(true);
    }
    expect(scheduleTrialClassResultSchema.safeParse({
      ok: true, data: { outcome: 'existing', booking },
    }).success).toBe(true);
    expect(scheduleTrialClassResultSchema.safeParse({
      ok: true, data: { outcome: 'updated', booking },
    }).success).toBe(false);
    expect(createLeadResultSchema.safeParse({ ok: true, data: { lead } }).success).toBe(false);
  });

  it('valida o conjunto fechado de erros sem aceitar metadados internos', () => {
    for (const code of toolErrorCodeSchema.options) {
      expect(getSchoolInfoResultSchema.safeParse({
        ok: false, error: { code, message: 'Mensagem pública.' },
      }).success).toBe(true);
    }
    expect(getSchoolInfoResultSchema.safeParse({
      ok: false, error: { code: 'UNKNOWN_ERROR', message: 'Falha.' },
    }).success).toBe(false);
    expect(getSchoolInfoResultSchema.safeParse({
      ok: false, error: { ...failure.error, stack: 'detalhe interno' },
    }).success).toBe(false);
    expect(getSchoolInfoResultSchema.safeParse({ ok: false, error: { code: 'NOT_FOUND' } }).success)
      .toBe(false);
  });

  it('distingue sucesso e erro sem coerção do discriminador', () => {
    for (const result of [
      { ok: 'true', data: { school } },
      { ok: true, error: failure.error },
      { ok: false, data: { school } },
      { ok: true, data: { school }, error: failure.error },
      { data: { school } },
    ]) {
      expect(getSchoolInfoResultSchema.safeParse(result).success).toBe(false);
    }
  });

  it('vincula cada payload à sua ferramenta e rejeita nomes desconhecidos', () => {
    expect(languageSchoolToolResultSchema.safeParse({
      tool: 'get_courses', result: { ok: true, data: { school } },
    }).success).toBe(false);
    expect(languageSchoolToolResultSchema.safeParse({
      tool: 'unknown_tool', result: failure,
    }).success).toBe(false);
    expect(languageSchoolToolResultSchema.safeParse({ tool: 'get_courses' }).success).toBe(false);
  });

  it('preserva tipos inferidos ao discriminar ferramenta e sucesso', () => {
    const result = languageSchoolToolResultSchema.parse({
      tool: 'get_course_details', result: { ok: true, data: { course } },
    });
    if (result.tool === 'get_course_details' && result.result.ok) {
      expectTypeOf(result.result.data.course.price).toEqualTypeOf<Price | null>();
      expectTypeOf(result.result.data.course.active).toEqualTypeOf<true>();
      expect(result.result.data.course.price).toBeNull();
    } else {
      throw new Error('Esperado um resultado de detalhes do curso.');
    }
  });
});
