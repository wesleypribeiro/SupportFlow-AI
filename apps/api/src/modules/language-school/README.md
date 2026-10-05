# Módulo de escolas de idiomas

Implementação das regras do segmento escolar, composta pelo [app.ts](../../app.ts) sobre o core genérico de conversa. As **sete tools** estão conectadas ao LangChain: `get_school_info`, `get_courses`, `get_course_details`, `get_available_slots`, `create_lead`, `schedule_trial_class` e `transfer_to_human`.

Consulte o [README principal](../../../../../README.md) para execução, variáveis, endpoints, fixtures completas e limitações; os [contratos públicos](../../../../../packages/contracts/README.md) descrevem schemas e envelopes.

## Camadas e composição

```text
infrastructure/langchain-tools.ts — schemas públicos + escopo privado do turno
    ↓ adapters de tools (entrada e saída validadas)
application/ — operações determinísticas
    ↓ interfaces de domain/
infrastructure/in-memory-*-repository.ts
```

- `domain/`: interfaces de repository, contexto, resolução conservadora de horário e intenção de handoff. Depende somente de contratos/Zod e do próprio domínio.
- `application/`: consultas, planejamento/confirmação de cadastro, disponibilidade, proposta/reserva e registro de handoff. Recebe interfaces e clock, sem LangChain, Fastify ou classes concretas.
- `infrastructure/`: fixtures, implementações em memória, adapters LangChain, integração de contexto, ações e apresentação de recibos.
- [prompt.ts](prompt.ts): política objetiva do atendimento; não é responsável pelas invariantes determinísticas.
- [config.ts](config.ts): escola configurada no processo; a composição exige `school_demo`, sem escolha de escola pelo navegador/modelo.

O core recebe tools, instruções e callbacks; não importa regras escolares. `action-confirmation.ts` faz o dispatcher explícito de cadastro/reserva dentro deste módulo, sem registry de plugins.

## Repositories

| Interface | Operações |
| --- | --- |
| [SchoolRepository](domain/school-repository.ts) | `getSchool`, `listActiveCourses`, `findActiveCourseById` |
| [LeadRepository](domain/lead-repository.ts) | `findByConversationId`, `createForConversation`, `updateForConversation` |
| [TrialClassRepository](domain/trial-class-repository.ts) | `listSlotsByCourseId`, `findSlotById`, `findConfirmedBySlotId`, `reserveSlot` |
| [HandoffRepository](domain/handoff-repository.ts) | `findOpenByConversationId`, `requestForConversation` |

Implementações mantêm cópias defensivas e IDs gerados pelo backend. Lead e handoff são associados internamente à conversa; não há busca global por contato ou CRUD genérico. Atualização de lead preserva o ID. `reserveSlot` verifica e insere sem `await` entre as operações; `requestForConversation` também consulta/cria atomicamente no processo e preserva a solicitação original.

[Catálogo](infrastructure/catalog-fixtures.ts) e [slots](infrastructure/slot-fixtures.ts) são fictícios. A aplicação inicia sem leads, reservas ou solicitações. `trialClassFixtures` é estado inicial opcional para testes de ocupação; o nome `slot_english_occupied` não torna a vaga ocupada. O clock é `now: () => Date`; testes usam `2030-06-10T12:00:00Z`, produção local usa o instante real.

## Contexto vigente

`ConversationContext` mantém `goal`, `name`, `contact`, `courseId`, `slotId`, `leadId` e `revision`, com `null` para desconhecidos. Histórico registra o passado; contexto orienta a decisão atual. O frontend não envia esse objeto.

O mesmo modelo interpreta um patch estruturado. O backend valida schema e fonte antes de aplicar: novos dados pessoais/objetivo devem estar sustentados pela mensagem atual; repetir o valor vigente é no-op. Campos não propostos são preservados. Curso precisa corresponder inequivocamente ao catálogo ativo; associar leadId após confirmação não incrementa revisão.

[slot-reference.ts](domain/slot-reference.ts) associa data/hora explícitas da mensagem e da evidência a exatamente um slot elegível, no fuso oficial. Aceita data brasileira numérica ou por extenso e hora explícita; não resolve “amanhã”, ordinais ou mensagens com múltiplas opções. O ID proposto deve ser o do slot correspondente: evidência de A não autoriza B. Referência insuficiente/ambígua mantém seleção/revisão. Curso diferente limpa o horário; seleção válida diferente incrementa revisão e invalida ação antiga após commit do turno.

