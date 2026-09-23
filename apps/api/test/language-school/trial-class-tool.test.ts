import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleTrialClassResultSchema, trialClassPendingActionSchema } from '@supportflow/contracts/language-school';
import type { Lead, Slot, TrialClass } from '@supportflow/contracts/language-school';
import { createConversationContext } from '../../src/modules/language-school/domain/conversation-context.js';
import type { ConversationContext } from '../../src/modules/language-school/domain/conversation-context.js';
import type { TrialClassScope } from '../../src/modules/language-school/application/prepare-trial-class.js';
import { courseFixtures, schoolFixture } from '../../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { createLanguageSchoolPendingActions } from '../../src/modules/language-school/infrastructure/pending-actions.js';
import { createScheduleTrialClassTool } from '../../src/modules/language-school/infrastructure/trial-class-tool.js';
import { createAvailableSlotsTool } from '../../src/modules/language-school/infrastructure/available-slots-tool.js';
import { slotFixtures, trialClassFixtures } from '../../src/modules/language-school/infrastructure/slot-fixtures.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const slotId = 'slot_english_a';
const data = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseId: 'course_english_travel', goal: 'viagem' };

async function harness(slots: readonly Slot[] = slotFixtures) {
  const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slots, trialClassFixtures);
  const conversationId = 'conversation_ana';
  const lead = (await leadRepository.createForConversation(conversationId, data))!;
  const scope: TrialClassScope = { conversationId, context: { ...createConversationContext(), ...structuredClone(data), leadId: lead.id, slotId, revision: 8 } };
  const actions = createLanguageSchoolPendingActions();
  const prepareAction = vi.fn((current: typeof scope, preview: unknown) => {
    actions.prepare(current.conversationId, current.context.revision, { kind: 'schedule_trial_class', preview });
  });
  const dependencies = { schoolRepository, leadRepository, trialClassRepository, now };
  const tool = createScheduleTrialClassTool({ ...dependencies, prepareAction });
  const query = createAvailableSlotsTool(dependencies);
  const input = { leadId: lead.id, slotId };
  const pending = () => actions.pending(scope.conversationId, scope.context.revision);
  return { ...dependencies, lead, scope, actions, prepareAction, tool, query, input, pending };
}

