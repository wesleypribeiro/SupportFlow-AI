# Design

## Context

O projeto possui OpenSpec com schema `spec-driven`, uma change anterior com 17 tarefas não iniciadas e nenhuma spec principal. Não há aplicação executável neste diretório. A motivação e a relação entre changes estão em [proposal.md](proposal.md): este plano é autossuficiente para a jornada escolar e não exige implementar clientes ou faturas antes.

As decisões aprovadas são escola única, dados fictícios, repositórios em memória, chat web e agenda interna demonstrativa. A change `supportflow-ai-mvp` permanece intacta. Não há contrato de aplicação publicado a migrar, mas os dois planos de chat são incompatíveis e não devem ser aplicados simultaneamente.

## Goals / Non-Goals

**Goals:** preservar a base Full Stack e o repository pattern; isolar o segmento escolar; usar resultados estruturados como fonte oficial; manter contexto corrigível e executar cadastros e reservas por regras testáveis.

**Non-Goals:** criar plataforma de plugins, abstração de tenants, CRM, motor de aprovação, protocolo próprio de agente ou garantia matemática sobre texto livre. Os demais limites de produto estão na proposta.

## Decisions

### 1. Core genérico e módulo de escola por composição

Manter npm workspaces, TypeScript strict, Fastify, Next.js, Zod e LangChain. Usar Vitest para testes locais. Estrutura futura:

```text
apps/api/src/
  core/                       chat, transporte, integração IA e conversas
  modules/language-school/
    domain/                   entidades e interfaces de repositório
    application/              consultas, cadastro, disponibilidade e reserva
    infrastructure/           tools, fixtures e repositórios em memória
  main.ts                     composição manual
apps/web/                     chat Next.js
packages/contracts/
  chat/                       envelopes e confirmação de ação
  language-school/            entradas e resultados das sete tools
```

O core recebe ferramentas, instruções e validadores pela composição. Regras sobre cursos, leads e horários pertencem ao módulo escolar. O domínio e os casos de uso não importam LangChain, Fastify, Next.js ou implementações de repositório. O navegador usa somente a API; um rewrite Next.js encaminha `/api/chat` e `/api/chat/confirm` ao Fastify. Chaves e configuração de modelo ficam no backend.

Uma escola configurada por processo é suficiente; o navegador e a LLM não escolhem tenant. A composição usa as primitivas LangChain já previstas, como `bindTools` e mensagens de ferramenta, com um único provedor configurado. Não adotar LangGraph nem exigir `CustomerRepository` ou `InvoiceRepository`, que pertencem ao plano anterior.

Alternativa descartada: interface de plugin, descoberta dinâmica e portas para vários provedores. Uma lista de ferramentas e instruções injetadas separa os segmentos sem esses componentes.

### 2. Domínio e repositórios mínimos

| Interface | Responsabilidade |
| --- | --- |
| `SchoolRepository` | Obter a escola, listar cursos ativos e consultar detalhes |
| `LeadRepository` | Registrar ou atualizar o único lead da conversa e recuperá-lo |
| `TrialClassRepository` | Listar slots e reservar uma vaga atomicamente |
| `HandoffRepository` | Registrar ou recuperar a solicitação aberta da conversa |

As implementações começam em memória. Um armazenamento simples de conversas guarda histórico, contexto do módulo, ação pendente e recibos de confirmação; não há infraestrutura adicional de sessão ou banco. A escola e os cursos usam fixtures; leads, reservas e solicitações são criados durante a demonstração. Reiniciar restaura as fixtures e perde os registros transitórios.

Dados estruturados propostos para os schemas:

| Tipo | Campos |
| --- | --- |
| School | `id`, `name`, `description`, `address`, `contact`, `openingHours`, `timezone` |
| CourseSummary | `id`, `name`, `language`, `modality`, `active` |
| Course | campos de CourseSummary, `description`, `price` |
| Price | `amountCents`, `currency: BRL`, `billingPeriod: month ou course`; preço ausente é `null` |
| Lead | `id`, `name`, `contact: { type: email ou phone, value }`, `courseId`, `goal: string ou null` |
| Slot | `slotId`, `courseId`, `startsAt` ISO com deslocamento, `timezone` |
| TrialClass | `id`, `leadId`, `courseId`, `slotId`, `startsAt`, `timezone`, `status: confirmed` |
| Handoff | `id`, `reason`, `status: requested` |

