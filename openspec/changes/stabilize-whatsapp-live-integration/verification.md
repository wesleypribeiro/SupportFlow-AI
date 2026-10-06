# Verificação — estabilização WhatsApp

Data: 2026-10-06. Branch: `fix/whatsapp-integration`. Node 24.21.0, npm 11.19.0, OpenSpec 1.13.1.

## Resultados

| Comando | Resultado |
| --- | --- |
| `npm test -- apps/api/test/whatsapp-webhook.test.ts apps/api/test/whatsapp-logging.test.ts apps/api/test/language-school/conversation-context.test.ts apps/api/test/chat-context.test.ts apps/api/test/whatsapp-text-channel.test.ts` | 257 testes aprovados em 5 arquivos |
| `npm test` | 1.535 testes aprovados em 55 arquivos |
| `npm run typecheck` | Aprovado nos workspaces |
| `npm run lint` | Aprovado na API, contratos e frontend |
| `npm run build` | Aprovado: contratos, API e Next.js |
| `openspec validate stabilize-whatsapp-live-integration --strict` | Aprovado, com informação sobre dependência de consolidação descrita abaixo |
| `git diff --check` | Aprovado |

A execução inicial dos novos testes encontrou três expectativas do próprio teste incompatíveis com os contratos já existentes (rótulo de preço ausente e formato plano `code` da inbox). Elas foram corrigidas sem alterar o produto. A execução focada e a suíte completa posteriores passaram integralmente. O Vitest emitiu somente sugestão de desempenho sobre isolamento de workers; a configuração permaneceu igual.

## Evidências de regressão

- Handshake: trio oficial preservado; aliases completos correspondentes aceitos; todos os subconjuntos parciais, divergências, duplicações oficiais/aliases, extras, aliases sem oficiais, tipos compostos e encoding inválido recusados. Challenge mantém bytes UTF-8 após decodificação, zeros e espaços; credenciais/modo incoerentes continuam 403.
- Logs Pino reais capturados com sentinelas comprovam ausência de queries, headers e segredos no sucesso/erro com aliases. Os testes HTTP de contexto também verificam ausência de logs de diagnóstico em sucesso e falha.
- Goal inferido não altera contexto/revisão/patch recebido; objetivo anterior é preservado. Nome legítimo junto de inferência pode avançar uma revisão; nome/contato sem fonte continuam rejeitando atomicamente o turno.
- API e webhook assinado consultam catálogo/preços com ScriptedChatModel que infere goal e escreve preço divergente. Results permanecem exatamente oficiais, incluindo preço conhecido, ausente e zero; apresentação WhatsApp ignora o preço inventado.
- Prévia atual permanece após consulta com goal inferido. Correção explícita muda revisão e prévia; a ação anterior retorna ACTION_STALE pelo serviço existente, sem gravar cadastro/reserva.
- Tool com objetivo diferente do contexto validado retorna INVALID_INPUT e nenhuma prévia. Cadastro válido com goal desconhecido prepara CONFIRMATION_REQUIRED e não grava até confirmação HTTP específica; depois retorna created com goal null.
- Suíte existente de assinatura/raw body/limite, referências de curso/horário, web, WhatsApp, atomicidade, recibos e concorrência permanece aprovada.

Foram acrescentados 42 casos parametrizados/individuais e substituído o antigo caso que exigia exceção de goal sem fonte pelos novos cenários de descarte: aumento líquido de 41 testes. O teste HTTP de objetivo antigo foi atualizado explicitamente para continuar o atendimento sem persistir o valor obsoleto. As rejeições de dados pessoais não foram relaxadas.

Modelos e transporte foram simulados; casos de uso/repositories e servidor Fastify são reais. Nenhuma chamada real à Meta/OpenAI foi executada. Nenhuma credencial real foi lida, impressa ou modificada; `.env` permaneceu intacto.

## Arquivos revisados e alterados

Diferenças finais em relação ao HEAD:

- `apps/api/src/channels/whatsapp/meta/webhook-security.ts`
- `apps/api/src/modules/language-school/domain/conversation-context.ts`
- `apps/api/src/channels/whatsapp/README.md`
- `apps/api/src/modules/language-school/README.md`
- `apps/api/test/whatsapp-webhook.test.ts`
- `apps/api/test/whatsapp-logging.test.ts`
- `apps/api/test/whatsapp-text-channel.test.ts`
- `apps/api/test/chat-context.test.ts`
- `apps/api/test/language-school/conversation-context.test.ts`

Limpeza adicional dos diffs experimentais, retornando ao HEAD sem mudança funcional: `apps/api/src/core/chat.ts`, `apps/api/src/core/conversation-service.ts`, `apps/api/src/modules/language-school/infrastructure/langchain-context.ts`. Removidos CHAT_DEBUG, CHAT_STAGE, CTX_STAGE e CTX_EVIDENCE_MISMATCH; logs operacionais existentes não foram alterados.

Criados nesta change: `.openspec.yaml`, `proposal.md`, `design.md`, `tasks.md`, `specs/support-chat/spec.md`, `specs/whatsapp-webhooks/spec.md` e este `verification.md`.

## Limites e controle de escopo

Inferência legítima parafraseada ainda pode ser descartada; o visitante pode precisar esclarecer o objetivo literalmente. A correção não elimina o caráter probabilístico da redação. A aceitação dos seis parâmetros é compatibilidade estritamente baseada no ensaio relatado, não aceitação genérica de extras.

OpenSpec validou a change e informou que um archive imediato recusaria o delta MODIFIED de `whatsapp-webhooks`, pois a capability ainda está na change ativa `whatsapp-channel-mvp`, não em `openspec/specs`. Esta dependência está documentada no design: consolidar a capability original antes de aplicar este delta em eventual encerramento. Nenhuma spec consolidada ou artefato da change anterior foi alterado.

`git check-ignore -v` aponta a regra `openspec/` em `.gitignore`: os artefatos novos existem localmente, mas não aparecem no `git status` normal. O ignore não foi modificado; não houve staging forçado nem commit. Sua inclusão no histórico requer decisão posterior do usuário.

Somente a task 1.1 desta estabilização foi concluída. `whatsapp-channel-mvp` permanece com 14/22 tasks marcadas, 5.2 concluída e 5.3 pendente. Sem novas funcionalidades, alteração de contratos, implementação de cliques, commit, push, merge, rebase ou archive.
