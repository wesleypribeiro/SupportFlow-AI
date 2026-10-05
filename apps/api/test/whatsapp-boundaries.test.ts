import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { WhatsAppMessage, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|js|mjs)$/.test(path) && !/\.test\./.test(path) ? [path] : [];
  });
}
function imports(path: string) {
  return ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles.map((item) => item.fileName);
}

describe('isolamento do canal e dos segredos', () => {
  it('web e contratos só importam arquivos próprios ou dependências públicas, sem config/infra da API', () => {
    for (const directory of ['apps/web/src', 'packages/contracts/src']) {
      const base = resolve(root, directory);
      const files = sources(base);
      if (directory === 'apps/web/src') files.push(resolve(root, 'apps/web/next.config.ts'));
      expect(files.length).toBeGreaterThan(0);
      for (const path of files) {
        const source = readFileSync(path, 'utf8');
        expect(source, path).not.toMatch(/\b(?:META_[A-Z_]+|WHATSAPP_[A-Z_]+|NEXT_PUBLIC_META_[A-Z_]+)\b/);
        // Sem acesso direto, desestruturação ou cópia de env para Next/browser.
        expect(source, path).not.toMatch(/\bprocess\b|import\.meta\.env|dotenv/);
        for (const dependency of imports(path)) {
          if (dependency.startsWith('.')) {
            const ownRoot = directory === 'apps/web/src' ? resolve(root, 'apps/web') : base;
            expect(resolve(dirname(path), dependency).startsWith(ownRoot + sep), `${path}: ${dependency}`).toBe(true);
          } else {
            expect(dependency, path).toMatch(/^(?:react|next|zod|@supportflow\/contracts)(?:\/|$)/);
          }
        }
      }
    }
  });

  it('core não importa canal Meta/WhatsApp nem módulo escolar', () => {
    for (const path of sources(resolve(root, 'apps/api/src/core'))) {
      for (const dependency of imports(path)) {
        expect(dependency, path).not.toMatch(/channels|whatsapp|meta|language-school/i);
      }
    }
  });

  it('canal só acessa tipos do serviço compartilhado, sem importar implementações do core, contratos comerciais, módulos ou SDKs', () => {
    for (const path of sources(resolve(root, 'apps/api/src/channels/whatsapp'))) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/process\.env/);
      for (const dependency of imports(path)) {
        if (dependency.startsWith('.')) {
          if (resolve(dirname(path), dependency) === resolve(root, 'apps/api/src/core/conversation-service.js')) {
            const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
            const declarations = source.statements.filter((statement) => ts.isImportDeclaration(statement)
              && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === dependency);
            expect(declarations.length, path).toBeGreaterThan(0);
            for (const declaration of declarations) {
              expect(ts.isImportDeclaration(declaration) && declaration.importClause?.isTypeOnly, path).toBe(true);
            }
            continue;
          }
          expect(resolve(dirname(path), dependency).startsWith(resolve(root, 'apps/api/src/channels/whatsapp') + sep), path).toBe(true);
        } else {
          expect(['zod', 'fastify', 'node:crypto', '@supportflow/contracts/chat'], path).toContain(dependency);
        }
      }
    }
    // A fronteira de transporte consiste somente em tipos, sem dependência externa.
    expect(imports(resolve(root, 'apps/api/src/channels/whatsapp/transport.ts'))).toEqual([]);
  });
});

describe('contrato interno de transporte normalizado', () => {
  it.each<WhatsAppMessage>([
    { type: 'text', body: 'Conteúdo demonstrativo' },
    { type: 'reply_buttons', body: 'Revisar proposta', buttons: [{ id: 'opaque-reference', title: 'Confirmar' }] },
  ])('aceite de $type exige messageId e preserva destinatário opaco', async (message) => {
    const request: WhatsAppSendRequest = { recipientId: '00090071992547409931234', message };
    const send = vi.fn<WhatsAppTransport['send']>().mockResolvedValue({ status: 'accepted', messageId: 'provider-message' });
    const transport: WhatsAppTransport = { send };
    const result = await transport.send(request);
    expect(send).toHaveBeenCalledWith(request);
    expect(result).toEqual({ status: 'accepted', messageId: 'provider-message' });
    expectTypeOf<Extract<WhatsAppSendResult, { status: 'accepted' }>['messageId']>().toEqualTypeOf<string>();
    expectTypeOf<WhatsAppSendResult['status']>().toEqualTypeOf<'accepted' | 'rejected' | 'unknown'>();
  });

  it.each<WhatsAppSendResult>([
    { status: 'rejected', reason: 'provider_rejection' },
    { status: 'unknown', reason: 'timeout' },
    { status: 'unknown', reason: 'invalid_response' },
    { status: 'unknown', reason: 'network_error' },
  ])('distingue $status/$reason sem fingir entrega ou rejeição em timeout', async (result) => {
    const transport: WhatsAppTransport = { send: async () => result };
    expect(await transport.send({ recipientId: 'opaque-demo-id', message: { type: 'text', body: 'Olá' } })).toEqual(result);
    expectTypeOf<'timeout'>().not.toExtend<Extract<WhatsAppSendResult, { status: 'rejected' }>['reason']>();
    expectTypeOf<{ status: 'accepted' }>().not.toExtend<WhatsAppSendResult>();
    expectTypeOf<keyof WhatsAppSendRequest>().toEqualTypeOf<'recipientId' | 'message'>();
  });
});
