import { randomUUID } from 'node:crypto';

export type ActionDefinition = { kind: string; args: unknown; preview: unknown };
export type ActionReceipt = { reply: string; results: unknown[] };
export type PreparedAction<Definition extends ActionDefinition> = Definition & {
  actionId: string;
  conversationId: string;
  revision: number;
};
export type ActionExecutor<Definition extends ActionDefinition> = (
  action: PreparedAction<Definition>,
) => Promise<unknown>;

type StoredAction<Definition extends ActionDefinition, Receipt> = { action: PreparedAction<Definition> } & (
  | { status: 'pending' | 'stale' }
  | { status: 'completed'; receipt: Receipt }
);

// Somente lifecycle local. Tipos de operação, argumentos e recibos vêm do módulo.
export class InMemoryPendingActions<Definition extends ActionDefinition, Receipt extends ActionReceipt> {
  private readonly actions = new Map<string, StoredAction<Definition, Receipt>>();
  private readonly current = new Map<string, string>();

  constructor(
    private readonly parseDefinition: (proposal: unknown) => Definition,
    private readonly parseReceipt: (receipt: unknown) => Receipt,
  ) {}

  prepare(conversationId: string, revision: number, proposal: unknown) {
    const staged = this.stage(conversationId, revision, proposal);
    staged.commit();
    return staged.preview;
  }

  // Rascunho privado ao turno: validar/gerar ID não altera o lifecycle global.
  stage(conversationId: string, revision: number, proposal: unknown) {
    const definition = structuredClone(this.parseDefinition(proposal));
    const action = {
      ...definition, actionId: randomUUID(), conversationId, revision,
    };
    return {
      preview: this.publicPreview(action),
      // Somente operações síncronas em memória, depois da validação da resposta.
      commit: () => {
        this.invalidateCurrent(conversationId);
        this.actions.set(action.actionId, { action, status: 'pending' });
        this.current.set(conversationId, action.actionId);
      },
    };
  }

  // Leitura sem mutação permite validar a resposta antes de salvar o turno.
  pending(conversationId: string, revision: number) {
    const id = this.current.get(conversationId);
    const action = id ? this.actions.get(id) : undefined;
    return action?.status === 'pending' && action.action.revision === revision
      ? this.publicPreview(action.action) : null;
  }

  invalidate(conversationId: string, revision: number): void {
    const id = this.current.get(conversationId);
    const action = id ? this.actions.get(id) : undefined;
    if (action?.status === 'pending' && action.action.revision !== revision) {
      this.invalidateCurrent(conversationId);
    }
  }

  // Retira uma prévia que deixou de exigir confirmação, preservando seu ID como stale.
  invalidateCurrent(conversationId: string): void {
    const id = this.current.get(conversationId);
    const action = id ? this.actions.get(id) : undefined;
    if (action?.status === 'pending') action.status = 'stale';
    this.current.delete(conversationId);
  }

  // Executar sob runExclusive da conversa; a rota nunca consulta a LLM aqui.
  async confirm(conversationId: string, revision: number, actionId: string,
    execute: ActionExecutor<Definition> | undefined,
  ): Promise<{ ok: true; receipt: Receipt } | { ok: false; code: 'NOT_FOUND' | 'ACTION_STALE' }> {
    const action = this.actions.get(actionId);
    if (!action || action.action.conversationId !== conversationId) return { ok: false, code: 'NOT_FOUND' };
    // Recibos são snapshots: revisão posterior não reinterpreta uma conclusão.
    if (action.status === 'completed') return { ok: true, receipt: structuredClone(action.receipt) };
    this.invalidate(conversationId, revision);
    if (action.status === 'stale') return { ok: false, code: 'ACTION_STALE' };
    if (!execute) throw new Error('Executor de confirmação não configurado.');

    const receipt = structuredClone(this.parseReceipt(await execute(structuredClone(action.action))));
    // Commit antes de construir/serializar a resposta HTTP. Retry recupera esta cópia.
    this.actions.set(actionId, { ...action, status: 'completed', receipt });
    this.current.delete(conversationId);
    return { ok: true, receipt: structuredClone(receipt) };
  }

  private publicPreview(action: PreparedAction<Definition>): {
    actionId: string; kind: Definition['kind']; preview: Definition['preview'];
  } {
    return structuredClone({ actionId: action.actionId, kind: action.kind, preview: action.preview });
  }
}
