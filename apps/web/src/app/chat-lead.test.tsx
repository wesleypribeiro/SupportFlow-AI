// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateLeadInput, LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import { Chat } from './chat';

const data: CreateLeadInput = { name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseId: 'course_english_travel', goal: 'viagem' };
const action = (id = 'action_A', preview = data): LanguageSchoolChatResponse['pendingAction'] => ({ actionId: id, kind: 'create_lead', preview });
const response = (overrides: Partial<LanguageSchoolChatResponse> = {}): LanguageSchoolChatResponse => ({
  conversationId: 'conversation_server', reply: 'Confira os dados.', results: [{ tool: 'create_lead', result: {
    ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirme.' },
  } }], pendingAction: action(), ...overrides,
});
const receipt = (outcome: 'created' | 'updated' | 'existing'): LanguageSchoolChatResponse => response({
  reply: 'Não consegui cadastrar.', pendingAction: null,
  results: [{ tool: 'create_lead', result: { ok: true, data: { outcome, lead: { id: 'lead_server', ...data } } } }],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = vi.fn<typeof fetch>();
const input = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Sua mensagem' });
const confirmButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /Confirmar cadastro|Tentar confirmar novamente|Confirmando cadastro/ });
const body = (index: number) => JSON.parse(String(request.mock.calls[index]?.[1]?.body));
function send(message = 'Quero cadastrar meu interesse.') {
  fireEvent.change(input(), { target: { value: message } });
  fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
}
async function prepared(first = response()) {
  request.mockResolvedValueOnce(json(first));
  render(<Chat />);
  send();
  await screen.findByRole('region', { name: 'Revisar cadastro' });
}
beforeEach(() => {
  request.mockReset(); request.mockRejectedValue(new Error('INTERNAL_SECRET'));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('prévia oficial e confirmação de cadastro', () => {
  it('mostra somente pendingAction na prévia; prosa de sucesso não cria recibo', async () => {
    await prepared(response({ reply: 'Cadastro concluído com sucesso. Nome Maria, maria@example.com.' }));
    const preview = screen.getByRole('region', { name: 'Revisar cadastro' });
    for (const value of [data.name, data.contact.value, data.courseId, data.goal!]) {
      expect(within(preview).getByText(value)).toBeDefined();
    }
    expect(preview.textContent).not.toContain('Maria');
    expect(preview.textContent).not.toContain('maria@example.com');
    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByRole('article', { name: 'Resultado oficial do cadastro' })).toBeNull();
    expect(screen.getByText(/Cadastro aguardando confirmação/)).toBeDefined();
  });

  it('apresenta objetivo ausente sem inventar preferência', async () => {
    await prepared(response({ pendingAction: action('action_A', { ...data, goal: null }) }));
    expect(screen.getByText('Objetivo não informado')).toBeDefined();
  });

  it.each(['created', 'updated'] as const)('envia somente IDs e renderiza recibo %s apesar de prosa divergente', async (outcome) => {
    await prepared();
    request.mockResolvedValueOnce(json(receipt(outcome)));
    fireEvent.click(confirmButton());
    const official = await screen.findByRole('article', { name: 'Resultado oficial do cadastro' });
    expect(within(official).getByRole('heading', { name: outcome === 'created' ? 'Cadastro realizado.' : 'Cadastro atualizado.' })).toBeDefined();
    expect(official.textContent).toContain('ana@example.com');
    expect(official.textContent).toContain('lead_server');
    expect(screen.getByText('Não consegui cadastrar.')).toBeDefined();
    expect(request.mock.calls[1]?.[0]).toBe('/api/chat/confirm');
    expect(body(1)).toEqual({ conversationId: 'conversation_server', actionId: 'action_A' });
    expect(screen.queryByRole('region', { name: 'Revisar cadastro' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirmar cadastro/ })).toBeNull();
  });

  it('existing vindo do chat dispensa confirmação', async () => {
    request.mockResolvedValueOnce(json(receipt('existing')));
    render(<Chat />); send();
    await screen.findByRole('heading', { name: 'Dados já cadastrados.' });
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bloqueia double click e envio de mensagem durante confirmação', async () => {
    await prepared();
    let finish!: (response: Response) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(input(), { target: { value: 'Meu novo email é outro@example.com' } });
    const button = confirmButton();
    fireEvent.click(button); fireEvent.click(button);
    fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(input().disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Confirmando');
    await act(async () => { finish(json(receipt('created'))); });
    expect(input().disabled).toBe(false);
    expect(input().value).toBe('Meu novo email é outro@example.com');
  });

  it.each(['same', 'new', 'none'] as const)('mensagem bloqueia confirmação e usa a ação retornada: %s', async (mode) => {
    await prepared();
    let finish!: (response: Response) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    send('Meu novo email é ana.novo@example.com');
    const oldButton = confirmButton();
    expect(oldButton.disabled).toBe(true);
    fireEvent.click(oldButton);
    expect(request).toHaveBeenCalledTimes(2);
    const pending = mode === 'none' ? null : mode === 'same' ? action() : action('action_B', {
      ...data, contact: { type: 'email', value: 'ana.novo@example.com' },
    });
    await act(async () => { finish(json(response({ pendingAction: pending, reply: 'Resposta nova.' }))); });
    if (mode === 'none') {
      expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
    } else {
      const previews = screen.getAllByRole('region', { name: 'Revisar cadastro' });
      expect(previews).toHaveLength(1);
      expect(previews[0]?.textContent).toContain(mode === 'new' ? 'ana.novo@example.com' : data.contact.value);
      expect(confirmButton().disabled).toBe(false);
      request.mockResolvedValueOnce(json(receipt('created')));
      fireEvent.click(confirmButton());
      await screen.findByRole('article', { name: 'Resultado oficial do cadastro' });
      expect(body(2)).toEqual({ conversationId: 'conversation_server', actionId: mode === 'new' ? 'action_B' : 'action_A' });
    }
  });

  it('409 retira a ação obsoleta e permite continuar sem inventar nova prévia', async () => {
    await prepared();
    request.mockResolvedValueOnce(json({ error: { code: 'ACTION_STALE', message: 'Ação antiga.' } }, 409));
    fireEvent.click(confirmButton());
    expect((await screen.findByRole('alert')).textContent).toContain('Os dados foram alterados');
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
    expect(input().disabled).toBe(false);
    request.mockResolvedValueOnce(json(response({ pendingAction: action('action_B') })));
    send('Quero revisar.');
    await screen.findByRole('region', { name: 'Revisar cadastro' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['network', 'http', 'invalid'] as const)('preserva os mesmos IDs para retry após %s; nunca consulta chat para recuperar recibo', async (failure) => {
    await prepared();
    if (failure === 'network') request.mockRejectedValueOnce(new Error('INTERNAL_SECRET'));
    if (failure === 'http') request.mockResolvedValueOnce(json({ error: { code: 'CHAT_ERROR', message: 'INTERNAL_SECRET' } }, 500));
    if (failure === 'invalid') request.mockResolvedValueOnce(json({ ...receipt('created'), results: [{ invented: true }] }));
    fireEvent.click(confirmButton());
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('INTERNAL_SECRET');
    expect(screen.queryByRole('article', { name: 'Resultado oficial do cadastro' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Revisar cadastro' })).toBeDefined();
    request.mockResolvedValueOnce(json(receipt('created')));
    fireEvent.click(screen.getByRole('button', { name: 'Tentar confirmar novamente' }));
    await screen.findByRole('article', { name: 'Resultado oficial do cadastro' });
    expect(request.mock.calls.slice(1).map(([url]) => url)).toEqual(['/api/chat/confirm', '/api/chat/confirm']);
    expect(body(2)).toEqual(body(1));
    expect(body(2)).toEqual({ conversationId: 'conversation_server', actionId: 'action_A' });
  });

  it('falha de chat mantém a prévia anterior e reabilita confirmação', async () => {
    await prepared();
    send('Quero corrigir meu contato.');
    await screen.findByRole('alert');
    expect(confirmButton().disabled).toBe(false);
    expect(screen.getByRole('region', { name: 'Revisar cadastro' }).textContent).toContain(data.contact.value);
  });

  it('404 de confirmação exibe mensagem pública como texto e permite nova conversa', async () => {
    await prepared();
    const message = 'Conversa ou ação não encontrada. <b>Indisponível</b>';
    request.mockResolvedValueOnce(json({ error: { code: 'NOT_FOUND', message } }, 404));
    fireEvent.click(confirmButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.querySelector('b')).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
    expect(input().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar nova conversa' }));
    expect(input().disabled).toBe(false);
    request.mockResolvedValueOnce(json(response({ conversationId: 'new_id', pendingAction: null, results: [] })));
    send('Olá');
    await screen.findByText('Confira os dados.');
    expect(body(2)).toEqual({ message: 'Olá' });
  });
});
