# Módulo de escolas de idiomas

Catálogo de leitura das tasks 2.2 e 2.3 de `language-school-sales-mvp`, conectado
ao chat na task 3.1, com contexto vigente na task 3.2 e política de atendimento
consolidada na task 3.4. As tasks 4.2 e 4.3 acrescentam a preparação de cadastro,
criação/atualização confirmadas e reconhecimento de lead idêntico sem escrita.
A task 4.4 conecta essa operação ao chat e à interface. Usa os contratos aprovados na task 2.1.
A task 5.1 acrescenta a consulta de disponibilidade da agenda interna, ainda sem
registro no LangChain nem seleção conversacional de horários.
A task 5.2 acrescenta somente a proposta determinística de aula experimental.

## Organização

- `domain/school-repository.ts`: interface de consulta da escola configurada.
- `domain/conversation-context.ts`: schemas internos e aplicação determinística
  de patches com validação da fonte, referências de curso e revisão.
- `application/catalog-queries.ts`: operações determinísticas, dependentes
  somente da interface e dos tipos compartilhados.
- `application/update-conversation-context.ts`: consulta ao catálogo pelo repository
  quando um patch propõe uma referência de curso.
- `infrastructure/catalog-fixtures.ts`: uma escola e quatro cursos fictícios.
- `infrastructure/in-memory-school-repository.ts`: armazenamento local de leitura.
- `infrastructure/catalog-tools.ts`: três funções com validação de entrada/saída e
  conversão de falhas para resultados públicos.
- `infrastructure/langchain-catalog-tools.ts`: adaptação das três consultas para
  tool calling, sem mudar domínio, casos de uso ou repositório.
- `infrastructure/langchain-tools.ts`: combina catálogo e `create_lead`, com escopo
  de execução fornecido pelo backend e propostas locais ao turno.
- `infrastructure/langchain-context.ts`: interpretação estruturada pelo mesmo modelo
  e descrição do contexto vigente para o atendimento.
- `prompt.ts`: política de conversa, consulta de fatos do catálogo e tratamento de
  resultados como dados, sem autorização de operações pela prosa.

O ponto de composição `src/app.ts` instancia o repositório e expõe `catalogTools`
ao código do backend. O core continua sem importar o módulo escolar e recebe as
tools, instruções e validação da resposta pública pela composição.

O adapter LangChain usa os mesmos schemas de entrada e delega a `catalogTools`.
O resultado validado vai em JSON no conteúdo da `ToolMessage` e como objeto no
`artifact`; `tool_call_id` mantém a associação padrão da chamada. Uma cópia validada
do objeto também compõe `results` de `/api/chat`, independentemente da prosa do modelo.
Argumentos rejeitados pelo LangChain são convertidos em `INVALID_INPUT` sanitizado;
`NOT_FOUND` é um resultado normal. Falhas técnicas interrompem o turno com `CHAT_ERROR`.

O contexto pertence ao módulo escolar; o core armazena e transporta seu tipo por
composição, sem conhecer regras de aluno ou curso. `ConversationContext` mantém
`goal`, `name`, `contact`, `courseId`, `slotId`, `leadId` e `revision`. A interpretação
propõe somente `goal`, `name`, `contact` e `courseReference`, com `null` significando
preservar. O patch usa schemas internos, sem ampliar contratos públicos.

`applyContextPatch` valida a proposta inteira antes de aplicar mudanças. Alterações
de dados pessoais e objetivo exigem trechos literais da mensagem atual. Repetir
exatamente o objetivo ou nome vigente, ou contato com o mesmo `type` e `value`, é
no-op sem exigir nova menção nem aumentar a revisão. Não há normalização adicional.
Valores já substituídos não recebem essa exceção. Um patch misto inválido continua
sendo rejeitado inteiro, sem salvar os demais campos ou o histórico do turno.
Referências de curso precisam de correspondência única entre as opções ativas
mencionadas; uma ambiguidade mantém a seleção anterior. Comparações de nome/idioma
ignoram caixa, sem reescrever os registros. A revisão aumenta uma vez quando algum
campo relevante muda, e permanece
igual para valores idênticos. O patch não cria lead ou horário; somente o executor
de cadastro confirmado pode associar o ID salvo a `leadId`, sem aumentar a revisão.

O contexto validado chega à seleção das tools em uma `SystemMessage` separada.
As respostas do assistente não alimentam a interpretação de dados pessoais. O core
salva contexto e histórico juntos após validar a resposta HTTP; qualquer falha do
turno descarta a cópia em processamento e mantém o estado anterior.

