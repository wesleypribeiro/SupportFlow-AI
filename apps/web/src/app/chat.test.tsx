// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCourse, LanguageSchoolChatResponse, School } from '@supportflow/contracts/language-school';
import { Chat } from './chat';
import nextConfig from '../../next.config';

const school: School = {
  id: 'school_demo', name: 'Escola Horizonte (fictícia)', description: 'Uma escola demonstrativa de idiomas.',
  address: 'Rua Exemplo, 123', contact: 'escola@example.com', openingHours: 'Segunda a sexta, das 9h às 18h',
  timezone: 'America/Sao_Paulo',
};
const course: ActiveCourse = {
  id: 'course_english', name: 'Inglês para viagens', language: 'Inglês', modality: 'online', active: true,
  description: 'Conversação para situações de viagem.',
  price: { amountCents: 35000, currency: 'BRL', billingPeriod: 'month' },
};
const response = (overrides: Partial<LanguageSchoolChatResponse> = {}): LanguageSchoolChatResponse => ({
  conversationId: 'conversation_server', reply: 'Olá! Como posso ajudar?', results: [], pendingAction: null,
  ...overrides,
});
const details = (selected: ActiveCourse): LanguageSchoolChatResponse['results'] => [
  { tool: 'get_course_details', result: { ok: true, data: { course: selected } } },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const request = vi.fn<typeof fetch>();
function input() { return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Sua mensagem' }); }
async function send(text = 'Olá') {
  const user = userEvent.setup();
  await user.type(input(), text);
  await user.click(screen.getByRole('button', { name: /^Enviar/ }));
  return user;
}
function submittedBody(index: number) {
  return JSON.parse(String(request.mock.calls[index]?.[1]?.body));
}

beforeEach(() => {
  request.mockReset();
  request.mockRejectedValue(new Error('Nenhuma chamada de rede é permitida neste teste.'));
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('chat da escola', () => {
  it('envia a primeira mensagem sem ID e mantém apenas o ID retornado nos próximos envios', async () => {
    request.mockResolvedValueOnce(json(response())).mockResolvedValueOnce(json(response({ reply: 'Segunda resposta.' })));
    render(<Chat />);
    const user = await send('  Quero conhecer os cursos  ');
    await screen.findByText('Olá! Como posso ajudar?');
    expect(request.mock.calls[0]?.[0]).toBe('/api/chat');
    expect(submittedBody(0)).toEqual({ message: 'Quero conhecer os cursos' });
    expect(input().value).toBe('');
    await user.type(input(), 'Me conte mais.');
    await user.keyboard('{Enter}');
    await screen.findByText('Segunda resposta.');
    expect(submittedBody(1)).toEqual({ message: 'Me conte mais.', conversationId: 'conversation_server' });
    expect(screen.getAllByRole('article', { name: 'Mensagem do visitante' })).toHaveLength(2);
    expect(screen.getAllByRole('article', { name: 'Resposta do assistente' })).toHaveLength(2);
  });

  it('não envia texto vazio ou espaços', async () => {
    render(<Chat />);
    const user = userEvent.setup();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Enviar/ }).disabled).toBe(true);
    await user.type(input(), '   ');
    await user.keyboard('{Enter}');
    fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
    expect(request).not.toHaveBeenCalled();
  });

  it('bloqueia botão, campo, nova conversa e submits simultâneos durante processamento', async () => {
    let finish!: (value: Response) => void;
    request.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    render(<Chat />);
    const user = await send();
    expect(screen.getByRole('status').textContent).toContain('Preparando sua resposta');
    expect(input().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Enviando/ }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Nova conversa/ }).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
    await user.keyboard('{Enter}{Enter}');
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { finish(json(response())); });
    await screen.findByText('Olá! Como posso ajudar?');
    expect(input().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Shift+Enter insere quebra de linha e Enter envia', async () => {
    request.mockResolvedValue(json(response()));
    render(<Chat />);
    const user = userEvent.setup();
    await user.type(input(), 'Olá');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input(), 'Quero inglês.');
    expect(input().value).toBe('Olá\nQuero inglês.');
    expect(request).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await screen.findByText('Olá! Como posso ajudar?');
    expect(submittedBody(0)).toEqual({ message: 'Olá\nQuero inglês.' });
  });

  it('Enter durante composição de caracteres não envia', () => {
    render(<Chat />);
    fireEvent.change(input(), { target: { value: 'Olá' } });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['http', 'network', 'invalid', 'not-json'] as const)('preserva o texto após erro %s e permite repetir sem duplicar o turno', async (failure) => {
    if (failure === 'http') request.mockResolvedValueOnce(json({ error: { code: 'CHAT_ERROR', message: 'INTERNAL_SECRET' } }, 500));
    if (failure === 'network') request.mockRejectedValueOnce(new Error('INTERNAL_SECRET'));
    if (failure === 'invalid') request.mockResolvedValueOnce(json({ ...response(), results: [{ invented: true }] }));
    if (failure === 'not-json') request.mockResolvedValueOnce(new Response('<html>INTERNAL_SECRET</html>'));
    request.mockResolvedValueOnce(json(response({ reply: 'Agora consegui responder.' })));
    render(<Chat />);
    const user = await send('Minha pergunta');
    await screen.findByRole('alert');
    expect(input().value).toBe('Minha pergunta');
    expect(screen.queryByRole('article', { name: 'Resposta do assistente' })).toBeNull();
    expect(document.body.textContent).not.toContain('INTERNAL_SECRET');
    expect(input().disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: /Tentar novamente/ }));
    await screen.findByText('Agora consegui responder.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('article', { name: 'Mensagem do visitante' })).toHaveLength(1);
    expect(submittedBody(1)).toEqual(submittedBody(0));
  });

  it('preserva o ID conhecido e os turnos anteriores após erro HTTP', async () => {
    request.mockResolvedValueOnce(json(response())).mockResolvedValueOnce(json({ error: { code: 'CHAT_ERROR', message: 'Falha' } }, 500))
      .mockResolvedValueOnce(json(response({ reply: 'Resposta recuperada.' })));
    render(<Chat />);
    await send('Primeira pergunta');
    await screen.findByText('Olá! Como posso ajudar?');
    const user = await send('Segunda pergunta');
    await screen.findByRole('alert');
    expect(screen.getByText('Olá! Como posso ajudar?')).toBeDefined();
    await user.click(screen.getByRole('button', { name: /Tentar novamente/ }));
    await screen.findByText('Resposta recuperada.');
    expect(submittedBody(2)).toEqual({ message: 'Segunda pergunta', conversationId: 'conversation_server' });
  });

  it('404 exige iniciar outra conversa e abandona o ID inválido, preservando o rascunho', async () => {
    request.mockResolvedValueOnce(json(response())).mockResolvedValueOnce(json({ error: { code: 'NOT_FOUND', message: 'Conversa ausente.' } }, 404))
      .mockResolvedValueOnce(json(response({ conversationId: 'new_conversation', reply: 'Nova conversa iniciada.' })));
    render(<Chat />);
    await send('Primeira pergunta');
    await screen.findByText('Olá! Como posso ajudar?');
    const user = await send('Quero continuar');
    expect((await screen.findByRole('alert')).textContent).toContain('não está mais disponível');
    expect(input().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Enviar mensagem' }));
    expect(request).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Iniciar nova conversa' }));
    expect(input().value).toBe('Quero continuar');
    expect(input().disabled).toBe(false);
    expect(screen.queryByRole('article', { name: 'Mensagem do visitante' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Enviar/ }));
    await screen.findByText('Nova conversa iniciada.');
    expect(submittedBody(2)).toEqual({ message: 'Quero continuar' });
  });

  it('uma nova montagem não recupera ID nem histórico da sessão anterior', async () => {
    request.mockImplementation(async () => json(response()));
    const view = render(<Chat />);
    await send();
    await screen.findByText('Olá! Como posso ajudar?');
    view.unmount();
    render(<Chat />);
    expect(screen.queryByRole('article', { name: 'Resposta do assistente' })).toBeNull();
    await send('Outra conversa');
    await screen.findByText('Olá! Como posso ajudar?');
    expect(submittedBody(1)).toEqual({ message: 'Outra conversa' });
  });

  it('mostra somente os dados estruturados da escola no cartão oficial', async () => {
    request.mockResolvedValue(json(response({ reply: 'Nome inventado na prosa.', results: [
      { tool: 'get_school_info', result: { ok: true, data: { school } } },
    ] })));
    render(<Chat />);
    await send('Qual a escola?');
    const card = await screen.findByRole('article', { name: 'Sobre a escola' });
    for (const value of [school.name, school.description, school.address, school.contact, school.openingHours]) {
      expect(within(card).getByText(value)).toBeDefined();
    }
    expect(card.textContent).not.toContain('Nome inventado');
  });

  it('mostra cursos somente de results, mesmo quando reply cita outro curso', async () => {
    request.mockResolvedValue(json(response({ reply: 'Curso inventado na prosa.', results: [
      { tool: 'get_courses', result: { ok: true, data: { courses: [
        { id: course.id, name: course.name, language: course.language, modality: course.modality, active: true },
      ] } } },
    ] })));
    render(<Chat />);
    await send();
    const list = await screen.findByRole('region', { name: 'Cursos disponíveis' });
    expect(within(list).getByRole('heading', { name: course.name })).toBeDefined();
    expect(within(list).getByText('Online')).toBeDefined();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list.textContent).not.toContain('Curso inventado');
  });

  it.each([
    { price: course.price, expected: /R\$\s*350,00/, period: 'por mês' },
    { price: null, expected: /Preço não informado/, period: null },
    { price: { amountCents: 0, currency: 'BRL', billingPeriod: 'course' } as const, expected: /R\$\s*0,00/, period: 'por curso' },
  ])('renderiza detalhes e preço oficial $expected sem consultar a prosa', async ({ price, expected, period }) => {
    request.mockResolvedValue(json(response({ reply: 'O curso custa R$ 999.', results: details({ ...course, price }) })));
    render(<Chat />);
    await send();
    const card = await screen.findByRole('article', { name: 'Detalhes do curso' });
    expect(within(card).getByRole('heading', { name: course.name })).toBeDefined();
    expect(within(card).getByText(course.description)).toBeDefined();
    expect(within(card).getByText(/Inglês · Online/)).toBeDefined();
    expect(within(card).getByText(expected)).toBeDefined();
    if (period) expect(within(card).getByText(period)).toBeDefined();
    expect(card.textContent).not.toContain('999');
    expect(screen.getByText('O curso custa R$ 999.')).toBeDefined();
  });

  it('prosa de sucesso e pendingAction null não criam recibos ou confirmações', async () => {
    request.mockResolvedValue(json(response({ reply: 'Cadastro realizado. Aula agendada. Reserva confirmada.' })));
    render(<Chat />);
    await send();
    await screen.findByText('Cadastro realizado. Aula agendada. Reserva confirmada.');
    expect(screen.queryByRole('region', { name: 'Informações da escola' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Recibo|Protocolo/)).toBeNull();
  });

  it('renderiza o texto da LLM literalmente sem criar HTML', async () => {
    const reply = '<img src=x onerror=alert(1)><script>alert(1)</script><b>Olá</b>';
    request.mockResolvedValue(json(response({ reply })));
    render(<Chat />);
    await send();
    await screen.findByText(reply);
    const assistant = screen.getByRole('article', { name: 'Resposta do assistente' });
    expect(assistant.querySelector('img, script, b')).toBeNull();
  });

  it('apresenta lista vazia e falha de consulta como resultados legíveis', async () => {
    request.mockResolvedValue(json(response({ results: [
      { tool: 'get_courses', result: { ok: true, data: { courses: [] } } },
      { tool: 'get_course_details', result: { ok: false, error: { code: 'NOT_FOUND', message: 'Detalhe técnico.' } } },
    ] })));
    render(<Chat />);
    await send();
    await screen.findByText('Nenhum curso disponível no momento.');
    expect(screen.getByText(/Este curso não está disponível/)).toBeDefined();
    expect(screen.queryByText('Detalhe técnico.')).toBeNull();
  });

  it('encaminha apenas /api/chat ao Fastify pelo rewrite do Next', async () => {
    expect(await nextConfig.rewrites?.()).toEqual([
      { source: '/api/chat', destination: 'http://127.0.0.1:3001/api/chat' },
    ]);
  });
});
