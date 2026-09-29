# Frontend de chat

Interface Next.js App Router com React e TypeScript. Consulte o [README principal](../../README.md) para instalação, ambiente, jornada, fixtures e limitações. Na raiz, `npm run dev` inicia a demonstração em http://127.0.0.1:3000; `npm run dev:web` inicia somente o frontend e requer a API em outro processo para conversar.

## Responsabilidades

| Arquivo | Responsabilidade |
| --- | --- |
| [chat.tsx](src/app/chat.tsx) | Histórico visual, rascunho, ID retornado, estado de processamento/erro e `currentPendingAction`. |
| [chat-api.ts](src/app/chat-api.ts) | Envio de mensagens/confirmações e validação Zod de respostas públicas. |
| [catalog-results.tsx](src/app/catalog-results.tsx) | Escola, cursos e preços oficiais; formatação de centavos para BRL. |
| [lead-results.tsx](src/app/lead-results.tsx) | Prévia de cadastro e recibos `created`, `updated` e `existing`. |
| [trial-class-results.tsx](src/app/trial-class-results.tsx) | Horários disponíveis, prévia da aula, recibos e indisponibilidade. |
| [handoff-results.tsx](src/app/handoff-results.tsx) | Protocolo, motivo original, status Solicitado e aviso demonstrativo. |
| [next.config.ts](next.config.ts) | Rewrites `/api/chat` e `/api/chat/confirm` para Fastify em `127.0.0.1:3001`. |

Não há API Route que duplique o Fastify, configuração de LLM, acesso a repositories ou credenciais do provedor no frontend. Mudar o endereço da API exige ajustar os rewrites.

## Estado e fronteiras de confiança

O primeiro envio contém somente `message`; os seguintes acrescentam o `conversationId` recebido. Cada turno visual conserva texto enviado, `reply` e `results`. O componente não replica objetivo, nome, contato, curso, slot ou revisão do contexto interno do backend.

Recarregar ou escolher **Nova conversa** descarta ID/histórico visual. Não há cookies, localStorage, recuperação de sessão ou busca do histórico do servidor. Isso não remove automaticamente a conversa anterior da memória da API.

`reply` é renderizado como texto, sem HTML arbitrário. Cards oficiais usam somente `results`; prévias usam somente `pendingAction`. Preço `null` aparece como não informado e zero como `R$ 0,00`. Horários são formatados a partir do ISO oficial no `timezone` retornado, sem alterar esses dados.

A prévia de cadastro e o recibo da aula exibem `courseId` porque esses contratos não fornecem o nome do curso. A prévia da aula fornece o resumo oficial e permite mostrar o nome. Nenhum nome, preço, protocolo ou sucesso é inferido da prosa.

## Prévias e confirmação

Somente a ação atual é apresentada:

| `kind` | Prévia | Botão |
| --- | --- | --- |
| `create_lead` | Nome, contato, curso e objetivo | **Confirmar cadastro** |
| `schedule_trial_class` | Aluno, curso, data, hora, fuso e aviso demonstrativo | **Confirmar aula experimental** |

Toda resposta válida substitui `currentPendingAction` pelo valor recebido. Enquanto uma mensagem é processada, a confirmação fica desabilitada. Mesmo actionId na resposta reabilita a prévia; outro ID a substitui; `null` a remove. Um turno falho conserva a ação para revisão/retry.

`confirmChatAction` envia exclusivamente `{ conversationId, actionId }`; não reenvia `preview` ou argumentos comerciais. Um ref compartilhado bloqueia mensagens e confirmações simultâneas, inclusive cliques antes do próximo render. Enter envia; Shift+Enter quebra linha; mensagens vazias não são enviadas.

`CONFIRMATION_REQUIRED` informa revisão pendente, sem card de sucesso. `created`/`updated`/`existing` e `SLOT_UNAVAILABLE` vêm exclusivamente dos resultados oficiais. “Sua aula está confirmada” em `reply`, sem recibo correspondente, não marca reserva como concluída.

## Recuperação de erros

- Rede, HTTP ou envelope inválido no envio: rascunho recuperável, sem resposta fictícia. Repetir o mesmo texto falho reutiliza o turno visual.
- `409 / ACTION_STALE`: retira a ação antiga e permite continuar conversando para obter nova prévia.
- Rede, HTTP 500 ou envelope inválido na confirmação: preserva conversa/actionId e oferece **Tentar confirmar novamente**. Reenvia a mesma confirmação, sem chamar o chat para descobrir o resultado; a escrita pode já estar concluída.
- `404 / NOT_FOUND`: informa indisponibilidade e permite iniciar nova conversa. A UI não distingue ação desconhecida de conversa removida, pois o contrato não revela essa diferença.

Sem modelo configurado na API, o chat apresenta `CHAT_ERROR` controlado. O frontend não possui modelo simulado automático.

## Solicitação humana

`transfer_to_human` apresenta somente o protocolo oficial, motivo original e `requested` como **Solicitado**, sem botão de confirmação. O aviso esclarece que nenhum atendimento ao vivo ou notificação externa foi iniciado. Handoff não confirma uma prévia preexistente. Resultados de falha mostram aviso, sem criar protocolo ou card de sucesso.

## Verificação

Na raiz, `npm test` executa também os quatro arquivos `chat*.test.tsx` usando Vitest, jsdom, Testing Library e fetch simulado. Não exige navegador instalado, rede externa ou OpenAI. `npm run typecheck`, `npm run lint` e `npm run build` incluem o frontend.

A homologação integrada 7.1 usou Next/Fastify reais e `ScriptedChatModel` no Chromium, incluindo catálogo, correções de prévias, reserva, perda de resposta/retry e handoff. Viewports de **390 px e 320 px** foram inspecionados sem overflow horizontal. Foram verificadas divergências entre prosa e preço/recibo oficial. A verificação complementar não usou dispositivo físico ou teclado virtual móvel; Playwright não é dependência da suíte obrigatória.

Veja os resultados completos no [registro de validação](../../openspec/changes/archive/2026-09-29-language-school-sales-mvp/verification.md) e o procedimento de [avaliação com modelo real](../../README.md#avaliação-opcional-com-modelo-real).
