import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryWhatsAppInbox } from '../src/channels/whatsapp/inbox.js';
import type { WhatsAppInboundMessage, WhatsAppInboxProcessor, WhatsAppInboxRecord } from '../src/channels/whatsapp/inbox.js';

const event: WhatsAppInboundMessage = {
  type: 'text', provider: 'meta', accountId: 'account', phoneNumberId: 'number',
  senderId: 'sender', messageId: 'message', occurredAt: Date.parse('2030-06-10T12:00:00Z'), text: 'Olá!',
};
const releases: (() => void)[] = [];
const inboxes: Pick<InMemoryWhatsAppInbox, 'drain'>[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
function inbox<Response>(processor?: WhatsAppInboxProcessor<Response>) {
  const instance = new InMemoryWhatsAppInbox(processor, { now: () => new Date(event.occurredAt) });
  inboxes.push(instance);
  return instance;
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(inboxes.splice(0).map((instance) => instance.drain()));
});

describe('3.2 — admissão atômica e fila local da inbox', () => {
  it('salva resultado antes da apresentação e isola mutações/falhas do callback, preservando dedupe e fila', async () => {
    const response = { reply: 'Resultado oficial.' };
    const process = vi.fn(async () => ({ ok: true as const, response }));
    let savedAtPresentation: unknown;
    const present = vi.fn(async (record: WhatsAppInboxRecord<typeof response>): Promise<void> => {
      savedAtPresentation = store.get(record.event);
      if (record.state !== 'processed' || record.event.type !== 'text') throw new Error('Resposta de teste inválida.');
      record.response.reply = 'Resposta adulterada';
      record.event.text = 'Texto adulterado';
      throw new Error('PRIVATE_PRESENTER_FAILURE');
    });
    const store = new InMemoryWhatsAppInbox(process, { now: () => new Date(event.occurredAt), onProcessed: present });
    inboxes.push(store);
    store.admit(event); await store.drain();
    expect(savedAtPresentation).toMatchObject({ state: 'processed', response: { reply: 'Resultado oficial.' } });
    expect(response).toEqual({ reply: 'Resultado oficial.' });
    expect(store.get(event)).toMatchObject({ state: 'processed', response, event, presentationError: 'PRESENTATION_ERROR' });
    expect(JSON.stringify(store.get(event))).not.toContain('PRIVATE');
    expect(store.admit(event)).toBe('duplicate'); await store.drain();
    expect(process).toHaveBeenCalledOnce(); expect(present).toHaveBeenCalledOnce();
    present.mockResolvedValueOnce(undefined);
    store.admit({ ...event, messageId: 'next' }); await store.drain();
    expect(process).toHaveBeenCalledTimes(2); expect(present).toHaveBeenCalledTimes(2);
    expect(store.get({ ...event, messageId: 'next' })).toMatchObject({ state: 'processed', response });
    expect(store.activeQueueCount).toBe(0);
  });

  it('registra received sincronamente e deduplica antes, durante e após processar', async () => {
    const entered = gate(); const release = gate();
    const process = vi.fn(async () => {
      entered.release(); await release.promise;
      return { ok: true as const, response: { reply: 'Olá de volta' } };
    });
    const store = inbox(process);
    expect(store.admit(event)).toBe('accepted');
    expect(store.get(event)).toMatchObject({ event, state: 'received' });
    expect(process).not.toHaveBeenCalled();
    expect(store.admit({ ...event })).toBe('duplicate');
    await entered.promise;
    expect(store.get(event)?.state).toBe('processing');
    expect(store.admit({ ...event })).toBe('duplicate');
    release.release(); await store.drain();
    expect(store.get(event)).toMatchObject({ state: 'processed', response: { reply: 'Olá de volta' } });
    expect(store.activeQueueCount).toBe(0);
    expect(store.admit({ ...event })).toBe('duplicate');
    await store.drain();
    expect(process).toHaveBeenCalledOnce();
  });

  it.each([
    ['conteúdo', { text: 'Outro texto' }],
    ['remetente', { senderId: 'another-sender' }],
    ['conta', { accountId: 'another-account' }],
    ['timestamp original', { occurredAt: event.occurredAt + 1_000 }],
    ['mensagem respondida', { replyToMessageId: 'outbound-other' }],
    ['tipo', { type: 'button_reply', reference: 'reference', replyToMessageId: 'outbound' }],
  ] as const)('rejeita colisão de %s sem alterar o original nem agendar trabalho', async (_label, patch) => {
    const entered = gate(); const release = gate();
    const process = vi.fn(async () => { entered.release(); await release.promise; return { ok: true as const, response: 'ok' }; });
    const store = inbox(process);
    store.admit(event);
    const conflicting = { ...event, ...patch } as WhatsAppInboundMessage;
    expect(store.admit(conflicting)).toBe('collision');
    await entered.promise;
    const original = store.get(event);
    expect(store.admit(conflicting)).toBe('collision');
    expect(store.get(event)).toEqual(original);
    release.release(); await store.drain();
    const completed = store.get(event);
    expect(store.admit(conflicting)).toBe('collision');
    expect(store.get(event)).toEqual(completed);
    expect(process).toHaveBeenCalledOnce();
    expect(store.activeQueueCount).toBe(0);
  });

  it('deduplica botão e rejeita troca da referência ou context.id', async () => {
    const process = vi.fn(async () => ({ ok: true as const, response: 'receipt' }));
    const store = inbox(process);
    const button: WhatsAppInboundMessage = { provider: 'meta', accountId: 'account', phoneNumberId: 'number',
      senderId: 'sender', messageId: 'button', occurredAt: event.occurredAt,
      type: 'button_reply', reference: 'opaque', replyToMessageId: 'preview' };
    store.admit(button);
    expect(store.admit({ ...button })).toBe('duplicate');
    expect(store.admit({ ...button, reference: 'foreign' })).toBe('collision');
    expect(store.admit({ ...button, replyToMessageId: 'foreign' })).toBe('collision');
    await store.drain();
    expect(store.admit(button)).toBe('duplicate');
    expect(process).toHaveBeenCalledOnce();
  });

  it('fingerprint independe da ordem das propriedades e preserva texto sem trim', async () => {
    const store = inbox(async () => ({ ok: true, response: 'ok' }));
    store.admit(event);
    const reordered = Object.fromEntries(Object.entries(event).reverse()) as WhatsAppInboundMessage;
    expect(store.admit(reordered)).toBe('duplicate');
    expect(store.admit({ ...event, text: ' Olá! ' })).toBe('collision');
    await store.drain();
  });

  it('chave de dedupe preserva número/messageId opacos e não colide por delimitador', async () => {
    const process = vi.fn(async () => ({ ok: true as const, response: 'ok' }));
    const store = inbox(process);
    const events = [
      { ...event, phoneNumberId: 'a:b', messageId: 'c' },
      { ...event, phoneNumberId: 'a', messageId: 'b:c' },
      ...['001', '1', ' ID ', 'ID', 'id'].map((messageId) => ({ ...event, messageId })),
      { ...event, phoneNumberId: 'other-number' }, event,
    ];
    for (const input of events) expect(store.admit(input)).toBe('accepted');
    await store.drain();
    expect(process).toHaveBeenCalledTimes(events.length);
    for (const input of events) {
      expect(store.get(input)?.event).toEqual(input);
      expect(store.admit(input)).toBe('duplicate');
    }
  });

  it('isola snapshots de entrada, argumento do processador, resultado e leitura', async () => {
    const release = gate(); const entered = gate();
    const response = { reply: 'ok', results: [{ value: 'original' }] };
    const store = inbox(async (input) => {
      expect(input).toEqual(event);
      input.senderId = 'changed-by-processor';
      if (input.type === 'text') input.text = 'changed-by-processor';
      entered.release(); await release.promise;
      return { ok: true, response };
    });
    const input = { ...event };
    store.admit(input);
    input.senderId = 'changed-by-caller'; input.text = 'changed-by-caller';
    await entered.promise;
    const read = store.get(event)!; read.event.senderId = 'changed-by-reader';
    expect(store.get(event)?.event).toEqual(event);
    release.release(); await store.drain();
    response.results[0]!.value = 'changed-after-result';
    const finished = store.get(event)!;
    expect(finished).toMatchObject({ state: 'processed', response: { results: [{ value: 'original' }] } });
    if (finished.state === 'processed') finished.response.results[0]!.value = 'changed-by-reader';
    expect(store.get(event)).toMatchObject({ response: { results: [{ value: 'original' }] } });
    expect(store.admit(event)).toBe('duplicate');
  });

  it.each(['accountId', 'phoneNumberId', 'senderId'] as const)('fila independente quando muda %s e drenagem por vínculo', async (field) => {
    const entered = gate(); const release = gate();
    const store = inbox(async (input) => {
      if (input.messageId === event.messageId) { entered.release(); await release.promise; }
      return { ok: true, response: input.messageId };
    });
    store.admit(event); await entered.promise;
    const other = { ...event, [field]: 'other', messageId: 'second' };
    store.admit(other);
    expect(store.activeQueueCount).toBe(2);
    await store.drain(other);
    expect(store.get(other)?.state).toBe('processed');
    expect(store.get(event)?.state).toBe('processing');
    expect(store.activeQueueCount).toBe(1);
    release.release(); await store.drain();
    expect(store.activeQueueCount).toBe(0);
  });

  it('mantém a cauda mais recente, drena novas admissões e remove fila ociosa sem remover dedupe', async () => {
    const entered = gate(); const release = gate(); const secondEntered = gate(); const secondRelease = gate();
    const order: string[] = [];
    const store = inbox(async (input) => {
      order.push(input.messageId);
      if (input.messageId === 'message') { entered.release(); await release.promise; }
      if (input.messageId === 'second') { secondEntered.release(); await secondRelease.promise; }
      return { ok: true, response: input.messageId };
    });
    store.admit(event); await entered.promise;
    let drained = false;
    const draining = store.drain().then(() => { drained = true; });
    store.admit({ ...event, messageId: 'second' });
    release.release(); await secondEntered.promise;
    expect(store.activeQueueCount).toBe(1); expect(drained).toBe(false);
    expect(store.get({ ...event, messageId: 'second' })?.state).toBe('processing');
    secondRelease.release(); await draining;
    expect(store.activeQueueCount).toBe(0);
    expect(store.admit(event)).toBe('duplicate');
    store.admit({ ...event, messageId: 'third' }); await store.drain();
    expect(order).toEqual(['message', 'second', 'third']);
    expect(store.activeQueueCount).toBe(0);
  });

  it.each(['throw', 'reject', 'controlled'] as const)('captura %s, sanitiza e continua sem retry automático do evento falho', async (mode) => {
    const privateError = Object.assign(new Error('PRIVATE_BODY_TOKEN'), { cause: { headers: 'PRIVATE_HEADERS', url: 'PRIVATE_URL' } });
    const process = vi.fn<WhatsAppInboxProcessor<string>>((input) => {
      if (input.messageId === event.messageId) {
        if (mode === 'throw') throw privateError;
        if (mode === 'reject') return Promise.reject(privateError);
        return Promise.resolve({ ok: false, code: 'CHAT_ERROR' });
      }
      return Promise.resolve({ ok: true, response: 'ok' });
    });
    const store = inbox(process);
    store.admit(event); store.admit({ ...event, messageId: 'next' });
    await store.drain();
    const failed = store.get(event)!;
    expect(failed).toEqual({ event, fingerprint: expect.any(String), state: 'failed', code: 'CHAT_ERROR' });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
    expect(store.get({ ...event, messageId: 'next' })?.state).toBe('processed');
    expect(store.admit(event)).toBe('duplicate'); await store.drain();
    expect(process).toHaveBeenCalledTimes(2); expect(store.activeQueueCount).toBe(0);
  });

  it('ausência de processador fica ignored explícito, sem sucesso comercial ou reexecução', async () => {
    const store = inbox();
    store.admit(event); await store.drain();
    expect(store.get(event)).toEqual({ event, fingerprint: expect.any(String), state: 'ignored', code: 'PROCESSOR_UNAVAILABLE' });
    expect(store.admit(event)).toBe('duplicate'); expect(store.activeQueueCount).toBe(0);
  });
});
