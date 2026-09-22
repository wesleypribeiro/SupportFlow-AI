import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  chatConfirmationRequestSchema,
  chatErrorResponseSchema,
  chatRequestSchema,
} from './index.js';
import {
  languageSchoolChatResponseSchema,
  languageSchoolPendingActionSchema,
} from '../language-school/chat.js';

const leadDraft = {
  name: 'Ana Exemplo',
  contact: { type: 'email', value: 'ana@example.com' },
  courseId: 'course:english',
  goal: 'Entrevistas de emprego',
};
const leadAction = {
  actionId: 'action:lead',
  kind: 'create_lead',
  preview: leadDraft,
};
const trialAction = {
  actionId: 'action:trial',
  kind: 'schedule_trial_class',
  preview: {
    lead: { id: 'lead:ana', ...leadDraft },
    course: {
      id: 'course:english', name: 'Inglês', language: 'en', modality: 'online', active: true,
    },
    slot: {
      slotId: 'slot:morning', courseId: 'course:english',
      startsAt: '2030-10-21T09:00:00-03:00', timezone: 'America/Sao_Paulo',
    },
  },
};
const reply = {
  conversationId: 'conversation:local',
  reply: 'Como posso ajudar?',
  results: [],
  pendingAction: null,
};

describe('mensagem pública do navegador', () => {
  it('aceita primeiro contato e continuidade, aparando somente a mensagem', () => {
    expect(chatRequestSchema.parse({ message: '  Olá!  ' })).toEqual({ message: 'Olá!' });
    expect(chatRequestSchema.parse({ message: 'Quais cursos?', conversationId: 'conv:1/local' }))
      .toEqual({ message: 'Quais cursos?', conversationId: 'conv:1/local' });
  });

  it('exige mensagem textual de 1 a 2.000 caracteres após aparar', () => {
    expect(chatRequestSchema.parse({ message: ` ${'a'.repeat(2000)} ` }).message)
      .toHaveLength(2000);
    for (const message of ['', '  ', 'a'.repeat(2001), 42, null, undefined]) {
      expect(chatRequestSchema.safeParse({ message }).success).toBe(false);
    }
    expect(chatRequestSchema.safeParse({ message: 'Olá', conversationId: 1 }).success)
      .toBe(false);
  });

  it.each([
    'schoolId', 'history', 'messages', 'results', 'toolResults', 'context',
    'system', 'revision', 'pendingAction', 'confirmed',
  ])('rejeita %s como fonte de dados ou autorização do navegador', (field) => {
    expect(chatRequestSchema.safeParse({ message: 'Olá!', [field]: 'não confiável' }).success)
      .toBe(false);
  });
});

