# SupportFlow AI

Fundação do MVP para escolas de idiomas, seguindo exclusivamente
[`language-school-sales-mvp`](openspec/changes/language-school-sales-mvp/proposal.md).
As tasks 1.1 a 2.3 entregam a fundação, os contratos públicos e o catálogo escolar
em memória com três tools de leitura. Chat, integração com agente, cadastro e
agendamento serão implementados nos milestones seguintes.

## Executar localmente

Requisitos: Node.js 24 e npm 11. Se usar nvm, execute `nvm use` na raiz.

```sh
npm ci
npm run dev
```

- Frontend: http://127.0.0.1:3000 — página inicial estática.
- API: http://127.0.0.1:3001/health — responde `{"status":"ok"}`.
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
Nesta etapa, a configuração é validada, mas nenhum modelo é instanciado ou
chamado. A composição carrega o catálogo fictício de `school_demo`; outro
`SCHOOL_ID` interrompe a inicialização, sem alterar os dados cadastrados.

## Estrutura e decisões

```text
apps/api/src/
  core/                       servidor HTTP e configuração do provedor
  modules/language-school/    domínio, consultas, tools e catálogo em memória
  app.ts                      composição manual, testável sem escutar uma porta
  main.ts                     ambiente do processo, escuta e encerramento
apps/web/                     aplicação Next.js
packages/contracts/           schemas e tipos públicos de chat e atendimento escolar
```

Todos os workspaces herdam TypeScript strict. O core não importa o módulo escolar;
`app.ts` conecta explicitamente as partes, sem sistema de plugins. As consultas
dependem de `SchoolRepository`; a implementação em memória fica na infraestrutura.
As tools estão disponíveis no backend como `catalogTools`, ainda sem agente ou
rotas de chat. A interface do repositório, fixtures e erros estão descritos no
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
