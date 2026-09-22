import { describe, expect, it, vi } from 'vitest';
import type { ActiveCourseSummary } from '@supportflow/contracts/language-school';
import {
  applyContextPatch,
  contextPatchSchema,
  conversationContextSchema,
  createConversationContext,
  type ContextPatch,
} from '../../src/modules/language-school/domain/conversation-context.js';
import { updateConversationContext } from '../../src/modules/language-school/application/update-conversation-context.js';
import {
  courseFixtures,
  schoolFixture,
} from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';

const courses: ActiveCourseSummary[] = courseFixtures.filter((course) => course.active)
  .map(({ id, name, language, modality }) => ({ id, name, language, modality, active: true }));

const patch = (changes: Partial<ContextPatch> = {}): ContextPatch => ({
  goal: null, name: null, contact: null, courseReference: null, ...changes,
});

describe('ConversationContext e applyContextPatch', () => {
  it('inicia todos os campos desconhecidos em null e a revisão em zero', () => {
    const initial = createConversationContext();

    expect(initial).toEqual({
      goal: null, name: null, contact: null, courseId: null, slotId: null, leadId: null, revision: 0,
    });
    expect(conversationContextSchema.parse(initial)).toEqual(initial);
    expect(createConversationContext()).not.toBe(initial);
  });

  it('registra viagem e depois substitui somente o objetivo por entrevistas de emprego', () => {
    const initial = createConversationContext();
    const travel = applyContextPatch(initial, patch({ goal: 'viagem', courseReference: 'inglês' }),
      'Quero inglês para viagem.', courses);
    const interviews = applyContextPatch(travel, patch({ goal: 'entrevistas de emprego' }),
      'Na verdade, quero principalmente para entrevistas de emprego.', courses);

    expect(travel).toMatchObject({ goal: 'viagem', courseId: 'course_english_travel', revision: 1 });
    expect(interviews).toMatchObject({
      goal: 'entrevistas de emprego', courseId: 'course_english_travel', revision: 2,
    });
    expect(initial).toEqual(createConversationContext());
    expect(travel.goal).toBe('viagem');
    expect(interviews.goal).not.toBe(travel.goal);
  });

  it('preserva nome, contato e curso ao corrigir apenas o objetivo', () => {
    const initial = applyContextPatch(createConversationContext(), patch({
      name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
      goal: 'viagem', courseReference: 'inglês',
    }), 'Sou Ana, ana@example.com. Quero inglês para viagem.', courses);
    const updated = applyContextPatch(initial, patch({ goal: 'entrevistas' }),
      'Agora quero entrevistas.', courses);

    expect(updated).toEqual({ ...initial, goal: 'entrevistas', revision: 2 });
    expect(updated.contact).not.toBe(initial.contact);
  });

  it('incrementa uma vez por patch, mesmo quando vários campos mudam', () => {
    const updated = applyContextPatch(createConversationContext(), patch({
      name: 'Ana', contact: { type: 'phone', value: '+55 (11) 99999-0000' }, goal: 'viagem',
    }), 'Sou Ana. +55 (11) 99999-0000. Quero viagem.', courses);

    expect(updated).toMatchObject({ revision: 1, contact: { value: '+55 (11) 99999-0000' } });
  });

  it('não incrementa para valores idênticos, mesmo com um novo objeto de contato', () => {
    const input = patch({ goal: 'viagem', contact: { type: 'email', value: 'ana@example.com' } });
    const message = 'Quero viagem. Meu contato é ana@example.com.';
    const first = applyContextPatch(createConversationContext(), input, message, courses);
    const repeated = applyContextPatch(first, structuredClone(input), message, courses);

    expect(repeated).toEqual(first);
    expect(repeated.revision).toBe(1);
  });

  it('null mantém valores anteriores e não incrementa revisão', () => {
    const initial = applyContextPatch(createConversationContext(), patch({ name: 'Ana' }),
      'Sou Ana.', courses);

    expect(applyContextPatch(initial, patch(), 'Obrigada!', courses)).toEqual(initial);
  });

  it('preserva literalmente os formatos de contato aprovados e permite a correção', () => {
    const initial = applyContextPatch(createConversationContext(), patch({
      contact: { type: 'phone', value: '(11) 99999-0000' },
    }), 'Meu telefone é (11) 99999-0000.', courses);
    const updated = applyContextPatch(initial, patch({
      contact: { type: 'email', value: 'Ana@example.com' },
    }), 'Prefiro Ana@example.com.', courses);

    expect(initial.contact).toEqual({ type: 'phone', value: '(11) 99999-0000' });
    expect(updated.contact).toEqual({ type: 'email', value: 'Ana@example.com' });
    expect(updated.revision).toBe(2);
  });

  it.each([
    patch({ goal: '' }),
    patch({ name: ' ' }),
    patch({ contact: { type: 'email', value: 'email-inválido' } }),
    patch({ contact: { type: 'phone', value: '123' } }),
    { ...patch(), goal: 12 },
    { ...patch(), contact: { type: 'whatsapp', value: '+5511999990000' } },
    { ...patch(), courseId: 'english_123' },
    { ...patch(), slotId: 'slot_inventado' },
    { ...patch(), leadId: 'lead_inventado' },
    { ...patch(), revision: 80 },
    { ...patch(), price: 0 },
    { ...patch(), availability: true },
    { ...patch(), schoolId: 'outra_escola' },
    { goal: 'viagem' },
  ])('rejeita o patch inválido sem alterar o contexto: %j', (input) => {
    const initial = { ...createConversationContext(), name: 'Ana', revision: 1 };
    const before = structuredClone(initial);

    expect(() => applyContextPatch(initial, input, 'Quero viagem.', courses)).toThrow();
    expect(initial).toEqual(before);
  });

  it('não aplica um objetivo válido se outro campo do mesmo patch é inválido', () => {
    const initial = { ...createConversationContext(), goal: 'viagem', revision: 1 };

    expect(() => applyContextPatch(initial, patch({
      goal: 'entrevistas', contact: { type: 'email', value: 'inválido' },
    }), 'Quero entrevistas. Meu contato é inválido.', courses)).toThrow();
    expect(initial).toMatchObject({ goal: 'viagem', contact: null, revision: 1 });
  });

  it.each([
    patch({ goal: 'viagem' }),
    patch({ name: 'Ana' }),
    patch({ contact: { type: 'email', value: 'ana@example.com' } }),
  ])('rejeita dado que não veio da mensagem atual do visitante: %j', (input) => {
    const initial = createConversationContext();

    expect(() => applyContextPatch(initial, input, 'Olá!', courses)).toThrow();
    expect(initial).toEqual(createConversationContext());
  });

  it('não aceita fragmentos internos de palavras como origem de dados pessoais', () => {
    expect(() => applyContextPatch(createConversationContext(), patch({ name: 'Ana' }),
      'Sou Anais.', courses)).toThrow();
  });

  it.each([
    ['course_english_travel', 'Quero course_english_travel.'],
    ['Inglês para viagens', 'Quero Inglês para viagens.'],
    ['inglês', 'Quero inglês para viagem.'],
    ['INGLÊS', 'Quero INGLÊS.'],
  ])('associa a referência inequívoca %s ao identificador cadastrado', (reference, message) => {
    expect(applyContextPatch(createConversationContext(), patch({ courseReference: reference }),
      message, courses)).toMatchObject({ courseId: 'course_english_travel', revision: 1 });
  });

  it.each([
    ['english_123', 'Quero english_123.'],
    ['course_german_foundations', 'Quero course_german_foundations.'],
    ['alemão', 'Quero alemão.'],
    ['inglês', 'Olá!'],
    ['inglês', 'Quero inglês ou espanhol.'],
    ['Inglês para viagens', 'Quero Inglês para viagens ou Conversação em espanhol.'],
  ])('mantém o curso anterior quando a referência não é segura: %s / %s', (reference, message) => {
    const initial = { ...createConversationContext(), courseId: 'course_french_intro', revision: 1 };

    expect(applyContextPatch(initial, patch({ courseReference: reference }), message, courses))
      .toEqual(initial);
  });

  it('não escolhe entre dois cursos ativos do mesmo idioma', () => {
    const withAnotherEnglish: ActiveCourseSummary[] = [...courses, {
      id: 'course_english_business', name: 'Inglês para negócios',
      language: 'Inglês', modality: 'online', active: true,
    }];
    const initial = createConversationContext();

    expect(applyContextPatch(initial, patch({ courseReference: 'inglês' }),
      'Quero inglês.', withAnotherEnglish)).toEqual(initial);
    expect(applyContextPatch(initial, patch({ courseReference: 'Inglês para viagens' }),
      'Quero Inglês para viagens.', withAnotherEnglish).courseId).toBe('course_english_travel');
  });

  it('não incrementa ao reafirmar o mesmo curso e não cria lead ou horário', () => {
    const initial = { ...createConversationContext(), courseId: 'course_english_travel', revision: 1 };

    expect(applyContextPatch(initial, patch({ courseReference: 'inglês' }), 'Quero inglês.', courses))
      .toEqual(initial);
    expect(initial).toMatchObject({ leadId: null, slotId: null });
  });

  it('preserva a referência de lead e limpa uma seleção futura de horário ao mudar o curso', () => {
    const initial = {
      ...createConversationContext(), courseId: 'course_english_travel', slotId: 'slot_anterior',
      leadId: 'lead_anterior', revision: 3,
    };
    const updated = applyContextPatch(initial, patch({ courseReference: 'espanhol' }),
      'Agora quero espanhol.', courses);

    expect(updated).toMatchObject({
      courseId: 'course_spanish_conversation', slotId: null, leadId: 'lead_anterior', revision: 4,
    });
    expect(initial.slotId).toBe('slot_anterior');
  });

  it('não compartilha dados de contexto entre conversas', () => {
    const first = createConversationContext();
    const second = createConversationContext();
    const updatedFirst = applyContextPatch(first, patch({ goal: 'viagem', courseReference: 'inglês' }),
      'Quero inglês para viagem.', courses);
    const updatedSecond = applyContextPatch(second, patch({ courseReference: 'espanhol' }),
      'Quero espanhol.', courses);

    expect(updatedFirst).toMatchObject({ goal: 'viagem', courseId: 'course_english_travel' });
    expect(updatedSecond).toMatchObject({ goal: null, courseId: 'course_spanish_conversation' });
    expect(second).toEqual(createConversationContext());
  });

  it('mantém o schema de interpretação separado do estado interno', () => {
    expect(contextPatchSchema.safeParse(createConversationContext()).success).toBe(false);
    expect(conversationContextSchema.safeParse(patch()).success).toBe(false);
  });
});

