import { AIMessage } from '@langchain/core/messages';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languageSchoolChatResponseSchema, leadPendingActionSchema, trialClassPendingActionSchema } from '@supportflow/contracts/language-school';
import { createApplication } from '../src/app.js';
import type { ActionExecutor } from '../src/core/pending-actions.js';
import type { LanguageSchoolAction } from '../src/modules/language-school/infrastructure/pending-actions.js';
import { conversationContextSchema } from '../src/modules/language-school/domain/conversation-context.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const slotId = 'slot_english_a';
const data = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseId: 'course_english_travel', goal: 'viagem' };
const emptyPatch = { name: null, contact: null, goal: null, courseReference: null };

describe('proposta de aula: vínculo, revisão e autorizações distintas', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  function application(model = new ScriptedChatModel([]), executeAction?: ActionExecutor<LanguageSchoolAction>) {
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
    const app = createApplication({}, { now, model, leadRepository, trialClassRepository, ...(executeAction ? { executeAction } : {}) });
    servers.push(app.server);
    return { ...app, leadRepository, trialClassRepository, model };
  }

  async function registeredConversation(app: ReturnType<typeof application>) {
    const current = app.conversations.create();
    const lead = (await app.leadRepository.createForConversation(current.id, data))!;
    current.context = { ...current.context, ...structuredClone(data), leadId: lead.id, slotId, revision: 8 };
    app.conversations.save(current);
    return current;
  }

  function confirm(server: FastifyInstance, conversationId: string, actionId: string, extra = {}) {
    return server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId, actionId, ...extra } });
  }

  async function proposal(app: ReturnType<typeof application>, id: string) {
    const context = app.conversations.get(id)!.context;
    const prepared = await app.prepareTrialClass(id, { leadId: context.leadId, slotId: context.slotId });
    expect(prepared.result).toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    return trialClassPendingActionSchema.parse(prepared.pendingAction);
  }

  async function expectNoBookings(app: ReturnType<typeof application>) {
    for (const slot of slotFixtures) expect(await app.trialClassRepository.findConfirmedBySlotId(slot.slotId)).toBeNull();
    const available = await app.getAvailableSlots({ courseId: data.courseId });
    expect(available).toMatchObject({ ok: true, data: { slots: expect.arrayContaining([expect.objectContaining({ slotId })]) } });
  }

  it('prepara prévia oficial sem modelo, mudança de contexto/histórico ou ocupação', async () => {
    const app = application();
    const current = await registeredConversation(app);
    const action = await proposal(app, current.id);
    expect(action.preview.lead).toEqual(await app.leadRepository.findByConversationId(current.id));
    expect(action.preview.slot).toEqual(await app.trialClassRepository.findSlotById(slotId));
    expect(action.preview.course.id).toBe(data.courseId);
    expect(app.conversations.get(current.id)).toEqual(current);
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    await expectNoBookings(app);
  });

  it('mantém a proposta com proposta direta independente do LangChain ao chat normal', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Pode revisar a prévia.') ]));
    const current = await registeredConversation(app);
    const action = await proposal(app, current.id);
    await expectNoBookings(app);
    expect(app.model.calls).toHaveLength(0);
    const chat = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: current.id, message: 'Pode continuar?' } });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().pendingAction).toEqual(action);
    expect(app.conversations.get(current.id)?.context).toEqual(current.context);
    expect(app.model.boundTools.map((tool) => 'name' in tool ? tool.name : undefined))
      .toEqual(['get_school_info', 'get_courses', 'get_course_details', 'get_available_slots', 'create_lead', 'schedule_trial_class', 'transfer_to_human']);
  });

  it.each(['args', 'leadId', 'slotId', 'courseId', 'confirmed', 'revision', 'preview'])(
    'confirmação HTTP rejeita %s e não substitui os argumentos armazenados', async (key) => {
      const execute = vi.fn(async () => { throw new Error('Não executar.'); });
      const app = application(new ScriptedChatModel([]), execute);
      const current = await registeredConversation(app);
      const action = await proposal(app, current.id);
      const response = await confirm(app.server, current.id, action.actionId, { [key]: key === 'confirmed' ? true : 'forged' });
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_REQUEST');
      expect(execute).not.toHaveBeenCalled();
      await expectNoBookings(app);
    },
  );

  it('ação inexistente e estrangeira retornam o mesmo 404 sem dados da proprietária', async () => {
    const execute = vi.fn(async () => { throw new Error('Não executar.'); });
    const app = application(new ScriptedChatModel([]), execute);
    const first = await registeredConversation(app);
    const other = await registeredConversation(app);
    const action = await proposal(app, first.id);
    const foreign = await confirm(app.server, other.id, action.actionId);
    const missing = await confirm(app.server, other.id, 'action_missing');
    expect(foreign.statusCode).toBe(404); expect(foreign.json()).toEqual(missing.json());
    expect(foreign.body).not.toContain(first.id); expect(foreign.body).not.toContain(data.contact.value);
    expect(execute).not.toHaveBeenCalled();
    await expectNoBookings(app);
  });

  it.each([
    { field: 'nome', message: 'Meu nome é Maria.', patch: { name: 'Maria' } },
    { field: 'contato', message: 'Meu email é ana.novo@example.com.', patch: { contact: { type: 'email', value: 'ana.novo@example.com' } } },
    { field: 'objetivo', message: 'Na verdade quero entrevistas de emprego.', patch: { goal: 'entrevistas de emprego' } },
    { field: 'curso', message: 'Agora quero francês.', patch: { courseReference: 'francês' } },
  ])('correção de $field invalida a reserva pendente antes de qualquer execução', async ({ message, patch, field }) => {
    const execute = vi.fn(async () => { throw new Error('Ação stale não pode executar.'); });
    const model = new ScriptedChatModel([new AIMessage('Preferência atualizada.')], { contextSteps: [{ ...emptyPatch, ...patch }] });
    const app = application(model, execute);
    const current = await registeredConversation(app);
    const savedLead = await app.leadRepository.findByConversationId(current.id);
    const action = await proposal(app, current.id);
    const chat = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: current.id, message } });
    expect(chat.statusCode).toBe(200); expect(chat.json().pendingAction).toBeNull();
    const updated = app.conversations.get(current.id)!;
    expect(updated.context.revision).toBe(9);
    if (field === 'curso') expect(updated.context).toMatchObject({ courseId: 'course_french_intro', slotId: null });
    const response = await confirm(app.server, current.id, action.actionId);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('ACTION_STALE');
    expect(execute).not.toHaveBeenCalled();
    expect(await app.leadRepository.findByConversationId(current.id)).toEqual(savedLead);
    // Lead antigo não é atualizado automaticamente para permitir uma nova proposta.
    expect((await app.prepareTrialClass(current.id, { leadId: savedLead!.id, slotId })).result)
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    await expectNoBookings(app);
  });

  it('troca validada de slot/revisão recusa ação antiga e prepara somente o horário atual', async () => {
    const execute = vi.fn(async () => { throw new Error('Não executar reserva.'); });
    const app = application(new ScriptedChatModel([]), execute);
    const current = await registeredConversation(app);
    const first = await proposal(app, current.id);
    // Estado interno validado, sem implementar interpretação natural de horários.
    await app.conversations.runExclusive(current.id, () => {
      const stored = app.conversations.get(current.id)!;
      stored.context = conversationContextSchema.parse({ ...stored.context, slotId: 'slot_english_b', revision: 9 });
      app.conversations.save(stored);
    });
    expect((await confirm(app.server, current.id, first.actionId)).statusCode).toBe(409);
    const second = await proposal(app, current.id);
    expect(second.actionId).not.toBe(first.actionId);
    expect(second.preview.slot.slotId).toBe('slot_english_b');
    expect((await confirm(app.server, current.id, first.actionId)).json().error.code).toBe('ACTION_STALE');
    expect(execute).not.toHaveBeenCalled(); await expectNoBookings(app);
  });

  it.each(['Pode continuar?', 'Sim'])('mensagem %s sem mudança conserva ação e nunca autoriza', async (message) => {
    const execute = vi.fn(async () => { throw new Error('Texto não confirma.'); });
    const model = new ScriptedChatModel([new AIMessage('A prévia continua pendente.')], {
      contextSteps: [{ ...emptyPatch, name: data.name, contact: data.contact, goal: data.goal }],
    });
    const app = application(model, execute);
    const current = await registeredConversation(app);
    const action = await proposal(app, current.id);
    const response = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: current.id, message } });
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingAction).toEqual(action);
    expect(app.conversations.get(current.id)?.context).toEqual(current.context);
    expect(execute).not.toHaveBeenCalled(); await expectNoBookings(app);
  });

  it('recibo de cadastro devolve somente create_lead e não consome a nova ação de aula', async () => {
    const app = application();
    const current = app.conversations.create();
    current.context = { ...current.context, ...structuredClone(data), slotId, revision: 8 };
    app.conversations.save(current);
    const leadAction = leadPendingActionSchema.parse((await app.prepareLead(current.id, data)).pendingAction);
    const created = await confirm(app.server, current.id, leadAction.actionId);
    expect(created.statusCode).toBe(200);
    const receipt = languageSchoolChatResponseSchema.parse(created.json());
    expect(receipt.results).toMatchObject([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created' } } }]);
    const action = await proposal(app, current.id);
    expect(action.actionId).not.toBe(leadAction.actionId);
    const retry = await confirm(app.server, current.id, leadAction.actionId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ reply: receipt.reply, results: receipt.results, pendingAction: action });
    expect(retry.json().results).toHaveLength(1);
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    await expectNoBookings(app);
    // Somente o ID específico da aula pode autorizar esta escrita.
    const scheduled = await confirm(app.server, current.id, action.actionId);
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json().results).toMatchObject([{ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created' } } }]);
  });

  it('uma nova proposta invalida a anterior, sem ocupar nenhuma das vagas', async () => {
    const execute = vi.fn(async () => { throw new Error('Não executar.'); });
    const app = application(new ScriptedChatModel([]), execute);
    const current = await registeredConversation(app);
    const first = await proposal(app, current.id);
    const second = await proposal(app, current.id);
    expect(first.actionId).not.toBe(second.actionId);
    const response = await confirm(app.server, current.id, first.actionId);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('ACTION_STALE');
    expect(execute).not.toHaveBeenCalled(); await expectNoBookings(app);
  });

  it('recusa conversa inexistente na composição sem gerar prévia', async () => {
    const app = application();
    expect(await app.prepareTrialClass('conversation_missing', { leadId: 'lead_missing', slotId })).toMatchObject({
      result: { ok: false, error: { code: 'NOT_FOUND' } }, pendingAction: null,
    });
    await expectNoBookings(app);
  });
});
