import { describe, expect, it } from 'vitest';
import { leadSchema } from '@supportflow/contracts/language-school';
import { InMemoryLeadRepository } from '../../src/modules/language-school/infrastructure/in-memory-lead-repository.js';

const input = () => ({
  name: 'Ana', contact: { type: 'email' as const, value: 'ana@example.com' },
  courseId: 'course_english_travel', goal: 'viagem',
});

describe('LeadRepository em memória', () => {
  it('cria ID no backend e recupera apenas pelo escopo da conversa', async () => {
    const repository = new InMemoryLeadRepository();
    expect(await repository.findByConversationId('A')).toBeNull();
    const lead = leadSchema.parse(await repository.createForConversation('A', input()));
    expect(lead.id).not.toBe('A');
    expect(lead.id.length).toBeGreaterThan(0);
    expect(lead).toEqual({ id: lead.id, ...input() });
    expect(await repository.findByConversationId('A')).toEqual(lead);
    expect(await repository.findByConversationId('B')).toBeNull();
    expect(await repository.findByConversationId(lead.id)).toBeNull();
  });

  it('não deduplica por contato/nome entre conversas', async () => {
    const repository = new InMemoryLeadRepository();
    const first = await repository.createForConversation('A', input());
    const second = await repository.createForConversation('B', input());
    expect(first?.id).not.toBe(second?.id);
    expect(await repository.findByConversationId('A')).toEqual(first);
    expect(await repository.findByConversationId('B')).toEqual(second);
  });

  it('protege entrada, retorno da criação e leituras com cópias defensivas', async () => {
    const repository = new InMemoryLeadRepository();
    const original = input();
    const created = await repository.createForConversation('A', original);
    if (!created) throw new Error('Lead esperado.');
    const snapshot = structuredClone(created);
    original.name = 'Outro nome';
    original.contact.value = 'original@example.com';
    created.contact.value = 'retorno@example.com';
    const read = await repository.findByConversationId('A');
    if (!read) throw new Error('Lead esperado.');
    read.contact.value = 'leitura@example.com';
    expect(await repository.findByConversationId('A')).toEqual(snapshot);
  });

  it('recusa substituição e concorrência de criação na mesma conversa sem modificar o lead', async () => {
    const repository = new InMemoryLeadRepository();
    const [first, repeated] = await Promise.all([
      repository.createForConversation('A', input()),
      repository.createForConversation('A', { ...input(), name: 'Maria' }),
    ]);
    expect(first).not.toBeNull();
    expect(repeated).toBeNull();
    expect(await repository.findByConversationId('A')).toEqual(first);
  });

  it.each([
    { ...input(), contact: { type: 'email' as const, value: 'inválido' } },
    { ...input(), id: 'id_escolhido_pelo_modelo' },
    { ...input(), price: 100 },
  ])('valida o registro inteiro antes da gravação: %j', async (data) => {
    const repository = new InMemoryLeadRepository();
    await expect(repository.createForConversation('A', data)).rejects.toThrow();
    expect(await repository.findByConversationId('A')).toBeNull();
  });

  it('atualiza o registro completo preservando o ID em múltiplas atualizações', async () => {
    const repository = new InMemoryLeadRepository();
    const created = leadSchema.parse(await repository.createForConversation('A', input()));
    const first = await repository.updateForConversation('A', { ...input(), name: 'Ana Silva' });
    const second = await repository.updateForConversation('A', { ...input(), name: 'Ana Silva', goal: null });
    expect(first).toEqual({ ...input(), name: 'Ana Silva', id: created.id });
    expect(second).toEqual({ ...input(), name: 'Ana Silva', goal: null, id: created.id });
    expect(await repository.findByConversationId('A')).toEqual(second);
  });

  it('copia entrada e retorno do update e preserva o escopo de outras conversas', async () => {
    const repository = new InMemoryLeadRepository();
    const original = leadSchema.parse(await repository.createForConversation('A', input()));
    const other = await repository.createForConversation('B', input());
    const change = { ...input(), contact: { type: 'email' as const, value: 'novo@example.com' } };
    const updated = await repository.updateForConversation('A', change);
    if (!updated) throw new Error('Lead atualizado esperado.');
    change.name = 'Alterado depois';
    change.contact.value = 'entrada@example.com';
    updated.contact.value = 'retorno@example.com';
    expect(await repository.findByConversationId('A'))
      .toEqual({ ...original, contact: { type: 'email', value: 'novo@example.com' } });
    expect(await repository.findByConversationId('B')).toEqual(other);
  });

  it('update de conversa inexistente ou de um leadId não cria nem altera outro registro', async () => {
    const repository = new InMemoryLeadRepository();
    const lead = leadSchema.parse(await repository.createForConversation('A', input()));
    expect(await repository.updateForConversation('B', input())).toBeNull();
    expect(await repository.updateForConversation(lead.id, input())).toBeNull();
    expect(await repository.findByConversationId('B')).toBeNull();
    expect(await repository.findByConversationId('A')).toEqual(lead);
  });

  it.each([
    { ...input(), contact: { type: 'email' as const, value: 'inválido' } },
    { ...input(), id: 'outro_lead' },
    { ...input(), conversationId: 'B' },
    { ...input(), outcome: 'updated' },
  ])('update inválido não substitui campos nem permite trocar ID/escopo: %j', async (data) => {
    const repository = new InMemoryLeadRepository();
    const original = await repository.createForConversation('A', input());
    const other = await repository.createForConversation('B', input());
    await expect(repository.updateForConversation('A', data)).rejects.toThrow();
    expect(await repository.findByConversationId('A')).toEqual(original);
    expect(await repository.findByConversationId('B')).toEqual(other);
  });
});
