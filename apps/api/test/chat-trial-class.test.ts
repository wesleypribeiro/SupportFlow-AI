import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { languageSchoolChatResponseSchema, scheduleTrialClassInputSchema, trialClassPendingActionSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput } from '@supportflow/contracts/language-school';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryPendingActions } from '../src/core/pending-actions.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const courseId = 'course_english_travel';
const slotA = 'slot_english_a';
const slotB = 'slot_english_b';
const data: CreateLeadInput = { name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseId, goal: 'viagem' };
const unchanged = { name: null, contact: null, goal: null, courseReference: null, slotReference: null };
const selection = (slotId: string, evidence = '11/06 às 10h') => ({ ...unchanged, slotReference: { slotId, evidence } });
const call = (name: string, args: Record<string, unknown>) => new AIMessage({ content: '', tool_calls: [{ name, args, id: `call_${name}`, type: 'tool_call' }] });
const schedule = (leadId: string, slotId = slotA) => call('schedule_trial_class', { leadId, slotId });
const now = () => new Date('2030-06-10T12:00:00Z');

describe('agenda no chat: seleção, proposta atômica e recibo independente da redação', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede proibida.'); });
  beforeEach(() => { vi.stubGlobal('fetch', fetch); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false'); });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  async function application(steps: ConstructorParameters<typeof ScriptedChatModel>[0], contextSteps: unknown[] = []) {
    const model = new ScriptedChatModel(steps, { contextSteps });
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
    const app = createApplication({}, { model, leadRepository, trialClassRepository, now });
    servers.push(app.server);
    const conversation = app.conversations.create();
    const lead = (await leadRepository.createForConversation(conversation.id, data))!;
    conversation.context = { ...conversation.context, ...data, leadId: lead.id, revision: 1 };
    app.conversations.save(conversation);
    return { ...app, model, leadRepository, trialClassRepository, conversation, lead };
  }
  type App = Awaited<ReturnType<typeof application>>;
  const chat = (app: App, message: string) => app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId: app.conversation.id, message } });
  const confirm = (app: App, actionId: string) => app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId: app.conversation.id, actionId } });
  const current = (app: App) => app.conversations.get(app.conversation.id)!;
  const scheduleFromContext = (slotId = slotA) => (messages: readonly BaseMessage[]) => {
    const context = messages.find((message) => message.name === 'conversation_context')!.text;
    const leadId = JSON.parse(context.slice(context.indexOf('{'))).leadId as string;
    return schedule(leadId, slotId);
  };

  it('registra exatamente sete tools, schemas estritos, consulta oficial sem ocupação e encaminha ToolMessage', async () => {
    const app = await application([call('get_available_slots', { courseId }), new AIMessage('Horários inventados na prosa não são oficiais.')]);
    const response = await chat(app, 'Quais horários vocês têm?');
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    expect(body.results).toEqual([{ tool: 'get_available_slots', result: await app.getAvailableSlots({ courseId }) }]);
    expect(body.pendingAction).toBeNull();
    expect(current(app).context.slotId).toBeNull();
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    expect(app.model.boundTools.map((tool) => 'name' in tool ? tool.name : undefined)).toEqual([
      'get_school_info', 'get_courses', 'get_course_details', 'get_available_slots', 'create_lead', 'schedule_trial_class', 'transfer_to_human',
    ]);
    const tool = app.model.boundTools.find((entry) => 'name' in entry && entry.name === 'schedule_trial_class');
    expect(tool && 'schema' in tool ? tool.schema : null).toBe(scheduleTrialClassInputSchema);
    expect(Object.keys(scheduleTrialClassInputSchema.shape)).toEqual(['leadId', 'slotId']);
    const forwarded = app.model.calls[1]!.messages.find((message): message is ToolMessage => ToolMessage.isInstance(message));
    expect(forwarded?.tool_call_id).toBe('call_get_available_slots');
    expect(JSON.parse(String(forwarded?.content))).toEqual(body.results[0]);
    expect(app.model.calls[1]!.options.tools).toBeUndefined();
    expect(app.model.contextCalls[0]!.messages.find((message) => message.name === 'eligible_slots')?.text).toContain(slotA);
  });

  it('seleciona A, preserva Sim, troca para B, invalida A e confirma apenas a nova prévia', async () => {
    const app = await application([
      scheduleFromContext(), new AIMessage('Sua aula já está marcada.'),
      new AIMessage('Use o botão para confirmar.'),
      scheduleFromContext(slotB), new AIMessage('Revise o novo horário.'), new AIMessage('Aula confirmada na demonstração.'),
      scheduleFromContext(slotB), new AIMessage('A mesma reserva já existe.'),
    ], [selection(slotA), unchanged, selection(slotB, '12/06 às 14h')]);
    const first = await chat(app, 'Escolho 11/06 às 10h.');
    expect(first.statusCode).toBe(200);
    const actionA = trialClassPendingActionSchema.parse(first.json().pendingAction);
    expect(first.json().results[0].result.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(actionA.preview.lead).toEqual(app.lead);
    expect(actionA.preview.slot).toEqual(slotFixtures.find((slot) => slot.slotId === slotA));
    expect(current(app).context).toMatchObject({ slotId: slotA, revision: 2 });
    expect(app.model.calls[0]!.messages.find((message) => message.name === 'conversation_context')?.text).toContain(`"slotId":"${slotA}"`);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    expect((await chat(app, 'Sim')).json().pendingAction).toEqual(actionA);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    const second = await chat(app, 'Prefiro 12/06 às 14h.');
    const actionB = trialClassPendingActionSchema.parse(second.json().pendingAction);
    expect(actionB.actionId).not.toBe(actionA.actionId);
    expect(actionB.preview.slot.slotId).toBe(slotB);
    expect(current(app).context).toMatchObject({ slotId: slotB, revision: 3 });
    expect((await confirm(app, actionA.actionId)).statusCode).toBe(409);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    const confirmed = await confirm(app, actionB.actionId);
    expect(confirmed.statusCode).toBe(200);
    const saved = await app.trialClassRepository.findConfirmedBySlotId(slotB);
    expect(confirmed.json().results[0].result).toEqual({ ok: true, data: { outcome: 'created', booking: saved } });
    const repeated = await chat(app, 'Quero a mesma aula.');
    expect(repeated.json()).toMatchObject({ pendingAction: null, results: [{ result: { ok: true, data: { outcome: 'existing', booking: saved } } }] });
  });

  it.each([
    ['inventado', selection('invented'), 'Escolho 11/06 às 10h.'],
    ['outro curso', selection('slot_french_a'), 'Escolho 11/06 às 10h.'],
    ['passado', selection('slot_english_past'), 'Escolho 11/06 às 10h.'],
    ['sem evidência atual', selection(slotB, '12/06 às 14h'), 'Pode continuar?'],
    ['ambíguo', unchanged, 'Talvez dia 11 ou 12, não sei.'],
  ])('não oficializa escolha %s', async (_scenario, patch, message) => {
    const app = await application([new AIMessage('Qual horário você prefere?')], [patch]);
    const response = await chat(app, message as string);
    expect(response.statusCode).toBe(200);
    expect(current(app).context).toMatchObject({ slotId: null, revision: 1 });
    expect(response.json().pendingAction).toBeNull();
  });

  it('revalida disponibilidade depois da interpretação e não aceita slot ocupado', async () => {
    const app = await application([new AIMessage('Consulte novamente os horários.')], [selection(slotA)]);
    const list = app.trialClassRepository.listSlotsByCourseId.bind(app.trialClassRepository);
    let calls = 0;
    vi.spyOn(app.trialClassRepository, 'listSlotsByCourseId').mockImplementation(async (id) => {
      // Outra conversa ocupa a vaga entre a lista enviada ao modelo e o patch.
      if (++calls === 2) await app.trialClassRepository.reserveSlot({ leadId: 'other_lead', slotId: slotA }, now());
      return list(id);
    });
    expect((await chat(app, 'Escolho 11/06 às 10h.')).statusCode).toBe(200);
    expect(app.model.contextCalls[0]!.messages.find((message) => message.name === 'eligible_slots')?.text).toContain(slotA);
    expect(current(app).context).toMatchObject({ slotId: null, revision: 1 });
    expect((await app.trialClassRepository.findConfirmedBySlotId(slotA))?.leadId).toBe('other_lead');
  });

  it('não permite que o navegador imponha slotId ou contexto', async () => {
    const app = await application([]);
    for (const extra of [{ slotId: slotA }, { context: { slotId: slotA } }]) {
      const response = await app.server.inject({ method: 'POST', url: '/api/chat', payload: {
        conversationId: app.conversation.id, message: 'Quero reservar.', ...extra,
      } });
      expect(response.statusCode).toBe(400);
      expect(current(app).context.slotId).toBeNull();
    }
    expect(app.model.contextCalls).toHaveLength(0);
    expect(app.model.calls).toHaveLength(0);
  });

  it('mesma seleção é no-op; mudança de curso limpa horário', async () => {
    const app = await application([new AIMessage('Certo.'), new AIMessage('Qual horário do francês?')], [selection(slotA), { ...unchanged, courseReference: 'francês' }]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    await chat(app, 'Escolho 11/06 às 10h.');
    expect(current(app).context).toMatchObject({ slotId: slotA, revision: 1 });
    await chat(app, 'Prefiro francês.');
    expect(current(app).context).toMatchObject({ courseId: 'course_french_intro', slotId: null, revision: 2 });
  });

  it.each([
    ['ID B com evidência de A', 'Escolho 11/06 às 10h.', '11/06 às 10h'],
    ['evidência genérica', 'Escolho.', 'Escolho'],
    ['duas escolhas, evidence recortada', 'Escolho 11/06 às 10h ou 12/06 às 14h.', '12/06 às 14h'],
  ])('seleção rejeitada (%s) preserva revision e ação vigente mesmo com tool call para B', async (_case, message, evidence) => {
    const app = await application([scheduleFromContext(slotB), new AIMessage('Informe uma única data e hora no fuso apresentado.')], [selection(slotB, evidence)]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const previous = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction);
    // Uma reserva já concluída também precisa permanecer intacta.
    await app.trialClassRepository.reserveSlot({ leadId: 'other_lead', slotId: 'slot_english_occupied' }, now());
    const before = await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)));
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const response = await chat(app, message);
    expect(response.statusCode).toBe(200);
    expect(current(app).context).toEqual(conversation.context);
    expect(response.json().pendingAction).toEqual(previous);
    expect(response.json().results[0].result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(app.model.calls[0]!.messages.find((entry) => entry.name === 'conversation_context')?.text).toContain(`"slotId":"${slotA}"`);
    expect(reserve).not.toHaveBeenCalled();
    expect(await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)))).toEqual(before);
  });

  it('somente a escolha válida de B muda revision e invalida A, sem criar ou modificar reservas', async () => {
    const app = await application([new AIMessage('Selecionado. Podemos revisar uma nova prévia.')], [selection(slotB, '12/06 às 14h')]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const previous = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction);
    await app.trialClassRepository.reserveSlot({ leadId: 'other_lead', slotId: 'slot_english_occupied' }, now());
    const before = await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)));
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const response = await chat(app, 'Escolho 12/06 às 14h.');
    expect(response.statusCode).toBe(200);
    expect(current(app).context).toEqual({ ...conversation.context, slotId: slotB, revision: conversation.context.revision + 1 });
    expect(response.json().pendingAction).toBeNull();
    const stale = await confirm(app, previous.actionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ACTION_STALE');
    expect(reserve).not.toHaveBeenCalled();
    expect(await Promise.all(slotFixtures.map((slot) => app.trialClassRepository.findConfirmedBySlotId(slot.slotId)))).toEqual(before);
  });

  it.each(['sem seleção', 'cadastro desatualizado', 'confirmed extra'])('recusa proposta %s sem escrita', async (scenario) => {
    const app = await application([(messages) => {
      const proposed = scheduleFromContext()(messages);
      if (scenario === 'confirmed extra') proposed.tool_calls![0]!.args.confirmed = true;
      return proposed;
    }, new AIMessage('Revise a seleção e o cadastro.')]);
    const conversation = current(app);
    if (scenario !== 'sem seleção') conversation.context.slotId = slotA;
    if (scenario === 'cadastro desatualizado') conversation.context.contact = { type: 'email', value: 'novo@example.com' };
    app.conversations.save(conversation);
    const response = await chat(app, 'Quero marcar.');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pendingAction: null, results: [{ result: { ok: false, error: { code: 'INVALID_INPUT' } } }] });
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
  });

  it.each([false, true])('falha após proposta preserva contexto, histórico e ação anterior (%s)', async (withPrevious) => {
    const app = await application([scheduleFromContext(slotB), new Error('Falha secreta'), new AIMessage('Revise a prévia atual.')], [selection(slotB, '12/06 às 14h')]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const previous = withPrevious ? (await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction : null;
    const before = current(app);
    const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
    const invalidate = vi.spyOn(InMemoryPendingActions.prototype, 'invalidateCurrent');
    const response = await chat(app, 'Prefiro 12/06 às 14h.');
    expect(response.statusCode).toBe(500);
    expect(current(app)).toEqual(before);
    expect(stage).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
    expect(app.model.calls[1]!.messages.find((message) => message.type === 'tool')?.text).toContain('CONFIRMATION_REQUIRED');
    expect((await chat(app, 'Pode continuar?')).json().pendingAction).toEqual(previous);
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toBeNull();
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotB)).toBeNull();
  });

  it.each(['erro', 'tool call', 'vazio', 'conteúdo inválido'])('reserva já salva sobrevive à redação %s; retry recupera recibo sem modelo nem nova escrita', async (failure) => {
    const app = await application([async () => {
      expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).not.toBeNull();
      if (failure === 'erro') throw new Error('OPENAI_SECRET');
      if (failure === 'tool call') return call('get_available_slots', { courseId });
      if (failure === 'vazio') return new AIMessage('  ');
      return new AIMessage({ content: [{ type: 'text', text: 'Conteúdo não textual simples' }] });
    }]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const action = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction);
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const response = await confirm(app, action.actionId);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    expect(body.reply).toBe('Aula experimental confirmada na agenda de demonstração.');
    expect(body.results).toEqual([{ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created', booking: await app.trialClassRepository.findConfirmedBySlotId(slotA) } } }]);
    expect((await confirm(app, action.actionId)).json()).toEqual(body);
    expect(reserve).toHaveBeenCalledTimes(1); expect(app.model.calls).toHaveLength(1);
    expect(app.model.contextCalls).toHaveLength(0); expect(app.model.calls[0]!.options.tools).toBeUndefined();
  });

  it('SLOT_UNAVAILABLE é recibo HTTP 200 com fallback e retry histórico', async () => {
    const app = await application([new Error('Falhou redação')]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const action = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction);
    await app.trialClassRepository.reserveSlot({ leadId: 'lead_other', slotId: slotA }, now());
    const response = await confirm(app, action.actionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].result.error.code).toBe('SLOT_UNAVAILABLE');
    expect(response.json().reply).toMatch(/horário.*disponível/i);
    expect((await confirm(app, action.actionId)).json()).toEqual(response.json());
    expect(app.model.calls).toHaveLength(1);
  });

  it('recibo existing também admite fallback sem nova reserva', async () => {
    const app = await application([new Error('Falha')]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const action = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction);
    await app.trialClassRepository.reserveSlot({ leadId: app.lead.id, slotId: slotA }, now());
    const response = await confirm(app, action.actionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].result.data.outcome).toBe('existing');
    expect(response.json().reply).toContain('já está confirmada');
  });

  it('reserva e recibo continuam snapshots após correção pelo chat e atualização confirmada do lead', async () => {
    const updated = { ...data, contact: { type: 'email' as const, value: 'novo@example.com' }, goal: 'entrevistas', courseId: 'course_french_intro' };
    const app = await application([
      new AIMessage('Prosa divergente: não consegui agendar.'),
      call('create_lead', updated), new AIMessage('Revise o novo cadastro.'), new AIMessage('Horário selecionado.'),
    ], [{ ...unchanged, contact: updated.contact, goal: updated.goal, courseReference: 'francês' }, selection('slot_french_a', '11/06 às 11h')]);
    const conversation = current(app); conversation.context.slotId = slotA; app.conversations.save(conversation);
    const action = trialClassPendingActionSchema.parse((await app.prepareTrialClass(conversation.id, { leadId: app.lead.id, slotId: slotA })).pendingAction);
    const receipt = (await confirm(app, action.actionId)).json();
    expect(receipt.results[0].result.data.outcome).toBe('created');
    const snapshot = await app.trialClassRepository.findConfirmedBySlotId(slotA);
    const changed = await chat(app, 'Meu email é novo@example.com. Quero francês para entrevistas.');
    expect(changed.statusCode).toBe(200);
    expect(current(app).context.slotId).toBeNull();
    const leadAction = changed.json().pendingAction;
    expect((await confirm(app, leadAction.actionId)).json().results[0].result.data.outcome).toBe('updated');
    await chat(app, 'Escolho 11/06 às 11h.');
    expect(current(app).context).toMatchObject({ ...updated, slotId: 'slot_french_a' });
    expect(await app.trialClassRepository.findConfirmedBySlotId(slotA)).toEqual(snapshot);
    expect((await confirm(app, action.actionId)).json()).toEqual(receipt);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_french_a')).toBeNull();
  });
});
