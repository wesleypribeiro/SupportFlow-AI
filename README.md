# SupportFlow AI

Assistente de atendimento com IA para **escolas de idiomas**, desenvolvido como projeto Full Stack de portfólio. O MVP consulta informações comerciais, registra o interesse de um visitante, confirma aulas experimentais e registra pedidos locais de atendimento humano.

**Esta versão é uma demonstração:** escola fictícia única, agenda interna e dados em memória. Não é um sistema de produção para armazenar dados reais de alunos.

## Navegação

- [Funcionalidades](#funcionalidades-implementadas) · [Arquitetura](#arquitetura)
- [Instalação](#requisitos-e-instalação) · [Ambiente](#configuração-do-ambiente) · [Execução](#execução-local)
- [Jornada](#fluxo-de-atendimento) · [Tools](#tools-disponíveis) · [API](#contratos-e-endpoints)
- [Fixtures](#dados-demonstrativos) · [Memória](#persistência-e-reinicialização)
- [Confirmação](#confirmação-e-segurança-das-operações) · [Concorrência](#disponibilidade-concorrência-e-recibos) · [Handoff](#atendimento-humano-local)
- [Validação](#testes-e-validação) · [Limitações](#limitações-conhecidas) · [Modelo real](#avaliação-opcional-com-modelo-real) · [Evolução](#próximas-evoluções)

## Funcionalidades implementadas

- Chat responsivo com continuidade na mesma aba, envio por teclado, processamento e recuperação de erros.
- Consulta da escola, catálogo ativo, detalhes, preços e horários cadastrados.
- Contexto atual separado do histórico; correções substituem preferências e invalidam prévias antigas.
- Um lead por conversa: cadastro e atualização confirmados, sem duplicação por repetição.
- Reserva de aula experimental com confirmação específica, uma vaga por slot e recibos históricos.
- Solicitação local de atendimento humano, inclusive sem cadastro, com protocolo e status `requested`.
- Sete tools com entradas/saídas Zod estritas; fatos e recibos oficiais separados da prosa da LLM.
- Testes de domínio, contratos, HTTP, frontend e jornadas integradas sem serviços externos.

O escopo implementado está na change [language-school-sales-mvp](openspec/changes/language-school-sales-mvp/proposal.md). O plano anterior `supportflow-ai-mvp` não foi implementado: clientes e faturas não fazem parte deste produto.

## Arquitetura

```text
apps/web — Next.js / React
    ↓ POST /api/chat; rewrite para Fastify
apps/api — API Fastify
    ↓
Conversation Core — histórico, contexto injetado, ordem por conversa e ações
    ↓
LangChain — interpretação e tool calling no backend
    ↓
Language School Module — adapters → casos de uso determinísticos
    ↓
SchoolRepository / LeadRepository / TrialClassRepository / HandoffRepository
    ↓
Implementações em memória
```

`packages/contracts` compartilha schemas Zod e tipos TypeScript entre API e frontend. Domínio e aplicação não importam LangChain, Fastify, React ou repositories concretos. A composição é explícita em [app.ts](apps/api/src/app.ts); [main.ts](apps/api/src/main.ts) inicia o processo.

A confirmação HTTP segue diretamente do core ao executor determinístico do módulo; a LLM não autoriza a escrita. Na reserva, ela pode redigir uma explicação **depois** de o recibo oficial estar salvo. Todo acesso a dados passa pelos casos de uso/repositories, sem acesso direto da LLM a banco ou fixtures.

O core recebe instruções, tools, contexto e validadores pela composição. Isso permite futuramente compor outro segmento sem colocar regras escolares no core; não há plataforma de plugins ou outro segmento implementado.

Documentação complementar: [frontend](apps/web/README.md), [módulo escolar](apps/api/src/modules/language-school/README.md) e [contratos](packages/contracts/README.md).

## Requisitos e instalação

- **Node.js 24** e **npm 11**, conforme `engines` do [package.json](package.json).
- Ambiente validado: Node 24.21.0, npm 11.19.0 e Fedora 43.
- OpenSpec CLI 1.13.1 para validar a change; é uma ferramenta separada dos workspaces.

Na raiz do checkout:

```bash
# Opcional, se você utiliza nvm:
nvm use

npm ci
```

`npm ci` instala o lockfile e os workspaces `packages/contracts`, `apps/api` e `apps/web`; pode precisar de acesso ao registry para baixar dependências. Não execute instalações separadas dentro dos workspaces.

Para instalar a versão do CLI usada na auditoria, caso ainda não esteja disponível:

```bash
npm install --global @fission-ai/openspec@1.13.1
openspec --version
```

## Configuração do ambiente

A API inicia sem `.env` e sem credenciais. Para usar o provedor real, crie **`apps/api/.env`**, a partir do [template seguro](apps/api/.env.example). Execute a cópia somente se esse arquivo ainda não existir:

```bash
cp apps/api/.env.example apps/api/.env
```

Edite o arquivo local sem versioná-lo. Os scripts `dev` e `start` da API usam o carregamento nativo do Node (`--env-file-if-exists=.env`); variáveis do processo também são aceitas.

| Variável | Padrão | Necessidade |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Opcional; endereço da API |
| `PORT` | `3001` | Opcional; porta da API |
| `SCHOOL_ID` | `school_demo` | Opcional; somente esse ID corresponde às fixtures |
| `OPENAI_API_KEY` | Ausente | Obrigatória para usar OpenAI real; somente no backend |
| `OPENAI_MODEL` | Ausente | Obrigatória junto da chave; modelo disponível na conta com tool calling e structured output compatíveis |

Descomente e preencha as duas variáveis OpenAI somente para a avaliação real. Configurar apenas uma impede a inicialização. Não use `NEXT_PUBLIC_`, não coloque chaves no frontend e não envie configuração do modelo pelo chat.

Sem as duas variáveis, frontend e healthcheck funcionam, mas `/api/chat` retorna `500 / CHAT_ERROR`: **não há modelo demonstrativo automático em `npm run dev`**. O `ScriptedChatModel` é utilizado pelos testes. `SCHOOL_ID` desconhecido também impede a inicialização; não cria outra escola.

## Execução local

Na raiz:

```bash
npm run dev
```

Ou em dois terminais independentes:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Os scripts de desenvolvimento compilam os contratos antes de iniciar cada aplicação.

| Serviço | Endereço |
| --- | --- |
| Chat Next.js | http://127.0.0.1:3000 |
| API Fastify | http://127.0.0.1:3001 |
| Healthcheck | http://127.0.0.1:3001/health |

```bash
curl http://127.0.0.1:3001/health
# {"status":"ok"}
```

O navegador chama `/api/chat` e `/api/chat/confirm` na origem do Next.js. Os [rewrites](apps/web/next.config.ts) encaminham para `127.0.0.1:3001`, sem duplicar a lógica do Fastify. Se alterar `HOST` ou `PORT`, os rewrites precisam corresponder ao endereço escolhido. `Ctrl+C` encerra os processos; o reinício da API perde o estado em memória.

## Fluxo de atendimento

Com o modelo configurado, abra o chat e use dados fictícios. Enter envia; Shift+Enter insere nova linha. Mensagens e confirmações não podem ser enviadas simultaneamente pela UI.

1. Pergunte **“Quais cursos vocês oferecem?”** e confira os cards oficiais.
2. Diga **“Quero inglês para viagem.”** e consulte os detalhes/preço do curso.
3. Informe **“Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.”**
4. Revise a prévia e clique em **Confirmar cadastro**. Confira o resultado oficial.
5. Pergunte **“Quais horários estão disponíveis?”**
6. Escolha uma data/hora realmente retornada, por exemplo **“Escolho 11/06/2030 às 10h.”**
7. Peça para agendar no horário selecionado; revise aluno, curso, data, hora e fuso.
8. Clique em **Confirmar aula experimental**. Confira o recibo oficial, que pode indicar sucesso ou indisponibilidade.
9. Em qualquer momento, diga **“Quero falar com alguém.”** para solicitar atendimento humano local.

Também é possível escolher o horário antes do cadastro; a proposta de reserva exige que o lead já esteja confirmado e corresponda ao contexto vigente. Se faltarem dados, o assistente deve pedir complemento. Alterar objetivo ou contato após cadastrar não atualiza automaticamente o lead: uma nova prévia de cadastro deve ser confirmada antes de prosseguir com a reserva.

A seleção de horário é conservadora: exige uma data e hora explícitas que correspondam a **um único slot oficial elegível** no fuso apresentado. “Amanhã”, “primeira opção”, duas alternativas na mesma mensagem ou evidência de A associada ao ID de B não estabelecem uma nova seleção válida. O backend preserva a anterior e o agente deve pedir esclarecimento.

## Tools disponíveis

Todas têm argumentos estritos; `conversationId`, contexto, revisão e autorização são fornecidos pelo backend, nunca pela LLM.

| Tool | Entrada | Finalidade e efeito |
| --- | --- | --- |
| `get_school_info` | `{}` | Leitura: dados da escola configurada, incluindo endereço, contato, funcionamento e fuso. |
| `get_courses` | `{}` | Leitura: resumos dos cursos ativos. Lista vazia é sucesso; preços estão nos detalhes. |
| `get_course_details` | `{ courseId }` | Leitura: curso ativo completo e preço cadastrado ou `null`. Ausente/inativo retorna `NOT_FOUND`. |
| `get_available_slots` | `{ courseId }` | Leitura: horários futuros e livres do curso ativo, ordenados por instante. Não ocupa vaga. |
| `create_lead` | `{ name, contact: { type, value }, courseId, goal }` | Propõe cadastro/update com dados coerentes com o contexto. Escrita exige prévia e confirmação; dados já idênticos retornam `existing` sem nova ação. `goal` aceita `null`. |
| `schedule_trial_class` | `{ leadId, slotId }` | Propõe reserva para lead atualizado e horário vigente. Nova escrita exige confirmação específica; mesma reserva pode retornar `existing` sem nova ação. |
| `transfer_to_human` | `{ reason }` | Escrita local após pedido explícito ou oferta aceita: registra/recupera solicitação da conversa, sem exigir lead ou segunda confirmação. |

`contact.type` é `email` ou `phone`, com formato validado; não há normalização silenciosa. IDs são opacos. A call da LLM para `create_lead` ou `schedule_trial_class` **não autoriza a escrita**: uma proposta válida retorna `ok: false`, `error.code: CONFIRMATION_REQUIRED`, com a prévia separada em `pendingAction`.

## Contratos e endpoints

Os [schemas públicos](packages/contracts/README.md) rejeitam extras, tipos incorretos e objetos aninhados incompatíveis, sem coerção. `message` é aparada e deve conter de 1 a 2.000 caracteres. O navegador não envia histórico, `schoolId`, contexto, resultados de tools ou configuração do modelo.

### `POST /api/chat`

Primeira mensagem:

```json
{"message":"Quais cursos vocês oferecem?"}
```

Continuação — substitua o identificador ilustrativo pelo recebido do backend:

```json
{"message":"Quero inglês para viagem.","conversationId":"id-retornado-pelo-backend"}
```

Exemplo de chamada ao Fastify, com o modelo configurado:

```bash
curl http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Quais cursos vocês oferecem?"}'
```

O sucesso é `{ conversationId, reply, results, pendingAction }`:

- `reply`: texto de apresentação; não constitui fato ou recibo oficial.
- `results`: itens `{ tool, result }`, com `result` igual a `{ ok: true, data }` ou `{ ok: false, error: { code, message } }`, conforme a tool.
- `pendingAction`: `null` ou `{ actionId, kind, preview }` fornecido pelo backend. Cadastro usa a prévia `{ name, contact, courseId, goal }`; reserva usa `{ lead, course, slot }` oficiais.

### `POST /api/chat/confirm`

Envie **somente os IDs retornados na mesma conversa**; os valores abaixo são placeholders, não uma ação existente:

```json
{"conversationId":"id-retornado-pelo-backend","actionId":"id-da-previa-retornada"}
```

Não reenvie `preview`, nome, contato, `leadId`, `slotId`, `confirmed`, `revision` ou outros argumentos. A resposta de sucesso usa o mesmo envelope do chat. Não existe endpoint público separado de CRUD ou de slots.

| Situação | HTTP e resultado |
| --- | --- |
| JSON/entrada inválida ou campo adicional | `400`, erro `INVALID_REQUEST` |
| Conversa/ação desconhecida ou ação de outra conversa | `404`, erro `NOT_FOUND` |
| Ação pendente substituída ou revisão antiga | `409`, erro `ACTION_STALE` |
| Modelo ausente ou falha técnica sem recuperação aplicável | `500`, erro `CHAT_ERROR` |
| Consulta válida, ausência de preço/vagas, prévia para confirmação | `200`, resultado estruturado da tool |
| Disputa de vaga durante confirmação | `200`, `SLOT_UNAVAILABLE` em `results`, salvo como recibo |

Erros HTTP usam `{ error: { code, message } }`. `INVALID_INPUT`/`NOT_FOUND` de tools podem integrar um turno HTTP 200. Em geral, `OPERATION_FAILED` de uma tool interrompe o turno com `CHAT_ERROR`; no handoff, é apresentado como resultado controlado quando a redação permite concluir o turno, sem protocolo fictício. Erros internos não são expostos.

## Dados demonstrativos

A escola `school_demo` é a **Escola Demonstração de Idiomas**, na Rua Fictícia dos Idiomas, 100, Cidade Exemplo. Contato `atendimento@escola-demonstracao.example`; funcionamento de segunda a sexta, das 9h às 18h; fuso **`America/Sao_Paulo`**. Todos esses dados são fictícios.

[Catálogo cadastrado](apps/api/src/modules/language-school/infrastructure/catalog-fixtures.ts):

| ID | Curso | Modalidade | Ativo | Preço oficial |
| --- | --- | --- | --- | --- |
| `course_english_travel` | Inglês para viagens | `online` | Sim | `35000` centavos / `BRL` / `month` — R$ 350,00 por mês |
| `course_spanish_conversation` | Conversação em espanhol | `in_person` | Sim | `null` — preço não informado |
| `course_french_intro` | Introdução ao francês | `online` | Sim | `0` centavos / `BRL` / `course` — curso gratuito na fixture |
| `course_german_foundations` | Fundamentos de alemão | `in_person` | Não | `28000` centavos / `BRL` / `month`; não oferecido comercialmente |

**`price: null` significa valor não informado. `amountCents: 0` é um preço real cadastrado como zero.** Não são equivalentes. A formatação para reais é apenas apresentação.

[Slots cadastrados](apps/api/src/modules/language-school/infrastructure/slot-fixtures.ts), todos com `timezone: America/Sao_Paulo`:

| Slot | Curso | `startsAt` oficial |
| --- | --- | --- |
| `slot_english_a` | `course_english_travel` | `2030-06-11T10:00:00-03:00` |
| `slot_english_b` | `course_english_travel` | `2030-06-12T14:00:00-03:00` |
| `slot_english_past` | `course_english_travel` | `2030-06-09T10:00:00-03:00` |
| `slot_english_occupied` | `course_english_travel` | `2030-06-11T09:00:00-03:00` |
| `slot_french_a` | `course_french_intro` | `2030-06-11T11:00:00-03:00` |
| `slot_spanish_past` | `course_spanish_conversation` | `2030-06-09T15:00:00-03:00` |

São horários **fixos de junho de 2030**, sem vínculo com a agenda verdadeira de uma escola. A aplicação usa relógio real e inicia sem reservas. Os testes injetam `2030-06-10T12:00:00Z` para distinguir passado/futuro e podem injetar `trialClassFixtures` para representar ocupação.

Os sufixos `_past` e `_occupied` não determinam disponibilidade: ela vem do instante e do registro de reserva. Em particular, `slot_english_occupied` começa livre na aplicação normal; a reserva fixture correspondente é usada apenas quando injetada. No relógio fixo dos testes, os slots de 09/06 estão no passado; antes dessa data real podem aparecer como futuros. Quando as datas expirarem, a consulta não inventará substitutos.

## Persistência e reinicialização

> **Toda a persistência deste MVP é memória local do processo da API. Reiniciar a API apaga conversas, histórico, contexto, leads, reservas, handoffs, pending actions e recibos.**

As fixtures de escola/cursos/slots são carregadas novamente e as vagas começam sem reservas. Não existe banco de dados, arquivo de persistência, recuperação de sessão entre reinicializações ou armazenamento comercial durável.

Recarregar o navegador ou escolher “Nova conversa” descarta o ID e o histórico visual da aba e inicia outra conversa. Isso não apaga automaticamente a conversa anterior da memória da API, mas a UI não a recupera por cookie ou localStorage. Uma tentativa de continuar um ID perdido após reinício retorna `404 / NOT_FOUND`.

IDs são identificadores opacos, **não autenticação**. Utilize apenas dados fictícios nesta demonstração.

## Confirmação e segurança das operações

### Cadastro: decisão de UX desta versão

Quando `create_lead` precisa gravar ou atualizar dados, o backend apresenta uma prévia para revisão e exige o botão **Confirmar cadastro**. A call da tool apenas propõe; a escrita ocorre após a confirmação específica. Um cadastro já idêntico retorna `existing` sem escrita ou nova confirmação.

Essa é a escolha de UX atual para dados voluntariamente fornecidos. Uma evolução poderá avaliar outro fluxo de consentimento para cadastro, mediante revisão própria. Isso **não flexibiliza a confirmação da reserva**.

### Reserva: regra obrigatória da arquitetura atual

Toda nova reserva depende de ação pendente válida, com argumentos imutáveis, vinculada à conversa, à revisão e ao `actionId` oficial. O visitante revisa os dados e clica em **Confirmar aula experimental**; o navegador envia somente `conversationId` e `actionId` a `/api/chat/confirm`.

Um “sim” no chat, `confirmed: true` da LLM, prosa alegando sucesso ou confirmação de cadastro não autorizam reserva. Não existe configuração global para desligar ambas as confirmações.

### Correções e atomicidade do turno

Há uma ação pendente atual por conversa. Correções efetivas em nome, contato, objetivo, curso ou horário incrementam `revision` e invalidam a prévia anterior. Repetir o valor vigente não incrementa a revisão; trocar curso limpa o horário incompatível. Confirmar ação antiga retorna `ACTION_STALE`, sem adaptar seus argumentos aos dados novos.

Prévias de cadastro/reserva ficam locais ao turno até a redação e o envelope público serem validados. Falha antes desse commit não deixa ação órfã. Mensagens e confirmações da mesma conversa são serializadas; conversas diferentes não compartilham uma fila global.

## Disponibilidade, concorrência e recibos

Consultar ou selecionar um slot não ocupa a vaga. O backend revalida lead, curso, horário e disponibilidade na confirmação. O `TrialClassRepository.reserveSlot` verifica ocupação e insere a reserva sem `await` entre decisão e escrita, garantindo uma reserva por slot **neste processo em memória**.

| Resultado | Significado |
| --- | --- |
| `created` | Uma nova reserva foi registrada após confirmação. No cadastro, significa o primeiro lead da conversa. |
| `existing` | O mesmo lead já tem a mesma reserva; nenhuma nova escrita. No cadastro, os dados já são idênticos. |
| `updated` | Exclusivo do cadastro: os novos dados confirmados atualizaram o mesmo `lead.id`. |
| `SLOT_UNAVAILABLE` | A vaga não pode ser reservada; outro lead pode tê-la ocupado depois da consulta. Conflito na confirmação gera recibo HTTP 200. |
| `ACTION_STALE` | A prévia foi invalidada/substituída; HTTP 409, sem executar seus argumentos. |

**Mesmo `actionId` concluído:** devolve o recibo histórico original, sem reexecutar nem pedir nova redação à LLM. Um recibo `created` permanece `created`; um recibo `SLOT_UNAVAILABLE` também permanece igual.

**Nova tentativa para o mesmo lead/slot:** se as referências continuarem válidas e a reserva já existir, retorna `existing`. Isso é diferente de recuperar uma confirmação histórica. Outro lead recebe indisponibilidade.

Após uma escrita, o recibo determinístico é salvo antes da redação opcional da reserva. Se a LLM falhar, retornar conteúdo inválido ou pedir outra tool nessa etapa, o resultado oficial e a mensagem de contingência são devolvidos com HTTP 200. Se a entrega HTTP falhar, a UI pode repetir os mesmos IDs e recuperar esse recibo.

Reservas concluídas são snapshots: mudar contexto ou atualizar o lead não cancela, remarca ou reescreve o booking. A atomicidade local não é uma solução distribuída/persistente para múltiplas instâncias; isso exigiria outra implementação.

## Atendimento humano local

`transfer_to_human` funciona sem nome, contato, curso, lead ou reserva. O backend verifica pedido explícito ou aceitação da última oferta válida já apresentada. Um “sim” genérico sem oferta de handoff não registra solicitação.

O repository gera um protocolo e mantém **uma solicitação aberta por conversa**, com `status: requested`. Repetições devolvem o ID e o motivo originais, mesmo quando o novo motivo é diferente. Não há segunda confirmação ou botão de handoff. Registrar esse pedido, por si só, não confirma nem invalida uma prévia de cadastro/reserva.

**O MVP não conecta um atendente humano real, não envia notificações externas e não promete prazo de atendimento.** A UI mostra “Solicitado” e o aviso demonstrativo. A apresentação do handoff é determinística; uma falha de redação posterior ao registro preserva protocolo, resultado oficial e histórico coerente.

## Testes e validação

Na raiz, com OpenSpec disponível para o último comando:

```bash
npm test
npm run typecheck
npm run lint
npm run build
openspec validate language-school-sales-mvp --strict
```

A auditoria da task 7.2 registrou **882 testes aprovados em 39 arquivos**, contagem reconfirmada na revisão documental 7.3. Consulte o [registro de verificação](openspec/changes/language-school-sales-mvp/verification.md) para ambiente, resultados e isolamento arquitetural.

A suíte principal não exige `.env`, chave OpenAI, rede externa, banco ou calendário. Usa Vitest, `ScriptedChatModel`, repositories em memória e Fastify `server.inject()`. O teste do SDK OpenAI usa transporte HTTP simulado. O frontend usa jsdom/Testing Library com fetch simulado; a [jornada integrada](apps/api/test/language-school-journey.test.ts) substitui somente a geração e falhas deliberadas de transporte, preservando casos de uso e repositories reais.

Os testes cobrem confirmação, revisão, concorrência, isolamento, correções, perda de resposta, prosa divergente e preservação de recibos. A homologação complementar no Chromium incluiu larguras de 390 px e 320 px; navegador/Playwright não são requisitos de `npm test`.

## Limitações conhecidas

- Aplicação demonstrativa com memória volátil e uma escola fictícia; sem autenticação, multi-tenant ou recuperação de sessão.
- Agenda fixa interna; sem calendário externo, cancelamento ou remarcação.
- Sem pagamentos, billing, painel administrativo, CRM completo ou atendimento humano ao vivo.
- Sem WhatsApp, notificações externas, voz, RAG, LangGraph ou múltiplos agentes.
- Seleção de horário e reconhecimento de intenção de handoff são conservadores; formulações ambíguas podem exigir esclarecimento.

### Texto livre continua probabilístico

A LLM pode interpretar parcialmente uma intenção, sugerir patches de contexto, pedir esclarecimentos e redigir respostas naturais. Pode também produzir texto inadequado ou divergente.

O sistema reduz riscos com schemas Zod, referências oficiais, casos de uso/repositories determinísticos, `results`, pending actions, confirmação explícita, recibos históricos e contingência do backend. Esses mecanismos **não eliminam toda possibilidade de erro textual**. A prosa não é fonte oficial de preço, curso, disponibilidade, reserva ou protocolo, nem autorização para escrever.

## Avaliação opcional com modelo real

Este procedimento é manual, separado de `npm test`, e **pode gerar custos no provedor**. Use somente dados fictícios. Nenhuma avaliação paga faz parte da validação automatizada.

1. Configure `OPENAI_API_KEY` exclusivamente na API e `OPENAI_MODEL`, como descrito em [ambiente](#configuração-do-ambiente).
2. Inicie com `npm run dev` e abra http://127.0.0.1:3000.
3. Consulte catálogo e detalhes; compare os cards oficiais às fixtures, incluindo preço ausente e zero.
4. Escolha inglês e informe nome/contato fictícios, por exemplo Ana e `ana@example.com`.
5. Peça o cadastro, revise e clique em **Confirmar cadastro**. Verifique o lead e `outcome` em `results`.
6. Consulte horários; escolha explicitamente uma data/hora exibida, por exemplo **“Escolho 11/06/2030 às 10h.”**, se ainda disponível e futura.
7. Peça o agendamento. A prévia e `CONFIRMATION_REQUIRED` devem existir sem reserva concluída. Clique em **Confirmar aula experimental** e confira o recibo.
8. Solicite **“Quero falar com alguém.”**. Verifique protocolo real e `requested`, sem promessa de atendimento ao vivo. Repita o pedido e confira o mesmo protocolo.
9. Em nova conversa, prepare cadastro e corrija contato antes de confirmar: **“Meu email correto é ana.novo@example.com.”**. A prévia antiga deve deixar de ser confirmável; a nova deve conter o contato atual.
10. Corrija o objetivo de viagem para **“Na verdade, quero principalmente entrevistas de emprego.”**. Se o lead já estiver salvo, ele deve exigir atualização confirmada antes de reservar.
11. Após consultar slots, tente **“Quero a primeira opção.”** ou duas datas na mesma mensagem. Isso não deve criar uma nova seleção oficial; peça/observe esclarecimento e depois informe uma única data e hora.
12. Antes de confirmar uma prévia de aula, escolha outro slot oficial explicitamente. Confirme somente a nova prévia e confira que o horário anterior não foi reservado.

No DevTools, acompanhe `/api/chat` e `/api/chat/confirm`: os fatos observáveis são `results`, `pendingAction` e os recibos. Avalie separadamente clareza da redação, escolha das tools e necessidade de esclarecimentos; não considere uma frase de sucesso como evidência de gravação. Uma avaliação manual bem-sucedida não prova ausência absoluta de alucinações.

## Próximas evoluções

A próxima evolução prevista é o **canal WhatsApp para o SupportFlow AI**, a ser planejado em **uma change independente**, reutilizando o motor conversacional existente. Nenhuma integração WhatsApp está implementada neste MVP.

Os artefatos de `language-school-sales-mvp` estão liberados para versionamento pelo `.gitignore`, incluindo specs, tarefas e auditoria. A change permanece disponível para revisão final; seu archive é uma etapa posterior explícita.
