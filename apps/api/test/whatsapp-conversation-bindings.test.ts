import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { chatRequestSchema } from '@supportflow/contracts/chat';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import type { WhatsAppConversationIdentity } from '../src/channels/whatsapp/conversation-bindings.js';
import type { WhatsAppEvent } from '../src/channels/whatsapp/events.js';
import { projectMetaWebhook } from '../src/channels/whatsapp/meta/webhook-projection.js';
import type { ConversationServiceResult } from '../src/core/conversation-service.js';
import { createConversationContext } from '../src/modules/language-school/domain/conversation-context.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { createJourneyModel, dialogue, leadTurn, modelContext, type JourneyScript } from './helpers/journey-script.js';
import { metaChange, metaEnvelope, metaOrigin, metaText } from './helpers/meta-webhook.js';

const identity: WhatsAppConversationIdentity = {
  provider: 'meta', accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: 'demo-recipient',
};
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET',
  META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN', META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  META_GRAPH_API_VERSION: 'v26.0', WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient,other-recipient',
};
const leadPatch = { name: 'Ana', contact: { type: 'phone' as const, value: '5511999990000' }, courseReference: 'inglês', goal: 'viagem' };
const registrationMessage = 'Meu nome é Ana, contato 5511999990000. Quero inglês para viagem e me cadastrar.';