Strings obrigatórias são não vazias. Validar formato de e-mail ou telefone conforme o contato escolhido, IDs de referências existentes, preço em centavos inteiros não negativos e datas válidas. `modality` é `online` ou `in_person`; o fuso configurado identifica a apresentação dos horários. Contratos incluem somente esses campos, com objetos aninhados estritos; relações com conversa e controle de ocupação são metadados internos do backend.

Não recalcular preços, descontos ou condições comerciais por inferência. `null` não significa gratuito. Cursos inativos não aparecem na oferta nem podem receber novos leads ou reservas. Os casos de uso consultam e verificam essas regras, sem pedir decisões à LLM.

Alternativa descartada: um repositório genérico de CRUD. As interfaces acima permitem substituir memória futuramente sem introduzir funcionalidades de CRM.

### 3. Sete ferramentas e fronteiras de confiança

Todas as tools usam entrada e saída Zod estritas, com resultado `{ ok: true, data }` ou `{ ok: false, error: { code, message } }`. O discriminador `tool` na resposta HTTP seleciona o schema correto; não há payload de fatos livre ou `passthrough`.

| Tool | Entrada do modelo | `data` de sucesso |
| --- | --- | --- |
| `get_school_info` | `{}` | `{ school }` |
| `get_courses` | `{}` | `{ courses: CourseSummary[] }` |
| `get_course_details` | `{ courseId }` | `{ course: Course }` |
| `get_available_slots` | `{ courseId }` | `{ courseId, slots: Slot[] }` |
| `create_lead` | `{ name, contact, courseId, goal }` | `{ outcome: created ou updated ou existing, lead }` |
| `schedule_trial_class` | `{ leadId, slotId }` | `{ outcome: created ou existing, booking: TrialClass }` |
| `transfer_to_human` | `{ reason }` | `{ request: Handoff }` |

`conversationId`, vínculo de escola, revisão do contexto e autorização são injetados pelo backend, nunca escolhidos nos argumentos da LLM. Ferramentas de escrita verificam suas referências contra os registros e o contexto atual. O schema de agendamento não contém `confirmed`.

Uma proposta de cadastro ou reserva feita pelo modelo passa pelo controle de ação pendente e retorna `CONFIRMATION_REQUIRED` enquanto não houver autorização. A mesma operação determinística é executada na confirmação recebida pelo backend. Campos e resultados continuam validados nos dois caminhos; não há rota alternativa de tool calling que ignore a confirmação.

