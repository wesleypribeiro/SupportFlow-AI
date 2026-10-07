import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { chatRequestSchema } from '@supportflow/contracts/chat';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { InMemoryWhatsAppInbox } from '../src/channels/whatsapp/inbox.js';
import type { WhatsAppInboundMessage, WhatsAppInboxProcessor } from '../src/channels/whatsapp/inbox.js';
import { registerMetaWebhookRoutes } from '../src/channels/whatsapp/meta/webhook-route.js';
import type { WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { createJourneyModel, dialogue, leadTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const credentials = { ...metaOrigin, appSecret: 'FAKE_APP_SECRET', webhookVerifyToken: 'FAKE_VERIFY_TOKEN' };
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: credentials.appSecret,
  META_WEBHOOK_VERIFY_TOKEN: credentials.webhookVerifyToken, META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  META_GRAPH_API_VERSION: 'v26.0', WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient,other-recipient',
};
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: 'demo-recipient' };
const key = (messageId: string) => ({ ...identity, messageId });
type App = ReturnType<typeof createApplication>;
type Processor = (event: WhatsAppInboundMessage, app: App) => ReturnType<WhatsAppInboxProcessor<LanguageSchoolChatResponse>>;
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
function post(server: FastifyInstance, messages: unknown[], statuses: unknown[] = []) {
  return postEnvelope(server, metaEnvelope([metaChange({ messages, statuses })]));
}
function postEnvelope(server: FastifyInstance, envelope: unknown, signature?: string) {
  const payload = Buffer.from(JSON.stringify(envelope));
  return server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
    'content-type': 'application/json',
    'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', credentials.appSecret).update(payload).digest('hex')}`,
  } });
}
// Composição exclusiva de teste para isolar a ordem da inbox sobre o motor real.
// O processador textual padrão tem sua própria suíte; referências ficam nas 5.x.
const processText: Processor = async (event, app) => {
  assert(event.type === 'text'); assert(app.whatsappBindings);
  const binding = await app.whatsappBindings.getOrCreate(event);
  if (!binding.ok) return binding;
  return app.conversationService.sendMessage(chatRequestSchema.parse({
    conversationId: binding.response.conversationId, message: event.text,
  }));
};
function application(script: JourneyScript = [], processor: Processor = processText) {
  let clock = Date.parse('2030-06-10T11:59:58Z');
  const model = createJourneyModel(script);
  const leadRepository = new InMemoryLeadRepository();
  const process = vi.fn<WhatsAppInboxProcessor<LanguageSchoolChatResponse>>((event) => processor(event, app));
  const app = createApplication(environment, { model, leadRepository, whatsappProcessor: process,
    whatsappTransport: { send: async () => ({ status: 'accepted', messageId: 'response' }) },
    now: () => new Date('2030-06-10T12:00:00Z'),
    // A segunda mensagem do teste de ordenação tem timestamp anterior à primeira,
    // mas ambas pertencem à execução corrente (política de reinício da task 3.3).
    whatsappNow: () => new Date(clock),
  });
  clock = Date.parse('2030-06-10T12:00:00Z'); // Ambas já ocorreram ao serem admitidas.
  assert(app.whatsappInbox); assert(app.whatsappBindings);
  const inbox = app.whatsappInbox;
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  return { ...app, inbox, bindings: app.whatsappBindings, model, process, leadRepository };
}

describe('3.2 — webhook assinado, ACK e processamento gerenciado', () => {
  const network = vi.fn(() => { throw new Error('Rede externa proibida.'); });
  beforeEach(() => {
    vi.stubGlobal('fetch', network);
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
  });
  afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await Promise.all(cleanups.splice(0).map((close) => close()));
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it('ACK com received precede o modelo; duplicatas concorrentes/em curso/concluídas têm um único turno e envio inicial', async () => {
    const entered = gate(); const release = gate(); const sending = gate(); const sent = gate();
    const transport: WhatsAppTransport = { send: vi.fn(async () => {
      sending.release(); await sent.promise;
      return { status: 'accepted' as const, messageId: 'outbound' };
    }) };
    const app = application([dialogue(async () => {
      entered.release(); await release.promise; return new AIMessage('Resposta única.');
    })], async (event, current) => {
      const result = await processText(event, current);
      if (result.ok) await transport.send({ recipientId: event.senderId, message: { type: 'text', body: result.response.reply } });
      return result;
    });
    const statesAtAck: unknown[] = [];
    app.server.addHook('onResponse', async () => {
      statesAtAck.push(app.inbox.get(key('message-text'))?.state);
    });
    const ack = await post(app.server, [metaText()]);
    expect(ack.statusCode).toBe(200); expect(ack.body).toBe('');
    expect(statesAtAck).toEqual(['received']);
    expect(app.model.calls).toHaveLength(0); expect(app.model.contextCalls).toHaveLength(0);
    expect(transport.send).not.toHaveBeenCalled();
    await entered.promise;
    const acks = await Promise.all([post(app.server, [metaText()]), post(app.server, [metaText()])]);
    expect(acks.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(app.inbox.get(key('message-text'))?.state).toBe('processing');
    release.release(); await sending.promise;
    expect((await post(app.server, [metaText()])).statusCode).toBe(200);
    sent.release(); await app.inbox.drain();
    const completed = app.inbox.get(key('message-text'))!;
    expect(completed.state).toBe('processed');
    expect((await post(app.server, [metaText()])).statusCode).toBe(200);
    await app.inbox.drain();
    expect(app.inbox.get(key('message-text'))).toEqual(completed);
    expect(app.process).toHaveBeenCalledOnce(); expect(transport.send).toHaveBeenCalledOnce();
    expect(app.model.calls).toHaveLength(1); expect(app.model.contextCalls).toHaveLength(1);
    const binding = app.bindings.get(identity)!;
    expect(app.conversations.get(binding.conversationId)?.history.map((message) => message.text)).toEqual(['Olá 👋', 'Resposta única.']);
    expect(app.inbox.activeQueueCount).toBe(0);
  });

  it('duas primeiras admissões da mesma identidade usam um vínculo e ordem de admissão, não timestamp', async () => {
    const entered = gate(); const release = gate();
    const app = application([dialogue(async () => {
      entered.release(); await release.promise; return new AIMessage('Primeira.');
    }), dialogue(new AIMessage('Segunda.'))]);
    const open = vi.spyOn(app.conversationService, 'openConversation');
    const lock = vi.spyOn(app.conversations, 'runExclusive');
    const responses = await Promise.all([
      post(app.server, [metaText({ id: 'first', text: { body: 'Primeiro texto' } })]),
      post(app.server, [metaText({ id: 'second', timestamp: '1907323199', text: { body: 'Segundo texto' } })]),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    await entered.promise;
    expect(app.inbox.get(key('second'))?.state).toBe('received');
    expect(app.model.calls).toHaveLength(1);
    release.release(); await app.inbox.drain();
    expect(open).toHaveBeenCalledOnce(); expect(lock).toHaveBeenCalledTimes(3);
    const binding = app.bindings.get(identity)!;
    expect(app.conversations.get(binding.conversationId)?.history.map((message) => message.text))
      .toEqual(['Primeiro texto', 'Primeira.', 'Segundo texto', 'Segunda.']);
    expect(app.inbox.activeQueueCount).toBe(0);
  });

  it('correção admitida enquanto um turno está bloqueado precede clique e impede escrita obsoleta', async () => {
    const entered = gate(); const release = gate();
    let actionId = ''; let conversationId = '';
    const app = application([
      leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' }),
      dialogue(async () => { entered.release(); await release.promise; return new AIMessage('Continuando.'); }),
      dialogue(new AIMessage('Contato corrigido.'), { contact: { type: 'email', value: 'ana.novo@example.com' } }),
    ], (event, current) => event.type === 'text' ? processText(event, current)
      // IDs oficiais obtidos abaixo, sem resolver reference, título ou args do
      // webhook. Testa somente a ordem da fila antes da futura resolução 5.x.
      : current.conversationService.confirmAction({ conversationId, actionId }));
    await post(app.server, [metaText({ id: 'proposal', text: { body: 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.' } })]);
    await app.inbox.drain();
    const proposal = app.inbox.get(key('proposal')); assert(proposal?.state === 'processed');
    assert(proposal.response.pendingAction);
    actionId = proposal.response.pendingAction.actionId; conversationId = proposal.response.conversationId;
    const revision = app.conversations.get(conversationId)!.context.revision;
    await post(app.server, [metaText({ id: 'slow', text: { body: 'Pode continuar?' } })]);
    await entered.promise;
    expect((await post(app.server, [
      metaText({ id: 'correction', text: { body: 'Meu email correto é ana.novo@example.com.' } }),
      metaButton({ id: 'click' }),
    ])).statusCode).toBe(200);
    expect(app.inbox.get(key('correction'))?.state).toBe('received');
    expect(app.inbox.get(key('click'))?.state).toBe('received');
    const confirm = vi.spyOn(app.conversationService, 'confirmAction');
    release.release(); await app.inbox.drain();
    expect(app.inbox.get(key('click'))).toMatchObject({ state: 'failed', code: 'ACTION_STALE' });
    expect(app.conversations.get(conversationId)?.context).toMatchObject({ revision: revision + 1, contact: { type: 'email', value: 'ana.novo@example.com' } });
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ conversationId, actionId });
    expect((await post(app.server, [metaButton({ id: 'click' })])).statusCode).toBe(200);
    await app.inbox.drain(); expect(confirm).toHaveBeenCalledOnce();
    expect(app.model.contextCalls).toHaveLength(3);
    expect(app.inbox.activeQueueCount).toBe(0);
  });

  it('conversa B conclui no motor real enquanto A aguarda o modelo', async () => {
    const entered = gate(); const release = gate();
    const app = application([dialogue(async () => {
      entered.release(); await release.promise; return new AIMessage('Resposta A.');
    }), dialogue(new AIMessage('Resposta B.'))]);
    await post(app.server, [metaText({ id: 'a' })]); await entered.promise;
    const other = { ...identity, senderId: 'other-recipient' };
    expect((await post(app.server, [metaText({ id: 'b', from: other.senderId })])).statusCode).toBe(200);
    await app.inbox.drain(other);
    expect(app.inbox.get(key('a'))?.state).toBe('processing');
    expect(app.inbox.get(key('b'))?.state).toBe('processed');
    const a = app.bindings.get(identity)!; const b = app.bindings.get(other)!;
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(app.conversations.get(a.conversationId)?.history).toEqual([]);
    expect(app.conversations.get(b.conversationId)?.history.at(-1)?.text).toBe('Resposta B.');
    release.release(); await app.inbox.drain();
  });

  it('falha na redação de proposta preserva contexto/ação e libera a próxima mensagem sem reexecutar a falha', async () => {
    const app = application([
      leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' }),
      { ...leadTurn({ contact: { type: 'email', value: 'ana.novo@example.com' } }),
        responses: [...leadTurn().responses.slice(0, 1), new Error('PRIVATE_MODEL_FAILURE')] },
      dialogue(new AIMessage('Continuando após falha.')),
    ]);
    await post(app.server, [metaText({ id: 'proposal', text: { body: 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.' } })]);
    await app.inbox.drain();
    const proposal = app.inbox.get(key('proposal')); assert(proposal?.state === 'processed');
    const conversationId = proposal.response.conversationId;
    const before = app.conversations.get(conversationId)!;
    const failedMessage = metaText({ id: 'failure', text: { body: 'Meu email correto é ana.novo@example.com. Cadastre com esse contato.' } });
    await post(app.server, [failedMessage]); await app.inbox.drain();
    expect(app.inbox.get(key('failure'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(app.conversations.get(conversationId)).toEqual(before);
    expect(await app.conversationService.getCurrentPendingAction({ conversationId })).toEqual({ ok: true, response: { pendingAction: proposal.response.pendingAction } });
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    await post(app.server, [failedMessage, metaText({ id: 'next', text: { body: 'Pode continuar?' } })]);
    await app.inbox.drain();
    expect(app.inbox.get(key('next'))?.state).toBe('processed');
    expect(app.process).toHaveBeenCalledTimes(3);
    expect(app.conversations.get(conversationId)?.history.filter((message) => message.type === 'human').map((message) => message.text))
      .toEqual(['Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.', 'Pode continuar?']);
    expect(app.inbox.activeQueueCount).toBe(0);
  });

  it('lote heterogêneo admite cada mensagem uma vez; status/mídia/malformado não viram turnos', async () => {
    const app = application([dialogue(), dialogue()]);
    const response = await postEnvelope(app.server, metaEnvelope([
      metaChange({ messages: [metaText({ id: 'one' }), metaText({ id: 'one' }), metaText({ timestamp: 'bad' })] }),
      metaChange({ messages: [metaText({ id: 'two' }), metaText({ type: 'image', image: { id: 'media' } })], statuses: [metaStatus()] }),
    ]));
    expect(response.statusCode).toBe(200); await app.inbox.drain();
    expect(app.process.mock.calls.map(([event]) => event.messageId)).toEqual(['one', 'two']);
    expect(app.inbox.get(key('outbound-message'))).toBeUndefined();
    expect(app.model.contextCalls).toHaveLength(2);
  });

  it('assinatura ou origem inválida no fim do lote não admite eventos parciais', async () => {
    const app = application();
    const envelope = metaEnvelope([metaChange({ messages: [metaText()] })]);
    expect((await postEnvelope(app.server, envelope, 'sha256=bad')).statusCode).toBe(403);
    expect((await postEnvelope(app.server, metaEnvelope([
      metaChange({ messages: [metaText()] }), metaChange({ metadata: { phone_number_id: 'foreign' } }),
    ]))).statusCode).toBe(403);
    await app.inbox.drain();
    expect(app.inbox.get(key('message-text'))).toBeUndefined(); expect(app.process).not.toHaveBeenCalled();
  });

  it('colisão retorna 409 sanitizado e não substitui original; irmãos válidos continuam deduplicáveis', async () => {
    const lines: string[] = [];
    const server = Fastify({ logger: { stream: { write: (line) => { lines.push(line); } } } });
    const process = vi.fn<WhatsAppInboxProcessor<string>>(() => Promise.reject(new Error('PRIVATE_REJECTION_STACK')));
    const inbox = new InMemoryWhatsAppInbox(process, { now: () => new Date('2030-06-10T12:00:00Z') });
    registerMetaWebhookRoutes(server, credentials, inbox);
    cleanups.push(async () => { await inbox.drain(); await server.close(); });
    const message = metaText({ id: 'PRIVATE_ID', from: 'PRIVATE_SENDER', text: { body: 'PRIVATE_BODY' } });
    await post(server, [message]); await inbox.drain();
    const original = inbox.get(key('PRIVATE_ID'));
    const collision = await post(server, [
      { ...message, from: 'PRIVATE_OTHER_SENDER' }, { ...message, text: { body: 'PRIVATE_OTHER_BODY' } },
      metaText({ id: 'sibling' }),
    ]);
    expect(collision.statusCode).toBe(409); expect(collision.body).toBe('');
    await inbox.drain();
    expect(inbox.get(key('PRIVATE_ID'))).toEqual(original);
    expect(process).toHaveBeenCalledTimes(2);
    expect((await post(server, [message, metaText({ id: 'sibling' })])).statusCode).toBe(200);
    await inbox.drain(); expect(process).toHaveBeenCalledTimes(2);
    expect(lines.join('')).toContain('WHATSAPP_INBOX_COLLISION');
    expect(lines.join('')).not.toContain('PRIVATE');
    expect(inbox.activeQueueCount).toBe(0);
  });

  it('falha de admissão retorna 503 vazio e conserva IDs já admitidos para a reentrega', async () => {
    const server = Fastify(); const inbox = new InMemoryWhatsAppInbox(undefined, { now: () => new Date('2030-06-10T12:00:00Z') });
    const admit = vi.fn((event: WhatsAppInboundMessage) => inbox.admit(event));
    admit.mockImplementationOnce((event) => inbox.admit(event)).mockImplementationOnce(() => { throw new Error('PRIVATE_ADMISSION'); });
    registerMetaWebhookRoutes(server, credentials, { admit });
    cleanups.push(async () => { await inbox.drain(); await server.close(); });
    const messages = [metaText({ id: 'one' }), metaText({ id: 'two' })];
    const response = await post(server, messages);
    expect(response.statusCode).toBe(503); expect(response.body).toBe('');
    expect(inbox.get(key('one'))).toBeDefined(); expect(inbox.get(key('two'))).toBeUndefined();
    expect((await post(server, messages)).statusCode).toBe(200);
    await inbox.drain(); expect(inbox.get(key('two'))?.state).toBe('ignored');
    expect(inbox.admit(inbox.get(key('one'))!.event)).toBe('duplicate');
  });

  it('composição de recepção isolada abre sessão vazia sem motor ou botão; desabilitada não cria inbox', async () => {
    const app = createApplication(environment, { whatsappProcessor: null, whatsappNow: () => new Date('2030-06-10T12:00:00Z') });
    const disabled = createApplication({});
    assert(app.whatsappInbox);
    cleanups.push(async () => { await app.whatsappInbox!.drain(); await app.server.close(); await disabled.server.close(); });
    expect(disabled.whatsappInbox).toBeUndefined();
    const open = vi.spyOn(app.conversationService, 'openConversation');
    const send = vi.spyOn(app.conversationService, 'sendMessage');
    const confirm = vi.spyOn(app.conversationService, 'confirmAction');
    expect((await post(app.server, [metaText(), metaButton()], [metaStatus()])).statusCode).toBe(200);
    await app.whatsappInbox.drain();
    expect(app.whatsappInbox.get(key('message-text'))?.state).toBe('ignored');
    expect(app.whatsappInbox.get(key('message-button'))?.state).toBe('ignored');
    expect(open).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    const binding = app.whatsappBindings?.get(identity); assert(binding);
    expect(app.conversations.get(binding.conversationId)?.history).toEqual([]);
  });
});