function success<T>(result: ConversationServiceResult<T>): T {
  assert(result.ok);
  return result.response;
}
function confirmation(response: LanguageSchoolChatResponse) {
  assert(response.pendingAction);
  return { conversationId: response.conversationId, actionId: response.pendingAction.actionId };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function textEvent(messageId: string, text: string): Extract<WhatsAppEvent, { type: 'text' }> {
  return { ...identity, type: 'text', messageId, text, occurredAt: Date.parse('2030-06-10T12:00:00Z') };
}

describe('3.1 — vínculo WhatsApp em memória', () => {
  const cleanups: (() => Promise<void>)[] = [];
  const network = vi.fn(() => { throw new Error('Rede externa proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', network);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
    vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((close) => close()));
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  function application(script: JourneyScript = []) {
    const model = createJourneyModel(script);
    const leadRepository = new InMemoryLeadRepository();
    const app = createApplication(environment, { model, leadRepository, now: () => new Date('2030-06-10T12:00:00Z') });
    cleanups.push(() => app.server.close());
    assert(app.whatsappBindings);
    return { ...app, bindings: app.whatsappBindings, model, leadRepository };
  }
  type App = ReturnType<typeof application>;
  // Exercita vínculo + serviço real diretamente. Não implementa inbox/dispatcher
  // nem conecta o webhook ao motor antes das tasks próprias.
  async function send(app: App, event: Extract<WhatsAppEvent, { type: 'text' }>) {
    const binding = success(await app.bindings.getOrCreate(event));
    return app.conversationService.sendMessage(chatRequestSchema.parse({ conversationId: binding.conversationId, message: event.text }));
  }

  it('compõe vínculos somente quando habilitado; lookup desconhecido não abre conversa', async () => {
    const disabled = createApplication({});
    cleanups.push(() => disabled.server.close());
    expect(disabled.whatsappBindings).toBeUndefined();
    const app = application();
    const create = vi.spyOn(app.conversations, 'create');
    const open = vi.spyOn(app.conversationService, 'openConversation');
    expect(app.bindings.get(identity)).toBeUndefined();
    expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    const binding = success(await app.bindings.getOrCreate(identity));
    expect(binding.identity).toEqual(identity);
    expect(binding.conversationId).toBe(create.mock.results[0]!.value.id);
    expect(app.conversations.get(binding.conversationId)).toEqual({ id: binding.conversationId, history: [], context: createConversationContext() });
    expect(app.bindings.get(identity)).toEqual(binding);
    expect(success(await app.bindings.getOrCreate({ ...identity }))).toEqual(binding);
    expect(open).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce();
    expect(await app.leadRepository.findByConversationId(binding.conversationId)).toBeNull();
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
  });

  it('duas primeiras mensagens concorrentes usam uma conversa e a fila existente, em ordem', async () => {
    const entered = gate(); const release = gate();
    const app = application([
      dialogue(async () => { entered.release(); await release.promise; return new AIMessage('Primeira resposta.'); }, { goal: 'viagem' }),
      dialogue((messages) => {
        expect(modelContext(messages).goal).toBe('viagem');
        expect(messages.some((message) => message.text === 'Primeira resposta.')).toBe(true);
        return new AIMessage('Segunda resposta.');
      }),
    ]);
    const open = vi.spyOn(app.conversationService, 'openConversation');
    const create = vi.spyOn(app.conversations, 'create');
    const lock = vi.spyOn(app.conversations, 'runExclusive');
    const first = send(app, textEvent('first', 'Quero estudar para viagem.'));
    const second = send(app, textEvent('second', 'Pode continuar?'));
    try {
      await entered.promise;
      expect(open).toHaveBeenCalledOnce(); expect(create).toHaveBeenCalledOnce();
      expect(lock).toHaveBeenCalledTimes(3); // Abertura + dois turnos; sem lock aninhado.
      expect(app.model.calls).toHaveLength(1); expect(app.model.contextCalls).toHaveLength(1);
      const binding = app.bindings.get(identity)!;
      expect(app.conversations.get(binding.conversationId)?.history).toEqual([]);
    } finally { release.release(); }
    const responses = (await Promise.all([first, second])).map(success);
    const id = responses[0]!.conversationId;
    expect(responses[1]!.conversationId).toBe(id);
    expect(app.bindings.get(identity)?.conversationId).toBe(id);
    expect(app.conversations.get(id)?.history.map((message) => message.text)).toEqual([
      'Quero estudar para viagem.', 'Primeira resposta.', 'Pode continuar?', 'Segunda resposta.',
    ]);
    expect(app.conversations.get(id)?.context).toEqual({ ...createConversationContext(), goal: 'viagem', revision: 1 });
  });

  it('isola cópias de entrada, aberturas concorrentes, criação repetida e leitura', async () => {
    const app = application();
    const input = { ...identity, profile: { name: 'Não guardar' }, conversationId: 'external-id' };
    const first = app.bindings.getOrCreate(input);
    const second = app.bindings.getOrCreate({ ...identity });
    input.senderId = 'changed'; input.accountId = 'changed'; input.phoneNumberId = 'changed';
    input.profile.name = 'Changed';
    const [left, right] = (await Promise.all([first, second])).map(success);
    assert(left && right);
    const original = structuredClone(right);
    expect(left).toEqual(right); expect(left).not.toBe(right); expect(left.identity).not.toBe(right.identity);
    expect(left).toEqual({ identity, conversationId: expect.any(String) });
    expect(left.conversationId).not.toBe('external-id');
    left.identity.senderId = 'changed'; left.conversationId = 'changed';
    expect(right).toEqual(original); expect(app.bindings.get(identity)).toEqual(original);
    const read = app.bindings.get(identity)!;
    read.identity.accountId = 'changed'; read.conversationId = 'changed';
    const repeated = success(await app.bindings.getOrCreate(identity));
    repeated.identity.phoneNumberId = 'changed'; repeated.conversationId = 'changed';
    expect(app.bindings.get(identity)).toEqual(original);
    expect(app.bindings.get(input)).toBeUndefined();
  });

  it.each(['accountId', 'phoneNumberId', 'senderId'] as const)('isola a conversa quando muda %s', async (field) => {
    const app = application();
    const other = { ...identity, [field]: `other-${field}` };
    const [first, second] = (await Promise.all([app.bindings.getOrCreate(identity), app.bindings.getOrCreate(other)])).map(success);
    assert(first && second);
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(app.bindings.get(identity)).toEqual(first); expect(app.bindings.get(other)).toEqual(second);
  });

  it('preserva IDs opacos, zeros, caixa, espaços e delimitadores sem colisões entre tuplas', async () => {
    const app = application();
    const identities: WhatsAppConversationIdentity[] = [
      { ...identity, accountId: 'a:b', phoneNumberId: 'c' },
      { ...identity, accountId: 'a', phoneNumberId: 'b:c' },
      ...['00090071992547409931234', '90071992547409931234', ' Sender ', 'Sender', 'sender', '["a","b"]'].map((senderId) => ({ ...identity, senderId })),
    ];
    const bindings = (await Promise.all(identities.map((input) => app.bindings.getOrCreate(input)))).map(success);
    expect(new Set(bindings.map((binding) => binding.conversationId)).size).toBe(identities.length);
    expect(bindings.map((binding) => binding.identity)).toEqual(identities);
    identities.forEach((input, index) => expect(app.bindings.get(input)).toEqual(bindings[index]));
  });

  it('abertura lenta não bloqueia outro remetente e só publica o vínculo depois de salvar a conversa', async () => {
    const entered = gate(); const release = gate();
    const app = application();
    const open = app.conversationService.openConversation;
    vi.spyOn(app.conversationService, 'openConversation').mockImplementationOnce(async () => {
      entered.release(); await release.promise; return open();
    });
    const first = app.bindings.getOrCreate(identity);
    try {
      await entered.promise;
      expect(app.bindings.get(identity)).toBeUndefined();
      const otherIdentity = { ...identity, senderId: 'other-recipient' };
      const other = success(await app.bindings.getOrCreate(otherIdentity));
      expect(app.bindings.get(otherIdentity)).toEqual(other);
      expect(app.conversations.get(other.conversationId)?.history).toEqual([]);
      expect(app.bindings.get(identity)).toBeUndefined();
    } finally { release.release(); }
    const binding = success(await first);
    expect(app.bindings.get(identity)).toEqual(binding);
    expect(app.conversations.get(binding.conversationId)?.context).toEqual(createConversationContext());
  });

  it.each(['save', 'rejection'] as const)('falha de abertura (%s) é sanitizada e não deixa vínculo; nova tentativa é possível', async (failure) => {
    const app = application();
    const open = vi.spyOn(app.conversationService, 'openConversation');
    if (failure === 'save') vi.spyOn(app.conversations, 'save').mockImplementationOnce(() => { throw new Error('PRIVATE_FAILURE'); });
    else open.mockRejectedValueOnce(new Error('PRIVATE_FAILURE'));
    const results = await Promise.all([app.bindings.getOrCreate(identity), app.bindings.getOrCreate(identity)]);
    expect(results).toEqual([{ ok: false, code: 'CHAT_ERROR' }, { ok: false, code: 'CHAT_ERROR' }]);
    expect(open).toHaveBeenCalledOnce(); expect(app.bindings.get(identity)).toBeUndefined();
    const binding = success(await app.bindings.getOrCreate(identity));
    expect(app.bindings.get(identity)).toEqual(binding);
    expect(app.conversations.get(binding.conversationId)?.context).toEqual(createConversationContext());
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('falha do primeiro turno preserva o vínculo vazio e a mensagem seguinte usa a mesma conversa', async () => {
    const app = application([dialogue(new Error('PRIVATE_FAILURE'), { goal: 'viagem' }), dialogue()]);
    const create = vi.spyOn(app.conversations, 'create');
    expect(await send(app, textEvent('first', 'Quero estudar para viagem.'))).toEqual({ ok: false, code: 'CHAT_ERROR' });
    const binding = app.bindings.get(identity)!;
    expect(app.conversations.get(binding.conversationId)).toEqual({ id: binding.conversationId, history: [], context: createConversationContext() });
    expect(success(await send(app, textEvent('second', 'Olá!'))).conversationId).toBe(binding.conversationId);
    expect(create).toHaveBeenCalledOnce();
    expect(app.conversations.get(binding.conversationId)?.history.filter((message) => message.type === 'human').map((message) => message.text)).toEqual(['Olá!']);
  });

  it('perfil, telefone, contatos e context.from não preenchem cadastro nem escolhem identidade ou sessão', async () => {
    const app = application([dialogue()]);
    const input = metaEnvelope([metaChange({
      contacts: [{ wa_id: 'another-recipient', profile: { name: 'PROFILE_NAME' } }],
      metadata: { phone_number_id: metaOrigin.phoneNumberId, display_phone_number: '5511999991111' },
      messages: [metaText({ from: leadPatch.contact.value, conversationId: 'external-id',
        context: { id: 'previous-message', from: 'context-not-sender' }, text: { body: 'Olá!' } })],
    })]);
    const projected = projectMetaWebhook(input, metaOrigin);
    assert(projected.status === 200);
    const event = projected.events[0]; assert(event?.type === 'text');
    const response = success(await send(app, event));
    expect(app.bindings.get({ ...identity, senderId: leadPatch.contact.value })?.conversationId).toBe(response.conversationId);
    for (const senderId of ['another-recipient', 'context-not-sender']) expect(app.bindings.get({ ...identity, senderId })).toBeUndefined();
    expect(response.conversationId).not.toBe('external-id'); expect(response.pendingAction).toBeNull();
    expect(response.results).toEqual([]);
    expect(app.conversations.get(response.conversationId)?.context).toEqual(createConversationContext());
    expect(await app.leadRepository.findByConversationId(response.conversationId)).toBeNull();
    const prompts = JSON.stringify([...app.model.calls, ...app.model.contextCalls]);
    for (const metadata of ['PROFILE_NAME', leadPatch.contact.value, '5511999991111', 'another-recipient', 'context-not-sender', 'external-id']) {
      expect(prompts).not.toContain(metadata);
    }
  });

  it('remetentes com o mesmo contato comercial têm contextos, leads, ações e recibos separados', async () => {
    const app = application([leadTurn(leadPatch), leadTurn({ ...leadPatch, name: 'Bruno' })]);
    const first = success(await send(app, textEvent('first', registrationMessage)));
    const second = success(await send(app, { ...textEvent('second', registrationMessage.replace('Ana', 'Bruno')), senderId: 'other-recipient' }));
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(first.pendingAction?.actionId).not.toBe(second.pendingAction?.actionId);
    expect(await app.conversationService.confirmAction({ ...confirmation(first), conversationId: second.conversationId }))
      .toEqual({ ok: false, code: 'NOT_FOUND' });
    const firstReceipt = success(await app.conversationService.confirmAction(confirmation(first)));
    expect(await app.leadRepository.findByConversationId(second.conversationId)).toBeNull();
    expect(success(await app.conversationService.getCurrentPendingAction({ conversationId: second.conversationId })).pendingAction).toEqual(second.pendingAction);
    const secondReceipt = success(await app.conversationService.confirmAction(confirmation(second)));
    const firstLead = await app.leadRepository.findByConversationId(first.conversationId);
    const secondLead = await app.leadRepository.findByConversationId(second.conversationId);
    assert(firstLead && secondLead);
    expect(firstLead.id).not.toBe(secondLead.id); expect(firstLead.contact).toEqual(secondLead.contact);
    expect(firstLead.name).toBe('Ana'); expect(secondLead.name).toBe('Bruno');
    expect(app.conversations.get(first.conversationId)?.context.leadId).toBe(firstLead.id);
    expect(app.conversations.get(second.conversationId)?.context.leadId).toBe(secondLead.id);
    expect(firstReceipt.results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: firstLead } } }]);
    expect(secondReceipt.results).toEqual([{ tool: 'create_lead', result: { ok: true, data: { outcome: 'created', lead: secondLead } } }]);
    expect(success(await app.conversationService.confirmAction(confirmation(first)))).toEqual(firstReceipt);
    expect(success(await app.conversationService.confirmAction(confirmation(second)))).toEqual(secondReceipt);
  });

  it('não associa sessão web com o mesmo telefone nem aceita seu conversationId vindo do provider', async () => {
    const app = application([leadTurn(leadPatch), dialogue(), leadTurn(leadPatch)]);
    const web = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { message: registrationMessage } });
    expect(web.statusCode).toBe(200);
    const webProposal = languageSchoolChatResponseSchema.parse(web.json());
    const confirmed = await app.server.inject({ method: 'POST', url: '/api/chat/confirm', payload: confirmation(webProposal) });
    expect(confirmed.statusCode).toBe(200);
    const webBefore = app.conversations.get(webProposal.conversationId);
    const webLead = await app.leadRepository.findByConversationId(webProposal.conversationId); assert(webLead);
    const projected = projectMetaWebhook(metaEnvelope([metaChange({
      conversationId: webProposal.conversationId,
      contacts: [{ wa_id: leadPatch.contact.value, profile: { name: leadPatch.name } }],
      messages: [metaText({ from: leadPatch.contact.value, conversationId: webProposal.conversationId, text: { body: 'Olá!' } })],
    })]), metaOrigin);
    assert(projected.status === 200);
    const event = projected.events[0]; assert(event?.type === 'text');
    const whatsapp = success(await send(app, event));
    expect(whatsapp.conversationId).not.toBe(webProposal.conversationId);
    expect(app.conversations.get(whatsapp.conversationId)?.context).toEqual(createConversationContext());
    expect(await app.leadRepository.findByConversationId(whatsapp.conversationId)).toBeNull();
    expect(await app.conversationService.confirmAction({ ...confirmation(webProposal), conversationId: whatsapp.conversationId }))
      .toEqual({ ok: false, code: 'NOT_FOUND' });
    const whatsappProposal = success(await send(app, { ...event, messageId: 'registration', text: registrationMessage }));
    success(await app.conversationService.confirmAction(confirmation(whatsappProposal)));
    const whatsappLead = await app.leadRepository.findByConversationId(whatsapp.conversationId); assert(whatsappLead);
    expect(whatsappLead.contact).toEqual(webLead.contact); expect(whatsappLead.id).not.toBe(webLead.id);
    expect(app.conversations.get(webProposal.conversationId)).toEqual(webBefore);
    expect(await app.leadRepository.findByConversationId(webProposal.conversationId)).toEqual(webLead);
    expect(success(await app.conversationService.confirmAction(confirmation(webProposal)))).toEqual(confirmed.json());
  });
});
