import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { createLeadInputSchema, languageSchoolChatResponseSchema, leadPendingActionSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput } from '@supportflow/contracts/language-school';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryPendingActions } from '../src/core/pending-actions.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { languageSchoolInstructions } from '../src/modules/language-school/prompt.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const data = (): CreateLeadInput => ({
  name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
  courseId: 'course_english_travel', goal: 'viagem',
});
const unchanged = { name: null, contact: null, goal: null, courseReference: null };
const completePatch = { name: data().name, contact: data().contact, goal: data().goal, courseReference: data().courseId };
const visitor = 'Quero cadastrar meu interesse. Sou Ana, ana@example.com, course_english_travel para viagem.';
const call = (args: Record<string, unknown> = data(), name = 'create_lead') => new AIMessage({
  content: '', tool_calls: [{ name, args, id: 'call_lead', type: 'tool_call' }],
});

describe('cadastro no chat: proposta local ao turno e confirmação separada', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function application(model: ScriptedChatModel) {
    const leadRepository = new InMemoryLeadRepository();
    const app = createApplication({}, { model, leadRepository });
    servers.push(app.server);
    return { ...app, model, leadRepository };
  }
  const chat = (app: ReturnType<typeof application>, message: string, conversationId?: string) =>
    app.server.inject({ method: 'POST', url: '/api/chat', payload: { message, ...(conversationId ? { conversationId } : {}) } });
  const confirm = (app: ReturnType<typeof application>, conversationId: string, actionId: string) =>
    app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: { conversationId, actionId } });

  it('usa o contexto do mesmo turno, publica a proposta sem escrita e só confirma por IDs', async () => {
    const model = new ScriptedChatModel([
      call(), new AIMessage('Cadastro concluído com sucesso.'),
      call(), new AIMessage('Seus dados já estão cadastrados.'),
    ], { contextSteps: [completePatch] });
    const app = application(model);
    const create = vi.spyOn(app.leadRepository, 'createForConversation');
    const response = await chat(app, visitor);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    const action = leadPendingActionSchema.parse(body.pendingAction);
    expect(action.preview).toEqual(data());
    expect(body.results).toMatchObject([{ tool: 'create_lead', result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED' } } }]);
    expect(await app.leadRepository.findByConversationId(body.conversationId)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(app.conversations.get(body.conversationId)?.context).toMatchObject({ ...data(), revision: 1, leadId: null });
    expect(model.calls[0]?.messages.find((message) => message.name === 'conversation_context')?.text).toContain('"name":"Ana"');
    const forwarded = model.calls[1]?.messages.find((message): message is ToolMessage => ToolMessage.isInstance(message));
    expect(forwarded?.tool_call_id).toBe('call_lead');
    expect(JSON.parse(String(forwarded?.content))).toEqual(body.results[0]);
    expect(model.calls[1]?.options.tools).toBeUndefined();

    const registered = await confirm(app, body.conversationId, action.actionId);
    expect(registered.statusCode).toBe(200);
    const receipt = languageSchoolChatResponseSchema.parse(registered.json());
    const saved = await app.leadRepository.findByConversationId(body.conversationId);
    expect(receipt.results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: saved } } }]);
    expect(receipt.pendingAction).toBeNull();
    expect(model.calls).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await confirm(app, body.conversationId, action.actionId)).json()).toEqual(receipt);
    const repeated = await chat(app, 'Quero cadastrar os mesmos dados.', body.conversationId);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ pendingAction: null, results: [{ tool: 'create_lead', result: {
      ok: true, data: { outcome: 'existing', lead: saved },
    } }] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('registra somente as sete tools e mantém escopo e autorização fora do schema da LLM', async () => {
    const app = application(new ScriptedChatModel([new AIMessage('Qual seu nome e contato?')]));
    const response = await chat(app, 'Quero me cadastrar.');
    expect(response.json()).toMatchObject({ results: [], pendingAction: null });
    const tools = app.model.boundTools;
    expect(tools.map((tool) => 'name' in tool ? tool.name : undefined))
      .toEqual(['get_school_info', 'get_courses', 'get_course_details', 'get_available_slots', 'create_lead', 'schedule_trial_class', 'transfer_to_human']);
    const lead = tools.find((tool) => 'name' in tool && tool.name === 'create_lead');
    expect(lead && 'schema' in lead ? lead.schema : undefined).toBe(createLeadInputSchema);
    for (const extra of ['conversationId', 'context', 'leadId', 'actionId', 'revision', 'confirmed', 'outcome']) {
      expect(createLeadInputSchema.safeParse({ ...data(), [extra]: true }).success).toBe(false);
    }
    expect(await app.leadRepository.findByConversationId(response.json().conversationId)).toBeNull();
    expect(languageSchoolInstructions).toMatch(/se faltar algum dado, peça o complemento/i);
    expect(languageSchoolInstructions).toMatch(/texto como "sim" não confirma/i);
  });

  it.each([{ ...data(), confirmed: true }, { ...data(), conversationId: 'foreign' }, { ...data(), name: 'Maria' }])(
    'rejeita argumentos extras ou divergentes sem propor ação: %j', async (args) => {
      const app = application(new ScriptedChatModel([call(args), new AIMessage('Confira os dados.')], { contextSteps: [completePatch] }));
      const response = await chat(app, visitor);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ pendingAction: null, results: [{ result: { ok: false, error: { code: 'INVALID_INPUT' } } }] });
      expect(await app.leadRepository.findByConversationId(response.json().conversationId)).toBeNull();
    },
  );

  it('Sim e turnos sem correção preservam a ação sem autorizar escrita', async () => {
    const app = application(new ScriptedChatModel([
      call(), new AIMessage('Revise a prévia.'), new AIMessage('Use o botão Confirmar cadastro.'), new AIMessage('Pode revisar os dados.'),
    ], { contextSteps: [completePatch] }));
    const first = (await chat(app, visitor)).json();
    const initialContext = app.conversations.get(first.conversationId)?.context;
    for (const message of ['Sim', 'Pode continuar?']) {
      const response = await chat(app, message, first.conversationId);
      expect(response.statusCode).toBe(200);
      expect(response.json().pendingAction).toEqual(first.pendingAction);
      expect(app.conversations.get(first.conversationId)?.context).toEqual(initialContext);
      expect(await app.leadRepository.findByConversationId(first.conversationId)).toBeNull();
    }
  });

  it('correção troca a prévia, invalida a antiga e grava somente o novo contato após confirmação', async () => {
    const corrected = { ...data(), contact: { type: 'email' as const, value: 'ana.novo@example.com' } };
    const app = application(new ScriptedChatModel([
      call(), new AIMessage('Revise.'), call(corrected), new AIMessage('Revise os dados novos.'),
    ], { contextSteps: [completePatch, { ...unchanged, contact: corrected.contact }] }));
    const first = (await chat(app, visitor)).json();
    const second = await chat(app, 'Meu novo email é ana.novo@example.com.', first.conversationId);
    const current = leadPendingActionSchema.parse(second.json().pendingAction);
    expect(current.actionId).not.toBe(first.pendingAction.actionId);
    expect(current.preview).toEqual(corrected);
    const stale = await confirm(app, first.conversationId, first.pendingAction.actionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ACTION_STALE');
    expect(await app.leadRepository.findByConversationId(first.conversationId)).toBeNull();
    const foreign = app.conversations.create(); app.conversations.save(foreign);
    expect((await confirm(app, foreign.id, current.actionId)).statusCode).toBe(404);
    expect((await confirm(app, first.conversationId, current.actionId)).statusCode).toBe(200);
    expect(await app.leadRepository.findByConversationId(first.conversationId)).toEqual({ id: expect.any(String), ...corrected });
  });

  it.each([false, true])('falha da redação descarta a proposta e preserva todo o turno anterior (ação anterior: %s)', async (withPrevious) => {
    const corrected = { ...data(), contact: { type: 'email' as const, value: 'ana.novo@example.com' } };
    const model = new ScriptedChatModel([
      call(corrected), new Error('Falha interna secreta.'), new AIMessage('A prévia atual está disponível.'),
    ], { contextSteps: [{ ...unchanged, contact: corrected.contact }] });
    const app = application(model);
    const conversation = app.conversations.create();
    conversation.context = { ...conversation.context, ...data(), revision: 1 };
    app.conversations.save(conversation);
    const previous = withPrevious ? await app.prepareAction(conversation.id, { kind: 'create_lead', preview: data() }) : null;
    const before = app.conversations.get(conversation.id);
    const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
    const invalidate = vi.spyOn(InMemoryPendingActions.prototype, 'invalidateCurrent');
    const response = await chat(app, 'Meu novo email é ana.novo@example.com.', conversation.id);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('CHAT_ERROR');
    expect(response.body).not.toContain('secreta');
    expect(model.calls[1]?.messages.find((message) => message.type === 'tool')?.text).toContain('CONFIRMATION_REQUIRED');
    expect(stage).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(app.conversations.get(conversation.id)).toEqual(before);
    expect(await app.leadRepository.findByConversationId(conversation.id)).toBeNull();
    // Leitura pelo próximo turno prova que não há proposta órfã nem invalidação.
    const next = await chat(app, 'Pode continuar?', conversation.id);
    expect(next.json().pendingAction).toEqual(previous);
    if (previous) expect((await confirm(app, conversation.id, previous.actionId)).statusCode).toBe(200);
  });

  it('valida a resposta pública antes do commit do rascunho e preserva a ação anterior', async () => {
    const app = application(new ScriptedChatModel([call(), new AIMessage(''), new AIMessage('Revise.') ]));
    const conversation = app.conversations.create();
    conversation.context = { ...conversation.context, ...data(), revision: 1 };
    app.conversations.save(conversation);
    const previous = await app.prepareAction(conversation.id, { kind: 'create_lead', preview: data() });
    const before = app.conversations.get(conversation.id);
    const stage = vi.spyOn(InMemoryPendingActions.prototype, 'stage');
    const response = await chat(app, 'Quero prosseguir.', conversation.id);
    expect(response.statusCode).toBe(500);
    expect(app.conversations.get(conversation.id)).toEqual(before);
    expect(stage).toHaveBeenCalledTimes(1);
    const discarded = stage.mock.results[0]!.value as { preview: { actionId: string } };
    expect((await confirm(app, conversation.id, discarded.preview.actionId)).statusCode).toBe(404);
    expect((await chat(app, 'Pode continuar?', conversation.id)).json().pendingAction).toEqual(previous);
  });

  it('existing seguido de falha não retira uma prévia anterior nem modifica o lead', async () => {
    const app = application(new ScriptedChatModel([call(), new Error('Redação falhou.'), new AIMessage('Revise.') ]));
    const conversation = app.conversations.create();
    const saved = await app.leadRepository.createForConversation(conversation.id, data());
    conversation.context = { ...conversation.context, ...data(), leadId: saved!.id, revision: 1 };
    app.conversations.save(conversation);
    const previous = await app.prepareAction(conversation.id, { kind: 'create_lead', preview: data() });
    const before = app.conversations.get(conversation.id);
    const response = await chat(app, 'Meus dados já estão cadastrados?', conversation.id);
    expect(response.statusCode).toBe(500);
    expect(app.model.calls[1]?.messages.find((message) => message.type === 'tool')?.text).toContain('existing');
    expect(app.conversations.get(conversation.id)).toEqual(before);
    expect(await app.leadRepository.findByConversationId(conversation.id)).toEqual(saved);
    expect((await chat(app, 'Pode continuar?', conversation.id)).json().pendingAction).toEqual(previous);
  });
});
