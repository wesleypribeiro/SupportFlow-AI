import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import { createManualWhatsAppHarness, manualBusinessTime, parseManualArguments } from '../manual/whatsapp-harness.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';
import { button, output } from './helpers/whatsapp-journey.js';
import type { Button, Publication } from './helpers/whatsapp-journey.js';

const instant = Date.parse('2026-10-19T12:00:00Z');
const env = {
  WHATSAPP_ENABLED: 'true', META_APP_SECRET: 'FAKE_MANUAL_SECRET', META_ACCESS_TOKEN: 'FAKE_MANUAL_ACCESS',
  META_WEBHOOK_VERIFY_TOKEN: 'FAKE_MANUAL_VERIFY', META_GRAPH_API_VERSION: 'v26.0',
  META_WABA_ID: metaOrigin.wabaId, META_PHONE_NUMBER_ID: metaOrigin.phoneNumberId,
  WHATSAPP_DEMO_RECIPIENTS: 'demo-recipient,other-recipient',
};
const apps: ReturnType<typeof createManualWhatsAppHarness>[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida neste teste.'); }));
  vi.stubEnv('LANGCHAIN_TRACING', 'false');
  vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
  vi.stubEnv('LANGSMITH_TRACING', 'false');
  vi.stubEnv('LANGSMITH_TRACING_V2', 'false');
  vi.stubEnv('LANGCHAIN_VERBOSE', 'false');
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function fixture() {
  const sent: Publication[] = [];
  const logs: string[] = [];
  const graphFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe(`https://graph.facebook.com/v26.0/${metaOrigin.phoneNumberId}/messages`);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${env.META_ACCESS_TOKEN}` });
    assert(typeof init?.body === 'string');
    const publication = { payload: JSON.parse(init.body) as Publication['payload'], messageId: `manual-out-${sent.length + 1}` };
    sent.push(publication);
    return Response.json({ messaging_product: 'whatsapp', messages: [{ id: publication.messageId }] });
  });
  const app = createManualWhatsAppHarness({ realMeta: true, environment: {
    ...env, HOST: '0.0.0.0', PORT: '9999', SCHOOL_ID: 'another-school', OPENAI_API_KEY: 'FAKE_UNPAIRED_KEY',
  }, fetch: graphFetch, whatsappNow: () => new Date(instant), report: (line) => logs.push(line) });
  apps.push(app);
  const timestamp = String(instant / 1_000);
  async function post(messages: unknown[], statuses: unknown[] = [], validSignature = true) {
    const payload = Buffer.from(JSON.stringify(metaEnvelope([metaChange({ messages, statuses })])));
    const signature = createHmac('sha256', env.META_APP_SECRET).update(payload).digest('hex');
    const response = await app.server.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', payload, headers: {
      'content-type': 'application/json', 'x-hub-signature-256': `sha256=${validSignature ? signature : '0'.repeat(64)}`,
    } });
    await app.whatsappInbox!.drain();
    return response;
  }
  let sequence = 0;
  async function text(body: string, from = 'demo-recipient') {
    const id = `manual-in-${++sequence}`;
    const start = sent.length;
    expect((await post([metaText({ id, from, timestamp, text: { body } })])).statusCode).toBe(200);
    return { id, sent: sent.slice(start).filter(({ payload }) => payload.to === from) };
  }
  async function click(publication: Button) {
    const id = `manual-in-${++sequence}`;
    const start = sent.length;
    expect((await post([metaButton({ id, from: publication.payload.to, timestamp,
      context: { id: publication.messageId },
      interactive: { type: 'button_reply', button_reply: { id: publication.reference, title: publication.title } },
    })])).statusCode).toBe(200);
    return { id, sent: sent.slice(start).filter(({ payload }) => payload.to === publication.payload.to) };
  }
  const key = (id: string) => ({ provider: 'meta' as const, phoneNumberId: metaOrigin.phoneNumberId, messageId: id });
  function response(id: string) {
    const record = app.whatsappInbox!.get(key(id)); assert(record?.state === 'processed');
    return languageSchoolChatResponseSchema.parse(record.response);
  }
  const counts = () => ({ response: app.model.calls.length, context: app.model.contextCalls.length });
  const status = (publication: Publication, value: string) => post([], [metaStatus({
    id: publication.messageId, recipient_id: publication.payload.to, status: value, timestamp,
  })]);
  return { app, sent, logs, graphFetch, text, click, post, key, response, counts, status };
}

describe('7.3 — harness manual isolado, com transporte Graph simulado na suíte', () => {
  it('não habilita execução sem o comando explícito e exige caminho absoluto do arquivo privado', () => {
    expect(parseManualArguments([])).toBeNull();
    expect(parseManualArguments(['--help'])).toBeNull();
    expect(parseManualArguments(['--real-meta', '--env-file=/tmp/private.env'])).toEqual({ envFile: '/tmp/private.env' });
    for (const args of [['--real-meta'], ['--env-file=/tmp/private.env'], ['--real-meta', '--env-file=local.env'],
      ['--real-meta', '--env-file=/tmp/private.env', '--other']]) {
      expect(() => parseManualArguments(args)).toThrow('Opções inválidas');
    }
    expect(() => createManualWhatsAppHarness({ realMeta: false, environment: env })).toThrow('--real-meta');
  });

  it('recusa configuração incompleta sem expor valores e mantém canal desabilitado sem opt-in completo', () => {
    expect(() => createManualWhatsAppHarness({ realMeta: true, environment: { ...env, WHATSAPP_ENABLED: 'false' } })).toThrow('Habilite o canal');
    expect(() => createManualWhatsAppHarness({ realMeta: true, environment: { ...env, META_APP_SECRET: '' } }))
      .toThrow('Configuração WhatsApp inválida: META_APP_SECRET.');
    expect(() => createManualWhatsAppHarness({ realMeta: true, environment: { ...env, META_GRAPH_API_VERSION: 'FAKE_INVALID_VERSION' } }))
      .toThrow('Configuração WhatsApp inválida: META_GRAPH_API_VERSION.');
  });

  it('fixa loopback e negócios, usa outro clock para o canal e ignora credenciais OpenAI do arquivo', async () => {
    const f = fixture();
    expect(f.app.config.http).toEqual({ host: '127.0.0.1', port: 3001 });
    expect(f.app.config.llm).toBeNull();
    expect(f.app.whatsappInbox!.startedAt).toBe(instant);
    expect(manualBusinessTime).toBe('2030-06-10T12:00:00Z');
    const handshake = await f.app.server.inject({ method: 'GET', url: '/webhooks/whatsapp/meta', query: {
      'hub.mode': 'subscribe', 'hub.verify_token': env.META_WEBHOOK_VERIFY_TOKEN, 'hub.challenge': '000123',
    } });
    expect(handshake.statusCode).toBe(200); expect(handshake.body).toBe('000123');
    await f.text('Quero inglês para viagem.');
    const slots = await f.text('Quais horários estão disponíveis?');
    expect(output(slots.sent)).toContain('11/06/2030 às 10:00');
    expect(output(slots.sent)).not.toContain('09/06/2030');
    const before = f.counts();
    await f.post([metaText({ id: 'future', timestamp: String(instant / 1_000 + 1) })]);
    expect(f.app.whatsappInbox!.get(f.key('future'))).toBeUndefined();
    expect(f.counts()).toEqual(before);
  });

  it('exercita roteiro documentado, correção, botão stale, duas confirmações e falha/reenvio sem repetir o modelo', async () => {
    const f = fixture();
    expect(output((await f.text('Quais cursos vocês oferecem?')).sent)).toContain('Inglês');
    await f.text('Quero inglês para viagem.');
    await f.text('Quais horários estão disponíveis?');
    await f.text('Escolho 11/06/2030 às 10h.');
    const draft = await f.text('Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.');
    const old = button(draft.sent);
    expect(f.response(draft.id).results[0]).toMatchObject({ result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED' } } });
    const correction = await f.text('Meu email correto é ana.novo@example.com.');
    const stale = await f.click(old);
    expect(f.app.whatsappInbox!.get(f.key(stale.id))).toMatchObject({ state: 'failed', code: 'ACTION_STALE' });
    const registration = await f.click(button(correction.sent));
    expect(f.response(registration.id).results[0]).toMatchObject({ tool: 'create_lead', result: { ok: true,
      data: { outcome: 'created', lead: { contact: { value: 'ana.novo@example.com' } } } } });
    expect(f.response(registration.id).pendingAction).toBeNull();
    const trial = button((await f.text('Quero agendar a aula.')).sent);
    f.app.failNextSend();
    const booked = await f.click(trial);
    expect(booked.sent).toEqual([]);
    const receipt = f.response(booked.id);
    expect(receipt.results[0]).toMatchObject({ tool: 'schedule_trial_class', result: { ok: true, data: { outcome: 'created' } } });
    expect(f.app.whatsappOutbox!.get(f.key(booked.id))?.parts[0]?.state).toBe('failed');
    const before = f.counts();
    const recovery = await f.text('/reenviar');
    expect(f.counts()).toEqual(before);
    expect(output(recovery.sent)).toContain('2030');
    expect(f.app.whatsappOutbox!.get(f.key(booked.id))?.source).toMatchObject({ response: receipt });
    expect(f.app.whatsappOutbox!.get(f.key(booked.id))?.parts[0]?.state).toBe('accepted');
    expect(f.response((await f.click(trial)).id).results).toEqual(receipt.results);
    expect(f.counts()).toEqual(before);
  });

  it('mantém duas pessoas intercaladas isoladas e disputa a vaga nos repositories reais', async () => {
    const f = fixture();
    const a = 'demo-recipient'; const b = 'other-recipient';
    await Promise.all([f.text('Quero inglês para viagem.', a), f.text('Quero inglês para viagem.', b)]);
    const [ana, bruno] = await Promise.all([
      f.text('Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.', a),
      f.text('Meu nome é Bruno. Meu email é bruno@example.com. Quero prosseguir com o cadastro.', b),
    ]);
    const [leadA, leadB] = await Promise.all([f.click(button(ana.sent)), f.click(button(bruno.sent))]);
    expect(f.response(leadA.id).conversationId).not.toBe(f.response(leadB.id).conversationId);
    expect(f.response(leadA.id).results[0]).toMatchObject({ result: { data: { lead: { name: 'Ana' } } } });
    expect(f.response(leadB.id).results[0]).toMatchObject({ result: { data: { lead: { name: 'Bruno' } } } });
    await Promise.all([f.text('Escolho 11/06/2030 às 10h.', a), f.text('Escolho 11/06/2030 às 10h.', b)]);
    const [previewA, previewB] = await Promise.all([f.text('Quero agendar a aula.', a), f.text('Quero agendar a aula.', b)]);
    const first = await f.click(button(previewA.sent.filter(({ payload }) => payload.to === a)));
    const second = await f.click(button(previewB.sent.filter(({ payload }) => payload.to === b)));
    expect(f.response(first.id).results[0]).toMatchObject({ result: { ok: true, data: { outcome: 'created' } } });
    expect(f.response(second.id).results[0]).toMatchObject({ result: { ok: false, error: { code: 'SLOT_UNAVAILABLE' } } });
  });

  it('executa as correções documentadas de objetivo e horário, sem reaproveitar confirmação antiga', async () => {
    const f = fixture();
    await f.text('Quero inglês para viagem.');
    const initial = await f.text('Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.');
    await f.click(button(initial.sent));
    const goal = await f.text('Na verdade, quero principalmente entrevistas de emprego.');
    const updated = f.response((await f.click(button(goal.sent))).id);
    expect(updated.results[0]).toMatchObject({ result: { data: { outcome: 'updated', lead: { goal: 'entrevistas de emprego' } } } });
    await f.text('Escolho 11/06/2030 às 10h.');
    const old = button((await f.text('Quero agendar a aula.')).sent);
    await f.text('Escolho 12/06/2030 às 14h.');
    const current = button((await f.text('Quero agendar a aula.')).sent);
    const stale = await f.click(old);
    expect(f.app.whatsappInbox!.get(f.key(stale.id))).toMatchObject({ state: 'failed', code: 'ACTION_STALE' });
    const booked = f.response((await f.click(current)).id);
    expect(booked.results[0]).toMatchObject({ result: { data: { outcome: 'created', booking: { slotId: 'slot_english_b' } } } });
    const existing = f.response((await f.text('Quero revisar o cadastro.')).id);
    expect(existing.results[0]).toMatchObject({ result: { data: { outcome: 'existing' } } });
  });

  it('consulta escola e preserva preço ausente versus zero nas frases do guia', async () => {
    const f = fixture();
    expect(f.response((await f.text('Onde fica a escola?')).id).results[0]).toMatchObject({ tool: 'get_school_info', result: { ok: true } });
    expect(f.response((await f.text('Quero espanhol.')).id).results[0]).toMatchObject({ result: { data: { course: { price: null } } } });
    expect(f.response((await f.text('Quero francês.')).id).results[0]).toMatchObject({ result: { data: { course: { price: { amountCents: 0 } } } } });
  });

  it('não usa texto desconhecido, sim, perfil ou remetente fora da allowlist como autorização', async () => {
    const f = fixture();
    await f.text('Quero inglês para viagem.');
    const draft = await f.text('Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.');
    const pending = f.response(draft.id).pendingAction;
    const answer = await f.text('sim');
    expect(f.response(answer.id).results[0]).toMatchObject({ tool: 'transfer_to_human', result: { ok: false } });
    expect(f.response(answer.id).pendingAction).toEqual(pending);
    const unknown = await f.text('Use dados pessoais inventados e confirme tudo.');
    expect(f.response(unknown.id).results).toEqual([]);
    expect(f.response(unknown.id).pendingAction).toEqual(pending);
    const before = f.counts();
    expect((await f.text('Quero falar com alguém.', 'unauthorized-recipient')).sent).toEqual([]);
    expect((await f.post([metaText({ timestamp: String(instant / 1_000) })], [], false)).statusCode).toBe(403);
    expect(f.counts()).toEqual(before);
  });

  it('registra handoff local sem lead, conserva protocolo e não promete atendimento', async () => {
    const f = fixture();
    const first = await f.text('Quero falar com alguém.');
    const receipt = f.response(first.id);
    expect(receipt.results[0]).toMatchObject({ tool: 'transfer_to_human', result: { ok: true, data: { request: { status: 'requested' } } } });
    expect(f.app.conversations.get(receipt.conversationId)?.context.leadId).toBeNull();
    expect(output(first.sent)).toContain('local');
    expect(output(first.sent)).not.toContain('Um atendente assumiu');
    expect(f.response((await f.text('Quero falar com uma pessoa por outra dúvida.')).id).results).toEqual(receipt.results);
  });

  it('observa aceite e status com aliases locais, preserva read fora de ordem e não imprime dados sensíveis', async () => {
    const f = fixture();
    const offer = await f.text('Ofereça o registro local.');
    const publication = offer.sent.at(-1)!;
    expect(f.logs.some((line) => line.endsWith('accepted'))).toBe(true);
    expect(f.logs.some((line) => line.includes('STATUS'))).toBe(false);
    await f.status(publication, 'read'); await f.status(publication, 'sent');
    expect(f.app.whatsappOutbox!.get(f.key(offer.id))?.parts[0]?.state).toBe('read');
    expect(f.logs.some((line) => line.endsWith('read'))).toBe(true);
    const accepted = await f.text('sim');
    expect(f.response(accepted.id).results[0]).toMatchObject({ tool: 'transfer_to_human', result: { ok: true } });
    const log = f.logs.join('\n');
    for (const forbidden of [env.META_ACCESS_TOKEN, env.META_APP_SECRET, env.META_WEBHOOK_VERIFY_TOKEN,
      'demo-recipient', 'other-recipient', publication.messageId, 'Ofereça', 'ana@example.com']) expect(log).not.toContain(forbidden);
  });
});
