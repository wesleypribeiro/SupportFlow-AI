// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageSchoolChatResponse, Slot, TrialClassPendingAction } from '@supportflow/contracts/language-school';
import { Chat } from './chat';

const slot: Slot = { slotId: 'slot_A', courseId: 'course_english', startsAt: '2030-06-11T10:00:00-03:00', timezone: 'America/Sao_Paulo' };
const lead = { id: 'lead_official', name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' }, courseId: slot.courseId, goal: 'viagem' };
const course = { id: slot.courseId, name: 'Inglês para Viagens', language: 'inglês', modality: 'online' as const, active: true as const };
const action = (id = 'action_A', selected = slot): TrialClassPendingAction => ({ actionId: id, kind: 'schedule_trial_class', preview: { lead, course, slot: selected } });
const response = (overrides: Partial<LanguageSchoolChatResponse> = {}): LanguageSchoolChatResponse => ({
  conversationId: 'conversation_server', reply: 'Sua aula já está marcada. Maria, dia 20 às 23h.',
  results: [{ tool: 'schedule_trial_class', result: { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Revise.' } } }],
  pendingAction: action(), ...overrides,
});
const receipt = (outcome: 'created' | 'existing' | 'SLOT_UNAVAILABLE') => response({
  reply: outcome === 'SLOT_UNAVAILABLE' ? 'Aula confirmada.' : 'Não consegui agendar.', pendingAction: null,
  results: [{ tool: 'schedule_trial_class', result: outcome === 'SLOT_UNAVAILABLE'
    ? { ok: false, error: { code: 'SLOT_UNAVAILABLE', message: 'Indisponível.' } }
    : { ok: true, data: { outcome, booking: { ...slot, id: 'booking_official', leadId: lead.id, status: 'confirmed' } } } }],
});
const request = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Sua mensagem' });
const button = () => screen.getByRole<HTMLButtonElement>('button', { name: /Confirmar aula experimental|Tentar confirmar novamente|Confirmando aula/ });
const requestBody = (index: number) => JSON.parse(String(request.mock.calls[index]?.[1]?.body));
function send(message = 'Quero a aula do dia 11 às 10h.') {
  fireEvent.change(field(), { target: { value: message } });
  fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
}
async function prepared() {
  request.mockResolvedValueOnce(json(response())); render(<Chat />); send();
  await screen.findByRole('region', { name: 'Revisar aula experimental' });
}
beforeEach(() => { request.mockReset(); request.mockRejectedValue(new Error('INTERNAL_SECRET')); vi.stubGlobal('fetch', request); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('agenda oficial na interface', () => {
  it.each([false, true])('renderiza horários estruturados, inclusive lista vazia (%s)', async (empty) => {
    request.mockResolvedValueOnce(json(response({ pendingAction: null, reply: 'Há horários todos os dias às 23h.', results: [{
      tool: 'get_available_slots', result: { ok: true, data: { courseId: slot.courseId, slots: empty ? [] : [slot] } },
    }] })));
    render(<Chat />); send('Quais horários?');
    const list = await screen.findByRole('region', { name: 'Horários disponíveis' });
    expect(list.textContent).not.toContain('23h');
    if (empty) expect(within(list).getByText('Não há horários disponíveis no momento.')).toBeDefined();
    else {
      for (const text of ['11 de junho de 2030', '10:00', 'America/Sao Paulo']) expect(within(list).getByText(text)).toBeDefined();
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    }
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
  });

  it('prévia usa somente pendingAction; sucesso na prosa não cria recibo nem remove confirmação', async () => {
    await prepared();
    const preview = screen.getByRole('region', { name: 'Revisar aula experimental' });
    for (const text of ['Ana', course.name, '11 de junho de 2030', '10:00', 'America/Sao Paulo']) expect(within(preview).getByText(text)).toBeDefined();
    expect(preview.textContent).not.toContain('Maria'); expect(preview.textContent).not.toContain('23h');
    expect(preview.textContent).toContain('Agenda demonstrativa');
    expect(button().disabled).toBe(false);
    expect(screen.queryByRole('article', { name: 'Recibo oficial da aula' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirmar cadastro' })).toBeNull();
  });

  it.each(['created', 'existing', 'SLOT_UNAVAILABLE'] as const)('envia somente IDs e apresenta o resultado %s independentemente da prosa', async (outcome) => {
    await prepared(); request.mockResolvedValueOnce(json(receipt(outcome))); fireEvent.click(button());
    if (outcome === 'SLOT_UNAVAILABLE') {
      await screen.findByText('Este horário não está mais disponível. Consulte os horários novamente.');
      expect(screen.queryByRole('article', { name: 'Recibo oficial da aula' })).toBeNull();
    } else {
      const official = await screen.findByRole('article', { name: 'Recibo oficial da aula' });
      expect(within(official).getByRole('heading', { name: outcome === 'created' ? 'Aula experimental confirmada.' : 'Esta aula experimental já estava confirmada.' })).toBeDefined();
      for (const text of [slot.courseId, 'Confirmado', '10:00']) expect(within(official).getByText(text)).toBeDefined();
      expect(official.textContent).toContain('booking_official');
    }
    expect(request.mock.calls[1]?.[0]).toBe('/api/chat/confirm');
    expect(requestBody(1)).toEqual({ conversationId: 'conversation_server', actionId: 'action_A' });
    expect(screen.queryByRole('region', { name: 'Revisar aula experimental' })).toBeNull();
    expect(field().disabled).toBe(false);
  });

  it('bloqueia double click e envio enquanto confirma a aula', async () => {
    await prepared(); let finish!: (response: Response) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const confirm = button(); fireEvent.click(confirm); fireEvent.click(confirm); send();
    expect(request).toHaveBeenCalledTimes(2); expect(field().disabled).toBe(true); expect(confirm.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Confirmando sua aula');
    await act(async () => { finish(json(receipt('created'))); });
    expect(field().disabled).toBe(false);
  });

  it.each(['same', 'new', 'none'] as const)('mensagem bloqueia confirmação e respeita a próxima ação: %s', async (mode) => {
    await prepared(); let finish!: (response: Response) => void;
    request.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    send('Prefiro dia 12 às 14h.');
    expect(button().disabled).toBe(true); fireEvent.click(button()); expect(request).toHaveBeenCalledTimes(2);
    const pendingAction = mode === 'none' ? null : mode === 'same' ? action() : action('action_B', { ...slot, slotId: 'slot_B', startsAt: '2030-06-12T14:00:00-03:00' });
    await act(async () => { finish(json(response({ pendingAction }))); });
    if (mode === 'none') expect(screen.queryByRole('button', { name: /Confirmar aula/ })).toBeNull();
    else {
      expect(screen.getAllByRole('region', { name: 'Revisar aula experimental' })).toHaveLength(1);
      expect(button().disabled).toBe(false);
      expect(within(screen.getByRole('region', { name: 'Revisar aula experimental' })).getByText(mode === 'same' ? '10:00' : '14:00')).toBeDefined();
      request.mockResolvedValueOnce(json(receipt('created'))); fireEvent.click(button());
      await screen.findByRole('article', { name: 'Recibo oficial da aula' });
      expect(requestBody(2)).toEqual({ conversationId: 'conversation_server', actionId: mode === 'same' ? 'action_A' : 'action_B' });
    }
  });

  it('409 retira ação stale e permite continuar a conversa', async () => {
    await prepared(); request.mockResolvedValueOnce(json({ error: { code: 'ACTION_STALE', message: 'Revise.' } }, 409));
    fireEvent.click(button()); expect((await screen.findByRole('alert')).textContent).toContain('Os dados foram alterados');
    expect(screen.queryByRole('button', { name: /Confirmar aula/ })).toBeNull(); expect(field().disabled).toBe(false);
  });

  it.each(['network', '500', 'invalid'])('retry preserva actionId após %s, sem consultar chat', async (failure) => {
    await prepared();
    if (failure === 'network') request.mockRejectedValueOnce(new Error('SECRET'));
    else request.mockResolvedValueOnce(json(failure === '500' ? { error: { code: 'CHAT_ERROR', message: 'SECRET' } } : {}, failure === '500' ? 500 : 200));
    fireEvent.click(button()); await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).not.toContain('SECRET');
    request.mockResolvedValueOnce(json(receipt('created'))); fireEvent.click(button());
    await screen.findByRole('article', { name: 'Recibo oficial da aula' });
    expect(requestBody(2)).toEqual(requestBody(1));
    expect(request.mock.calls.slice(1).map(([url]) => url)).toEqual(['/api/chat/confirm', '/api/chat/confirm']);
  });

  it('substitui confirmação de cadastro por confirmação de aula sem reutilizar a autorização', async () => {
    request.mockResolvedValueOnce(json(response({ pendingAction: { actionId: 'lead_action', kind: 'create_lead', preview: { name: lead.name, contact: lead.contact, courseId: lead.courseId, goal: lead.goal } } })));
    render(<Chat />); send(); await screen.findByRole('button', { name: 'Confirmar cadastro' });
    request.mockResolvedValueOnce(json(response())); send('Quero marcar a aula.'); await screen.findByRole('button', { name: 'Confirmar aula experimental' });
    expect(screen.queryByRole('button', { name: 'Confirmar cadastro' })).toBeNull();
    request.mockResolvedValueOnce(json(receipt('created'))); fireEvent.click(button()); await screen.findByRole('article', { name: 'Recibo oficial da aula' });
    expect(requestBody(2)).toEqual({ conversationId: 'conversation_server', actionId: 'action_A' });
  });
});