## Política e fluxo por turno

O prompt permite saudações, conversa geral e respostas sobre o objetivo sem consulta
comercial. O modelo decide se precisa de uma tool; o backend não classifica frases
para escolher por ele. Escola, cursos, modalidades, preços e condições cadastradas
devem vir das três consultas disponíveis. Conhecimento próprio, suposições, valores
típicos de mercado e prosa anterior do assistente não são fontes desses fatos.
Ausências são informadas, mantendo a distinção entre preço `null` e zero. IDs usados
em consultas vêm de dados validados; uma referência ambígua exige esclarecimento.

Após a atualização validada do contexto, há uma chamada de seleção com tools.
Sem tool calls, essa resposta encerra o turno. Com chamadas, o backend executa a
rodada solicitada, anexa as `ToolMessage`s e faz uma chamada de redação sem tools
vinculadas. Uma nova tool call nessa redação retorna `CHAT_ERROR`, sem executar
outra rodada. Não há retry de tool calling, recursão ou loop autônomo. Incluindo
a interpretação do contexto, são duas chamadas ao modelo sem consultas ou três
com consultas. Dependências ainda ausentes são resolvidas em turnos posteriores.

Textos de escola, cursos e erros permanecem no conteúdo estruturado de mensagens
com papel `tool`; não se tornam mensagens de sistema nem modificam as ferramentas
disponíveis. A prosa não altera `results`, cria recibos ou autoriza operações.
O prompt orienta coleta de dados faltantes, uso do contexto vigente no cadastro e
revisão da prévia com o botão. Uma tool call ou “Sim” não autoriza escrita. Apenas
resultados oficiais permitem explicar cadastro concluído; agendamento, reserva e
transferência continuam indisponíveis.

`chat-policy.test.ts` usa `ScriptedChatModel`, os adapters reais e `server.inject()`:
verifica objetivo sem consulta, catálogo seguido de detalhes por ID oficial,
ausências, prosa divergente e descrição de curso que tenta dar instruções. Nesse
último caso, até uma redação simulada incorreta mantém os dados oficiais; tentar
uma nova chamada de tool falha sem executar outra operação. A suíte existente
preserva validação de argumentos, associação de IDs e SDK com transporte simulado.
Os testes verificam essas fronteiras arquiteturais e cláusulas essenciais do prompt,
sem provar que um modelo real sempre escolherá a tool certa ou resistirá a instruções
maliciosas em texto. A linguagem natural continua probabilística.

## SchoolRepository

| Método | Retorno |
| --- | --- |
| `getSchool()` | `Promise<School>` da única escola da instância |
| `listActiveCourses()` | `Promise<ActiveCourseSummary[]>` com os cinco campos do resumo |
| `findActiveCourseById(courseId)` | `Promise<ActiveCourse \| null>`; `null` para ausente ou inativo |

Os tipos vêm dos contratos por imports somente de tipo. Domínio e aplicação não
dependem de LangChain, Fastify, implementações de repositório ou variáveis de
ambiente. Não há CRUD, cache ou base genérica de repositório.

A implementação em memória mantém também os cursos inativos, mas os exclui das
consultas comerciais. Copia os dados na construção e ao devolver objetos, para
que uma alteração pelo consumidor não mude os registros. Não normaliza textos,
IDs, modalidades, preços ou periodicidades. A listagem projeta somente os campos
previstos no resumo; os detalhes preservam o curso completo.

## Fixtures

Escola `school_demo`: **Escola Demonstração de Idiomas**, no endereço fictício
Rua Fictícia dos Idiomas, 100, Cidade Exemplo. Contato demonstrativo
`atendimento@escola-demonstracao.example`, funcionamento de segunda a sexta das
9h às 18h, fuso `America/Sao_Paulo`.

| ID do curso | Nome | Modalidade | Ativo | Preço registrado |
| --- | --- | --- | --- | --- |
| `course_english_travel` | Inglês para viagens | `online` | Sim | `35000` centavos, `BRL`, `month` |
| `course_spanish_conversation` | Conversação em espanhol | `in_person` | Sim | `null` |
| `course_french_intro` | Introdução ao francês | `online` | Sim | `0` centavos, `BRL`, `course` |
| `course_german_foundations` | Fundamentos de alemão | `in_person` | Não | `28000` centavos, `BRL`, `month` |

