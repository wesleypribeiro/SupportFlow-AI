# SupportFlow AI

Fundação do MVP para escolas de idiomas, seguindo exclusivamente
[`language-school-sales-mvp`](openspec/changes/language-school-sales-mvp/proposal.md).
As tasks 1.1 a 5.4 entregam contratos estritos, catálogo, chat com contexto em memória,
cadastro confirmado e agenda demonstrativa com reserva atômica e recibos históricos.
O agente dispõe de seis tools: `get_school_info`, `get_courses`, `get_course_details`,
`get_available_slots`, `create_lead` e `schedule_trial_class`. Cadastro e reserva
exigem prévia oficial e confirmação específica por IDs em `/api/chat/confirm`.
O frontend apresenta horários, prévias e recibos exclusivamente do backend.
Uma falha da LLM depois da reserva preserva o resultado com mensagem determinística.
A task 6.1 acrescenta a operação interna de solicitação de atendimento humano,
com um registro local por conversa, inclusive sem cadastro. Sua integração ao
agente e apresentação no chat permanecem para a task 6.2; não há atendentes
conectados ou envio para serviços externos.

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
Enter envia; Shift+Enter insere uma nova linha. O Next.js encaminha `/api/chat` e `/api/chat/confirm`
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
`pendingAction` permanece `null` no fluxo normal: nenhuma tool de escrita está conectada.
Quando uma ação é preparada internamente pelo backend, esse campo publica somente
`{ actionId, kind, preview }` da ação vigente.

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
autenticação, expiração ou persistência. Mensagens e confirmações compartilham
`conversations.runExclusive`: uma fila local de promises por `conversationId`.
Cada operação lê o estado quando chega sua vez; falhas não bloqueiam as seguintes.
Conversas diferentes prosseguem independentemente e entradas da fila são removidas
quando ficam ociosas.

Primeiro, o mesmo modelo interpreta uma proposta estruturada de atualização do
contexto, que o backend valida e aplica. Em seguida, o atendimento usa o contexto
vigente em uma mensagem de sistema separada do histórico. O modelo tem as três consultas de catálogo e `create_lead` disponíveis. As tools retornam `ToolMessage`s com seus IDs
correspondentes. Se houve consultas, uma chamada final ao modelo original, sem
tools vinculadas nem `tool_choice`, redige a resposta. São duas chamadas de modelo
sem consultas ou três com consultas, em sequência fixa, sem loop aberto.

O campo `results` copia os objetos validados produzidos pelas tools; `reply` contém
somente a prosa do modelo. Texto livre continua probabilístico e não preenche nem
altera os dados oficiais. Uma saudação pode retornar `results: []` sem consultar tools.

| Situação | HTTP | Código público |
| --- | --- | --- |
| Entrada inválida, JSON malformado ou campos adicionais | 400 | `INVALID_REQUEST` |
| Conversa/ação inexistente ou ação de outra conversa | 404 | `NOT_FOUND` |
| Confirmação de ação substituída ou de revisão antiga | 409 | `ACTION_STALE` |
| Modelo ausente, falha inesperada ou saída inválida | 500 | `CHAT_ERROR` |

`INVALID_INPUT` ou `NOT_FOUND` de uma consulta aparecem em `results` com HTTP 200
quando o modelo consegue concluir o turno. `OPERATION_FAILED` de uma tool interrompe
o atendimento com `CHAT_ERROR`. As mensagens públicas não incluem exceções internas.

## Infraestrutura de confirmação

`POST /api/chat/confirm` aceita somente `{ conversationId, actionId }`. Campos como
`args`, `confirmed`, `revision` ou dados de negócio retornam `400/INVALID_REQUEST`.
Texto “Sim” enviado ao chat não autoriza a execução. A confirmação não consulta a LLM.

O core guarda ações em memória com ID, conversa, tipo, argumentos capturados,
revisão, prévia e estado `pending`, `stale` ou `completed`. A composição escolar
valida a prévia usando os contratos existentes e deriva dela os argumentos, sem
aceitar uma segunda versão editável. Cópias defensivas protegem a preparação,
as leituras, os argumentos entregues ao executor e os recibos.

Há somente uma prévia pendente vigente por conversa. Preparar outra invalida a
anterior; mudar a revisão após um turno bem-sucedido também a invalida. Um turno
que falha não salva histórico/contexto nem invalida a ação. IDs invalidados são
retidos para responder `ACTION_STALE`, e recibos concluídos para repetição segura.
Esses registros desaparecem ao reiniciar o processo.

`createApplication` oferece `prepareAction(conversationId, { kind, preview })`
somente para composição interna, passando pela mesma fila das rotas, e aceita
`executeAction` como dependência opcional. O executor recebe uma cópia da ação
armazenada, inclusive seus argumentos e vínculo. O executor padrão cria ou atualiza
o lead da conversa ou confirma a aula, conforme o tipo da ação. A suíte da
infraestrutura também injeta executores simulados compatíveis com os contratos.

O recibo validado (`reply` e `results`) é salvo antes de construir/enviar a resposta
HTTP. Uma repetição verifica o vínculo e devolve esse snapshot antes de avaliar a
revisão atual, sem chamar novamente o executor, inclusive após falha de envio ou
mudança de contexto. O envelope continua mostrando a prévia **atualmente** pendente,
quando existir outra; o recibo original não muda. Falha técnica antes de registrar
um recibo válido retorna `500/CHAT_ERROR`. A UI oferece “Confirmar cadastro” somente para a prévia atual do backend.

