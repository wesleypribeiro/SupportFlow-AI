import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { languageSchoolPendingActionSchema } from '@supportflow/contracts/language-school';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import type { WhatsAppInboxRecord } from '../src/channels/whatsapp/inbox.js';
import { createMetaCloudApiClient } from '../src/channels/whatsapp/meta/cloud-api-client.js';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import { handoffOffer } from '../src/modules/language-school/domain/handoff-intent.js';
import { courseFixtures, schoolFixture } from '../src/modules/language-school/infrastructure/catalog-fixtures.js';
import { InMemorySchoolRepository } from '../src/modules/language-school/infrastructure/in-memory-school-repository.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryHandoffRepository } from '../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures, trialClassFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { catalogTurn, courseTurn, createJourneyModel, dialogue, handoffTurn, leadTurn, query, slotsTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient,other-recipient',
};
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: 'demo-recipient' };
const key = (messageId: string) => ({ ...identity, messageId });
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

function application(script: JourneyScript) {
  const model = createJourneyModel(script);
  const schoolRepository = new InMemorySchoolRepository(schoolFixture, courseFixtures);
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures, trialClassFixtures);
  const handoffRepository = new InMemoryHandoffRepository();
  const sent: { to: string; type: string; text: { body: string } }[] = [];
  const savedAtSend: (WhatsAppInboxRecord<LanguageSchoolChatResponse> | undefined)[] = [];
  let currentMessage = '';
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    savedAtSend.push(app.whatsappInbox!.get(key(currentMessage)));
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `outbound-${sent.length}` }] }));
  });
  const whatsappTransport = createMetaCloudApiClient({ accessToken: environment.META_ACCESS_TOKEN,
    graphApiVersion: 'v26.0', phoneNumberId: metaOrigin.phoneNumberId }, { fetch });
  const app = createApplication(environment, { model, schoolRepository, leadRepository, trialClassRepository, handoffRepository,
    now, whatsappNow: now, whatsappTransport });
  const inbox = app.whatsappInbox!;
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  async function post(messages: ReturnType<typeof metaText>[], statuses: unknown[] = []) {
    currentMessage = messages[0]?.id ?? '';
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages, statuses,
      contacts: [{ wa_id: identity.senderId, profile: { name: 'Não é nome do lead' } }],
    })])));
    return app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
  }
  async function text(messageId: string, body: string, extras: Record<string, unknown> = {}) {
    const start = sent.length;
    expect((await post([metaText({ id: messageId, text: { body }, ...extras })])).statusCode).toBe(200);
    await inbox.drain();
    return sent.slice(start).map((message) => message.text.body).join('\n\n');
  }
  function response(messageId: string) {
    const record = inbox.get(key(messageId)); assert(record?.state === 'processed');
    return record.response;
  }
  return { ...app, inbox, model, schoolRepository, leadRepository, trialClassRepository, handoffRepository,
    fetch, sent, savedAtSend, post, text, response };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida.'); }));
  vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('LANGCHAIN_TRACING_V2', 'false'); vi.stubEnv('LANGSMITH_TRACING', 'false');
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(cleanups.splice(0).map((close) => close()));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('4.3 — texto por webhook assinado, motor real e apresentação oficial', () => {
  it('percorre catálogo → curso → horários; salva envelope antes do envio, preserva prosa no histórico e não reserva', async () => {
    const app = application([catalogTurn(), courseTurn(), slotsTurn()]);
    const states: unknown[] = [];
    app.server.addHook('onResponse', async () => { states.push(app.inbox.get(key('catalog'))?.state); });
    const catalog = await app.text('catalog', 'Quais cursos vocês oferecem?');
    expect(states[0]).toBe('received');
    expect(catalog).toContain('nova sessão demonstrativa');
    expect(catalog).toContain('Inglês para viagens'); expect(catalog).toContain('Conversação em espanhol');
    expect(catalog).not.toContain('Fundamentos de alemão');
    const details = await app.text('course', 'Quero inglês para viagem. Quanto custa?');
    expect(details).toContain('R$ 350,00 por mês'); expect(details).not.toContain('999');
    expect(app.response('course').reply).toContain('999');
    const slots = await app.text('slots', 'Quais horários estão disponíveis?');
    expect(slots).toContain('11/06/2030 às 10:00'); expect(slots).toContain('12/06/2030 às 14:00');
    expect(slots).toContain('America/Sao_Paulo'); expect(slots).toContain('Informe explicitamente');
    expect(slots).not.toMatch(/slot_english_past|slot_english_occupied/);
    const conversationId = app.response('catalog').conversationId;
    expect(app.response('course').conversationId).toBe(conversationId);
    expect(app.response('slots').conversationId).toBe(conversationId);
    expect(app.conversations.get(conversationId)?.context).toMatchObject({ name: null, contact: null, leadId: null,
      courseId: 'course_english_travel', goal: 'viagem' });
    expect(app.conversations.get(conversationId)?.history.some((message) => message.text.includes('999'))).toBe(true);
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    expect(app.savedAtSend).toHaveLength(app.sent.length);
    for (const record of app.savedAtSend) expect(record).toMatchObject({ state: 'processed', response: { conversationId } });
    expect(app.sent.every((message) => message.type === 'text' && message.to === identity.senderId)).toBe(true);
    const calls = app.model.calls.length; const count = app.sent.length;
    await app.text('slots', 'Quais horários estão disponíveis?');
    expect(app.model.calls).toHaveLength(calls); expect(app.sent).toHaveLength(count);
  });

  it.each([false, true])('texto inválido é orientado sem truncar ou executar modelo (sessão existente: %s)', async (existing) => {
    const app = application([leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' })]);
    if (existing) await app.text('lead', 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.');
    const conversationId = app.whatsappBindings!.get(identity)?.conversationId;
    const before = conversationId && app.conversations.get(conversationId);
    const pending = conversationId && await app.conversationService.getCurrentPendingAction({ conversationId });
    const calls = app.model.calls.length; const contextCalls = app.model.contextCalls.length;
    for (const [index, invalid] of ['', ' \n\t ', 'á'.repeat(2_001), 'x'.repeat(4_096)].entries()) {
      const messageId = `invalid-${index}`;
      const output = await app.text(messageId, invalid);
      expect(output).toContain('1 a 2.000'); expect(output).toContain('não foi processado nem truncado');
      expect(app.inbox.get(key(messageId))).toMatchObject({ state: 'ignored',
        code: existing ? 'INVALID_TEXT' : 'INVALID_INITIAL_TEXT', event: { text: invalid } });
    }
    expect(app.model.calls).toHaveLength(calls); expect(app.model.contextCalls).toHaveLength(contextCalls);
    if (conversationId) {
      expect(app.conversations.get(conversationId)).toEqual(before);
      expect(await app.conversationService.getCurrentPendingAction({ conversationId })).toEqual(pending);
      expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
    } else expect(app.whatsappBindings!.get(identity)).toBeUndefined();
  });

  it('apara apenas bordas e aceita exatamente 2.000 caracteres num único turno', async () => {
    const app = application([dialogue(new AIMessage('Recebido.'))]);
    const content = 'á'.repeat(2_000);
    const original = ` \n${content}\t `;
    expect(await app.text('boundary', original)).toContain('Recebido.');
    const response = app.response('boundary');
    const history = app.conversations.get(response.conversationId)!.history;
    expect(history.map((message) => message.text)).toEqual([content, 'Recebido.']);
    expect(app.model.contextCalls).toHaveLength(1); expect(app.model.calls).toHaveLength(1);
    expect(app.inbox.get(key('boundary'))?.event).toMatchObject({ text: original });
  });

  it.each([false, true])('pedido explícito sem lead apresenta protocolo real e preserva original ao repetir (falha de redação: %s)', async (fails) => {
    const app = application([handoffTurn('Preciso de uma pessoa.', fails ? new Error('PRIVATE_DRAFT') : new AIMessage('Um atendente assumiu.')),
      handoffTurn('Outro motivo.')]);
    const output = await app.text('handoff', 'Quero falar com alguém.');
    const response = app.response('handoff');
    const request = await app.handoffRepository.findOpenByConversationId(response.conversationId); assert(request);
    expect(output).toContain(request.id); expect(output).toContain('Status: Solicitado');
    expect(output).toContain('não inicia atendimento humano ao vivo'); expect(output).not.toContain('assumiu');
    expect(request.status).toBe('requested'); expect(response.pendingAction).toBeNull();
    expect(await app.leadRepository.findByConversationId(response.conversationId)).toBeNull();
    expect(app.conversations.get(response.conversationId)?.context).toMatchObject({ revision: 0, name: null, contact: null, leadId: null });
    const repeat = await app.text('repeat', 'Preciso falar com uma pessoa.');
    expect(repeat).toContain(request.id); expect(repeat).toContain(request.reason); expect(repeat).not.toContain('Outro motivo');
    expect(app.response('repeat').results).toEqual(response.results);
  });

  it.each(['create_lead', 'schedule_trial_class'] as const)('handoff e Sim preservam ação %s e revisão, sem confirmação ou escrita comercial', async (kind) => {
    const app = application([leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' }),
      handoffTurn(), dialogue(new AIMessage('Confirmação depende da ação específica.'))]);
    await app.text('lead', 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.');
    const { conversationId } = app.response('lead');
    let pending = app.response('lead').pendingAction;
    if (kind === 'schedule_trial_class') {
      assert(pending);
      const confirmed = await app.conversationService.confirmAction({ conversationId, actionId: pending.actionId }); assert(confirmed.ok);
      const conversation = app.conversations.get(conversationId)!;
      conversation.context.slotId = 'slot_english_a'; app.conversations.save(conversation);
      pending = languageSchoolPendingActionSchema.parse((await app.prepareTrialClass(conversationId, { leadId: conversation.context.leadId, slotId: 'slot_english_a' })).pendingAction);
    }
    assert(pending);
    const context = app.conversations.get(conversationId)!.context;
    const lead = await app.leadRepository.findByConversationId(conversationId);
    const confirm = vi.spyOn(app.conversationService, 'confirmAction');
    const output = await app.text('handoff', 'Antes disso, quero falar com alguém.');
    expect(output).toContain('Protocolo:'); expect(output).toContain('aguardando confirmação');
    expect(app.response('handoff').pendingAction).toEqual(pending);
    await app.text('yes', 'sim');
    expect(app.response('yes').pendingAction).toEqual(pending);
    expect(app.conversations.get(conversationId)!.context).toEqual(context);
    expect(await app.leadRepository.findByConversationId(conversationId)).toEqual(lead);
    expect(await app.trialClassRepository.findConfirmedBySlotId('slot_english_a')).toBeNull();
    expect(confirm).not.toHaveBeenCalled(); expect(app.sent.every((message) => message.type === 'text')).toBe(true);
  });

  it.each(['omitida', 'aceita', 'falhou'] as const)('Sim não aceita oferta %s sem evidência, mesmo com context.id/status externos', async (mode) => {
    const offer = mode === 'omitida' ? query('get_courses', {}, {}, new AIMessage(handoffOffer)) : dialogue(new AIMessage(handoffOffer));
    const app = application([offer, handoffTurn()]);
    if (mode === 'falhou') app.fetch.mockRejectedValue(new Error('PRIVATE_TRANSPORT'));
    const output = await app.text('offer', 'Estou com uma dúvida.');
    const first = app.response('offer');
    expect(first.reply).toBe(handoffOffer);
    if (mode === 'omitida') expect(output).not.toContain(handoffOffer);
    if (mode === 'aceita') expect(output).toContain(handoffOffer);
    await app.post([], [metaStatus({ id: 'outbound-2', status: 'read' })]);
    await app.text('yes', 'Sim, por favor.', { context: { id: 'outbound-2', previousPresentation: handoffOffer }, previousPresentation: handoffOffer });
    expect(app.response('yes').results[0]?.result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await app.handoffRepository.findOpenByConversationId(first.conversationId)).toBeNull();
  });

  it('preserva a regra web de aceitar a última oferta no histórico e recusa scope no request HTTP', async () => {
    const app = application([dialogue(new AIMessage(handoffOffer)), handoffTurn()]);
    const offered = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Tenho uma dúvida.' } });
    const { conversationId } = offered.json();
    const invalid = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId, message: 'Sim', previousPresentation: handoffOffer } });
    expect(invalid.statusCode).toBe(400);
    const accepted = await app.server.inject({ method: 'POST', url: '/api/chat', payload: { conversationId, message: 'Sim, por favor.' } });
    expect(accepted.statusCode).toBe(200); expect(accepted.json().results[0].result.ok).toBe(true);
    expect(await app.handoffRepository.findOpenByConversationId(conversationId)).not.toBeNull();
    expect(app.fetch).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'unknown', 'exception'] as const)('falha de transporte %s não apaga protocolo nem repete modelo/escrita', async (failure) => {
    const app = application([handoffTurn()]);
    // O aviso demonstrativo tem seu próprio callback; aqui isolamos o envio do resultado.
    app.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'notice' }] })));
    if (failure === 'exception') app.fetch.mockRejectedValue(new Error('PRIVATE_SEND_ERROR'));
    else app.fetch.mockResolvedValue(new Response(JSON.stringify(failure === 'rejected' ? { error: { message: 'PRIVATE_PROVIDER', type: 'Error', code: 1 } } : {}), { status: failure === 'rejected' ? 400 : 200 }));
    await app.text('handoff', 'Quero falar com alguém.');
    const record = app.inbox.get(key('handoff')); assert(record?.state === 'processed');
    expect(record.presentationError).toBe('PRESENTATION_ERROR');
    expect(JSON.stringify(record)).not.toContain('PRIVATE');
    const saved = await app.handoffRepository.findOpenByConversationId(record.response.conversationId); assert(saved);
    expect(record.response.results[0]?.result).toEqual({ ok: true, data: { request: saved } });
    const attempts = app.fetch.mock.calls.length; const calls = app.model.calls.length;
    await app.text('handoff', 'Quero falar com alguém.');
    expect(app.fetch).toHaveBeenCalledTimes(attempts); expect(app.model.calls).toHaveLength(calls);
    expect(app.inbox.get(key('handoff'))).toEqual(record);
    expect(await app.handoffRepository.findOpenByConversationId(record.response.conversationId)).toEqual(saved);
  });

  it('interrompe as partes após falha e mantém a resposta integral salva, sem retry automático', async () => {
    const reply = 'Texto longo preservado. '.repeat(400);
    const app = application([dialogue(new AIMessage(reply))]);
    app.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'notice' }] })));
    app.fetch.mockResolvedValue(new Response('{}'));
    await app.text('long', 'Olá');
    expect(app.fetch).toHaveBeenCalledTimes(2);
    const part = JSON.parse(String(app.fetch.mock.calls[1]?.[1]?.body));
    expect(part.text.body).toMatch(/^\[1\/\d+\]/);
    expect(app.response('long').reply).toBe(reply);
    expect(app.inbox.get(key('long'))).toMatchObject({ state: 'processed', presentationError: 'PRESENTATION_ERROR' });
    expect(app.model.calls).toHaveLength(1);
  });

  it('ACK precede modelo/envio; resultado já está salvo enquanto o transporte aguarda', async () => {
    const entered = gate(); const releaseModel = gate(); const sending = gate(); const releaseSend = gate();
    const app = application([dialogue(async () => { entered.release(); await releaseModel.promise; return new AIMessage('Olá.'); })]);
    const normalFetch = app.fetch.getMockImplementation()!;
    app.fetch.mockImplementation(async (...args) => { sending.release(); await releaseSend.promise; return normalFetch(...args); });
    expect((await app.post([metaText({ id: 'slow' })])).statusCode).toBe(200);
    expect(app.model.calls).toHaveLength(0); expect(app.fetch).not.toHaveBeenCalled();
    await entered.promise; releaseModel.release(); await sending.promise;
    const record = app.inbox.get(key('slow')); expect(record).toMatchObject({ state: 'processed', response: { reply: 'Olá.' } });
    releaseSend.release(); await app.inbox.drain();
    expect(app.inbox.get(key('slow'))).toEqual(record); expect(app.inbox.activeQueueCount).toBe(0);
  });

  it('falha antes do commit preserva contexto/ação e erro salvo; próxima mensagem prossegue sem reexecutar a falha', async () => {
    const failure = leadTurn({ contact: { type: 'email', value: 'ana.novo@example.com' } });
    failure.responses[1] = new Error('PRIVATE_MODEL_FAILURE');
    const app = application([leadTurn({ name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' }), failure, dialogue()]);
    await app.text('lead', 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.');
    const { conversationId, pendingAction } = app.response('lead');
    const before = app.conversations.get(conversationId);
    const output = await app.text('failure', 'Meu email correto é ana.novo@example.com. Cadastre esse contato.');
    expect(output).toContain('Não foi possível concluir');
    expect(app.inbox.get(key('failure'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(app.savedAtSend.at(-1)).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(app.conversations.get(conversationId)).toEqual(before);
    expect(await app.conversationService.getCurrentPendingAction({ conversationId })).toEqual({ ok: true, response: { pendingAction } });
    await app.text('next', 'Pode continuar?');
    expect(app.response('next').pendingAction).toEqual(pendingAction);
    expect(await app.leadRepository.findByConversationId(conversationId)).toBeNull();
  });

  it('ignora botões/status/mídia sem confirmação ou turno e restringe texto aos participantes configurados', async () => {
    const app = application([dialogue()]);
    const confirm = vi.spyOn(app.conversationService, 'confirmAction');
    await app.text('greeting', 'Olá!');
    const calls = app.model.calls.length; const sends = app.sent.length;
    await app.post([metaButton(), metaText({ id: 'media', type: 'image' }), metaText({ id: 'foreign', from: 'unlisted' })], [metaStatus()]);
    await app.inbox.drain();
    expect(app.inbox.get(key('message-button'))).toMatchObject({ state: 'ignored', code: 'UNSUPPORTED_MESSAGE' });
    expect(app.whatsappBindings!.get({ ...identity, senderId: 'unlisted' })).toBeUndefined();
    expect(app.model.calls).toHaveLength(calls); expect(app.sent).toHaveLength(sends); expect(confirm).not.toHaveBeenCalled();
  });
});