describe('updateConversationContext', () => {
  const createRepository = () => new InMemorySchoolRepository(schoolFixture, courseFixtures);

  it('consulta o catálogo pelo repository para validar uma referência de curso', async () => {
    const repository = createRepository();
    const listCourses = vi.spyOn(repository, 'listActiveCourses');

    const updated = await updateConversationContext(repository, createConversationContext(),
      patch({ courseReference: 'inglês' }), 'Quero inglês.');

    expect(updated.courseId).toBe('course_english_travel');
    expect(listCourses).toHaveBeenCalledOnce();
  });

  it('não consulta o catálogo quando somente o objetivo muda', async () => {
    const repository = createRepository();
    const listCourses = vi.spyOn(repository, 'listActiveCourses');

    const updated = await updateConversationContext(repository, createConversationContext(),
      patch({ goal: 'viagem' }), 'Quero viagem.');

    expect(updated.goal).toBe('viagem');
    expect(listCourses).not.toHaveBeenCalled();
  });

  it('rejeita um patch inválido antes de consultar o catálogo', async () => {
    const repository = createRepository();
    const listCourses = vi.spyOn(repository, 'listActiveCourses');

    await expect(updateConversationContext(repository, createConversationContext(),
      { ...patch({ courseReference: 'inglês' }), courseId: 'english_123' }, 'Quero inglês.'))
      .rejects.toThrow();
    expect(listCourses).not.toHaveBeenCalled();
  });

  it('uma falha de consulta não aplica sequer os campos válidos do patch', async () => {
    const repository = createRepository();
    vi.spyOn(repository, 'listActiveCourses').mockRejectedValue(new Error('Detalhe interno'));
    const initial = createConversationContext();

    await expect(updateConversationContext(repository, initial,
      patch({ goal: 'viagem', courseReference: 'inglês' }), 'Quero inglês para viagem.'))
      .rejects.toThrow();
    expect(initial).toEqual(createConversationContext());
  });

  it('valida a saída do catálogo antes de aceitar uma referência', async () => {
    const repository = createRepository();
    vi.spyOn(repository, 'listActiveCourses').mockResolvedValue([{
      id: 'course_english_travel', name: 'Inglês para viagens', language: 'Inglês',
      modality: 'online', active: false,
    } as unknown as ActiveCourseSummary]);
    const initial = createConversationContext();

    await expect(updateConversationContext(repository, initial,
      patch({ goal: 'viagem', courseReference: 'inglês' }), 'Quero inglês para viagem.'))
      .rejects.toThrow();
    expect(initial).toEqual(createConversationContext());
  });
});