Preço `null` continua indisponível; o preço zero continua cadastrado com sua moeda
e periodicidade. Os dados são exclusivamente fictícios e restaurados a cada nova
instância do repositório.

`SCHOOL_ID` deve corresponder a `school_demo`. Uma configuração desconhecida
interrompe a composição antes de abrir o servidor, sem renomear a fixture ou
fabricar outra escola. Não há seleção de escola nos argumentos das tools.

## Operações e falhas públicas

As funções `get_school_info`, `get_courses` e `get_course_details` recebem
`unknown`, validam a entrada com `@supportflow/contracts/language-school` e só
então delegam aos casos de uso. O resultado também é validado pelo schema público
correspondente antes de sair da tool.

| Tool | Sucesso | Ausência esperada |
| --- | --- | --- |
| `get_school_info({})` | `{ ok: true, data: { school } }` | Escola já exigida pela composição |
| `get_courses({})` | `{ ok: true, data: { courses } }` | Lista vazia é sucesso |
| `get_course_details({ courseId })` | `{ ok: true, data: { course } }` | `NOT_FOUND` se ausente ou inativo |

- Entrada inválida retorna `INVALID_INPUT` antes de acessar o repositório.
- O caso de uso converte `null` em `NOT_FOUND`, sem lançar exceção de domínio.
- Exceção inesperada ou saída incompatível retorna `OPERATION_FAILED`, sem dados
  parciais, stack trace, mensagem original da exceção ou valores substitutos.
- Mensagens de erro são fixas e os envelopes de falha também passam pelo schema.

Os testes usam o repositório em memória. Doubles e spies ficam restritos aos
cenários de falha, implementação incompatível e ausência de consulta após entrada
inválida. A suíte não chama rede ou modelos de linguagem.

## Política de cadastro de lead — tasks 4.2 e 4.3

`domain/lead-repository.ts` define somente:

| Método | Retorno |
| --- | --- |
| `findByConversationId(conversationId)` | `Promise<Lead \| null>` da própria conversa |
| `createForConversation(conversationId, input)` | `Promise<Lead \| null>`; null se já existe lead, sem substituí-lo |
| `updateForConversation(conversationId, input)` | `Promise<Lead \| null>`; substitui os dados completos preservando o ID; null se não há lead |

`InMemoryLeadRepository` usa um Map por conversa e gera o ID no backend. Valida o
registro inteiro antes de escrever, sem intercalar awaits na verificação/criação.
Entrada e retornos são copiados defensivamente. Contatos iguais em conversas
diferentes geram leads distintos. No update, o ID é obtido do registro existente;
input com ID é rejeitado. Não há await entre consulta e substituição do registro
completo já validado, nem criação implícita no update. Não há upsert, CRM ou busca global.

`application/create-lead.ts` separa duas operações determinísticas. A preparação
valida os campos obrigatórios do contexto e compara nome, contato, curso e objetivo
com o input, sem normalização. Verifica a correspondência entre registro e
`context.leadId`, consulta o curso ativo através da operação de catálogo e compara
todos os dados do lead com o contexto. Retorna um plano de criação, atualização ou
reconhecimento de dados idênticos. `confirmLeadRegistration` repete essas verificações
antes de gravar. O backend decide os outcomes; input com `outcome` é rejeitado.

| Estado validado | Chamada à tool | Confirmação |
| --- | --- | --- |
| Sem lead e `leadId: null` | Prévia + `CONFIRMATION_REQUIRED` | `created`, novo ID associado ao contexto |
| Lead idêntico e ID coerente | `existing`, sem prévia/escrita | `existing`, sem escrita se houver ação a confirmar |
| Lead diferente e mesmo ID coerente | Nova prévia + `CONFIRMATION_REQUIRED` | `updated`, mesmo ID |

Nome, `contact.type`, `contact.value`, curso e objetivo são comparados exatamente.
Não há merge direto do patch da LLM no repository. O update recebe os dados completos
do contexto validado. `goal: null` é permitido quando já é o estado vigente; a política
do interpretador não mudou (`null` no patch continua significando preservar).

`infrastructure/lead-tool.ts` valida entrada/saída com os schemas existentes e
encaminha a prévia à infraestrutura da 4.1 quando houver escrita a confirmar.
Para `existing`, devolve o lead do repository e invalida eventual prévia redundante,
mantendo o ID antigo como stale. Na composição, `prepareLead(conversationId, input)` obtém o contexto
atual dentro da fila e retorna `{ result, pendingAction }`. O `conversationId` é
um parâmetro separado do backend, nunca campo da entrada pública da tool.