## Fluxo limitado por turno

1. Interpretar patch com o modelo injetado, validar e aplicar em uma cópia do contexto.
2. Disponibilizar contexto vigente em mensagem de sistema separada do histórico.
3. Selecionar zero ou mais calls com as sete tools disponíveis.
4. Executar a rodada por adapters/casos de uso e anexar `ToolMessage`s associados aos IDs das calls.
5. Se houve tools, redigir uma resposta com o modelo **sem tools vinculadas**. Sem calls, a resposta de seleção encerra o turno.
6. Validar resposta pública e salvar o turno; propostas de ação são commitadas somente nessa etapa.

Não há loop autônomo, AgentExecutor, LangGraph, execução recursiva ou segunda rodada de tools na redação. Saudações e diálogo sem fatos comerciais podem dispensar consultas. Dados de tool não se tornam novas instruções do sistema; a prosa não preenche `results`.

A camada de tool valida entradas e saídas, mapeando falhas para os códigos públicos existentes. Referências indisponíveis produzem `NOT_FOUND`; argumentos inválidos, `INVALID_INPUT`; falhas técnicas/saídas inválidas, `OPERATION_FAILED`. No chat, falhas técnicas de catálogo/cadastro/agenda interrompem o turno com `CHAT_ERROR`; handoff admite apresentação controlada de sua falha, sem falso protocolo.

## Cadastro: proposta e escrita separadas

`prepareLeadRegistration` compara argumentos, contexto validado e lead daquela conversa, além de exigir curso ativo. Divergência do vínculo `context.leadId`/repository é falha controlada, sem recuperação inventada.

- Ausente: prepara `create_lead` e retorna `CONFIRMATION_REQUIRED`; só a confirmação cria e retorna `created`.
- Idêntico: retorna `existing` do registro oficial, sem escrita ou nova prévia.
- Diferente: prepara nova prévia; o registro antigo permanece até a confirmação, que retorna `updated` com o mesmo ID.

A confirmação adicional de cadastro é a política de UX atual, distinta da regra obrigatória de reserva. [lead-confirmation.ts](infrastructure/lead-confirmation.ts) associa o ID salvo ao contexto, dentro da serialização da conversa. Não autoriza aula nem muda revisão apenas por associar esse ID.

## Agenda e reserva

`getAvailableSlots` exige curso ativo, lê slots válidos e filtra por `startsAt > now`, curso, fuso compatível e ausência de reserva. Compara instantes absolutos, preserva ISO/fuso e ordena cronologicamente. Lista vazia é sucesso; consulta não seleciona horário ou ocupa vaga.

Antes de propor/confirmar aula, `validateTrialClassReferences` verifica lead da conversa, dados atuais de nome/contato/objetivo/curso, curso ativo, slot selecionado e fuso. Lead desatualizado exige atualização de cadastro confirmada primeiro. Nova reserva exige horário futuro e livre; o executor revalida registros atuais, sem confiar somente na prévia.

O adapter de `schedule_trial_class` aceita apenas `leadId`/`slotId`; contexto e conversa vêm do scope, que exige seleção vigente. Na proposta, `scope.proposeAction` mantém `{ lead, course, slot }` oficiais locais ao turno. Falha na redação sem escrita não deixa ação órfã nem invalida a anterior.

Na confirmação, [confirm-trial-class.ts](application/confirm-trial-class.ts) delega a decisão final a `reserveSlot`, sem read-then-write na aplicação:

| Situação | Resultado |
| --- | --- |
| Vaga livre e referências válidas | `created` com booking confirmado |
| Mesmo lead/slot já registrado | `existing`, sem nova escrita |
| Vaga de outro lead | `SLOT_UNAVAILABLE`, sem nova reserva |
| Ação antiga | Core retorna `409 / ACTION_STALE` antes de executar |

Conflito de vaga durante confirmação é **HTTP 200 com recibo `SLOT_UNAVAILABLE`**, que conclui a ação. Repetir o mesmo actionId devolve seu recibo original, mesmo após mudança posterior de contexto; uma nova call para reserva já existente retorna `existing` se as referências forem válidas. Booking e recibos concluídos não acompanham updates de contexto/lead.