Na confirmação de aula, indisponibilidade é um resultado de negócio em `results`
com HTTP 200, seguindo o fluxo de recibo definido na task 5.3. Esse recibo também
é salvo; o retry do mesmo actionId não volta a disputar a vaga. Uma nova chamada
para o mesmo lead/slot retorna `existing`; uma nova chamada de outro lead retorna
`SLOT_UNAVAILABLE`. A consulta de horários passa a excluir a vaga ocupada.

O backend oferece `prepareLead(conversationId, input)` para exercitar diretamente
`create_lead`, dentro da fila da conversa. O retorno separa `result` de `pendingAction`.
Esse método é um acesso interno; o adapter LangChain usa o mesmo caso de uso. Entrada
estrita válida deve corresponder exatamente a nome, contato (`type` e `value`),
curso e objetivo do contexto atual. O curso também deve continuar ativo no
`SchoolRepository`. Cadastro inicial ou dados diferentes retornam
`CONFIRMATION_REQUIRED` sem gravar. Dados idênticos retornam `existing` imediatamente,
usando o registro do repository, sem ação pendente, escrita ou nova revisão.
Uma prévia redundante é invalidada; seus IDs antigos continuam retornando `ACTION_STALE`.

Na confirmação, o executor usa os argumentos armazenados, revalida contexto e
catálogo e compara o lead da conversa com os dados vigentes completos. Sem lead,
cria e retorna `created`; com dados diferentes, atualiza o mesmo ID e retorna
`updated`; com dados idênticos, retorna `existing` sem escrita. Os resultados usam
o registro oficial e passam por `createLeadResultSchema`. O ID criado é associado
a `context.leadId` dentro da mesma fila, sem alterar a revisão ou o histórico. Falha técnica anterior à
gravação retorna `CHAT_ERROR`, não consome um recibo e permite repetir a confirmação.
Falhas de validação/referência retornam resultado estruturado de erro; não criam lead.

O repository oferece consulta, criação e atualização explícita por conversa, com
cópias defensivas, recusa de uma segunda criação e preservação do ID no update.
O registro inteiro é validado antes da substituição. Não há deduplicação por contato.
Lead salvo e `context.leadId` devem corresponder, inclusive quanto à ausência;
inconsistências retornam `OPERATION_FAILED` na tool ou `500/CHAT_ERROR` na confirmação,
sem escrita nem recuperação automática. Corrigir contexto não edita o cadastro:
exige nova prévia e confirmação. Retentar uma ação concluída retorna seu recibo
histórico, sem consultar o estado atual para redefinir o outcome. `create_lead` também está vinculada ao LangChain, mas apenas propõe cadastro/atualização; a confirmação continua exclusiva de `/api/chat/confirm`.

Os testes usam barreiras de promises para comprovar a ordem correção → confirmação,
a execução única em confirmações concorrentes, a independência entre conversas e
a limpeza da fila, sem temporizadores de espera nem serviços externos.

## Cadastro integrado ao chat — task 4.4

O runner fornece `conversationId` e uma cópia do contexto validado do turno ao
adapter por um escopo interno. Esses campos não fazem parte do schema da LLM.
`create_lead` recebe apenas nome, contato, curso e objetivo; os casos de uso
continuam validando sua correspondência com o contexto e o catálogo ativo.
`CONFIRMATION_REQUIRED` é um resultado normal com HTTP 200, encaminhado como
`ToolMessage` e preservado em `results`. `existing` não exige nova confirmação.

Durante a execução das tools, preparar ou retirar uma prévia é somente uma proposta
local do turno. Após a redação, `actions.stage` valida e captura argumentos e ID sem
alterar os Maps globais. A rota valida o envelope completo e então, sem `await`
entre as operações, salva histórico/contexto, invalida a revisão anterior e faz
commit da nova ação (ou retira a prévia redundante). Falhar na tool, redação ou
validação descarta a proposta e conserva a ação anterior. Não há escrita de lead
nesse fluxo. As duas rotas continuam compartilhando a fila por conversa.

A interface mantém apenas a ação atualmente retornada pelo backend. Uma correção
bloqueia temporariamente a confirmação; depois, a resposta substitui, preserva ou
remove a prévia. O botão envia somente os dois IDs. `409/ACTION_STALE` retira a ação
e orienta nova revisão; falha de rede, HTTP 500 ou resposta inválida mantém os mesmos
IDs para repetir a confirmação e recuperar o recibo. Chat e confirmação compartilham
um bloqueio de envio. Resultados `created`, `updated` e `existing` são apresentados
exclusivamente a partir dos dados oficiais, mesmo que a prosa diga outra coisa.

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
anterior. Não há resolução semântica avançada de cursos. Na task 5.4, o interpretador
propõe uma referência de horário com evidência na mensagem atual. O backend revalida
a referência contra as vagas oficiais futuras do curso antes de alterar `slotId`.
Outra seleção incrementa revisão; repetir a seleção não incrementa; trocar curso
limpa o horário. Escolha ambígua preserva o estado e exige esclarecimento.
`leadId` começa `null` e só recebe o ID salvo após confirmação de cadastro. O patch
da LLM não pode criar horários, leads ou alterar a revisão diretamente.

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