`infrastructure/lead-confirmation.ts` é o executor padrão para `create_lead`.
Após vínculo e revisão serem verificados pelo core, usa os argumentos capturados,
revalida contexto/catálogo e executa a decisão do caso de uso. Na criação associa o
ID salvo a `leadId`; updates preservam esse ID e existing não faz escrita. Não há
incremento de revisão por efeito da confirmação. A infraestrutura conserva
o recibo antes do envio HTTP. Uma confirmação repetida devolve o snapshot anterior,
inclusive depois de corrigir o contexto ou de concluir outro update. Um retry de
`created` continua `created`; um retry de `updated` continua sendo aquele `updated`
com os dados daquela ação. Não se reexecuta o cadastro para construir um recibo antigo.
Uma correção só muda o contexto e torna a ação pendente anterior stale. O lead salvo
permanece intacto até uma nova confirmação, e uma prévia nova invalida a pendente anterior.

Mapeamento da preparação: entrada ou contexto incompletos/divergentes →
`INVALID_INPUT`; curso ausente/inativo → `NOT_FOUND`; prévia preparada →
`CONFIRMATION_REQUIRED`; exceção/saída interna incompatível → `OPERATION_FAILED`.
Registro sem vínculo no contexto, ID divergente ou vínculo sem registro são
inconsistências técnicas: não há correção automática nem escrita. Retornam
`OPERATION_FAILED` na tool e `CHAT_ERROR` na confirmação. Falhas esperadas na confirmação ficam no resultado
estruturado `create_lead` com HTTP 200, sem sucesso de negócio; falhas técnicas
anteriores à escrita seguem `500/CHAT_ERROR` e mantêm a ação disponível para retry.
As respostas não expõem detalhes internos. Apenas resultados concluídos são
conservados pela infraestrutura de recibos.

O caso de uso não conhece LangChain, Fastify ou implementações de repositório.
O core não conhece lead. Na integração da 4.4, o runner passa um escopo genérico
com conversa, cópia do contexto e callback de proposta. O adapter compõe a tool com
esse escopo, mantendo `createLeadInputSchema` como única entrada visível ao modelo.
Não há rota adicional de preparação.

O callback da tool no chat somente guarda uma proposta local; não chama `prepare`
nem invalida ações globais. A redação precisa terminar e o envelope precisa ser
validado antes do commit síncrono de contexto, histórico e ação. `existing` propõe
retirar a prévia apenas no commit. Uma falha conserva inclusive a ação anterior.
O acesso interno direto `prepareLead` mantém sua preparação imediata dentro da fila;
o caminho conversacional usa staging para preservar a atomicidade do turno.

Os testes do repository, da tool e de confirmação verificam proposta sem escrita,
contexto como autoridade, revisão, cópias defensivas, isolamento, revalidação do
curso, falhas sem registro parcial e retry sem segundo cadastro. `lead-policy.test.ts`
acrescenta updates por campo, existing sem escrita, revisões sucessivas, vínculo
inconsistente e recibos históricos. Confirmar cadastro retorna exclusivamente
`tool: create_lead`; não seleciona horário nem autoriza outra ação. Todos os testes
são locais; as confirmações usam `server.inject()` e não consultam uma LLM.

`chat-lead.test.ts` cobre a composição LangChain com quatro tools, o schema sem
escopo/autorização, ToolMessages e resultados oficiais, ausência de escrita antes
da confirmação, existing, Sim, correção e ação antiga/estrangeira. Os testes de
atomicidade provocam falha na redação com/sem ação anterior, resposta pública
inválida e falha após existing, conservando histórico, contexto e lifecycle.

## Consulta da agenda interna — task 5.1

`domain/trial-class-repository.ts` oferece somente leituras:

| Método | Retorno |
| --- | --- |
| `listSlotsByCourseId(courseId)` | `Promise<Slot[]>` cadastrados para o curso, sem filtrar por relógio |
| `findSlotById(slotId)` | `Promise<Slot \| null>`; leitura por ID adicionada na 5.2, com cópia defensiva |
| `findConfirmedBySlotId(slotId)` | `Promise<TrialClass \| null>`; reserva confirmada ocupa a única vaga |

