// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';
import { Chat } from './chat';

const official = { id: 'handoff_backend_123', reason: 'Prefiro falar com uma pessoa.', status: 'requested' as const };
const response = (overrides: Partial<LanguageSchoolChatResponse> = {}): LanguageSchoolChatResponse => ({
  conversationId: 'conversation_backend', reply: 'Um atendente assumiu sua conversa. Protocolo FALSO.',
  results: [{ tool: 'transfer_to_human', result: { ok: true, data: { request: official } } }], pendingAction: null, ...overrides,
});
const request = vi.fn<typeof fetch>();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function send(message = 'Não quero me cadastrar agora. Prefiro falar com uma pessoa.') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Sua mensagem' }), { target: { value: message } });
  fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
}
const card = () => screen.findByRole('article', { name: 'Protocolo oficial de atendimento' });
beforeEach(() => { request.mockReset(); request.mockRejectedValue(new Error('PRIVATE')); vi.stubGlobal('fetch', request); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('solicitação local apresentada pelos results oficiais', () => {
  it('jornada sem lead mostra ID, motivo e requested como solicitado, sem confirmação', async () => {
    request.mockResolvedValueOnce(json(response())); render(<Chat />); send();
    const receipt = await card();
    for (const value of [official.id, official.reason, 'Solicitado']) expect(within(receipt).getByText(value)).toBeDefined();
    expect(within(receipt).getByRole('heading', { name: 'Solicitação de atendimento registrada' })).toBeDefined();
    expect(receipt.textContent).toContain('Nenhum atendimento humano ao vivo foi iniciado');
    expect(receipt.textContent).toContain('nenhuma notificação externa foi enviada');
    expect(receipt.textContent).not.toMatch(/FALSO|assumiu/);
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/api/chat');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ message: 'Não quero me cadastrar agora. Prefiro falar com uma pessoa.' });
  });

  it('prosa sem resultado oficial não cria protocolo', async () => {
    request.mockResolvedValueOnce(json(response({ results: [] }))); render(<Chat />); send();
    await screen.findByText('Um atendente assumiu sua conversa. Protocolo FALSO.');
    expect(screen.queryByRole('article', { name: 'Protocolo oficial de atendimento' })).toBeNull();
    expect(screen.queryByText('Solicitado')).toBeNull();
  });

  it.each(['INVALID_INPUT', 'OPERATION_FAILED'] as const)('falha %s não mostra card de sucesso mesmo com prosa divergente', async (code) => {
    request.mockResolvedValueOnce(json(response({ results: [{ tool: 'transfer_to_human', result: { ok: false, error: { code, message: 'PRIVATE' } } }] })));
    render(<Chat />); send();
    const notice = await screen.findByLabelText('Falha na solicitação de atendimento');
    expect(notice.textContent).not.toContain('PRIVATE');
    expect(notice.textContent).toMatch(/Nenhuma nova solicitação|Não foi possível registrar/);
    expect(screen.queryByRole('article', { name: 'Protocolo oficial de atendimento' })).toBeNull();
    expect(screen.queryByText('Solicitado')).toBeNull();
  });

  it('repetição mantém ID e motivo originais em ambos os turnos', async () => {
    request.mockResolvedValueOnce(json(response())); render(<Chat />); send(); await card();
    request.mockResolvedValueOnce(json(response({ reply: 'Outro motivo na prosa não substitui o primeiro.' })));
    send('Preciso falar com um atendente sobre outro assunto.');
    await screen.findByText('Outro motivo na prosa não substitui o primeiro.');
    const receipts = screen.getAllByRole('article', { name: 'Protocolo oficial de atendimento' });
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(within(receipt).getByText(official.id)).toBeDefined();
      expect(within(receipt).getByText(official.reason)).toBeDefined();
    }
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ conversationId: 'conversation_backend', message: 'Preciso falar com um atendente sobre outro assunto.' });
  });

  it('preserva prévia existente e não confirma cadastro durante o handoff', async () => {
    const pendingAction: LanguageSchoolChatResponse['pendingAction'] = { kind: 'create_lead', actionId: 'lead_action', preview: {
      name: 'Ana', contact: { type: 'email', value: 'ana@example.com' }, courseId: 'course_english_travel', goal: null,
    } };
    request.mockResolvedValueOnce(json(response({ results: [], pendingAction, reply: 'Revise o cadastro.' })));
    render(<Chat />); send('Quero cadastrar.');
    const confirm = await screen.findByRole<HTMLButtonElement>('button', { name: 'Confirmar cadastro' });
    let finish!: (value: Response) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })); send();
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm);
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => { finish(json(response({ pendingAction }))); });
    await card(); expect(confirm.disabled).toBe(false);
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/chat', '/api/chat']);
    expect(screen.getAllByRole('button', { name: /Confirmar/ })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Revisar cadastro' }).textContent).toContain('ana@example.com');
  });

  it('motivo é texto, inclusive HTML, e resultado contrário à prosa prevalece no card', async () => {
    const reason = '<img src=x onerror=alert(1)> Quero uma pessoa.';
    request.mockResolvedValueOnce(json(response({ reply: 'Não consegui registrar.', results: [{ tool: 'transfer_to_human', result: { ok: true, data: { request: { ...official, reason } } } }] })));
    render(<Chat />); send(); const receipt = await card();
    expect(within(receipt).getByText(reason)).toBeDefined();
    expect(receipt.querySelector('img')).toBeNull();
    expect(within(receipt).getByText('Solicitado')).toBeDefined();
  });

  it('envelope com status inexistente é rejeitado antes de incorporar protocolo', async () => {
    request.mockResolvedValueOnce(json(response({ results: [{ tool: 'transfer_to_human', result: { ok: true, data: { request: { ...official, status: 'assigned' } } } }] as never })));
    render(<Chat />); send(); await screen.findByRole('alert');
    expect(screen.queryByRole('article', { name: 'Protocolo oficial de atendimento' })).toBeNull();
    expect(screen.queryByText(official.id)).toBeNull();
  });
});