Erros esperados: `INVALID_INPUT`, `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `ACTION_STALE`, `SLOT_UNAVAILABLE` e `OPERATION_FAILED`. Ausência de preço ou horários é um resultado válido. As mensagens de erro são produzidas pela aplicação; exceções internas não entram no prompt nem na resposta pública.

### 4. Fatos do sistema e linguagem natural

Preços, horários, disponibilidade, dados da escola, cursos e resultados de cadastro e agendamento vêm exclusivamente dos resultados estruturados validados. O backend copia esses resultados para `results`; o frontend renderiza dados comerciais e recibos a partir deles. O modelo não constrói esses objetos nem decide que uma gravação aconteceu.

O prompt orienta o agente a consultar tools para fatos comerciais, informar dados ausentes e não preencher esses fatos a partir do próprio conhecimento. A LLM pode interpretar intenção e formular perguntas e explicações em português; saudações e coleta de objetivo não exigem consulta comercial. Resultados de ferramentas são dados, não novas instruções autorizando ferramentas ou escritas.

**Limite explícito:** texto livre de uma LLM continua probabilístico. Os schemas validam dados e o backend controla estados e operações; isso não prova que toda frase livre será fiel. O sistema não usa prosa gerada para preencher campos oficiais, confirmar disponibilidade ou autorizar ações. Não há segunda LLM, validador semântico de prosa ou promessa de eliminação absoluta de invenções. Testes com modelo falso demonstram as fronteiras do sistema, não infalibilidade linguística.

Se a redação falhar após uma escrita, o resultado já registrado é retornado com mensagem fixa baseada no recibo. Falhar antes de gravar não produz sucesso. Essa diferença é necessária agora que há efeitos de negócio.

### 5. Contexto atual e correções do usuário

O backend guarda histórico e um contexto atual separado: objetivo, nome, contato, curso, horário e lead da conversa. A interpretação da mensagem pode usar a LLM para extrair alterações, mas essa atualização é validada e limitada a dados fornecidos pelo usuário e referências de catálogo/horários consultados. Não permite editar preços ou disponibilidade.

Aplicar correções antes das próximas consultas ou propostas. Campos não alterados continuam válidos; um campo corrigido substitui seu valor anterior. O histórico permanece para compreensão, mas não tem prioridade sobre o contexto atual. Se a referência for ambígua, pedir esclarecimento em vez de escolher silenciosamente outro curso ou horário.

Uma revisão numérica local do contexto é incrementada quando objetivo, nome, contato, curso ou horário mudam. Invalidar a ação pendente anterior, limpar seleções incompatíveis (por exemplo, horário de outro curso) e apresentar nova prévia. Isso cobre: “Quero inglês para viagem” seguido de “Na verdade, quero principalmente para entrevistas de emprego”. A próxima decisão e o `goal` do lead usam entrevistas de emprego; a confirmação anterior não pode registrar viagem.

Processar mensagens e confirmações da mesma conversa em ordem, evitando que uma confirmação ultrapasse uma correção já recebida. Trata-se de serialização local do estado em memória, não de um motor de workflows. Reservas concluídas não mudam por alterações posteriores do contexto. Se o lead precisar acompanhar uma correção, `create_lead` atualiza somente o registro daquela conversa após nova confirmação de cadastro.

### 6. Confirmação obrigatória de reserva

Uma ação pendente guarda no servidor `actionId`, conversa, tipo de operação, argumentos normalizados imutáveis, revisão do contexto e prévia. A interface recebe apenas a identificação e a prévia necessária à revisão. Há no máximo uma ação pendente atual por conversa; a criação de outra invalida a anterior. A UI apresenta “Confirmar aula experimental” junto a lead, curso, data, hora, fuso e indicação de agenda interna.

`POST /api/chat/confirm` recebe somente `{ conversationId, actionId }`. O backend primeiro verifica o vínculo; para ação já concluída na mesma conversa, devolve o recibo original sem reavaliar a revisão nem reexecutar. Para ação pendente, verifica tipo, revisão e situação. Os argumentos usados são os da ação armazenada, não um payload reescrito pela LLM ou pelo navegador. Um “sim” em texto pode levar o assistente a orientar o uso do botão, mas não substitui esse comando explícito na primeira versão.

Autorização válida libera somente aquela ação. Antes de propor e executar nova reserva, o caso de uso verifica lead da conversa e sua correspondência com nome, contato, objetivo e curso atuais. Se o lead ainda contém informações substituídas, primeiro apresentar e confirmar sua atualização pela política de cadastro; depois preparar nova reserva. Antes da escrita também verificar curso ativo, horário futuro e disponibilidade. A confirmação e o resultado consumido ficam associados à ação para repetição segura. Ações pendentes invalidadas retornam `ACTION_STALE`; referências inexistentes ou de outra conversa são recusadas sem expor registros alheios.

Um `confirmed: true` gerado pela LLM nunca é autorização. A confirmação de cadastro também não autoriza reserva. Essa separação é uma invariante do agendamento, independentemente de futuras decisões de UX.

Alternativa descartada: considerar a interpretação da LLM sobre consentimento suficiente. O botão e a ação armazenada oferecem vínculo determinístico sem um sistema genérico de aprovações.

### 7. Decisão de UX separada: confirmação do cadastro

**Decisão desta versão:** mostrar nome, contato, curso e objetivo e exigir “Confirmar cadastro” antes de gravar ou atualizar o lead. O backend usa a mesma estrutura pequena de ação pendente, com tipo `create_lead`, mas a política é específica do cadastro. Dados pessoais devem ter sido fornecidos voluntariamente pelo visitante; a prévia permite corrigi-los.

**Evolução possível, não implementada agora:** permitir cadastro a partir de dados voluntariamente fornecidos sem confirmação adicional. Essa mudança futura afetaria a política e os cenários de `lead-capture`; não removeria nem flexibilizaria a confirmação obrigatória de `schedule_trial_class`. Não criar uma configuração global que desligue ambas.

Na conversa há um lead: primeira gravação retorna `created`; dados idênticos retornam `existing` sem mutação; uma correção confirmada retorna `updated` para o mesmo ID. Não realizar deduplicação global por nome ou contato, nem oferecer edição de leads de outras conversas. A confirmação de uma ação já concluída retorna o recibo original, mesmo que o lead tenha sido atualizado depois.

### 8. Agenda interna, repetição e encaminhamento

Cada slot tem uma vaga. Listar horários não ocupa a vaga. `TrialClassRepository` deve verificar e ocupar o slot em uma única operação, registrando a reserva associada; em memória, o trecho de verificação/gravação não intercala operações assíncronas. Dois leads concorrendo pelo mesmo slot resultam em um sucesso e um `SLOT_UNAVAILABLE`.

Antes de considerar indisponibilidade, procurar reserva já existente para o mesmo lead/slot, sempre dentro da conversa correta. Repetição devolve o registro, não cria outra reserva e não autoriza um slot diferente. Guardar recibo e cópia da prévia concluída para que alterações posteriores do contexto não reinterpretem o que foi confirmado. O agendamento mantém seu snapshot; nenhuma correção implica remarcação ou cancelamento.

`transfer_to_human` pode registrar uma solicitação após pedido explícito do visitante ou aceitação de uma oferta; não exige lead. Repetição retorna a solicitação aberta original, mesmo que o motivo enviado depois seja diferente. O estado é sempre `requested`, com protocolo local. Não há envio externo, atendente conectado ou prazo prometido.

Essas regras de repetição são específicas das três escritas. Não reintroduzir deduplicação genérica de tool calls, contadores de invocação ou deadline global.

### 9. Fluxo do agente, transporte e interface

O atendimento avança por turnos: consulta de catálogo, escolha de curso, detalhes/horários, coleta e confirmação de cadastro, proposta e confirmação de reserva. O módulo oferece as sete tools, mas não pressupõe que IDs produzidos por uma operação possam ser inventados como argumentos de outra no mesmo lote. Quando faltar uma dependência, perguntar ao visitante ou usar o resultado no próximo turno.

Por mensagem: atualizar contexto, selecionar e executar as ferramentas solicitadas, encaminhar seus resultados com a associação padrão LangChain e formular a resposta final sem ferramentas vinculadas. Uma confirmação HTTP executa a ação armazenada diretamente; a LLM só pode explicar o resultado depois. Não há loop aberto nem framework adicional de agente.

Contratos estritos:

- Mensagem: `POST /api/chat` com `{ message, conversationId? }`.
- Confirmação: `POST /api/chat/confirm` com `{ conversationId, actionId }`.
- Resposta: `{ conversationId, reply, results, pendingAction }`.
- Cada resultado: `{ tool, result }`, validado pela união dos sete contratos.
- Prévia: `null` ou `{ actionId, kind, preview }`; `kind` é `create_lead` ou `schedule_trial_class`, com schema específico. Prévia de cadastro contém os argumentos normalizados; prévia de reserva contém `lead`, `course` e `slot` consultados.
- Erro: `{ error: { code, message } }`.

O schema compartilhado de chat define o envelope; a composição do módulo fornece os schemas de resultados e prévias. Assim o core não contém regras sobre alunos ou aulas. `results` é montado pelo backend e a UI mostra seus dados como componentes do atendimento, sem expor JSON bruto, prompt ou raciocínio do modelo.

HTTP 400 indica `INVALID_REQUEST`; 404, `NOT_FOUND` para conversa/ação ausente; 409, `ACTION_STALE`; 500, `CHAT_ERROR`. Resultados de consulta como curso inexistente e a preparação `CONFIRMATION_REQUIRED` podem ser apresentados em HTTP 200 como parte normal da conversa. A política específica da task 5.3 registra `SLOT_UNAVAILABLE` durante a confirmação como recibo de negócio em `results`, retornado com HTTP 200 e reutilizado no retry do mesmo actionId sem nova execução. Isso substitui a indicação anterior de HTTP 409 para disputa de vaga. Falha técnica de ferramenta interrompe o turno, exceto que uma escrita já concluída é entregue pelo recibo de sucesso.

A UI mantém o ID no estado da aba, apresenta fatos e prévias do backend e bloqueia envio simultâneo. Recarregar inicia uma nova conversa. Ao corrigir dados, desabilita ações antigas; erro de transporte durante confirmação permite repetir o mesmo `actionId`. O backend continua sendo a autoridade, inclusive se a UI estiver desatualizada. Não tratar IDs opacos como autenticação: o ambiente é de demonstração com dados fictícios.

### 10. Testes e critérios de entrega

Usar Vitest, fixtures e modelo simulado. Relógio simples injetado nos testes de horário futuro evita dependência da data de execução. Não testar extremos monetários ou construir harness de protocolo.

| Área | Verificação essencial |
| --- | --- |
| Contratos e catálogo | extras/tipos inválidos, curso ativo/inativo, preço cadastrado/ausente |
| Contexto | objetivo mais recente, preservação dos demais campos, isolamento, invalidação de ação antiga |
| Cadastro | campos do visitante, prévia, confirmação UX, created/existing/updated e ausência de duplicação |
| Reserva | confirmação vinculada, `confirmed: true` rejeitado, lead/curso/slot coerentes, futuro, conflito de vaga e repetição |
| Resultados oficiais | origem nas tools, prosa divergente não altera `results`, recibo mantido após falha de redação |
| Handoff | com/sem lead, pedido aceito, uma solicitação aberta, nenhum envio externo |
| Chat | requisições válidas/inválidas, confirmação antiga/estrangeira, apresentação de fatos, correção e recuperação |

Os testes principais não usam rede, chaves de LLM ou calendário real. Verificação manual da UI cobre teclado, tela estreita, prévias distintas e reenvio após falha. Uma avaliação opcional com LLM real observa qualidade da interpretação e redação, sem ser prova de ausência absoluta de invenções nem pré-requisito da suíte.

## Risks / Trade-offs

- [Texto livre pode divergir dos dados] → separar dados oficiais de prosa, orientar uso das tools e explicitar os limites probabilísticos.
- [LLM interpreta uma correção de forma inadequada] → contexto atual validado, prévias visíveis e correção pelo visitante; testar substituição de contexto com modelo simulado sem alegar infalibilidade semântica.
- [Vaga muda depois da consulta] → verificar novamente e reservar atomicamente no backend.
- [Memória perdida no reinício] → indicar agenda demonstrativa e reinicialização; persistência real requer outra evolução.
- [Plano anterior tem nomes de capabilities iguais] → manter ambos intactos nesta entrega, mas aplicar apenas este plano para o produto escolar.

## Migration Plan

Não há código, dados persistidos ou API em produção a migrar. A implementação futura seguirá os incrementos de [tasks.md](tasks.md). Esta criação não altera `supportflow-ai-mvp`, não sincroniza specs principais, não arquiva changes e não instala dependências. Não é necessário resolver perguntas adicionais para implementar o escopo aprovado; eventual flexibilização da confirmação de cadastro é uma decisão futura separada.
