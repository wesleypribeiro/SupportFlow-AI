import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLeadResultSchema, leadPendingActionSchema } from '@supportflow/contracts/language-school';
import { createConversationContext } from '../../src/modules/language-school/domain/conversation-context.js';
import type { ConversationContext } from '../../src/modules/language-school/domain/conversation-context.js';
import { InMemoryLeadRepository } from '../../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { schoolFixture, courseFixtures } from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { createLeadTool } from '../../src/modules/language-school/infrastructure/lead-tool.js';
import { createLanguageSchoolPendingActions } from '../../src/modules/language-school/infrastructure/pending-actions.js';

const data = () => ({
  name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' },
  courseId: 'course_english_travel', goal: 'viagem',
});

function harness(context: Partial<ConversationContext> = {}) {
  const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const leadRepository = new InMemoryLeadRepository();
  const actions = createLanguageSchoolPendingActions();
  const prepare = vi.spyOn(actions, 'prepare');
  const scope = { conversationId: 'conversation_test', context: { ...createConversationContext(), ...data(), revision: 7, ...context } };
  const create_lead = createLeadTool({
    schoolRepository, leadRepository,
    prepareAction: (current, preview) => { actions.prepare(current.conversationId, current.context.revision, { kind: 'create_lead', preview }); },
    clearPendingAction: (current) => { actions.invalidateCurrent(current.conversationId); },
  });
  return { schoolRepository, leadRepository, actions, prepare, scope, create_lead };
}

describe('create_lead: proposta validada sem escrita', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('prepara somente os dados oficiais na revisão vigente e retorna CONFIRMATION_REQUIRED', async () => {
    const h = harness();
    const write = vi.spyOn(h.leadRepository, 'createForConversation');
    const result = await h.create_lead(data(), h.scope);
    expect(createLeadResultSchema.parse(result)).toEqual({ ok: false, error: {
      code: 'CONFIRMATION_REQUIRED', message: 'Revise a prévia e confirme o cadastro antes de gravá-lo.',
    } });
    expect(h.prepare).toHaveBeenCalledExactlyOnceWith('conversation_test', 7, { kind: 'create_lead', preview: data() });
    const pending = leadPendingActionSchema.parse(h.actions.pending('conversation_test', 7));
    expect(pending).toEqual({ actionId: expect.any(String), kind: 'create_lead', preview: data() });
    expect(Object.keys(pending.preview).sort()).toEqual(['contact', 'courseId', 'goal', 'name']);
    expect(h.actions.pending('conversation_test', 8)).toBeNull();
    expect(await h.leadRepository.findByConversationId('conversation_test')).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'nome ausente', context: { name: null } },
    { label: 'contato ausente', context: { contact: null } },
    { label: 'contato inválido', context: { contact: { type: 'email' as const, value: 'inválido' } } },
    { label: 'curso ausente', context: { courseId: null } },
  ])('não prepara quando o contexto tem $label', async ({ context }) => {
    const h = harness(context);
    expect(await h.create_lead(data(), h.scope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toBeNull();
  });

  it.each([
    { ...data(), name: 'Maria' },
    { ...data(), name: ' Ana ' },
    { ...data(), contact: { type: 'email', value: 'maria@example.com' } },
    { ...data(), contact: { type: 'phone', value: '+55 (11) 99999-1234' } },
    { ...data(), courseId: 'course_spanish_conversation' },
    { ...data(), goal: 'entrevistas de emprego' },
    { ...data(), goal: null },
  ])('não prepara dados diferentes do contexto: %j', async (input) => {
    const h = harness();
    expect(await h.create_lead(input, h.scope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toBeNull();
  });

  it('não reaproveita objetivo anterior substituído', async () => {
    const h = harness({ goal: 'entrevistas de emprego' });
    expect(await h.create_lead(data(), h.scope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(h.actions.pending(h.scope.conversationId, 7)).toBeNull();
    expect(await h.create_lead({ ...data(), goal: 'entrevistas de emprego' }, h.scope))
      .toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
  });

  it.each(['course_missing', 'course_german_foundations'])('não prepara curso ausente/inativo: %s', async (courseId) => {
    const h = harness({ courseId });
    expect(await h.create_lead({ ...data(), courseId }, h.scope)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toBeNull();
  });

  it('aceita objetivo null e preserva telefone formatado sem normalização', async () => {
    const input = { ...data(), goal: null, contact: { type: 'phone' as const, value: '+55 (11) 99999-1234' } };
    const h = harness(input);
    expect(await h.create_lead(input, h.scope)).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(h.actions.pending(h.scope.conversationId, 7)?.preview).toEqual(input);
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toBeNull();
  });

  it.each([
    {}, { ...data(), name: undefined }, { ...data(), name: 123 },
    { ...data(), contact: { type: 'email', value: 'inválido' } },
    { ...data(), contact: { type: 'phone', value: '123' } },
    { ...data(), id: 'model_id' }, { ...data(), conversationId: 'foreign' },
    { ...data(), confirmed: true }, { ...data(), revision: 99 },
    { ...data(), contact: { ...data().contact, verified: true } },
    { ...data(), price: 0 },
  ])('valida entrada estrita antes de consultar: %j', async (input) => {
    const h = harness();
    const query = vi.spyOn(h.schoolRepository, 'findActiveCourseById');
    expect(createLeadResultSchema.parse(await h.create_lead(input, h.scope)))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(query).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it.each(['catalog', 'lead_read', 'prepare'])('sanitiza falha inesperada de %s sem gravar', async (stage) => {
    const h = harness();
    const error = new Error('INTERNAL_ONLY: detalhe privado');
    if (stage === 'catalog') vi.spyOn(h.schoolRepository, 'findActiveCourseById').mockRejectedValue(error);
    if (stage === 'lead_read') vi.spyOn(h.leadRepository, 'findByConversationId').mockRejectedValueOnce(error);
    if (stage === 'prepare') h.prepare.mockImplementation(() => { throw error; });
    const result = await h.create_lead(data(), h.scope);
    expect(createLeadResultSchema.parse(result)).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('INTERNAL_ONLY');
    expect(h.actions.pending(h.scope.conversationId, 7)).toBeNull();
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toBeNull();
  });

  it('não prepara ação a partir de resultado de catálogo incompatível', async () => {
    const h = harness();
    const course = await h.schoolRepository.findActiveCourseById(data().courseId);
    if (!course) throw new Error('Fixture ausente.');
    vi.spyOn(h.schoolRepository, 'findActiveCourseById').mockResolvedValue({ ...course, id: 'course_different' });
    expect(await h.create_lead(data(), h.scope)).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('recusa inconsistência entre lead registrado e contexto sem vínculo', async () => {
    const h = harness();
    const saved = await h.leadRepository.createForConversation(h.scope.conversationId, data());
    expect(await h.create_lead(data(), h.scope)).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toEqual(saved);
  });
});
