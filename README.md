# SupportFlow AI

Fundação do MVP para escolas de idiomas, seguindo exclusivamente
[`language-school-sales-mvp`](openspec/changes/language-school-sales-mvp/proposal.md).
As tasks 1.1 a 3.1 entregam a fundação, os contratos públicos, o catálogo escolar
e a API de chat com conversas em memória e três tools via LangChain. A interface
de chat, o contexto semântico, o cadastro e o agendamento ficam para as próximas tasks.

## Executar localmente

Requisitos: Node.js 24 e npm 11. Se usar nvm, execute `nvm use` na raiz.

```sh
npm ci
npm run dev
```

- Frontend: http://127.0.0.1:3000 — página inicial estática.
- API: http://127.0.0.1:3001/health — responde `{"status":"ok"}`.
- Chat: `POST http://127.0.0.1:3001/api/chat` — requer modelo configurado para responder.
- `Ctrl+C` encerra os dois processos.

Também é possível iniciar separadamente com `npm run dev:api` e `npm run dev:web`.

## Configuração do backend

Os valores padrão permitem iniciar sem arquivo de ambiente e sem credenciais.
Para personalizar, copie `apps/api/.env.example` para `apps/api/.env`. Os scripts
da API carregam esse arquivo com o suporte nativo do Node.js.

| Variável | Padrão | Uso |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Endereço de escuta da API |
| `PORT` | `3001` | Porta da API |
| `SCHOOL_ID` | `school_demo` | Deve corresponder à única escola das fixtures |
| `OPENAI_API_KEY` | ausente | Credencial opcional do provedor |
| `OPENAI_MODEL` | ausente | Modelo opcional do provedor |

Chave e modelo devem ser configurados juntos e somente em `apps/api/.env` ou no
ambiente do processo da API. Não use prefixo `NEXT_PUBLIC_` para esses valores.
Quando ambos estão presentes, a composição instancia `ChatOpenAI`; somente uma
requisição de chat invoca o modelo. Sem configuração, a aplicação inicia normalmente
e o chat retorna HTTP 500 com `CHAT_ERROR`. A composição carrega `school_demo`; outro
`SCHOOL_ID` interrompe a inicialização, sem alterar os dados cadastrados.

## Consultar pelo chat

Com o provedor configurado no backend:

```sh
curl http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Quais cursos vocês oferecem?"}'
```

A resposta contém `{ conversationId, reply, results, pendingAction }`. Use o
`conversationId` retornado junto à próxima `message` para continuar a conversa.
O navegador pode enviar somente esses dois campos; o ID é gerado pelo backend.
`pendingAction` permanece `null` nesta etapa.

Cada instância da aplicação mantém um `Map` privado de conversas, com ID e
histórico LangChain (usuário, assistente e resultados de ferramentas). O histórico
é salvo apenas depois da conclusão e validação do turno; falhas não deixam chamadas
de ferramenta pendentes no histórico. Reiniciar a API apaga as conversas. Não há
autenticação, expiração ou persistência. A serialização de envios simultâneos da
mesma conversa fica para a etapa de confirmação: nesta versão, envie um turno por
vez. As operações de leitura/gravação já estão centralizadas por conversa.

O turno consulta o modelo com três tools vinculadas, executa as consultas pedidas
e entrega `ToolMessage`s com seus IDs correspondentes. Se houve consultas, uma
segunda chamada ao modelo original, sem tools vinculadas nem `tool_choice`, redige
a resposta. Não há outra rodada de execução de ferramentas.

O campo `results` copia os objetos validados produzidos pelas tools; `reply` contém
somente a prosa do modelo. Texto livre continua probabilístico e não preenche nem
altera os dados oficiais. Uma saudação pode retornar `results: []` sem consultar tools.

| Situação | HTTP | Código público |
| --- | --- | --- |
| Entrada inválida, JSON malformado ou campos adicionais | 400 | `INVALID_REQUEST` |
| Conversa informada não existe | 404 | `NOT_FOUND` |
| Modelo ausente, falha inesperada ou saída inválida | 500 | `CHAT_ERROR` |

`INVALID_INPUT` ou `NOT_FOUND` de uma consulta aparecem em `results` com HTTP 200
quando o modelo consegue concluir o turno. `OPERATION_FAILED` de uma tool interrompe
o atendimento com `CHAT_ERROR`. As mensagens públicas não incluem exceções internas.

## Estrutura e decisões

```text
apps/api/src/
  core/                       HTTP, conversas, fluxo LangChain e configuração
  modules/language-school/    domínio, consultas, tools e catálogo em memória
  app.ts                      composição manual, testável sem escutar uma porta
  main.ts                     ambiente do processo, escuta e encerramento
apps/web/                     aplicação Next.js
packages/contracts/           schemas e tipos públicos de chat e atendimento escolar
```

Todos os workspaces herdam TypeScript strict. O core não importa o módulo escolar;
`app.ts` conecta explicitamente as partes, sem sistema de plugins. As consultas
dependem de `SchoolRepository`; a implementação em memória fica na infraestrutura.
As tools continuam disponíveis como `catalogTools`; um adapter da infraestrutura
escolar as envolve com `tool()` do LangChain, usando os mesmos schemas e casos de uso.
A interface do repositório, fixtures e erros estão descritos no
[README do módulo escolar](apps/api/src/modules/language-school/README.md).

LangChain está instalado somente na API, por meio de `@langchain/core` e
`@langchain/openai`, sem LangGraph. Os contratos compartilhados não dependem do
backend nem exportam sua configuração. O frontend não importa código da API.

Os schemas Zod e as decisões de modelagem estão documentados no
[README dos contratos](packages/contracts/README.md).

## Verificação

```sh
npm test
npm run lint
npm run typecheck
npm run build
```

Os testes usam ambiente fornecido explicitamente, valores fictícios e
`Fastify.inject`, sem credenciais reais, servidor externo ou chamadas de LLM.
`createApplication({}, { model })` aceita um `BaseChatModel` simulado: os testes
usam o `invoke` real do LangChain com respostas programadas, sem o provedor OpenAI.
Não é necessário criar um `.env` para executar testes, typecheck ou build.
Os builds são executados na ordem contracts → API → web.
Como a API agora importa os schemas do pacote compartilhado, os scripts de teste,
typecheck da API e desenvolvimento da API compilam `contracts` antes de usá-lo.
Isso permite executar os comandos após `npm ci`, sem depender de um `dist` antigo.

Para executar os artefatos compilados, use dois terminais após o build:

```sh
npm run start --workspace @supportflow/api
npm run start --workspace @supportflow/web
```
