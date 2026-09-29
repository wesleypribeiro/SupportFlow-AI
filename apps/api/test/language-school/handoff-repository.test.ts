import { describe, expect, it } from 'vitest';
import { handoffSchema } from '@supportflow/contracts/language-school';
import type { TransferToHumanInput } from '@supportflow/contracts/language-school';
import { InMemoryHandoffRepository } from '../../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';

const reason = 'Quero falar com um atendente';

describe('InMemoryHandoffRepository', () => {
  it('gera ID no backend e registra somente o objeto público requested', async () => {
    const repository = new InMemoryHandoffRepository();
    expect(await repository.findOpenByConversationId('A')).toBeNull();
    const request = await repository.requestForConversation('A', { reason });
    expect(handoffSchema.parse(request)).toEqual({ id: expect.any(String), reason, status: 'requested' });
    expect(request.id.length).toBeGreaterThan(0);
    expect(request.id).not.toBe('A');
    expect(await repository.findOpenByConversationId('A')).toEqual(request);
  });

  it('repetição devolve ID e motivo originais, sem reescrever o registro', async () => {
    const repository = new InMemoryHandoffRepository();
    const first = await repository.requestForConversation('A', { reason });
    const repeated = await repository.requestForConversation('A', { reason: 'Preciso esclarecer outra dúvida' });
    expect(repeated).toEqual(first);
    expect(repeated).not.toBe(first);
    expect(await repository.findOpenByConversationId('A')).toEqual(first);
  });

  it('conversas diferentes podem ter o mesmo motivo, com registros independentes', async () => {
    const repository = new InMemoryHandoffRepository();
    const a = await repository.requestForConversation('A', { reason });
    expect(await repository.findOpenByConversationId('B')).toBeNull();
    expect(await repository.findOpenByConversationId(a.id)).toBeNull();
    const b = await repository.requestForConversation('B', { reason });
    expect(a.id).not.toBe(b.id);
    expect(await repository.findOpenByConversationId('A')).toEqual(a);
    expect(await repository.findOpenByConversationId('B')).toEqual(b);
  });

  it('entrada e retornos não compartilham referências com o registro interno', async () => {
    const repository = new InMemoryHandoffRepository();
    const input = { reason: '  Quero uma pessoa.  ' };
    const first = await repository.requestForConversation('A', input);
    const original = structuredClone(first);
    input.reason = 'Entrada alterada'; first.reason = 'Retorno alterado'; first.id = 'id_falso';
    const read = (await repository.findOpenByConversationId('A'))!;
    expect(read).toEqual(original); read.reason = 'Leitura alterada';
    const repeated = await repository.requestForConversation('A', { reason: 'Outro motivo' });
    expect(repeated).toEqual(original); repeated.reason = 'Repetição alterada';
    expect(await repository.findOpenByConversationId('A')).toEqual(original);
    expect(original.reason).toBe('  Quero uma pessoa.  ');
  });

  it.each([
    { reason: '' }, { reason: ' \n ' }, { reason: 123 }, { reason, id: 'model_id' }, { reason, status: 'assigned' },
  ])('validação que falha antes da gravação não deixa solicitação parcial: %j', async (input) => {
    const repository = new InMemoryHandoffRepository();
    await expect(repository.requestForConversation('A', input as TransferToHumanInput)).rejects.toThrow();
    expect(await repository.findOpenByConversationId('A')).toBeNull();
    const saved = await repository.requestForConversation('A', { reason });
    await expect(repository.requestForConversation('A', input as TransferToHumanInput)).rejects.toThrow();
    expect(await repository.findOpenByConversationId('A')).toEqual(saved);
  });

  it('não registra solicitação sem identificador válido da conversa', async () => {
    const repository = new InMemoryHandoffRepository();
    await expect(repository.requestForConversation(' ', { reason })).rejects.toThrow();
    expect(await repository.findOpenByConversationId(' ')).toBeNull();
  });

  it('chamadas concorrentes da mesma conversa devolvem uma única solicitação original', async () => {
    const repository = new InMemoryHandoffRepository();
    const reasons = ['Quero um atendente', 'Preciso esclarecer outra dúvida', 'Aceito o encaminhamento'];
    const requests = await Promise.all(reasons.map((value) => repository.requestForConversation('A', { reason: value })));
    const original = (await repository.findOpenByConversationId('A'))!;
    expect(reasons).toContain(original.reason);
    expect(new Set(requests.map((request) => request.id)).size).toBe(1);
    for (const request of requests) expect(request).toEqual(original);
  });
});
