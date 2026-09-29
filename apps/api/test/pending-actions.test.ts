import { describe, expect, it, vi } from 'vitest';
import { createLanguageSchoolPendingActions } from '../src/modules/language-school/infrastructure/pending-actions.js';
import type { LanguageSchoolAction } from '../src/modules/language-school/infrastructure/pending-actions.js';
import type { PreparedAction } from '../src/core/pending-actions.js';

const proposal = () => ({
  kind: 'create_lead' as const,
  preview: {
    name: 'Ana Exemplo', contact: { type: 'email' as const, value: 'ana@example.com' },
    courseId: 'course_english_travel', goal: 'viagem',
  },
});
const receipt = () => ({
  reply: 'Recibo do teste.',
  results: [{ tool: 'create_lead', result: {
    ok: true, data: { outcome: 'created', lead: { id: 'lead_test', ...proposal().preview } },
  } }],
});

describe('snapshots internos de ações', () => {
  it('stage não altera a ação atual e commit usa o snapshot protegido do rascunho', async () => {
    const actions = createLanguageSchoolPendingActions();
    const first = actions.prepare('conversation', 2, proposal());
    const input = proposal();
    const staged = actions.stage('conversation', 2, input);
    input.preview.name = 'Alterado depois';
    if ('name' in staged.preview.preview) staged.preview.preview.name = 'Alterado na leitura';
    expect(actions.pending('conversation', 2)).toEqual(first);
    expect(await actions.confirm('conversation', 2, staged.preview.actionId, undefined))
      .toEqual({ ok: false, code: 'NOT_FOUND' });
    staged.commit();
    expect(actions.pending('conversation', 2)).toEqual({ ...proposal(), actionId: staged.preview.actionId });
    expect(await actions.confirm('conversation', 2, first.actionId, undefined))
      .toEqual({ ok: false, code: 'ACTION_STALE' });
    const execute = vi.fn(async () => receipt());
    await actions.confirm('conversation', 2, staged.preview.actionId, execute);
    expect(execute.mock.calls[0]).toEqual([expect.objectContaining({ args: proposal().preview })]);
  });

  it('não permite que leituras da prévia ou mutação do executor alterem os argumentos capturados', async () => {
    const actions = createLanguageSchoolPendingActions();
    const prepared = actions.prepare('conversation', 2, proposal());
    const exposed = actions.pending('conversation', 2);
    if (exposed && 'contact' in exposed.preview) exposed.preview.contact.value = 'alterado@example.com';
    const failing = vi.fn(async (action: PreparedAction<LanguageSchoolAction>) => {
      if (action.kind !== 'create_lead') throw new Error('Tipo inesperado no teste.');
      action.args.contact.value = 'executor@example.com';
      throw new Error('Falhou antes de concluir.');
    });
    await expect(actions.confirm('conversation', 2, prepared.actionId, failing)).rejects.toThrow();
    const retry = vi.fn(async () => receipt());
    expect((await actions.confirm('conversation', 2, prepared.actionId, retry)).ok).toBe(true);
    expect(retry).toHaveBeenCalledExactlyOnceWith({
      ...proposal(), args: proposal().preview,
      actionId: prepared.actionId, conversationId: 'conversation', revision: 2,
    });
    expect(actions.pending('conversation', 2)).toBeNull();
  });

  it('preserva o recibo contra mutações no retorno do executor e na leitura de uma conclusão', async () => {
    const actions = createLanguageSchoolPendingActions();
    const action = actions.prepare('conversation', 2, proposal());
    const original = receipt();
    const execute = vi.fn(async () => original);
    const completed = await actions.confirm('conversation', 2, action.actionId, execute);
    original.results[0]!.result.data.lead.contact.value = 'alterado@example.com';
    if (!completed.ok) throw new Error('Conclusão esperada.');
    completed.receipt.reply = 'Alterado na leitura';
    completed.receipt.results.splice(0);
    const replay = await actions.confirm('conversation', 99, action.actionId, execute);
    expect(replay).toEqual({ ok: true, receipt: receipt() });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('salva recibo antes da redação, preserva resultados e nunca depende da LLM no retry', async () => {
    const actions = createLanguageSchoolPendingActions();
    const action = actions.prepare('conversation', 2, proposal());
    const execute = vi.fn(async () => receipt());
    const describe = vi.fn(async (_action, official) => {
      // Ainda durante a redação, uma leitura da conclusão já recupera o recibo.
      expect(await actions.confirm('conversation', 99, action.actionId, execute))
        .toEqual({ ok: true, receipt: receipt() });
      official.results.splice(0); // Redator recebe cópia; fatos oficiais não mudam.
      return 'Explicação natural.';
    });
    const completed = await actions.confirm('conversation', 2, action.actionId, execute, describe);
    expect(completed).toEqual({ ok: true, receipt: { ...receipt(), reply: 'Explicação natural.' } });
    expect(await actions.confirm('conversation', 99, action.actionId, execute, describe)).toEqual(completed);
    expect(execute).toHaveBeenCalledTimes(1); expect(describe).toHaveBeenCalledTimes(1);
  });

  it('detecta revisão diferente na própria confirmação mesmo sem invalidação antecipada', async () => {
    const actions = createLanguageSchoolPendingActions();
    const action = actions.prepare('conversation', 2, proposal());
    expect(actions.pending('conversation', 3)).toBeNull();
    const execute = vi.fn(async () => receipt());
    expect(await actions.confirm('conversation', 3, action.actionId, execute))
      .toEqual({ ok: false, code: 'ACTION_STALE' });
    expect(actions.pending('conversation', 2)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('não publica nem registra como concluído um recibo incompatível com o schema', async () => {
    const actions = createLanguageSchoolPendingActions();
    const action = actions.prepare('conversation', 2, proposal());
    await expect(actions.confirm('conversation', 2, action.actionId, async () => ({
      ...receipt(), results: [{ tool: 'invented_tool', result: {} }],
    }))).rejects.toThrow();
    expect(actions.pending('conversation', 2)).toEqual(action);
  });
});