## Contingência depois de escrita

O lifecycle salva primeiro o recibo determinístico. [confirmation-reply.ts](infrastructure/confirmation-reply.ts) pode redigir somente a apresentação de uma aula já decidida. Erro, tool call, texto vazio ou conteúdo inválido preservam o recibo e mensagem determinística, com HTTP 200. A confirmação de cadastro usa apresentação determinística. Retry não reexecuta nem depende de nova redação.

Isso não recupera falhas técnicas anteriores à escrita. O armazenamento permanece em memória, sem transação distribuída ou sobrevivência a reinício.

## Apresentação WhatsApp — task 4.1

[whatsapp-presentation.ts](infrastructure/whatsapp-presentation.ts) expõe
`presentLanguageSchoolWhatsApp(envelope)`: valida o contrato escolar existente e
formata os sete results e as duas prévias, sem receber repositories, consultar
regras comerciais, escrever estado ou chamar modelo/transporte. Havendo results
ou prévia, a apresentação é determinística; somente diálogo sem ambos usa `reply`.
O envelope e o histórico do motor permanecem intactos.

O retorno contém mensagens textuais e, quando couber, `confirmation` com corpo
completo, título, `actionId` e `kind` da prévia. Esse conteúdo não é um botão
enviável nem uma autorização: referência opaca, verificação de commit/vínculo e
publicação pertencem às tasks posteriores. Os títulos são “Confirmar cadastro”
e “Confirmar aula”; o corpo distingue a aula experimental demonstrativa.

Texto acima de 4.096 unidades UTF-16 é dividido em partes numeradas, com a
numeração incluída no limite, preservando conteúdo e preferindo linhas/palavras
completas. Grafemas permanecem juntos; um grafema isolado maior que uma mensagem
é dividido por pontos de código, sem perda. A contagem UTF-16 é conservadora.
Prévia acima de 1.024 unidades retorna integralmente como texto, com orientação
para corrigir/reduzir dados e `confirmation: null`, sem confirmação incompleta.
Datas usam o fuso oficial; preços nulos e zero continuam distintos.

## Handoff: solicitação local

[handoff-intent.ts](domain/handoff-intent.ts) reconhece conservadoramente pedidos explícitos e aceita resposta curta somente à última oferta válida já apresentada/salva. A oferta canônica é “Posso registrar uma solicitação local de atendimento humano nesta demonstração?”. Negativas, hipóteses, citações e “sim” sem essa oferta não autorizam registro. Não é um classificador geral de linguagem natural.

O adapter expõe somente `{ reason }`. `conversationId` e `visitorIntent` são internos. A operação não exige dados comerciais, não cria/atualiza lead ou booking, nem altera revisão/pendingAction por si só. O repository retorna uma solicitação por conversa, preservando ID, motivo original e `requested` em repetições.

[handoff-reply.ts](infrastructure/handoff-reply.ts) apresenta determinística e explicitamente o registro demonstrativo, sem atendente conectado, notificação externa ou prazo. Resultado oficial validado de registro permite recuperar falha **exclusivamente na redação posterior**, salvando a mensagem de contingência no histórico. Propostas de cadastro/reserva da mesma rodada são descartadas se essa redação falhar; ações anteriores seguem sua revisão. Falhas antes do registro não geram protocolo fictício.

## Testes e limites

`npm test` na raiz inclui casos de uso, repositories, contratos, adapters e HTTP. [language-school-journey.test.ts](../../../test/language-school-journey.test.ts) percorre o produto pelas rotas reais, com geração via `ScriptedChatModel`, clock fixo e repositories reais. O [teste OpenAI](../../../test/chat-openai.test.ts) preserva o SDK com transporte simulado.

As invariantes verificadas são estruturais/determinísticas, não uma garantia de qualidade ou infalibilidade da prosa. A [auditoria](../../../../../openspec/changes/archive/2026-09-29-language-school-sales-mvp/verification.md) registra o isolamento das camadas e a execução sem serviços externos. Não há persistência, autenticação, operadores conectados, calendário externo ou outros segmentos implementados.
