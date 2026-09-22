# SupportFlow AI

Fundação do MVP para escolas de idiomas, seguindo exclusivamente
[`language-school-sales-mvp`](openspec/changes/language-school-sales-mvp/proposal.md).
As tasks 1.1 a 3.4 entregam a fundação, os contratos públicos, o catálogo escolar
e a API de chat com histórico e contexto vigente em memória, além de três tools
via LangChain, a interface de chat e a política de consultas por turno.
Cadastro e agendamento ficam para as próximas tasks.

## Executar localmente

Requisitos: Node.js 24 e npm 11. Se usar nvm, execute `nvm use` na raiz.

```sh
npm ci
npm run dev
```

- Frontend: http://127.0.0.1:3000 — chat com dados fictícios.
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

Com o provedor configurado no backend, abra o frontend e envie uma mensagem.
Enter envia; Shift+Enter insere uma nova linha. O Next.js encaminha `/api/chat`
para o Fastify local em `127.0.0.1:3001`, por rewrite, sem duplicar a rota.
Também é possível consultar pelo terminal:

```sh
curl http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Quais cursos vocês oferecem?"}'
```

A resposta contém `{ conversationId, reply, results, pendingAction }`. Use o
`conversationId` retornado junto à próxima `message` para continuar a conversa.
O navegador pode enviar somente esses dois campos; o ID é gerado pelo backend.
`pendingAction` permanece `null` nesta etapa.

O frontend mantém somente o histórico visual de cada turno, o ID retornado, o
rascunho e os estados de envio/erro. Não recebe nem replica o contexto interno.
Recarregar a página inicia outra conversa; não há cookies ou armazenamento local
de conversas. Os cards de escola, cursos e preços usam exclusivamente `results`;
a prosa de `reply` é exibida como texto, sem gerar fatos ou recibos. Preço `null`
aparece como não informado; zero aparece como `R$ 0,00`.

Durante o processamento, novos envios ficam bloqueados. Erros de rede, HTTP ou
envelope inválido preservam o rascunho para nova tentativa. Uma conversa removida
retorna `404/NOT_FOUND`: a interface permite iniciar outra explicitamente, sem
reutilizar o ID inválido. A organização e a verificação visual estão no
[README do frontend](apps/web/README.md).

Cada instância da aplicação mantém um `Map` privado de conversas, com ID,
histórico LangChain e contexto atual separado. Histórico e contexto são salvos
juntos apenas depois da conclusão e validação do turno; falhas não deixam chamadas
de ferramenta pendentes ou mudanças parciais de contexto. Reiniciar a API apaga as conversas. Não há
autenticação, expiração ou persistência. A serialização de envios simultâneos da
mesma conversa fica para a etapa de confirmação: nesta versão, envie um turno por
vez. As operações de leitura/gravação já estão centralizadas por conversa.

Primeiro, o mesmo modelo interpreta uma proposta estruturada de atualização do
contexto, que o backend valida e aplica. Em seguida, o atendimento usa o contexto
vigente em uma mensagem de sistema separada do histórico. O modelo tem três tools
comerciais disponíveis, e as consultas retornam `ToolMessage`s com seus IDs
correspondentes. Se houve consultas, uma chamada final ao modelo original, sem
tools vinculadas nem `tool_choice`, redige a resposta. São duas chamadas de modelo
sem consultas ou três com consultas, em sequência fixa, sem loop aberto.

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

## Contexto vigente

O contexto interno começa assim, sem alterar `ChatRequest` ou a resposta pública:

```json
{
  "goal": null,
  "name": null,
  "contact": null,
  "courseId": null,
  "slotId": null,
  "leadId": null,
  "revision": 0
}
```

Na conversa “Quero inglês para viagem” seguida de “Na verdade, quero principalmente
para entrevistas de emprego”, o histórico preserva ambas as declarações, enquanto
`goal` passa de `viagem` para `entrevistas de emprego`. A revisão passa de 0 para 1
e depois para 2. Campos não alterados, como nome, contato e curso, são preservados.
Reaplicar os mesmos valores ou não propor alterações mantém a revisão.

A interpretação usa `withStructuredOutput` do LangChain com o mesmo modelo
injetado e somente mensagens do visitante. Uma proposta não modifica a conversa:
Zod e `applyContextPatch` validam os campos antes de produzir uma nova cópia.
Alterações de objetivo, nome e contato precisam aparecer literalmente na mensagem
atual; uma resposta anterior do assistente não serve de fonte. Repetir exatamente
o valor vigente é no-op, mesmo sem nova menção, e não aumenta a revisão. Contato
repetido exige igualdade de `type` e `value`, sem normalização. Um valor antigo
substituído continua sujeito à validação da mensagem atual. Formatos de contato
seguem os schemas já aprovados. Falha de interpretação, validação, catálogo ou
atendimento retorna `CHAT_ERROR` e preserva integralmente o turno anterior.

Decisões conservadoras desta etapa: `null` na proposta significa **não alterar**,
enquanto `null` no contexto significa **ainda não informado**; não há comando de
exclusão de campos. Paráfrases que não aparecem na mensagem atual são rejeitadas.
Curso é associado por ID exato, nome ou idioma sem diferenciar maiúsculas/minúsculas,
desde que a referência identifique uma única opção ativa no catálogo consultado pelo
`SchoolRepository`. Referência inventada, inativa, ausente ou ambígua mantém o curso
anterior. Não há resolução semântica avançada de cursos. `slotId` e `leadId` continuam
`null`: o patch não pode criar horários, leads ou alterar a revisão diretamente.

A validação limita a origem e o formato dos valores; a interpretação de intenção
continua probabilística. O contexto não contém preços, disponibilidade ou fatos da
escola, que continuam vindo exclusivamente dos resultados estruturados das tools.

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
usam `invoke` e o parser de structured output reais do LangChain com respostas
programadas. O teste do SDK OpenAI usa transporte simulado, sem acesso ao provedor.
O frontend usa o mesmo Vitest, com jsdom e Testing Library; `fetch` é simulado e
nenhum teste de interface depende da API em execução. Os testes verificam envios,
recuperação, histórico visual e cards oficiais mesmo com prosa divergente.
Não é necessário criar um `.env` para executar testes, typecheck ou build.
Os builds são executados na ordem contracts → API → web.
Os scripts de teste, typecheck e desenvolvimento dos apps compilam `contracts`
antes de usá-lo.
Isso permite executar os comandos após `npm ci`, sem depender de um `dist` antigo.

Para executar os artefatos compilados, use dois terminais após o build:

```sh
npm run start --workspace @supportflow/api
npm run start --workspace @supportflow/web
```
