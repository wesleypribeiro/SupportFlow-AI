import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication } from '../src/app.js';
import { createWhatsAppTextChannel } from '../src/channels/whatsapp/text-channel.js';
import type { WhatsAppSendRequest, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { InMemoryLeadRepository } from '../src/modules/language-school/infrastructure/in-memory-lead-repository.js';
import { InMemoryTrialClassRepository } from '../src/modules/language-school/infrastructure/in-memory-trial-class-repository.js';
import { slotFixtures } from '../src/modules/language-school/infrastructure/slot-fixtures.js';
import { presentLanguageSchoolWhatsApp } from '../src/modules/language-school/infrastructure/whatsapp-presentation.js';
import { createJourneyModel, dialogue, leadTurn, scheduleTurn } from './helpers/journey-script.js';
import type { JourneyScript } from './helpers/journey-script.js';
import { metaChange, metaEnvelope, metaOrigin, metaText } from './helpers/meta-webhook.js';

const now = () => new Date('2030-06-10T12:00:00Z');
const identity = { provider: 'meta' as const, accountId: metaOrigin.wabaId, phoneNumberId: metaOrigin.phoneNumberId, senderId: 'demo-recipient' };
const key = (messageId: string) => ({ ...identity, messageId });
const environment = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_APP_SECRET', META_WEBHOOK_VERIFY_TOKEN: 'FAKE_VERIFY_TOKEN',
  META_ACCESS_TOKEN: 'FAKE_ACCESS_TOKEN', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId, WHATSAPP_DEMO_RECIPIENTS: identity.senderId,
};
const student = { name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseReference: 'inglês', goal: 'viagem' };
const slotA = { slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } };
const slotB = { slotReference: { slotId: 'slot_english_b', evidence: '12/06/2030 às 14h' } };
const kinds = ['create_lead', 'schedule_trial_class'] as const;
type Kind = typeof kinds[number];
type Publication = { request: WhatsAppSendRequest; messageId: string };
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
  const leadRepository = new InMemoryLeadRepository();
  const trialClassRepository = new InMemoryTrialClassRepository(slotFixtures);
  const sent: Publication[] = [];
  const send = vi.fn<WhatsAppTransport['send']>(async (request) => {
    const messageId = `outbound-${sent.length + 1}`;
    sent.push({ request: structuredClone(request), messageId });
    return { status: 'accepted', messageId };
  });
  const app = createApplication(environment, { model, leadRepository, trialClassRepository, now, whatsappTransport: { send } });
  assert(app.whatsappInbox && app.whatsappConfirmationReferences && app.whatsappBindings);
  const inbox = app.whatsappInbox;
  const references = app.whatsappConfirmationReferences;
  const register = vi.spyOn(references, 'getOrCreate');
  const confirm = vi.spyOn(app.conversationService, 'confirmAction');
  cleanups.push(async () => { await inbox.drain(); await app.server.close(); });
  async function post(messages: unknown[]) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages })])));
    const response = await app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', environment.META_APP_SECRET).update(payload).digest('hex')}`,
    } });
    expect(response.statusCode).toBe(200);
  }
  async function text(messageId: string, body: string) {
    const start = sent.length;
    await post([metaText({ id: messageId, text: { body } })]);
    await inbox.drain();
    return sent.slice(start);
  }
  function response(messageId: string) {
    const record = inbox.get(key(messageId)); assert(record?.state === 'processed');
    return record.response;
  }
  return { ...app, model, leadRepository, trialClassRepository, inbox, references, register, confirm, sent, send, post, text, response };
}
type App = ReturnType<typeof application>;
function button(publications: Publication[]) {
  const publication = publications.filter(({ request }) => request.message.type === 'reply_buttons').at(-1);
  assert(publication?.request.message.type === 'reply_buttons');
  const control = publication.request.message.buttons[0]; assert(control);
  expect(publication.request.message.buttons).toHaveLength(1);
  return { ...publication, reference: control.id, title: control.title, body: publication.request.message.body };
}
function output(publications: Publication[]) { return publications.map(({ request }) => request.message.body).join('\n'); }
function scriptFor(kind: Kind): JourneyScript {
  return [leadTurn(student), ...(kind === 'schedule_trial_class' ? [scheduleTurn(slotA)] : [])];
}
async function prepare(app: App, kind: Kind) {
  let publications = await app.text('lead', 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.');
  let response = app.response('lead'); assert(response.pendingAction);
  if (kind === 'schedule_trial_class') {
    // Fixture pelo serviço real: conectar cliques à execução pertence à task 5.3.
    const registered = await app.conversationService.confirmAction({ conversationId: response.conversationId, actionId: response.pendingAction.actionId });
    assert(registered.ok);
    publications = await app.text('trial', 'Quero agendar 11/06/2030 às 10h.');
    response = app.response('trial');
  }
  assert(response.pendingAction?.kind === kind);
  app.confirm.mockClear();
  return { ...response, pendingAction: response.pendingAction, publication: button(publications), publications };
}
async function business(app: App, conversationId: string) {
  return {
    lead: await app.leadRepository.findByConversationId(conversationId),
    slotA: await app.trialClassRepository.findConfirmedBySlotId('slot_english_a'),
    slotB: await app.trialClassRepository.findConfirmedBySlotId('slot_english_b'),
  };
}
function click(publication: ReturnType<typeof button>) {
  return { ...identity, type: 'button_reply' as const, occurredAt: now().getTime(), messageId: `click-${publication.messageId}`,
    reference: publication.reference, replyToMessageId: publication.messageId };
}
async function rejectStale(app: App, publication: ReturnType<typeof button>) {
  const event = click(publication);
  const resolved = app.references.resolve(event); assert(resolved.ok);
  const calls = app.model.calls.length;
  // Exercita o lifecycle autoritativo com o alvo realmente publicado, sem
  // implementar o roteamento de cliques no processador de produção da task 5.3.
  const result = await app.conversationService.confirmAction({ conversationId: resolved.target.conversationId, actionId: resolved.target.actionId });
  expect(result).toEqual({ ok: false, code: 'ACTION_STALE' });
  assert(!result.ok);
  const channel = createWhatsAppTextChannel({ service: app.conversationService, bindings: app.whatsappBindings!,
    references: app.references, present: presentLanguageSchoolWhatsApp, transport: { send: app.send } });
  const start = app.sent.length;
  await channel.present({ event, fingerprint: 'test', state: 'failed', code: result.code });
  expect(output(app.sent.slice(start))).toContain('revisar a prévia atual');
  expect(app.model.calls).toHaveLength(calls);
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

describe('5.2 — publicação de prévias commitadas no WhatsApp', () => {
  it.each(kinds)('publica %s somente depois do commit/envelope salvo; CONFIRMATION_REQUIRED não escreve nem vira recibo', async (kind) => {
    const app = application(scriptFor(kind));
    const originalSend = app.send.getMockImplementation()!;
    app.send.mockImplementation(async (request) => {
      if (request.message.type === 'reply_buttons') {
        const reference = request.message.buttons[0]!.id;
        const stored = app.references.get(reference); assert(stored);
        expect(stored.messageIds).toEqual([]);
        const id = stored.kind === 'create_lead' ? 'lead' : 'trial';
        const response = app.response(id);
        expect(response.pendingAction).toMatchObject({ actionId: stored.actionId, kind: stored.kind });
        expect(await app.conversationService.getCurrentPendingAction({ conversationId: response.conversationId }))
          .toEqual({ ok: true, response: { pendingAction: response.pendingAction } });
        expect(app.references.resolve(click(button([{ request, messageId: 'unaccepted' }]))).ok).toBe(false);
      }
      return originalSend(request);
    });
    const proposed = await prepare(app, kind);
    const { publication, pendingAction, conversationId } = proposed;
    expect(proposed.results).toEqual([{ tool: kind, result: { ok: false, error: {
      code: 'CONFIRMATION_REQUIRED', message: expect.any(String),
    } } }]);
    expect(publication.title).toBe(kind === 'create_lead' ? 'Confirmar cadastro' : 'Confirmar aula');
    expect(publication.request.recipientId).toBe(identity.senderId);
    expect(publication.body).toBe(presentLanguageSchoolWhatsApp(app.response(kind === 'create_lead' ? 'lead' : 'trial')).confirmation?.body);
    for (const value of ['Ana', 'ana@example.com', 'course_english_travel', 'viagem']) expect(publication.body).toContain(value);
    expect(output(proposed.publications)).not.toMatch(/Cadastro realizado\.|Sua aula está confirmada\./);
    expect(app.references.get(publication.reference)).toMatchObject({ actionId: pendingAction.actionId, kind,
      binding: { conversationId }, messageIds: [publication.messageId] });
    expect(app.references.resolve(click(publication))).toEqual({ ok: true, target: { conversationId, actionId: pendingAction.actionId, kind } });
    const state = await business(app, conversationId);
    expect(state.slotA).toBeNull(); expect(state.slotB).toBeNull();
    if (kind === 'create_lead') expect(state.lead).toBeNull();
    else {
      expect(publication.body).toContain('11/06/2030 às 10:00'); expect(publication.body).toContain('America/Sao_Paulo');
      expect(publication.body).toContain('Agenda interna demonstrativa');
      const leadButton = button(app.sent.filter(({ request }) => request.message.type === 'reply_buttons' && request.message.buttons[0]?.title === 'Confirmar cadastro'));
      expect(publication.reference).not.toBe(leadButton.reference);
    }
    expect(app.confirm).not.toHaveBeenCalled();
  });

  it.each(kinds)('repetir os dados vigentes sem nova proposta preserva ação/revisão/referência de %s', async (kind) => {
    const app = application([...scriptFor(kind), dialogue(new AIMessage('Revise os dados.'), { ...student, ...(kind === 'schedule_trial_class' && slotA) })]);
    const first = await prepare(app, kind);
    const context = app.conversations.get(first.conversationId)!.context;
    const before = await business(app, first.conversationId);
    const again = button(await app.text('same', 'Sou Ana, ana@example.com, inglês para viagem. O horário segue 11/06/2030 às 10h.'));
    expect(app.response('same').pendingAction).toEqual(first.pendingAction);
    expect(app.conversations.get(first.conversationId)!.context).toEqual(context);
    expect(again.reference).toBe(first.publication.reference);
    expect(app.references.get(again.reference)?.messageIds).toEqual([first.publication.messageId, again.messageId]);
    for (const publication of [first.publication, again]) expect(app.references.resolve(click(publication))).toMatchObject({
      ok: true, target: { actionId: first.pendingAction.actionId, kind },
    });
    expect(await business(app, first.conversationId)).toEqual(before); expect(app.confirm).not.toHaveBeenCalled();
  });

  it.each(kinds)('“sim” seguido de tool call para %s continua proposta sem consentimento', async (kind) => {
    const app = application([...scriptFor(kind), kind === 'create_lead' ? leadTurn() : scheduleTurn()]);
    const first = await prepare(app, kind);
    const before = await business(app, first.conversationId);
    const context = app.conversations.get(first.conversationId)!.context;
    const publications = await app.text('yes', 'sim');
    expect(app.response('yes').results[0]).toMatchObject({ tool: kind, result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED' } } });
    expect(button(publications).title).toBe(first.publication.title);
    expect(output(publications)).not.toMatch(/Cadastro realizado\.|Sua aula está confirmada\./);
    expect(app.conversations.get(first.conversationId)!.context).toEqual(context);
    expect(await business(app, first.conversationId)).toEqual(before); expect(app.confirm).not.toHaveBeenCalled();
  });

  it.each(kinds.flatMap((kind) => ['contato', 'objetivo'].map((field) => ({ kind, field }))))(
    'corrigir $field substitui a prévia de $kind e recusa o botão antigo ainda visível', async ({ kind, field }) => {
      const patch = field === 'contato' ? { contact: { type: 'email' as const, value: 'ana.novo@example.com' } } : { goal: 'entrevistas' };
      const app = application([...scriptFor(kind), leadTurn(patch)]);
      const first = await prepare(app, kind);
      const before = await business(app, first.conversationId);
      const revision = app.conversations.get(first.conversationId)!.context.revision;
      const next = button(await app.text('correction', field === 'contato' ? 'Meu contato correto é ana.novo@example.com.' : 'Meu objetivo agora é entrevistas.'));
      const action = app.response('correction').pendingAction; assert(action?.kind === 'create_lead');
      expect(action.actionId).not.toBe(first.pendingAction.actionId);
      expect(next.reference).not.toBe(first.publication.reference); expect(next.title).toBe('Confirmar cadastro');
      expect(action.preview).toMatchObject(patch);
      expect(next.body).toContain(field === 'contato' ? 'ana.novo@example.com' : 'entrevistas');
      expect(next.body).not.toContain(field === 'contato' ? 'ana@example.com' : 'Objetivo: viagem');
      expect(app.conversations.get(first.conversationId)!.context.revision).toBe(revision + 1);
      expect(app.sent).toContainEqual({ request: first.publication.request, messageId: first.publication.messageId });
      await rejectStale(app, first.publication);
      expect(await business(app, first.conversationId)).toEqual(before);
      expect(await app.conversationService.getCurrentPendingAction({ conversationId: first.conversationId }))
        .toEqual({ ok: true, response: { pendingAction: action } });
    });

  it('corrigir slot publica nova aula com data oficial e recusa o botão anterior sem ocupar nenhuma vaga', async () => {
    const app = application([...scriptFor('schedule_trial_class'), scheduleTurn(slotB)]);
    const first = await prepare(app, 'schedule_trial_class');
    const before = await business(app, first.conversationId);
    const next = button(await app.text('slot-b', 'Agora escolho 12/06/2030 às 14h.'));
    expect(next.reference).not.toBe(first.publication.reference); expect(next.title).toBe('Confirmar aula');
    expect(next.body).toContain('12/06/2030 às 14:00'); expect(next.body).not.toContain('11/06/2030');
    expect(app.response('slot-b').pendingAction).toMatchObject({ kind: 'schedule_trial_class', preview: { slot: { slotId: 'slot_english_b' } } });
    await rejectStale(app, first.publication);
    expect(await business(app, first.conversationId)).toEqual(before);
  });

  it.each(kinds)('falha na redação de %s não publica referência órfã nem invalida a anterior', async (kind) => {
    const drafting = gate(); const releaseDraft = gate();
    const failure = kind === 'create_lead' ? leadTurn({ contact: { type: 'email', value: 'ana.novo@example.com' } }) : scheduleTurn(slotB);
    failure.responses[1] = async () => { drafting.release(); await releaseDraft.promise; throw new Error('PRIVATE_DRAFT_FAILURE'); };
    const app = application([...scriptFor(kind), failure, dialogue()]);
    const first = await prepare(app, kind);
    const conversation = app.conversations.get(first.conversationId);
    const before = await business(app, first.conversationId);
    const registered = app.register.mock.calls.length;
    const sent = app.sent.length;
    await app.post([metaText({ id: 'failure', text: { body: kind === 'create_lead' ? 'Meu contato correto é ana.novo@example.com.' : 'Agora escolho 12/06/2030 às 14h.' } })]);
    await drafting.promise;
    expect(app.inbox.get(key('failure'))?.state).toBe('processing');
    expect(app.register).toHaveBeenCalledTimes(registered); expect(app.sent).toHaveLength(sent);
    expect(app.conversations.get(first.conversationId)).toEqual(conversation);
    releaseDraft.release(); await app.inbox.drain();
    expect(app.inbox.get(key('failure'))).toMatchObject({ state: 'failed', code: 'CHAT_ERROR' });
    expect(app.register).toHaveBeenCalledTimes(registered);
    expect(output(app.sent.slice(sent))).not.toContain('PRIVATE');
    expect(app.conversations.get(first.conversationId)).toEqual(conversation);
    expect(await app.conversationService.getCurrentPendingAction({ conversationId: first.conversationId }))
      .toEqual({ ok: true, response: { pendingAction: first.pendingAction } });
    expect(app.references.resolve(click(first.publication))).toMatchObject({ ok: true, target: { actionId: first.pendingAction.actionId } });
    expect(button(await app.text('continue', 'Pode continuar?')).reference).toBe(first.publication.reference);
    expect(await business(app, first.conversationId)).toEqual(before); expect(app.confirm).not.toHaveBeenCalled();
  });

  it('falha na primeira proposta não registra referência nem ação global', async () => {
    const failure = leadTurn(student); failure.responses[1] = new Error('PRIVATE_DRAFT_FAILURE');
    const app = application([failure]);
    await app.text('failure', 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.');
    const conversationId = app.whatsappBindings!.get(identity)!.conversationId;
    expect(app.register).not.toHaveBeenCalled();
    expect(app.sent.every(({ request }) => request.message.type === 'text')).toBe(true);
    expect(app.conversations.get(conversationId)?.history).toEqual([]);
    expect(await app.conversationService.getCurrentPendingAction({ conversationId })).toEqual({ ok: true, response: { pendingAction: null } });
    expect((await business(app, conversationId)).lead).toBeNull();
  });

  it.each(['rejected', 'unknown', 'exception'] as const)('envio de botão %s preserva ação sem criar correlação utilizável ou executar escrita', async (status) => {
    const app = application(scriptFor('create_lead'));
    const originalSend = app.send.getMockImplementation()!;
    app.send.mockImplementation(async (request) => {
      const accepted = await originalSend(request);
      if (request.message.type === 'text') return accepted;
      if (status === 'exception') throw new Error('PRIVATE_TRANSPORT');
      return status === 'unknown' ? { status, reason: 'timeout' } : { status, reason: 'provider_rejection' };
    });
    const proposed = await prepare(app, 'create_lead');
    expect(app.inbox.get(key('lead'))).toMatchObject({ state: 'processed', presentationError: 'PRESENTATION_ERROR', response: { pendingAction: proposed.pendingAction } });
    expect(app.references.get(proposed.publication.reference)?.messageIds).toEqual([]);
    expect(app.references.resolve(click(proposed.publication))).toEqual({ ok: false, code: 'INVALID_CONFIRMATION' });
    expect(await app.conversationService.getCurrentPendingAction({ conversationId: proposed.conversationId }))
      .toEqual({ ok: true, response: { pendingAction: proposed.pendingAction } });
    expect((await business(app, proposed.conversationId)).lead).toBeNull(); expect(app.confirm).not.toHaveBeenCalled();
    const calls = app.model.calls.length; const sends = app.send.mock.calls.length;
    await app.text('lead', 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.');
    expect(app.model.calls).toHaveLength(calls); expect(app.send).toHaveBeenCalledTimes(sends);
  });

  it('prévia completa acima do limite permanece textual, sem registrar referência ou botão incompleto', async () => {
    const goal = 'x'.repeat(1_100);
    const app = application([leadTurn({ ...student, goal })]);
    const publications = await app.text('large', `Sou Ana, ana@example.com. Quero inglês com objetivo ${goal}.`);
    expect(app.response('large').pendingAction).toMatchObject({ kind: 'create_lead', preview: { goal } });
    expect(output(publications)).toContain(goal); expect(output(publications)).toContain('Não há botão de confirmação');
    expect(publications.every(({ request }) => request.message.type === 'text')).toBe(true);
    expect(app.register).not.toHaveBeenCalled(); expect(app.confirm).not.toHaveBeenCalled();
  });

  it('relê a ação após envio textual lento e não registra nem publica prévia já substituída', async () => {
    const sending = gate(); const releaseSend = gate();
    const app = application([leadTurn(student), leadTurn({ contact: { type: 'email', value: 'ana.novo@example.com' } })]);
    const originalSend = app.send.getMockImplementation()!;
    app.send.mockImplementation(async (request) => {
      if (request.message.body.includes('Aguardando confirmação.')) { sending.release(); await releaseSend.promise; }
      return originalSend(request);
    });
    await app.post([metaText({ id: 'lead', text: { body: 'Sou Ana, ana@example.com. Quero inglês para viagem e me cadastrar.' } })]);
    await sending.promise;
    const original = app.response('lead'); assert(original.pendingAction);
    // Outro adapter interno pode avançar a conversa enquanto o transporte aguarda.
    // A fila/envios independentes do canal permanecem no escopo futuro da 6.1.
    const corrected = await app.conversationService.sendMessage({ conversationId: original.conversationId,
      message: 'Meu contato correto é ana.novo@example.com.' }); assert(corrected.ok && corrected.response.pendingAction);
    releaseSend.release(); await app.inbox.drain();
    expect(app.register).not.toHaveBeenCalled();
    expect(app.sent.every(({ request }) => request.message.type === 'text')).toBe(true);
    expect(output(app.sent)).toContain('revisar a prévia atual');
    expect(app.response('lead')).toEqual(original);
    expect((await business(app, original.conversationId)).lead).toBeNull();
  });
});