describe('confirmação pública de uma ação', () => {
  const confirmation = { conversationId: 'conv:local', actionId: 'action:trial' };

  it('aceita somente os dois IDs opacos, sem produzir autorização ou argumentos', () => {
    expect(chatConfirmationRequestSchema.parse(confirmation)).toEqual(confirmation);
  });

  it.each([
    'confirmed', 'schoolId', 'kind', 'arguments', 'preview', 'leadId', 'slotId',
    'name', 'contact', 'courseId', 'goal', 'context', 'revision',
  ])('rejeita o campo adicional %s', (field) => {
    expect(chatConfirmationRequestSchema.safeParse({
      ...confirmation, [field]: field === 'confirmed' ? true : leadDraft,
    }).success).toBe(false);
  });

  it('rejeita IDs ausentes, vazios ou de tipo incorreto', () => {
    for (const input of [
      {}, { conversationId: 'conv:local' }, { actionId: 'action:trial' },
      { ...confirmation, actionId: '' }, { ...confirmation, conversationId: 1 },
    ]) {
      expect(chatConfirmationRequestSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('prévias públicas de ações pendentes', () => {
  it.each([leadAction, trialAction])('aceita prévia de $kind', (action) => {
    expect(languageSchoolPendingActionSchema.parse(action)).toEqual(action);
    expect(languageSchoolChatResponseSchema.parse({ ...reply, pendingAction: action }).pendingAction)
      .toEqual(action);
  });

  it('vincula cada tipo de ação à sua prévia específica', () => {
    expect(languageSchoolPendingActionSchema.safeParse({
      ...leadAction, preview: trialAction.preview,
    }).success).toBe(false);
    expect(languageSchoolPendingActionSchema.safeParse({
      ...trialAction, preview: leadDraft,
    }).success).toBe(false);
    expect(languageSchoolPendingActionSchema.safeParse({
      ...leadAction, kind: 'transfer_to_human',
    }).success).toBe(false);
  });

  it('exige uma ação identificada e todos os dados da prévia', () => {
    expect(languageSchoolPendingActionSchema.safeParse({ ...leadAction, actionId: undefined }).success)
      .toBe(false);
    expect(languageSchoolPendingActionSchema.safeParse({ ...trialAction, preview: {} }).success)
      .toBe(false);
  });

  it('rejeita argumentos de execução, revisão e contexto internos na prévia pública', () => {
    for (const field of ['arguments', 'revision', 'conversationId', 'schoolId', 'confirmed']) {
      expect(languageSchoolPendingActionSchema.safeParse({ ...trialAction, [field]: 1 }).success)
        .toBe(false);
    }
    expect(languageSchoolPendingActionSchema.safeParse({
      ...trialAction, preview: { ...trialAction.preview, confirmed: true },
    }).success).toBe(false);
    expect(languageSchoolPendingActionSchema.safeParse({
      ...trialAction,
      preview: { ...trialAction.preview, slot: { ...trialAction.preview.slot, occupiedBy: 'lead:other' } },
    }).success).toBe(false);
    expect(languageSchoolPendingActionSchema.safeParse({
      ...leadAction, preview: { ...leadDraft, id: 'inventado' },
    }).success).toBe(false);
  });
});

describe('respostas públicas do chat', () => {
  it('aceita diálogo sem ferramentas e sem ação pendente', () => {
    expect(languageSchoolChatResponseSchema.parse(reply)).toEqual(reply);
  });

  it('aceita dados de ferramenta e conserva a união discriminada nos tipos inferidos', () => {
    const response = languageSchoolChatResponseSchema.parse({
      ...reply,
      results: [{
        tool: 'get_course_details',
        result: { ok: true, data: { course: {
          ...trialAction.preview.course, description: 'Curso demonstrativo.', price: null,
        } } },
      }],
    });
    const first = response.results[0];
    expect(first?.tool).toBe('get_course_details');
    if (first?.tool === 'get_course_details' && first.result.ok) {
      expect(first.result.data.course.price).toBeNull();
      expectTypeOf(first.result.data.course.active).toEqualTypeOf<true>();
      expectTypeOf(first.result.data.course.price).toEqualTypeOf<{
        amountCents: number; currency: 'BRL'; billingPeriod: 'month' | 'course';
      } | null>();
    }
  });

  it('aceita CONFIRMATION_REQUIRED junto da prévia sem emitir recibo de sucesso', () => {
    const response = { ...reply, pendingAction: leadAction, results: [{
      tool: 'create_lead',
      result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirme o cadastro.' } },
    }] };
    expect(languageSchoolChatResponseSchema.parse(response)).toEqual(response);
  });

  it('não gera resultados oficiais a partir do texto livre', () => {
    const response = { ...reply, reply: 'Cadastro concluído e aula confirmada.' };
    expect(languageSchoolChatResponseSchema.parse(response)).toEqual(response);
  });

  it('exige todos os campos da resposta e rejeita tipos incorretos', () => {
    for (const field of ['conversationId', 'reply', 'results', 'pendingAction']) {
      expect(languageSchoolChatResponseSchema.safeParse({ ...reply, [field]: undefined }).success)
        .toBe(false);
    }
    for (const invalid of [
      { ...reply, reply: ' ' }, { ...reply, reply: 1 }, { ...reply, results: {} },
      { ...reply, pendingAction: true }, { ...reply, results: [{ tool: 'invented', result: {} }] },
    ]) {
      expect(languageSchoolChatResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each(['history', 'context', 'revision', 'schoolId', 'systemPrompt', 'apiKey'])(
    'rejeita %s na resposta pública', (field) => {
      expect(languageSchoolChatResponseSchema.safeParse({ ...reply, [field]: 'interno' }).success)
        .toBe(false);
    },
  );

  it('rejeita um resultado de ferramenta incompatível com seu nome', () => {
    expect(languageSchoolChatResponseSchema.safeParse({ ...reply, results: [{
      tool: 'get_courses', result: { ok: true, data: { slots: [] } },
    }] }).success).toBe(false);
  });
});

describe('erros públicos do chat', () => {
  it.each(['INVALID_REQUEST', 'NOT_FOUND', 'ACTION_STALE', 'SLOT_UNAVAILABLE', 'CHAT_ERROR'])(
    'aceita o código %s com mensagem controlada', (code) => {
      const input = { error: { code, message: 'Não foi possível concluir.' } };
      expect(chatErrorResponseSchema.parse(input)).toEqual(input);
    },
  );

  it('rejeita códigos desconhecidos, mensagens ausentes e detalhes internos', () => {
    for (const input of [
      { error: { code: 'OPERATION_FAILED', message: 'Falha de ferramenta.' } },
      { error: { code: 'CHAT_ERROR' } },
      { error: { code: 'CHAT_ERROR', message: ' ' } },
      { error: { code: 'CHAT_ERROR', message: 500 } },
      { error: { code: 'CHAT_ERROR', message: 'Falha.', stack: 'interno' } },
      { error: { code: 'CHAT_ERROR', message: 'Falha.' }, reply: 'Sucesso' },
    ]) {
      expect(chatErrorResponseSchema.safeParse(input).success).toBe(false);
    }
  });
});
