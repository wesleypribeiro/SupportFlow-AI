import { AIMessage } from '@langchain/core/messages';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryPendingActions } from '../src/core/pending-actions.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures, trialClassFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const courseId = 'course_english_travel';

describe('composição da consulta de horários sem efeitos', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede proibida.'); });
  beforeEach(() => { vi.stubGlobal('fetch', fetch); });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it('consulta duas vezes sem credenciais, sem novos IDs, lead, contexto, ação ou confirmação', async () => {
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures, trialClassFixtures);
    const leadRepository = new InMemoryLeadRepository();
    const executeAction = vi.fn(async () => { throw new Error('Consulta não confirma ações.'); });
    const app = createApplication({}, { now, trialClassRepository, leadRepository, executeAction });
    servers.push(app.server);
    const conversation = app.conversations.create();
    app.conversations.save(conversation);
    const createConversation = vi.spyOn(app.conversations, 'create');
    const saveConversation = vi.spyOn(app.conversations, 'save');
    const prepare = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
    const invalidate = vi.spyOn(InMemoryPendingActions.prototype, 'invalidateCurrent');
    const leadCreate = vi.spyOn(leadRepository, 'createForConversation');
    const leadUpdate = vi.spyOn(leadRepository, 'updateForConversation');
    const before = await Promise.all(slotFixtures.map((entry) => trialClassRepository.findConfirmedBySlotId(entry.slotId)));
    const first = await app.getAvailableSlots({ courseId });
    const second = await app.getAvailableSlots({ courseId });
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, data: { courseId, slots: ['slot_english_a', 'slot_english_b']
      .map((id) => slotFixtures.find((entry) => entry.slotId === id)) } });
    expect(await Promise.all(slotFixtures.map((entry) => trialClassRepository.findConfirmedBySlotId(entry.slotId)))).toEqual(before);
    expect(before.filter((booking) => booking !== null)).toEqual(trialClassFixtures);
    expect(app.conversations.get(conversation.id)).toEqual(conversation);
    expect(await leadRepository.findByConversationId(conversation.id)).toBeNull();
    for (const spy of [createConversation, saveConversation, prepare, invalidate, leadCreate, leadUpdate, executeAction]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('composição padrão usa as fixtures sem reservas e respeita o clock injetado', async () => {
    const app = createApplication({}, { now });
    servers.push(app.server);
    const result = await app.getAvailableSlots({ courseId });
    expect(result).toEqual({ ok: true, data: { courseId,
      slots: ['slot_english_occupied', 'slot_english_a', 'slot_english_b'].map((id) => slotFixtures.find((entry) => entry.slotId === id)),
    } });
    const later = createApplication({}, { now: () => new Date('2031-01-01T00:00:00Z') });
    servers.push(later.server);
    expect(await later.getAvailableSlots({ courseId })).toEqual({ ok: true, data: { courseId, slots: [] } });
  });

  it('consulta diretamente sem modelo e disponibiliza a tool no chat sem acioná-la para saudação', async () => {
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
    const model = new ScriptedChatModel([new AIMessage('Olá!')]);
    const app = createApplication({}, { now, model });
    servers.push(app.server);
    await app.getAvailableSlots({ courseId });
    expect(model.calls).toHaveLength(0);
    expect(model.contextCalls).toHaveLength(0);
    const chat = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Olá' } });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({ results: [], pendingAction: null });
    expect(model.boundTools.map((tool) => 'name' in tool ? tool.name : undefined))
      .toEqual(['get_school_info', 'get_courses', 'get_course_details', 'get_available_slots', 'create_lead', 'schedule_trial_class', 'transfer_to_human']);
    expect(app.conversations.get(chat.json().conversationId)?.context.slotId).toBeNull();
  });
});
