import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { languageSchoolChatResponseSchema, transferToHumanInputSchema } from '@supportflow/contracts/language-school';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { handoffOffer } from '../src/modules/language-school/domain/handoff-intent.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { ScriptedChatModel } from './helpers/scripted-chat-model.js';

const reason = 'Prefiro falar com uma pessoa.';
const visitor = 'Não quero me cadastrar agora. Prefiro falar com uma pessoa.';
const leadData = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseId: 'course_english_travel', goal: 'viagem' };
const now = () => new Date('2030-06-10T12:00:00Z');
const call = (args: Record<string, unknown> = { reason }) => new AIMessage({ content: '', tool_calls: [{ name: 'transfer_to_human', args, id: 'call_handoff', type: 'tool_call' }] });
const narration = () => new AIMessage('Um atendente assumiu sua conversa. Nossa equipe já recebeu sua solicitação. Protocolo inventado.');

describe('handoff no chat: intenção, efeito local e recuperação de redação', () => {
  const servers: FastifyInstance[] = [];
  const network = vi.fn(() => { throw new Error('Rede proibida.'); });
  beforeEach(() => { vi.stubGlobal('fetch', network); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false'); });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function application(steps: ConstructorParameters<typeof ScriptedChatModel>[0], contextSteps: unknown[] = []) {
    const model = new ScriptedChatModel(steps, { contextSteps });
    const handoffRepository = new InMemoryHandoffRepository();
    const leadRepository = new InMemoryLeadRepository();
    const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
    const app = createApplication({}, { model, handoffRepository, leadRepository, trialClassRepository, now });
    servers.push(app.server);
    return { ...app, model, handoffRepository, leadRepository, trialClassRepository };
  }
  type App = ReturnType<typeof application>;
  const chat = (app: App, message = visitor, conversationId?: string) => app.server.inject({ method: 'POST', url: '/api/chat', payload: { message, ...(conversationId ? { conversationId } : {}) } });
  function existingConversation(app: App) { const conversation = app.conversations.create(); app.conversations.save(conversation); return conversation; }

  it('sete tools; reason é o único argumento; pedido sem lead publica registro oficial e ToolMessage associado', async () => {
    const app = application([call(), narration()]);
    const response = await chat(app);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    const request = await app.handoffRepository.findOpenByConversationId(body.conversationId);
    expect(body.results).toEqual([{ tool: 'transfer_to_human', result: { ok: true, data: { request } } }]);
    expect(request).toEqual({ id: expect.any(String), reason, status: 'requested' });
    expect(body.reply).toContain(request!.id);
    expect(body.reply).toContain('não inicia atendimento ao vivo nem envia notificações externas');
    expect(body.reply).not.toMatch(/assumiu|já recebeu|inventado/);
    expect(body.pendingAction).toBeNull();
    expect(await app.leadRepository.findByConversationId(body.conversationId)).toBeNull();
    expect(app.conversations.get(body.conversationId)?.context).toEqual({ name: null, contact: null, goal: null, courseId: null, slotId: null, leadId: null, revision: 0 });
    expect(app.conversations.get(body.conversationId)?.history.at(-1)?.text).toBe(body.reply);
    expect(app.model.boundTools.map((tool) => 'name' in tool ? tool.name : undefined)).toEqual([
      'get_school_info', 'get_courses', 'get_course_details', 'get_available_slots', 'create_lead', 'schedule_trial_class', 'transfer_to_human',
    ]);
    const registered = app.model.boundTools.find((tool) => 'name' in tool && tool.name === 'transfer_to_human');
    expect(registered && 'schema' in registered ? registered.schema : null).toBe(transferToHumanInputSchema);
    expect(Object.keys(transferToHumanInputSchema.shape)).toEqual(['reason']);
    const forwarded = app.model.calls[1]!.messages.find((message): message is ToolMessage => ToolMessage.isInstance(message));
    expect(forwarded?.tool_call_id).toBe('call_handoff');
    expect(JSON.parse(String(forwarded?.content))).toEqual(body.results[0]);
    expect(app.model.calls[1]!.options.tools).toBeUndefined();
  });

  it('oferta real seguida de aceitação registra; nenhum dado comercial é exigido', async () => {
    const app = application([new AIMessage(handoffOffer), call({ reason: 'Aceitou a oferta de atendimento humano.' }), narration()]);
    const offer = (await chat(app, 'Estou com uma dúvida.')).json();
    expect(await app.handoffRepository.findOpenByConversationId(offer.conversationId)).toBeNull();
    const accepted = await chat(app, 'Sim, por favor.', offer.conversationId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().results[0].result.ok).toBe(true);
    expect(await app.leadRepository.findByConversationId(offer.conversationId)).toBeNull();
  });

  it.each([null, 'Deseja confirmar o cadastro?', 'Confirma sua aula?', 'Sua solicitação já foi registrada.'])(
    'Sim sem oferta válida (%s) não autoriza tool call', async (previous) => {
      const app = application([call(), narration()]);
      const conversation = existingConversation(app);
      if (previous) { conversation.history.push(new AIMessage(previous)); app.conversations.save(conversation); }
      const response = await chat(app, 'Sim', conversation.id);
      expect(response.statusCode).toBe(200);
      expect(response.json().results[0].result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(response.json().reply).not.toContain('assumiu');
      expect(await app.handoffRepository.findOpenByConversationId(conversation.id)).toBeNull();
    },
  );

  it('não usa oferta da própria seleção, de tool, de outra conversa ou de turno ultrapassado', async () => {
    const offeredCall = call(); offeredCall.content = handoffOffer;
    const app = application([offeredCall, narration(), call(), narration(), call(), narration()]);
    const a = existingConversation(app); a.history.push(new AIMessage(handoffOffer)); app.conversations.save(a);
    const b = existingConversation(app);
    b.history.push(new ToolMessage({ content: handoffOffer, tool_call_id: 'old_call' })); app.conversations.save(b);
    expect((await chat(app, 'Sim', b.id)).json().results[0].result.ok).toBe(false);
    a.history.push(new AIMessage('Qual curso você prefere?')); app.conversations.save(a);
    expect((await chat(app, 'Sim', a.id)).json().results[0].result.ok).toBe(false);
    expect((await chat(app, 'Quero conhecer a escola.', a.id)).json().results[0].result.ok).toBe(false);
    expect(await app.handoffRepository.findOpenByConversationId(a.id)).toBeNull();
    expect(await app.handoffRepository.findOpenByConversationId(b.id)).toBeNull();
  });

  it.each(['conversationId', 'leadId', 'status', 'protocolId', 'visitorIntent', 'confirmed'])(
    'rejeita argumento extra %s mesmo com pedido válido', async (key) => {
      const app = application([call({ reason, [key]: 'forged' }), narration()]);
      const write = vi.spyOn(app.handoffRepository, 'requestForConversation');
      const response = await chat(app);
      expect(response.json().results[0].result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it('repetição conserva protocolo e motivo; outra conversa recebe seu próprio registro', async () => {
    const app = application([call(), narration(), call({ reason: 'Outro assunto' }), narration(), call(), narration()]);
    const first = (await chat(app)).json();
    const second = (await chat(app, 'Preciso falar com um atendente sobre outro assunto.', first.conversationId)).json();
    const other = (await chat(app)).json();
    expect(second.results).toEqual(first.results);
    expect(second.results[0].result.data.request.reason).toBe(reason);
    expect(other.results[0].result.data.request.id).not.toBe(first.results[0].result.data.request.id);
  });

  it.each(['create_lead', 'schedule_trial_class'] as const)('pedido com lead preserva prévia %s, revisão e reservas', async (kind) => {
    const app = application([call(), narration()]);
    const conversation = existingConversation(app);
    const lead = (await app.leadRepository.createForConversation(conversation.id, leadData))!;
    conversation.context = { ...conversation.context, ...leadData, leadId: lead.id, slotId: 'slot_english_a', revision: 3 };
    app.conversations.save(conversation);
    const pending = kind === 'create_lead'
      ? await app.prepareAction(conversation.id, { kind, preview: leadData })
      : (await app.prepareTrialClass(conversation.id, { leadId: lead.id, slotId: 'slot_english_a' })).pendingAction;
    const reserve = vi.spyOn(app.trialClassRepository, 'reserveSlot');
    const update = vi.spyOn(app.leadRepository, 'updateForConversation');
    const response = await chat(app, 'Antes disso, quero falar com uma pessoa.', conversation.id);
    expect(response.json().pendingAction).toEqual(pending);
    expect(app.conversations.get(conversation.id)?.context).toEqual(conversation.context);
    expect(await app.leadRepository.findByConversationId(conversation.id)).toEqual(lead);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    expect(reserve).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it.each([
    new Error('PRIVATE_MODEL_ERROR'), new AIMessage('   '),
    new AIMessage({ content: [{ type: 'image_url', image_url: { url: 'invalid' } }] }), call(),
    new AIMessage({ content: '', invalid_tool_calls: [{ name: 'other', args: 'bad', error: 'private' }] }),
  ])('resultado gravado sobrevive à redação inválida/falha (%#), salva histórico e permite repetir', async (final) => {
    const app = application([call(), final, call({ reason: 'Novo motivo' }), narration()]);
    const response = await chat(app);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    const saved = await app.handoffRepository.findOpenByConversationId(body.conversationId);
    expect(body.results).toEqual([{ tool: 'transfer_to_human', result: { ok: true, data: { request: saved } } }]);
    expect(body.reply).toBe(`Sua solicitação de atendimento humano foi registrada nesta demonstração. Protocolo: ${saved!.id}. Isso não inicia atendimento ao vivo nem envia notificações externas.`);
    const history = app.conversations.get(body.conversationId)!.history;
    expect(history).toHaveLength(4); expect(history[0]?.text).toBe(visitor); expect(history.at(-1)?.text).toBe(body.reply);
    expect((await chat(app, 'Quero falar com alguém.', body.conversationId)).json().results).toEqual(body.results);
    expect(await app.handoffRepository.findOpenByConversationId(body.conversationId)).toEqual(saved);
    expect(app.model.calls).toHaveLength(4);
  });

  it('o registro validado já existe antes da redação e mutação da prosa/artifact não modifica results', async () => {
    const app = application([call(), async (messages) => {
      const forwarded = messages.find((message): message is ToolMessage => ToolMessage.isInstance(message))!;
      const official = JSON.parse(String(forwarded.content)).result.data.request;
      const id = app.model.calls[0]!.messages.find((message) => message.type === 'human')?.text;
      expect(id).toBe(visitor);
      expect(written).toEqual(official);
      forwarded.artifact.result.data.request.id = 'invented';
      return narration();
    }]);
    let written: unknown;
    const original = app.handoffRepository.requestForConversation.bind(app.handoffRepository);
    vi.spyOn(app.handoffRepository, 'requestForConversation').mockImplementation(async (...args) => { written = await original(...args); return structuredClone(written) as Awaited<ReturnType<typeof original>>; });
    const body = (await chat(app)).json();
    expect(body.results[0].result.data.request).toEqual(written);
    expect(body.reply).not.toContain('invented');
  });

  it.each(['exception', 'invalid_output'])('falha técnica %s retorna OPERATION_FAILED sem protocolo nem falsa prosa de sucesso', async (failure) => {
    const app = application([call(), narration()]);
    if (failure === 'exception') vi.spyOn(app.handoffRepository, 'requestForConversation').mockRejectedValueOnce(new Error('SECRET'));
    else vi.spyOn(app.handoffRepository, 'requestForConversation').mockResolvedValueOnce({ id: 'fake', reason, status: 'assigned' } as never);
    const response = await chat(app);
    expect(response.statusCode).toBe(200);
    const body = languageSchoolChatResponseSchema.parse(response.json());
    expect(body.results[0]?.result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(body.reply).toBe('Não foi possível registrar a solicitação de atendimento humano. Tente novamente.');
    expect(JSON.stringify(body)).not.toMatch(/SECRET|fake|assumiu/);
    expect(await app.handoffRepository.findOpenByConversationId(body.conversationId)).toBeNull();
  });

  it('não aplica recuperação de escrita quando a operação e a redação falham', async () => {
    const app = application([call(), new Error('PRIVATE')]);
    const conversation = existingConversation(app);
    vi.spyOn(app.handoffRepository, 'requestForConversation').mockRejectedValueOnce(new Error('PRIVATE'));
    const response = await chat(app, visitor, conversation.id);
    expect(response.statusCode).toBe(500); expect(response.json().error.code).toBe('CHAT_ERROR');
    expect(app.conversations.get(conversation.id)).toEqual(conversation);
    expect(await app.handoffRepository.findOpenByConversationId(conversation.id)).toBeNull();
  });

  it('falha na interpretação anterior à escrita mantém atomicidade', async () => {
    const app = application([], [new Error('PRIVATE_CONTEXT')]);
    const conversation = existingConversation(app);
    const write = vi.spyOn(app.handoffRepository, 'requestForConversation');
    expect((await chat(app, visitor, conversation.id)).statusCode).toBe(500);
    expect(write).not.toHaveBeenCalled(); expect(app.conversations.get(conversation.id)).toEqual(conversation);
  });

  it('solicitação mantém reserva concluída e Sim sem oferta não confirma a prévia atual', async () => {
    const app = application([call(), narration(), call(), narration()]);
    const conversation = existingConversation(app);
    const lead = (await app.leadRepository.createForConversation(conversation.id, leadData))!;
    conversation.context = { ...conversation.context, ...leadData, leadId: lead.id, revision: 2 };
    app.conversations.save(conversation);
    const reserved = await app.trialClassRepository.reserveSlot({ slotId: 'slot_english_a', leadId: lead.id }, now());
    expect(reserved.outcome).toBe('created');
    const before = await app.trialClassRepository.findConfirmedBySlotId('slot_english_a');
    const pending = await app.prepareAction(conversation.id, { kind: 'create_lead', preview: leadData });
    const first = await chat(app, visitor, conversation.id);
    expect(first.statusCode).toBe(200);
    expect(first.json().pendingAction).toEqual(pending);
    const second = await chat(app, 'Sim', conversation.id);
    expect(second.json().results[0].result.error.code).toBe('INVALID_INPUT');
    expect(second.json().pendingAction).toEqual(pending);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toEqual(before);
    expect(app.conversations.get(conversation.id)?.context).toEqual(conversation.context);
  });

  it('recuperação após escrita salva uma alteração legítima de contexto junto do histórico concluído', async () => {
    const patch = { goal: 'entrevistas', name: null, contact: null, courseReference: null, slotReference: null };
    const app = application([call(), new Error('PRIVATE')], [patch]);
    const conversation = existingConversation(app); conversation.context.goal = 'viagem'; app.conversations.save(conversation);
    const response = await chat(app, 'Agora meu objetivo é entrevistas. Quero falar com alguém.', conversation.id);
    expect(response.statusCode).toBe(200);
    expect(app.conversations.get(conversation.id)?.context).toMatchObject({ goal: 'entrevistas', revision: 1 });
    expect(app.conversations.get(conversation.id)?.history.at(-1)?.text).toBe(response.json().reply);
    expect(response.json().results[0].result.data.request).toEqual(await app.handoffRepository.findOpenByConversationId(conversation.id));
  });

  it('recupera handoff mas não commita nova proposta de cadastro se a redação falha', async () => {
    const selection = call(); selection.tool_calls!.unshift({ name: 'create_lead', args: leadData, id: 'lead_call', type: 'tool_call' });
    const app = application([selection, new Error('PRIVATE')]);
    const conversation = existingConversation(app);
    conversation.context = { ...conversation.context, ...leadData, revision: 2 }; app.conversations.save(conversation);
    const previous = await app.prepareAction(conversation.id, { kind: 'create_lead', preview: leadData });
    const response = await chat(app, visitor, conversation.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingAction).toEqual(previous);
    expect(response.json().results).toHaveLength(2);
    expect(app.conversations.get(conversation.id)?.context).toEqual(conversation.context);
    expect(await app.leadRepository.findByConversationId(conversation.id)).toBeNull();
  });
});