describe('schedule_trial_class: proposta determinística sem reserva', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('retorna CONFIRMATION_REQUIRED com registros oficiais, mantendo vaga livre e estado intacto', async () => {
    const h = await harness();
    const contextBefore = structuredClone(h.scope.context);
    const occupancyBefore = await Promise.all(slotFixtures.map((s) => h.trialClassRepository.findConfirmedBySlotId(s.slotId)));
    const create = vi.spyOn(h.leadRepository, 'createForConversation');
    const update = vi.spyOn(h.leadRepository, 'updateForConversation');
    const result = await h.tool(h.input, h.scope);
    expect(scheduleTrialClassResultSchema.parse(result)).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    const pending = trialClassPendingActionSchema.parse(h.pending());
    expect(pending.preview).toEqual({
      lead: h.lead,
      course: (await h.schoolRepository.listActiveCourses()).find((c) => c.id === data.courseId),
      slot: slotFixtures.find((s) => s.slotId === slotId),
    });
    expect(Object.keys(pending).sort()).toEqual(['actionId', 'kind', 'preview']);
    const first = await h.query({ courseId: data.courseId });
    expect(first).toMatchObject({ ok: true, data: { slots: expect.arrayContaining([pending.preview.slot]) } });
    expect(await h.query({ courseId: data.courseId })).toEqual(first);
    expect(await h.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
    expect(await Promise.all(slotFixtures.map((s) => h.trialClassRepository.findConfirmedBySlotId(s.slotId)))).toEqual(occupancyBefore);
    expect(h.scope.context).toEqual(contextBefore);
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toEqual(h.lead);
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it.each([
    {}, { leadId: 'lead' }, { slotId }, { leadId: 123, slotId }, { leadId: 'lead', slotId: false },
    { leadId: '', slotId }, { leadId: 'lead', slotId: '' },
  ])('recusa entrada inválida %j antes de acessar repositories', async (input) => {
    const h = await harness();
    const read = vi.spyOn(h.leadRepository, 'findByConversationId');
    expect(await h.tool(input, h.scope)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(read).not.toHaveBeenCalled(); expect(h.prepareAction).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'conversationId', 'courseId', 'actionId', 'revision', 'name', 'contact', 'goal', 'preview', 'extra'])(
    'rejeita campo extra %s, sem autorização ou proposta', async (key) => {
      const h = await harness();
      expect(await h.tool({ ...h.input, [key]: key === 'confirmed' ? true : 'inventado' }, h.scope))
        .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(h.pending()).toBeNull(); expect(h.prepareAction).not.toHaveBeenCalled();
      expect(await h.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
    },
  );

  it.each(['missing', 'context-missing', 'different-input', 'foreign'])(
    'recusa lead indisponível (%s) sem revelar dados', async (scenario) => {
      const h = await harness();
      if (scenario === 'missing') vi.spyOn(h.leadRepository, 'findByConversationId').mockResolvedValue(null);
      if (scenario === 'context-missing') h.scope.context.leadId = null;
      if (scenario === 'different-input') h.input.leadId = 'inventado';
      if (scenario === 'foreign') h.scope.conversationId = 'conversation_other';
      const result = await h.tool(h.input, h.scope);
      expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(JSON.stringify(result)).not.toContain(data.contact.value);
      expect(h.prepareAction).not.toHaveBeenCalled();
    },
  );

  const corrections: Partial<ConversationContext>[] = [
    { name: 'Maria' }, { name: null }, { contact: null },
    { contact: { type: 'email', value: 'ana.novo@example.com' } },
    { contact: { type: 'phone', value: '+5511999991234' } },
    { goal: 'entrevistas' }, { goal: null }, { courseId: 'course_french_intro' }, { courseId: null },
  ];
  it.each(corrections)('exige atualização confirmada do cadastro quando contexto diverge: %j', async (patch) => {
    const h = await harness();
    Object.assign(h.scope.context, patch);
    const update = vi.spyOn(h.leadRepository, 'updateForConversation');
    expect(await h.tool(h.input, h.scope)).toMatchObject({ ok: false, error: {
      code: 'INVALID_INPUT', message: expect.stringContaining('confirme a atualização do cadastro'),
    } });
    expect(h.prepareAction).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(await h.leadRepository.findByConversationId(h.scope.conversationId)).toEqual(h.lead);
  });

  it('aceita objetivo null quando o registro e o contexto estão alinhados', async () => {
    const h = await harness();
    await h.leadRepository.updateForConversation(h.scope.conversationId, { ...data, goal: null });
    h.scope.context.goal = null;
    expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(trialClassPendingActionSchema.parse(h.pending()).preview.lead.goal).toBeNull();
  });

  it.each(['course_missing', 'course_german_foundations'])('recusa curso ausente/inativo %s antes da agenda', async (courseId) => {
    const h = await harness();
    await h.leadRepository.updateForConversation(h.scope.conversationId, { ...data, courseId });
    h.scope.context.courseId = courseId;
    const read = vi.spyOn(h.trialClassRepository, 'findSlotById');
    expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(read).not.toHaveBeenCalled(); expect(h.prepareAction).not.toHaveBeenCalled();
  });

  it.each([
    ['slot_missing', 'NOT_FOUND'], ['slot_french_a', 'INVALID_INPUT'],
    ['slot_english_past', 'SLOT_UNAVAILABLE'], ['slot_english_occupied', 'SLOT_UNAVAILABLE'],
  ])('recusa slot %s com %s', async (selected, code) => {
    const h = await harness();
    h.scope.context.slotId = selected;
    expect(await h.tool({ ...h.input, slotId: selected }, h.scope)).toMatchObject({ error: { code } });
    expect(h.prepareAction).not.toHaveBeenCalled();
  });

  it('recusa outro horário mesmo sendo livre e válido para o curso', async () => {
    const h = await harness();
    expect(await h.tool({ ...h.input, slotId: 'slot_english_b' }, h.scope)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(h.pending()).toBeNull();
  });

  it('sem seleção prévia, valida o slot fornecido sem preencher context.slotId', async () => {
    const h = await harness();
    h.scope.context.slotId = null;
    expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(h.scope.context.slotId).toBeNull();
  });

  it.each([
    ['2030-06-10T08:59:59-03:00', 'SLOT_UNAVAILABLE'],
    ['2030-06-10T09:00:00-03:00', 'SLOT_UNAVAILABLE'],
    ['2030-06-10T12:00:00Z', 'SLOT_UNAVAILABLE'],
    ['2030-06-10T09:00:01-03:00', 'CONFIRMATION_REQUIRED'],
    ['2030-06-10T12:00:01Z', 'CONFIRMATION_REQUIRED'],
  ])('compara instantes absolutos: %s → %s', async (startsAt, code) => {
    const h = await harness(slotFixtures.map((s) => s.slotId === slotId ? { ...s, startsAt } : s));
    expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code } });
    if (code === 'CONFIRMATION_REQUIRED') expect(trialClassPendingActionSchema.parse(h.pending()).preview.slot.startsAt).toBe(startsAt);
    else expect(h.pending()).toBeNull();
  });

  it('trata fuso incompatível como dado interno inválido, sem preparar prévia', async () => {
    const h = await harness(slotFixtures.map((s) => s.slotId === slotId ? { ...s, timezone: 'UTC' } : s));
    expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code: 'OPERATION_FAILED' } });
    expect(h.prepareAction).not.toHaveBeenCalled();
  });

  it.each(['lead', 'course', 'slot', 'school', 'occupancy', 'clock', 'preparation'])(
    'sanitiza falha técnica em %s sem sucesso falso', async (source) => {
      const h = await harness();
      const error = new Error('INTERNAL_ONLY: segredo da infraestrutura');
      if (source === 'lead') vi.spyOn(h.leadRepository, 'findByConversationId').mockRejectedValue(error);
      if (source === 'course') vi.spyOn(h.schoolRepository, 'findActiveCourseById').mockRejectedValue(error);
      if (source === 'slot') vi.spyOn(h.trialClassRepository, 'findSlotById').mockRejectedValue(error);
      if (source === 'school') vi.spyOn(h.schoolRepository, 'getSchool').mockRejectedValue(error);
      if (source === 'occupancy') vi.spyOn(h.trialClassRepository, 'findConfirmedBySlotId').mockRejectedValue(error);
      if (source === 'preparation') h.prepareAction.mockImplementation(() => { throw error; });
      const tool = source === 'clock' ? createScheduleTrialClassTool({ ...h, now: () => new Date('invalid') }) : h.tool;
      const result = await tool(h.input, h.scope);
      expect(scheduleTrialClassResultSchema.parse(result)).toMatchObject({ error: { code: 'OPERATION_FAILED' } });
      expect(JSON.stringify(result)).not.toContain('INTERNAL_ONLY'); expect(h.pending()).toBeNull();
    },
  );

  it.each(['lead-schema', 'lead-link', 'slot-schema', 'slot-link', 'course-link', 'occupancy-schema', 'occupancy-link'])(
    'não publica saída interna inválida/incompatível: %s', async (source) => {
      const h = await harness();
      if (source === 'lead-schema') vi.spyOn(h.leadRepository, 'findByConversationId').mockResolvedValue({ ...h.lead, name: 42 } as unknown as Lead);
      if (source === 'lead-link') vi.spyOn(h.leadRepository, 'findByConversationId').mockResolvedValue({ ...h.lead, id: 'lead_other' });
      const slot = slotFixtures.find((s) => s.slotId === slotId)!;
      if (source === 'slot-schema') vi.spyOn(h.trialClassRepository, 'findSlotById').mockResolvedValue({ ...slot, startsAt: 'tomorrow' });
      if (source === 'slot-link') vi.spyOn(h.trialClassRepository, 'findSlotById').mockResolvedValue({ ...slot, slotId: 'slot_other' });
      if (source === 'course-link') {
        const course = (await h.schoolRepository.findActiveCourseById(data.courseId))!;
        vi.spyOn(h.schoolRepository, 'findActiveCourseById').mockResolvedValue({ ...course, id: 'course_other' });
      }
      if (source === 'occupancy-schema') vi.spyOn(h.trialClassRepository, 'findConfirmedBySlotId').mockResolvedValue({} as TrialClass);
      if (source === 'occupancy-link') vi.spyOn(h.trialClassRepository, 'findConfirmedBySlotId').mockResolvedValue(trialClassFixtures[0]!);
      expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code: 'OPERATION_FAILED' } });
      expect(h.prepareAction).not.toHaveBeenCalled();
    },
  );

  it('captura revisão, conversa e argumentos derivados da prévia com cópias defensivas', async () => {
    const h = await harness();
    const officialSlot = (await h.trialClassRepository.findSlotById(slotId))!;
    const officialCourse = (await h.schoolRepository.findActiveCourseById(data.courseId))!;
    vi.spyOn(h.trialClassRepository, 'findSlotById').mockResolvedValue(officialSlot);
    vi.spyOn(h.schoolRepository, 'findActiveCourseById').mockResolvedValue(officialCourse);
    vi.spyOn(h.leadRepository, 'findByConversationId').mockResolvedValue(h.lead);
    await h.tool(h.input, h.scope);
    const snapshot = structuredClone(h.pending());
    const publicCopy = trialClassPendingActionSchema.parse(h.pending());
    const expectedArgs = { ...h.input };
    h.input.leadId = 'lead_forged'; h.input.slotId = 'slot_forged';
    h.lead.contact.value = 'changed@example.com'; officialCourse.name = 'Outro'; officialSlot.startsAt = '2040-01-01T00:00:00Z';
    publicCopy.preview.lead.name = 'Outra'; publicCopy.preview.slot.slotId = 'slot_browser';
    expect(h.pending()).toEqual(snapshot);
    const execute = vi.fn(async (action) => {
      expect(action).toMatchObject({ conversationId: h.scope.conversationId, revision: 8, kind: 'schedule_trial_class', args: expectedArgs });
      expect(action.preview).toEqual(snapshot?.preview);
      throw new Error('Sem executor de reserva nesta task.');
    });
    await expect(h.actions.confirm(h.scope.conversationId, 8, publicCopy.actionId, execute)).rejects.toThrow('Sem executor');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.pending()).toEqual(snapshot);
    expect(await h.trialClassRepository.findConfirmedBySlotId(slotId)).toBeNull();
  });

  it('uma tentativa inválida posterior conserva a ação pendente anterior', async () => {
    const h = await harness();
    await h.tool(h.input, h.scope);
    const previous = structuredClone(h.pending());
    expect(await h.tool({ ...h.input, confirmed: true }, h.scope)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(h.pending()).toEqual(previous);
    vi.spyOn(h.trialClassRepository, 'findSlotById').mockRejectedValue(new Error('Falha temporária.'));
    expect(await h.tool(h.input, h.scope)).toMatchObject({ error: { code: 'OPERATION_FAILED' } });
    expect(h.pending()).toEqual(previous);
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
  });
});
