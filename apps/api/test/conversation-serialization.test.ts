import { describe, expect, it } from 'vitest';
import { InMemoryConversations } from '../src/core/conversations.js';

describe('fila local por conversa', () => {
  it('mantém ordem após falha e remove entradas ociosas', async () => {
    const conversations = new InMemoryConversations(() => ({ revision: 0 }));
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = conversations.runExclusive('A', async () => {
      order.push('A1');
      await blocked;
      order.push('falha A1');
      throw new Error('Falha controlada do teste.');
    });
    const rejection = expect(first).rejects.toThrow('Falha controlada');
    const second = conversations.runExclusive('A', () => { order.push('A2'); });
    const other = conversations.runExclusive('B', () => { order.push('B1'); });
    await other;
    expect(order).toEqual(['A1', 'B1']);
    // Verifica explicitamente a ausência de retenção de filas ociosas, sem API pública de diagnóstico.
    expect(conversations).toHaveProperty('queues.size', 1);
    release();
    await Promise.all([rejection, second]);
    expect(order).toEqual(['A1', 'B1', 'falha A1', 'A2']);
    expect(conversations).toHaveProperty('queues.size', 0);
    await conversations.runExclusive('A', () => { order.push('A3'); });
    expect(order.at(-1)).toBe('A3');
    expect(conversations).toHaveProperty('queues.size', 0);
  });
});
