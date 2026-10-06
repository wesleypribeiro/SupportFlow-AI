import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { chatErrorResponseSchema } from '@supportflow/contracts/chat';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { createApplication } from '../src/app.js';
import { conversationContextSchema } from '../src/modules/language-school/domain/conversation-context.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';
import { createJourneyModel, leadTurn, query } from './helpers/journey-script.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';

const unchanged = { goal: null, name: null, contact: null, courseReference: null };

function contextAt(model: ScriptedChatModel, callIndex: number) {
  const message = model.calls[callIndex]?.messages.find(
    (item) => item instanceof SystemMessage && item.name === 'conversation_context',
  );
  expect(message).toBeDefined();
  if (typeof message?.content !== 'string') throw new Error('Contexto estruturado ausente no teste.');
  const serialized = message.content.split('\n').at(-1);
  return conversationContextSchema.parse(JSON.parse(serialized ?? 'null'));
}

function visitorHistoryAt(model: ScriptedChatModel, callIndex: number) {
  return model.calls[callIndex]?.messages
    .filter((message) => message instanceof HumanMessage)
    .map((message) => message.content);
}

describe('contexto atual do chat escolar', () => {
  const servers: FastifyInstance[] = [];
  const fetch = vi.fn(() => { throw new Error('Rede externa proibida nos testes de contexto.'); });

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(fetch).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function application(model: ScriptedChatModel) {
    const app = createApplication({}, { model });
    servers.push(app.server);
    return app;
  }

  function post(server: FastifyInstance, message: string, conversationId?: string) {
    return server.inject({
      method: 'POST', url: '/api/chat',
      payload: conversationId === undefined ? { message } : { message, conversationId },
    });
  }

  it('consulta catálogo e preços oficiais com goal inferido, sem CHAT_ERROR ou revisão inventada', async () => {
    const active = courseFixtures.filter((course) => course.active);
    const model = createJourneyModel([
      query('get_courses', {}, { goal: 'viagem' }),
      ...active.map((course) => query('get_course_details', { courseId: course.id },
        { goal: 'viagem' }, new AIMessage('Todos custam R$ 999.'))),
    ]);
    const app = application(model);
    const catalogResponse = await post(app.server, 'Quais cursos vocês oferecem?');
    expect(catalogResponse.statusCode).toBe(200);
    const catalog = languageSchoolChatResponseSchema.parse(catalogResponse.json());
    const repository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
    expect(catalog.results).toEqual([{ tool: 'get_courses', result: { ok: true, data: { courses: await repository.listActiveCourses() } } }]);
    for (const course of active) {
      const response = await post(app.server, `Qual é o preço de ${course.name}?`, catalog.conversationId);
      expect(response.statusCode).toBe(200);
      const body = languageSchoolChatResponseSchema.parse(response.json());
      expect(body.results).toEqual([{ tool: 'get_course_details', result: { ok: true, data: { course } } }]);
      expect(body.pendingAction).toBeNull();
    }
    expect(app.conversations.get(catalog.conversationId)?.context).toEqual({
      goal: null, name: null, contact: null, courseId: null, slotId: null, leadId: null, revision: 0,
    });
  });

  it('goal inferido não entra na prévia; cadastro só grava após confirmação específica', async () => {
    const leadRepository = new InMemoryLeadRepository();
    const model = createJourneyModel([leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' },
      courseReference: 'inglês', goal: 'viagem' })]);
    const app = createApplication({}, { model, leadRepository }); servers.push(app.server);
    const response = await post(app.server, 'Sou Ana, ana@example.com. Quero inglês e me cadastrar.');
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    expect(body.results).toMatchObject([{ tool: 'create_lead', result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED' } } }]);
    expect(body.pendingAction).toMatchObject({ kind: 'create_lead', preview: { goal: null, name: 'Ana' } });
    expect(await leadRepository.findByConversationId(body.conversationId)).toBeNull();
    const confirmation = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: {
      conversationId: body.conversationId, actionId: body.pendingAction!.actionId,
    } });
    expect(confirmation.statusCode).toBe(200);
    expect(languageSchoolChatResponseSchema.parse(confirmation.json()).results).toMatchObject([
      { tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: { goal: null } } } },
    ]);
    expect(await leadRepository.findByConversationId(body.conversationId)).toMatchObject({ goal: null, name: 'Ana' });
  });

  it('inicia contexto vazio e mantém os campos internos fora do envelope público', async () => {
    const model = new ScriptedChatModel([new AIMessage('Olá!')]);
    const app = application(model);
    const response = await post(app.server, 'Olá');

    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    expect(Object.keys(body).sort()).toEqual(['conversationId', 'pendingAction', 'reply', 'results']);
    expect(body.pendingAction).toBeNull();
    expect(app.config.llm).toBeNull();
    expect(contextAt(model, 0)).toEqual({
      goal: null, name: null, contact: null, courseId: null,
      slotId: null, leadId: null, revision: 0,
    });
    expect(model.contextCalls).toHaveLength(1);
  });

  it('substitui viagem por entrevistas antes da próxima decisão e preserva o histórico', async () => {
    const model = new ScriptedChatModel([
      new AIMessage('Podemos conversar sobre o curso de inglês.'),
      new AIMessage('Vamos considerar seu objetivo de entrevistas de emprego.'),
    ], { contextSteps: [
      { ...unchanged, goal: 'viagem', courseReference: 'inglês' },
      { ...unchanged, goal: 'entrevistas de emprego' },
    ] });
    const { server } = application(model);
    const initialMessage = 'Quero inglês para viagem.';
    const correction = 'Na verdade, quero principalmente para entrevistas de emprego.';
    const initial = await post(server, initialMessage);
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const next = await post(server, correction, conversationId);

    expect(next.statusCode).toBe(200);
    expect(contextAt(model, 0)).toMatchObject({
      goal: 'viagem', courseId: 'course_english_travel', revision: 1,
    });
    expect(contextAt(model, 1)).toEqual({
      goal: 'entrevistas de emprego', name: null, contact: null,
      courseId: 'course_english_travel', slotId: null, leadId: null, revision: 2,
    });
    expect(visitorHistoryAt(model, 1)).toEqual([initialMessage, correction]);
    expect(languageSchoolChatResponseSchema.parse(next.json()).pendingAction).toBeNull();
  });

  it('preserva nome, contato e curso e não incrementa revisão para os mesmos dados', async () => {
    const contact = { type: 'email' as const, value: 'lia@example.com' };
    const provided = { goal: 'viagem', name: 'Lia Exemplo', contact, courseReference: 'inglês' };
    const model = new ScriptedChatModel([
      new AIMessage('Entendi seu interesse.'),
      new AIMessage('Continuamos com os mesmos dados.'),
      new AIMessage('Seu objetivo atual é entrevistas de emprego.'),
    ], { contextSteps: [provided, provided, { ...unchanged, goal: 'entrevistas de emprego' }] });
    const { server } = application(model);
    const message = 'Meu nome é Lia Exemplo, meu e-mail é lia@example.com e quero inglês para viagem.';
    const first = await post(server, message);
    const { conversationId } = languageSchoolChatResponseSchema.parse(first.json());
    const repeated = await post(server, message, conversationId);
    const changed = await post(server, 'Agora o objetivo é entrevistas de emprego.', conversationId);

    expect(repeated.statusCode).toBe(200);
    expect(changed.statusCode).toBe(200);
    expect(contextAt(model, 1)).toEqual(contextAt(model, 0));
    expect(contextAt(model, 2)).toEqual({
      goal: 'entrevistas de emprego', name: 'Lia Exemplo', contact,
      courseId: 'course_english_travel', slotId: null, leadId: null, revision: 2,
    });
  });

  it('retorna 200 ao repetir objetivo e nome vigentes depois de "Pode continuar?", sem nova revisão', async () => {
    const provided = { ...unchanged, goal: 'viagem', name: 'Ana' };
    const model = new ScriptedChatModel([
      new AIMessage('Entendi, Ana.'), new AIMessage('Podemos continuar.'),
      new AIMessage('Qual idioma deseja aprender?'),
    ], { contextSteps: [provided, { ...provided }, unchanged] });
    const { server } = application(model);
    const initialMessage = 'Meu nome é Ana. Quero estudar para viagem.';
    const initial = await post(server, initialMessage);
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const repeated = await post(server, 'Pode continuar?', conversationId);
    const next = await post(server, 'Sim.', conversationId);

    expect(repeated.statusCode).toBe(200);
    expect(languageSchoolChatResponseSchema.parse(repeated.json())).toMatchObject({
      conversationId, reply: 'Podemos continuar.', results: [], pendingAction: null,
    });
    expect(next.statusCode).toBe(200);
    expect(contextAt(model, 0)).toMatchObject({ goal: 'viagem', name: 'Ana', revision: 1 });
    expect(contextAt(model, 1)).toEqual(contextAt(model, 0));
    expect(contextAt(model, 2)).toEqual(contextAt(model, 0));
    expect(visitorHistoryAt(model, 2)).toEqual([initialMessage, 'Pode continuar?', 'Sim.']);
    expect(model.calls[2]?.messages.filter((message) => message.type !== 'system').map((message) => message.content))
      .toEqual([initialMessage, 'Entendi, Ana.', 'Pode continuar?', 'Podemos continuar.', 'Sim.']);
  });

  it('aceita objetivo repetido junto de nome novo e persiste somente uma nova revisão', async () => {
    const model = new ScriptedChatModel([
      new AIMessage('Entendi o objetivo.'), new AIMessage('Entendi, Ana.'), new AIMessage('Vamos continuar.'),
    ], { contextSteps: [
      { ...unchanged, goal: 'viagem' },
      { ...unchanged, goal: 'viagem', name: 'Ana' },
      unchanged,
    ] });
    const { server } = application(model);
    const initial = await post(server, 'Quero estudar para viagem.');
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const updated = await post(server, 'Meu nome é Ana.', conversationId);
    const next = await post(server, 'Pode continuar?', conversationId);

    expect(updated.statusCode).toBe(200);
    expect(next.statusCode).toBe(200);
    expect(contextAt(model, 0)).toMatchObject({ goal: 'viagem', name: null, revision: 1 });
    expect(contextAt(model, 1)).toEqual({ ...contextAt(model, 0), name: 'Ana', revision: 2 });
    expect(contextAt(model, 2)).toEqual(contextAt(model, 1));
    expect(visitorHistoryAt(model, 2)).toEqual([
      'Quero estudar para viagem.', 'Meu nome é Ana.', 'Pode continuar?',
    ]);
  });

  it.each([
    { label: 'formato inválido', contact: { type: 'email', value: 'inválido' } },
    { label: 'valor inventado', contact: { type: 'email', value: 'inventado@example.com' } },
  ])('não salva nome, revisão ou histórico de patch misto com contato de $label', async ({ contact }) => {
    const model = new ScriptedChatModel([
      new AIMessage('Entendi o objetivo.'), new AIMessage('Podemos continuar.'),
    ], { contextSteps: [
      { ...unchanged, goal: 'viagem' },
      { ...unchanged, goal: 'viagem', name: 'Ana', contact },
      unchanged,
    ] });
    const { server } = application(model);
    const initialMessage = 'Quero estudar para viagem.';
    const initial = await post(server, initialMessage);
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const failure = await post(server, 'Meu nome é Ana.', conversationId);
    const retry = await post(server, 'Pode continuar?', conversationId);

    expect(failure.statusCode).toBe(500);
    expect(chatErrorResponseSchema.parse(failure.json()).error.code).toBe('CHAT_ERROR');
    expect(retry.statusCode).toBe(200);
    expect(contextAt(model, 1)).toEqual(contextAt(model, 0));
    expect(contextAt(model, 1)).toMatchObject({ goal: 'viagem', name: null, contact: null, revision: 1 });
    expect(model.calls).toHaveLength(2);
    expect(model.contextCalls).toHaveLength(3);
    expect(model.calls[1]?.messages.filter((message) => message.type !== 'system').map((message) => message.content))
      .toEqual([initialMessage, 'Entendi o objetivo.', 'Pode continuar?']);
    expect(model.contextCalls[2]?.messages.filter((message) => message.type === 'human').map((message) => message.content))
      .toEqual([initialMessage, 'Pode continuar?']);
  });

  it('mantém contextos independentes ao intercalar duas conversas', async () => {
    const model = new ScriptedChatModel([
      new AIMessage('Resposta para Lia.'),
      new AIMessage('Resposta para Bia.'),
      new AIMessage('Continuamos com o interesse da Lia.'),
    ], { contextSteps: [
      { ...unchanged, name: 'Lia', goal: 'viagem', courseReference: 'inglês' },
      { ...unchanged, name: 'Bia', goal: 'trabalho', courseReference: 'espanhol' },
      unchanged,
    ] });
    const { server } = application(model);
    const first = await post(server, 'Sou Lia. Quero inglês para viagem.');
    const second = await post(server, 'Sou Bia. Quero espanhol para trabalho.');
    const initial = languageSchoolChatResponseSchema.parse(first.json());
    const other = languageSchoolChatResponseSchema.parse(second.json());
    const continued = await post(server, 'Vamos continuar.', initial.conversationId);

    expect(continued.statusCode).toBe(200);
    expect(other.conversationId).not.toBe(initial.conversationId);
    expect(contextAt(model, 1)).toMatchObject({
      name: 'Bia', goal: 'trabalho', courseId: 'course_spanish_conversation', revision: 1,
    });
    expect(contextAt(model, 2)).toEqual(contextAt(model, 0));
    expect(visitorHistoryAt(model, 2)).toEqual(['Sou Lia. Quero inglês para viagem.', 'Vamos continuar.']);
  });

  it.each([
    { reference: 'course_english_travel', message: 'Quero course_english_travel.', courseId: 'course_english_travel' },
    { reference: 'CONVERSAÇÃO EM ESPANHOL', message: 'Quero CONVERSAÇÃO EM ESPANHOL.', courseId: 'course_spanish_conversation' },
    { reference: 'francês', message: 'Quero francês.', courseId: 'course_french_intro' },
  ])('resolve referência única de curso ativo: $reference', async ({ reference, message, courseId }) => {
    const model = new ScriptedChatModel([new AIMessage('Curso identificado no catálogo.')], {
      contextSteps: [{ ...unchanged, courseReference: reference }],
    });
    const { server } = application(model);
    const response = await post(server, message);

    expect(response.statusCode).toBe(200);
    expect(contextAt(model, 0)).toMatchObject({ courseId, revision: 1 });
  });

  it.each([
    { reference: 'course_invented', message: 'Quero course_invented.' },
    { reference: 'course_german_foundations', message: 'Quero course_german_foundations.' },
    { reference: 'espanhol', message: 'Podemos continuar?' },
    { reference: 'francês', message: 'Quero inglês ou francês.' },
  ])('não substitui curso por referência desconhecida, inativa ou sem escolha válida: $reference', async ({ reference, message }) => {
    const model = new ScriptedChatModel([
      new AIMessage('Seu interesse atual é inglês.'),
      new AIMessage('Pode esclarecer qual curso deseja?'),
    ], { contextSteps: [
      { ...unchanged, courseReference: 'inglês' },
      { ...unchanged, courseReference: reference },
    ] });
    const { server } = application(model);
    const initial = await post(server, 'Quero inglês.');
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const next = await post(server, message, conversationId);

    expect(next.statusCode).toBe(200);
    expect(contextAt(model, 1)).toEqual(contextAt(model, 0));
    expect(contextAt(model, 1)).toMatchObject({ courseId: 'course_english_travel', revision: 1 });
  });

  it.each([
    { label: 'erro de interpretação', patch: new Error('INTERNAL_ONLY: falha privada da extração') },
    { label: 'objetivo com tipo incorreto', patch: { ...unchanged, goal: 123 } },
    { label: 'nome sem fonte na mensagem atual', patch: { ...unchanged, goal: 'entrevistas de emprego', name: 'Nome Inventado' } },
    { label: 'contato inválido junto de objetivo válido', patch: {
      ...unchanged, goal: 'entrevistas de emprego', contact: { type: 'email', value: 'email-invalido' },
    } },
    { label: 'slot controlado pelo backend', patch: { ...unchanged, slotId: 'slot_invented' } },
    { label: 'lead controlado pelo backend', patch: { ...unchanged, leadId: 'lead_invented' } },
    { label: 'revisão controlada pelo backend', patch: { ...unchanged, revision: 99 } },
    { label: 'preço fora do contexto permitido', patch: { ...unchanged, price: 100 } },
    { label: 'campo obrigatório ausente', patch: { goal: null, name: null, contact: null } },
  ])('rejeita $label sem persistir contexto parcial ou histórico', async ({ patch }) => {
    const model = new ScriptedChatModel([
      new AIMessage('Entendi o objetivo inicial.'),
      new AIMessage('Podemos continuar a conversa.'),
    ], { contextSteps: [{ ...unchanged, goal: 'viagem' }, patch, unchanged] });
    const { server } = application(model);
    const initial = await post(server, 'Quero estudar para viagem.');
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const failure = await post(server, 'Quero entrevistas de emprego.', conversationId);
    const retry = await post(server, 'Podemos continuar?', conversationId);

    expect(failure.statusCode).toBe(500);
    expect(chatErrorResponseSchema.parse(failure.json()).error.code).toBe('CHAT_ERROR');
    expect(failure.body).not.toContain('INTERNAL_ONLY');
    expect(retry.statusCode).toBe(200);
    expect(model.contextCalls).toHaveLength(3);
    expect(model.calls).toHaveLength(2);
    expect(contextAt(model, 1)).toEqual(contextAt(model, 0));
    expect(visitorHistoryAt(model, 1)).toEqual(['Quero estudar para viagem.', 'Podemos continuar?']);
  });

  it('não aceita como nome do visitante um nome inventado em resposta anterior do modelo', async () => {
    const model = new ScriptedChatModel([
      new AIMessage('Seu nome é Nome Inventado.'),
      new AIMessage('Pode informar seu nome?'),
    ], { contextSteps: [unchanged, { ...unchanged, name: 'Nome Inventado' }, unchanged] });
    const { server } = application(model);
    const initial = await post(server, 'Olá');
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const failure = await post(server, 'Qual é meu nome?', conversationId);
    const retry = await post(server, 'Podemos continuar?', conversationId);

    expect(failure.statusCode).toBe(500);
    expect(retry.statusCode).toBe(200);
    expect(contextAt(model, 1)).toMatchObject({ name: null, revision: 0 });
    expect(visitorHistoryAt(model, 1)).toEqual(['Olá', 'Podemos continuar?']);
  });

  it('descarta objetivo antigo do histórico depois de uma correção, sem abortar o turno', async () => {
    const model = new ScriptedChatModel([
      new AIMessage('Entendi o interesse inicial.'),
      new AIMessage('Agora consideramos entrevistas de emprego.'),
      new AIMessage('Continuamos com entrevistas de emprego.'),
      new AIMessage('Podemos seguir.'),
    ], { contextSteps: [
      { ...unchanged, goal: 'viagem' },
      { ...unchanged, goal: 'entrevistas de emprego' },
      { ...unchanged, goal: 'viagem' },
      unchanged,
    ] });
    const { server } = application(model);
    const initial = await post(server, 'Quero estudar para viagem.');
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const correction = await post(server, 'Agora prefiro entrevistas de emprego.', conversationId);
    const continued = await post(server, 'Pode continuar?', conversationId);
    const next = await post(server, 'Podemos seguir?', conversationId);

    expect(correction.statusCode).toBe(200);
    expect(continued.statusCode).toBe(200);
    expect(next.statusCode).toBe(200);
    expect(contextAt(model, 1)).toMatchObject({ goal: 'entrevistas de emprego', revision: 2 });
    expect(contextAt(model, 2)).toEqual(contextAt(model, 1));
    expect(contextAt(model, 3)).toEqual(contextAt(model, 1));
    expect(visitorHistoryAt(model, 3)).toEqual([
      'Quero estudar para viagem.', 'Agora prefiro entrevistas de emprego.', 'Pode continuar?', 'Podemos seguir?',
    ]);
  });

  it.each([
    { label: 'falha do modelo', final: new Error('INTERNAL_ONLY: redação indisponível') },
    { label: 'resposta pública inválida', final: new AIMessage('') },
  ])('não grava atualização se o turno terminar com $label', async ({ final }) => {
    const model = new ScriptedChatModel([
      new AIMessage('Entendi o interesse inicial.'),
      new AIMessage({ content: '', tool_calls: [{
        name: 'get_courses', args: {}, id: 'call_context_catalog', type: 'tool_call',
      }] }),
      final,
      new AIMessage('Podemos continuar.'),
    ], { contextSteps: [
      { ...unchanged, goal: 'viagem' },
      { ...unchanged, goal: 'entrevistas de emprego' },
      unchanged,
    ] });
    const { server } = application(model);
    const initial = await post(server, 'Quero estudar para viagem.');
    const { conversationId } = languageSchoolChatResponseSchema.parse(initial.json());
    const failure = await post(server, 'Quero entrevistas de emprego.', conversationId);
    const retry = await post(server, 'Vamos continuar.', conversationId);

    expect(failure.statusCode).toBe(500);
    expect(chatErrorResponseSchema.parse(failure.json()).error.code).toBe('CHAT_ERROR');
    expect(retry.statusCode).toBe(200);
    expect(contextAt(model, 1)).toMatchObject({ goal: 'entrevistas de emprego', revision: 2 });
    expect(contextAt(model, 2)).toEqual(contextAt(model, 1));
    expect(contextAt(model, 3)).toEqual(contextAt(model, 0));
    expect(visitorHistoryAt(model, 3)).toEqual(['Quero estudar para viagem.', 'Vamos continuar.']);
  });

  it.each([
    { context: { goal: 'objetivo imposto pelo navegador' } },
    { courseId: 'course_english_travel' },
    { revision: 99 },
  ])('rejeita campos internos do navegador antes de interpretar a mensagem: %j', async (extra) => {
    const model = new ScriptedChatModel([]);
    const { server } = application(model);
    const response = await server.inject({
      method: 'POST', url: '/api/chat', payload: { message: 'Olá', ...extra },
    });

    expect(response.statusCode).toBe(400);
    expect(chatErrorResponseSchema.parse(response.json()).error.code).toBe('INVALID_REQUEST');
    expect(model.contextCalls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });
});
