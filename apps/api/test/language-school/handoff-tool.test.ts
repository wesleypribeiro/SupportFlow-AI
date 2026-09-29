import { afterEach, describe, expect, it, vi } from 'vitest';
import { transferToHumanResultSchema } from '@supportflow/contracts/language-school';
import type { Handoff } from '@supportflow/contracts/language-school';
import { transferToHuman } from '../../src/modules/language-school/application/transfer-to-human.js';
import type { HandoffScope } from '../../src/modules/language-school/application/transfer-to-human.js';
import { InMemoryHandoffRepository } from '../../src/modules/language-school/infrastructure/in-memory-handoff-repository.js';
import { createTransferToHumanTool } from '../../src/modules/language-school/infrastructure/handoff-tool.js';

const scope: HandoffScope = { conversationId: 'conversation_A', visitorIntent: 'request' };
const input = { reason: 'Não quero me cadastrar. Prefiro falar com alguém.' };
afterEach(() => vi.restoreAllMocks());

describe('transfer_to_human determinístico', () => {
  it.each(['request', 'accepted_offer'] as const)('registra após intenção %s sem receber dados de cadastro', async (visitorIntent) => {
    const repository = new InMemoryHandoffRepository();
    const tool = createTransferToHumanTool(repository);
    const result = await tool(input, { ...scope, visitorIntent });
    expect(transferToHumanResultSchema.parse(result)).toEqual({ ok: true, data: {
      request: await repository.findOpenByConversationId(scope.conversationId),
    } });
    expect(result).toMatchObject({ data: { request: { id: expect.any(String), reason: input.reason, status: 'requested' } } });
  });

  it('o caso de uso devolve o registro original, não o motivo da nova chamada', async () => {
    const repository = new InMemoryHandoffRepository();
    const original = await repository.requestForConversation(scope.conversationId, input);
    const result = await transferToHuman(repository, scope, { reason: 'Outro motivo' });
    expect(result).toEqual({ ok: true, data: { request: original } });
    expect(transferToHumanResultSchema.parse(result)).toEqual(result);
  });

  it.each([{}, null, [], { reason: '' }, { reason: ' \t\n ' }, { reason: 2 }, { reason: false }])(
    'rejeita entrada incompatível sem acessar o repository: %j', async (value) => {
      const repository = new InMemoryHandoffRepository();
      const write = vi.spyOn(repository, 'requestForConversation');
      const result = await createTransferToHumanTool(repository)(value, scope);
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(result).not.toHaveProperty('data');
      expect(transferToHumanResultSchema.safeParse(result).success).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(await repository.findOpenByConversationId(scope.conversationId)).toBeNull();
    },
  );

  it.each(['conversationId', 'leadId', 'status', 'requestId', 'id', 'confirmed', 'visitorIntent', 'revision'])(
    'rejeita campo extra %s; a LLM não escolhe escopo, ID, status ou intenção', async (key) => {
      const repository = new InMemoryHandoffRepository();
      const write = vi.spyOn(repository, 'requestForConversation');
      const result = await createTransferToHumanTool(repository)({ ...input, [key]: key === 'confirmed' ? true : 'conversation_B' }, scope);
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(write).not.toHaveBeenCalled();
      expect(await repository.findOpenByConversationId('conversation_B')).toBeNull();
    },
  );

  it('sem pedido nem aceitação da oferta, a operação não registra', async () => {
    const repository = new InMemoryHandoffRepository();
    const write = vi.spyOn(repository, 'requestForConversation');
    const result = await createTransferToHumanTool(repository)(input, { ...scope, visitorIntent: null });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(write).not.toHaveBeenCalled();
    expect(await repository.findOpenByConversationId(scope.conversationId)).toBeNull();
  });

  it('um valor inválido de intenção interna não é considerado pedido', async () => {
    const repository = new InMemoryHandoffRepository();
    const result = await createTransferToHumanTool(repository)(input, { ...scope, visitorIntent: true as never });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await repository.findOpenByConversationId(scope.conversationId)).toBeNull();
  });

  it('falha técnica anterior à escrita não emite protocolo; retry pode registrar', async () => {
    const repository = new InMemoryHandoffRepository();
    vi.spyOn(repository, 'requestForConversation').mockRejectedValueOnce(new Error('INTERNAL_SECRET stack infrastructure'));
    const tool = createTransferToHumanTool(repository);
    const result = await tool(input, scope);
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain('INTERNAL_SECRET');
    expect(await repository.findOpenByConversationId(scope.conversationId)).toBeNull();
    const retried = await tool(input, scope);
    expect(retried).toEqual({ ok: true, data: { request: await repository.findOpenByConversationId(scope.conversationId) } });
  });

  it.each([
    {}, { id: 'fake', reason: 'Texto', status: 'assigned' },
    { id: 'fake', reason: ' ', status: 'requested' },
    { id: 'fake', reason: 'Texto', status: 'requested', conversationId: 'leaked' },
  ])('não publica resultado interno inválido: %j', async (value) => {
    const repository = new InMemoryHandoffRepository();
    vi.spyOn(repository, 'requestForConversation').mockResolvedValueOnce(value as Handoff);
    const result = await createTransferToHumanTool(repository)(input, scope);
    expect(result).toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } });
    expect(result).not.toHaveProperty('data');
    expect(JSON.stringify(result)).not.toContain('fake');
    expect(await repository.findOpenByConversationId(scope.conversationId)).toBeNull();
  });
});