`InMemoryTrialClassRepository` recebe slots e, opcionalmente, reservas iniciais.
Valida os schemas e mantém cópias defensivas de entradas e saídas. A ocupação usa
um Map por `slotId`, dentro da mesma instância da agenda. Não há método de escrita,
geração de ID, bloqueio ou criação de reserva durante uma consulta. A futura
operação atômica poderá consultar e gravar nesse mesmo estado, sem substituir as
leituras atuais; ela ainda não está implementada.

`application/get-available-slots.ts` reutiliza `getCourseDetails` para verificar o
curso ativo antes de acessar a agenda. Valida os registros retornados, preserva
somente o curso pedido, exige o fuso cadastrado da escola e inclui apenas slots
com `Date.parse(startsAt) > now().getTime()` e nenhuma reserva confirmada. O relógio
é lido uma vez por consulta, antes da leitura da agenda. Comparações usam instantes
absolutos, incluindo offsets distintos; o resultado conserva o ISO e o fuso originais.

**Decisão de apresentação:** os slots são ordenados cronologicamente, em ordem
crescente do instante absoluto. Essa ordenação não depende da ordem das fixtures
nem modifica o armazenamento. Dado interno inválido ou fuso incompatível interrompe
a consulta como falha controlada, sem publicar disponibilidade parcial.

`infrastructure/available-slots-tool.ts` implementa `get_available_slots` com os
schemas públicos existentes. Input inválido produz `INVALID_INPUT`; curso ausente
ou inativo, `NOT_FOUND`; falha técnica/saída inválida, `OPERATION_FAILED`, sem expor
exceções. Curso sem vagas produz sucesso com `slots: []`.

A composição instancia o repository e expõe a operação interna
`app.getAvailableSlots({ courseId })`. Aceita `trialClassRepository` e `now: () => Date`
como overrides; somente a composição usa `() => new Date()` por padrão. Não foi
adicionado endpoint, registro LangChain, instrução de prompt ou componente de UI.
A consulta não recebe conversa, contexto, lead, ação ou executor de confirmação.
`context.slotId` permanece como antes e nenhum resultado se transforma em reserva.

### Fixtures e relógio de referência

`infrastructure/slot-fixtures.ts` contém datas fixas, sem geração ou deslocamento
dinâmico. Os cenários abaixo usam **2030-06-10T12:00:00Z** como relógio injetado.
Todos os registros têm `timezone: America/Sao_Paulo`, igual à escola fictícia.

| slotId | courseId | startsAt cadastrado | Cenário com relógio fixo |
| --- | --- | --- | --- |
| `slot_english_a` | `course_english_travel` | `2030-06-11T10:00:00-03:00` | Futuro livre A |
| `slot_english_b` | `course_english_travel` | `2030-06-12T14:00:00-03:00` | Futuro livre B |
| `slot_english_past` | `course_english_travel` | `2030-06-09T10:00:00-03:00` | Passado |
| `slot_english_occupied` | `course_english_travel` | `2030-06-11T09:00:00-03:00` | Ocupado quando injetada a reserva fixture |
| `slot_spanish_past` | `course_spanish_conversation` | `2030-06-09T15:00:00-03:00` | Curso sem vagas futuras |
| `slot_french_a` | `course_french_intro` | `2030-06-11T11:00:00-03:00` | Futuro livre de outro curso |

`trialClassFixtures` contém `trial_demo_occupied`, associado a `lead_demo_occupied`
e `slot_english_occupied`, com `status: confirmed` e os mesmos curso/ISO/fuso do slot.
É somente estado inicial fictício para testes; nenhum lead é criado por ele.
A composição normal começa com reservas vazias. Portanto, inclusive esse slot fica
livre até existir ocupação real; o sufixo do ID não determina disponibilidade.

Na aplicação normal, passado/futuro seguem o relógio real. As datas não são
adaptadas ao dia atual: poderão deixar de ser futuras, retornando lista vazia.
Os testes sempre injetam um instante fixo e não dependem da data da execução.

Os testes de repository, caso de uso/tool e composição cobrem isolamento por curso,
cópias defensivas, ocupação inicial, passado/agora/futuro, offsets distintos,
ordenação, lista vazia, validação de contratos e falhas sanitizadas. Consultas
repetidas preservam as vagas livres, reservas, IDs, lead e contexto; nenhum estado
de ação/confirmador é acessado e nenhuma LLM ou rede é necessária.

## Proposta de aula experimental — task 5.2

`application/prepare-trial-class.ts` valida uma proposta sem escrever. Recebe
`conversationId` e `ConversationContext` do backend, as três interfaces de
repository e o mesmo `now: () => Date` usado na disponibilidade. Consulta o lead
exclusivamente pela conversa; exige vínculo com `context.leadId` e igualdade exata
de nome, tipo/valor do contato, curso e objetivo. Divergência exige revisão e
confirmação da atualização de cadastro; não atualiza o lead automaticamente.

O curso é revalidado por `getCourseDetails`. O slot é consultado por ID, deve
corresponder ao curso atual e ao fuso da escola, ter instante estritamente maior
que o relógio injetado e não possuir reserva confirmada. Esta leitura de ocupação
não garante disponibilidade na confirmação: a operação atômica pertence à 5.3.

Se `context.slotId` estiver definido, deve ser idêntico ao argumento. Se for
`null`, a proposta valida o slot fornecido contra a agenda e preserva o contexto
sem preenchê-lo, seguindo a condição explícita da task. Nenhuma interpretação
natural de horário foi acrescentada. Curso corrigido pelo fluxo existente limpa
a seleção incompatível e incrementa a revisão; os testes de troca de horário
fornecem estado interno validado com a nova revisão.

`infrastructure/trial-class-tool.ts` recebe somente `{ leadId, slotId }` como
entrada pública. Usa `scheduleTrialClassInputSchema` e
`scheduleTrialClassResultSchema`, sem coerção ou campos extras. O escopo do backend
é um parâmetro separado. Não foi registrada uma quinta tool no LangChain.

A prévia `{ lead, course, slot }` é validada pelo contrato existente. `lead` e
`slot` são registros oficiais; `course` projeta somente os campos do resumo ativo
do catálogo. Não há informações extraídas da prosa. A infraestrutura existente
deriva `{ leadId, slotId }` desses dados, captura cópias e associa conversa/revisão.
A preparação gera `CONFIRMATION_REQUIRED`; nenhuma `TrialClass`, ID de reserva
ou ocupação é criada. `get_available_slots` continua mostrando a mesma vaga.

| Condição | Resultado público |
| --- | --- |
| Input extra/inválido, slot diferente da seleção ou referências de cursos incompatíveis | `INVALID_INPUT` |
| Cadastro divergente do contexto | `INVALID_INPUT`, orientando confirmar a atualização do cadastro |
| Lead/context.leadId ausente, ID do lead diferente, conversa/curso/slot inexistente ou curso inativo | `NOT_FOUND`, sem dados de outra conversa |
| Slot passado, exatamente no instante atual ou ocupado | `SLOT_UNAVAILABLE` |
| Proposta válida | `CONFIRMATION_REQUIRED` e prévia separada |
| Falha técnica, vínculo interno incoerente, schema inválido ou fuso incompatível com a escola | `OPERATION_FAILED`, sem detalhes internos |

`app.prepareTrialClass(conversationId, input)` usa a mesma fila local de chat e
confirmação. Lê o contexto atual dentro da fila e prepara a ação somente após
validar todos os registros. Não adiciona endpoint. Uma falha de validação não
substitui a ação anterior. A nova proposta bem-sucedida torna a anterior stale;
revisão diferente também impede executá-la. Mensagens sem mudança conservam a
ação; “Sim” continua sem autorizar nada.

`POST /api/chat/confirm` permanece restrito aos dois IDs. Ação estrangeira/ausente
retorna 404 e stale retorna 409. Repetir o ID de um cadastro concluído devolve seu
recibo de `create_lead`, mantendo a proposta de aula pendente. Não há executor de
reserva nesta task: confirmar uma proposta de aula ainda válida retorna
`500 / CHAT_ERROR` controlado e a ação permanece pendente, sem sucesso fictício.

O ID `slot_english_occupied` foi preservado para evitar renomear fixtures e testes.
Ocupação é decidida exclusivamente pelas reservas, nunca pelo nome do slot.

Os testes adicionados cobrem entradas estritas, cadastro desatualizado/estrangeiro,
catálogo, instante absoluto com offsets, ocupação, prévia oficial e imutabilidade.
Com `server.inject()` e modelo simulado, verificam revisão por nome/contato/objetivo/
curso/horário, ausência de mudança, isolamento, recibo de cadastro independente e
ausência de execução de reserva. Não precisam de rede ou credenciais.
