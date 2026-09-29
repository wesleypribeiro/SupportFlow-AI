# Módulo de escolas de idiomas

Catálogo de leitura das tasks 2.2 e 2.3 de `language-school-sales-mvp`, conectado
ao chat na task 3.1, com contexto vigente na task 3.2 e política de atendimento
consolidada na task 3.4. As tasks 4.2 e 4.3 acrescentam a preparação de cadastro,
criação/atualização confirmadas e reconhecimento de lead idêntico sem escrita.
A task 4.4 conecta essa operação ao chat e à interface. Usa os contratos aprovados na task 2.1.
A task 5.1 acrescenta a consulta de disponibilidade da agenda interna.
A task 5.2 acrescenta somente a proposta determinística de aula experimental.
A task 5.3 acrescenta reserva atômica e recibo determinístico pela confirmação HTTP.
A task 5.4 conecta consulta, seleção, proposta e recibo ao chat e à interface.
A task 6.1 acrescenta solicitação local de atendimento humano como operação
determinística interna. A task 6.2 conecta essa operação ao LangChain e ao chat.

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
- `infrastructure/langchain-tools.ts`: combina catálogo, `create_lead` e as duas tools de agenda, com escopo
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
propõe `goal`, `name`, `contact`, `courseReference` e `slotReference`, com `null` significando
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
resultados oficiais permitem explicar operações concluídas. A task 6.2 acrescenta
o registro local de solicitação humana, sem iniciar atendimento ao vivo.

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

`domain/trial-class-repository.ts` oferece as leituras abaixo e `reserveSlot`,
acrescentado na task 5.3:

| Método | Retorno |
| --- | --- |
| `listSlotsByCourseId(courseId)` | `Promise<Slot[]>` cadastrados para o curso, sem filtrar por relógio |
| `findSlotById(slotId)` | `Promise<Slot \| null>`; leitura por ID adicionada na 5.2, com cópia defensiva |
| `findConfirmedBySlotId(slotId)` | `Promise<TrialClass \| null>`; reserva confirmada ocupa a única vaga |

`InMemoryTrialClassRepository` recebe slots e, opcionalmente, reservas iniciais.
Valida os schemas e mantém cópias defensivas de entradas e saídas. A ocupação usa
um Map por `slotId`, dentro da mesma instância da agenda. Não há escrita,
geração de ID, bloqueio ou criação de reserva durante uma consulta. A operação
atômica da task 5.3 utiliza esse mesmo estado, preservando as leituras existentes.

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
é um parâmetro separado. A task 5.4 acrescenta seu adapter ao LangChain, com escopo separado do input.

A prévia `{ lead, course, slot }` é validada pelo contrato existente. `lead` e
`slot` são registros oficiais; `course` projeta somente os campos do resumo ativo
do catálogo. Não há informações extraídas da prosa. A infraestrutura existente
deriva `{ leadId, slotId }` desses dados, captura cópias e associa conversa/revisão.
A preparação gera `CONFIRMATION_REQUIRED`; nenhuma `TrialClass`, ID de reserva
ou ocupação é criada. `get_available_slots` continua mostrando a mesma vaga.

| Condição | Resultado público |
| --- | --- |
| Input extra/inválido, slot diferente da seleção, referências de cursos incompatíveis ou fuso incompatível com a escola | `INVALID_INPUT` |
| Cadastro divergente do contexto | `INVALID_INPUT`, orientando confirmar a atualização do cadastro |
| Lead/context.leadId ausente, ID do lead diferente, conversa/curso/slot inexistente ou curso inativo | `NOT_FOUND`, sem dados de outra conversa |
| Slot passado/atual sem reserva própria, ou ocupado por outro lead | `SLOT_UNAVAILABLE` |
| Reserva já registrada para o mesmo lead e slot (5.3) | `existing`, sem nova ação/escrita |
| Proposta válida | `CONFIRMATION_REQUIRED` e prévia separada |
| Falha técnica, vínculo interno incoerente ou schema inválido | `OPERATION_FAILED`, sem detalhes internos |

`app.prepareTrialClass(conversationId, input)` usa a mesma fila local de chat e
confirmação. Lê o contexto atual dentro da fila e prepara a ação somente após
validar todos os registros. Não adiciona endpoint. Uma falha de validação não
substitui a ação anterior. A nova proposta bem-sucedida torna a anterior stale;
revisão diferente também impede executá-la. Mensagens sem mudança conservam a
ação; “Sim” continua sem autorizar nada.

`POST /api/chat/confirm` permanece restrito aos dois IDs. Ação estrangeira/ausente
retorna 404 e stale retorna 409. Repetir o ID de um cadastro concluído devolve seu
recibo de `create_lead`, mantendo a proposta de aula pendente. A task 5.3 conecta
o executor real de reserva descrito abaixo; a 5.2 acrescentou apenas a preparação.

O ID `slot_english_occupied` foi preservado para evitar renomear fixtures e testes.
Ocupação é decidida exclusivamente pelas reservas, nunca pelo nome do slot.

Os testes adicionados cobrem entradas estritas, cadastro desatualizado/estrangeiro,
catálogo, instante absoluto com offsets, ocupação, prévia oficial e imutabilidade.
Com `server.inject()` e modelo simulado, verificam revisão por nome/contato/objetivo/
curso/horário, ausência de mudança, isolamento, recibo de cadastro independente e
ausência de execução de reserva. Não precisam de rede ou credenciais.

## Reserva atômica e recibos — task 5.3

`TrialClassRepository.reserveSlot({ leadId, slotId }, now: Date)` acrescenta a única
escrita da agenda. Seu resultado interno é `created`/`existing` com `booking`,
`unavailable` para ocupação por outro lead ou horário não futuro, ou `not_found`
para slot ausente. Não aceita ID de reserva nem dados de horário do chamador.

Na implementação em memória, a leitura do slot e da ocupação, a decisão e a
inserção no Map ocorrem sem await/yield. Esta é a fronteira atômica por vaga,
independente das filas de conversa. Um banco futuro precisará de constraint ou
transação equivalente. O registro inteiro é validado por `trialClassSchema` antes
do commit, usa UUID do backend e curso/ISO/fuso do slot oficial. Inputs e retornos
não permitem alterar o registro armazenado.

Mesmo lead/slot recupera `existing` antes de considerar a vaga ocupada ou o
horário passado: trata-se de recuperar uma reserva concluída, sem nova escrita.
Uma nova reserva exige `startsAt > now`, novamente verificado dentro da operação
atômica. Cada slot possui somente um registro; outro lead recebe `unavailable`.

`validateTrialClassReferences` é compartilhado pela preparação e confirmação:
reconsulta lead da conversa, compara contexto e cadastro, valida curso ativo,
seleção do slot e fuso. Fuso válido mas incompatível é agora `INVALID_INPUT`
para a operação de proposta/confirmação; schemas inválidos continuam falhas
técnicas. A consulta `get_available_slots` preserva seu comportamento anterior.

`application/confirm-trial-class.ts` usa o relógio injetado e delega a decisão final
diretamente a `reserveSlot`; não usa `findConfirmedBySlotId` seguido de escrita.
O executor `infrastructure/trial-class-confirmation.ts` lê a conversa atual e os
argumentos armazenados da ação. Não confia no snapshot da prévia como prova de
validade atual e não consulta a LLM. Produz um recibo validado com mensagem
determinística sobre a agenda demonstrativa.

`infrastructure/action-confirmation.ts` faz o dispatcher explícito por `kind`
entre os executores de cadastro e aula. O core e os contratos públicos não mudaram.
A integração ao LangChain e à UI foi acrescentada na task 5.4, descrita abaixo.

| Situação | Resultado |
| --- | --- |
| Confirmação válida de vaga livre | `created`, vaga ocupada |
| Nova chamada/execução para mesmo lead e mesmo slot | `existing`, sem escrita |
| Vaga ocupada por outro lead | `SLOT_UNAVAILABLE`, sem escrita adicional |
| Retry do mesmo actionId concluído | Recibo histórico exato, sem executar novamente |
| Exceção técnica antes de gravar | HTTP 500 `CHAT_ERROR`, ação disponível para retry |

**Transporte da task 5.3:** o conflito é guardado como recibo em `results` e
retornado com HTTP 200. Esta escolha segue o fluxo específico de recibo desta
task e substitui a indicação geral anterior de HTTP 409 para `SLOT_UNAVAILABLE`.
HTTP 409 continua sendo usado para `ACTION_STALE`. O recibo de conflito também
conclui a ação; repetir seu ID retorna a mesma indisponibilidade sem outra tentativa.

Depois de `created`, repetir o ID da ação devolve `created`, enquanto uma nova
chamada da tool retorna `existing` e remove uma prévia que não requer mais escrita.
Os recibos e reservas são snapshots: mudanças de contexto, updates confirmados
do lead e novas ações não reescrevem a reserva ou recibos anteriores. Não há
cancelamento/remarcação. `get_available_slots` exclui o slot ocupado para qualquer
conversa, inclusive para o próprio lead que o reservou.

`slot-reservation.test.ts` verifica resultados, IDs, cópias, futuro e concorrência
com `Promise.all` para leads diferentes e iguais. `trial-class-confirmation.test.ts`
usa `server.inject()` e uma barreira antes da operação real para colocar duas
conversas simultaneamente na disputa: exatamente uma vence. Cobre revalidação,
falha antes da escrita, falha de envio após o recibo salvo, retries históricos,
regressão de cadastro e reservas preservadas após updates. Nenhum teste depende
de credenciais, rede ou OpenAI real.


## Agenda no chat e contingência após escrita — task 5.4

As seis tools do módulo usam schemas públicos existentes. `get_available_slots`
delega à consulta determinística, sem selecionar/ocupar vagas. O adapter de
`schedule_trial_class` exige `context.slotId`, usa o escopo interno da conversa e
chama `scope.proposeAction`, assim como o cadastro. Não chama `actions.prepare`
durante o turno. A proposta permanece local até redação e validação do envelope;
falha preserva contexto, histórico e a ação anterior, sem ação órfã.

O mesmo modelo interpreta `slotReference: { slotId, evidence } | null`, recebendo
os slots oficiais elegíveis do curso vigente em mensagem de sistema marcada como
dados. Evidence deve ser trecho literal da mensagem atual; o backend reconsulta
as vagas com relógio injetado, valida curso, futuro, ocupação e schema antes de
aplicar o ID. `domain/slot-reference.ts` exige uma data e uma hora explícitas tanto
na evidência quanto na mensagem inteira. Aceita DD/MM com ano opcional ou data por
extenso em português, combinada com HH:mm, Hh ou HhMM. Compara esses componentes
com `startsAt` no `timezone` oficial, como na apresentação da UI. Exige exatamente
um slot elegível correspondente e o mesmo ID proposto: evidência de A não autoriza B.
Várias datas/horas, slots indistinguíveis, referência genérica, relativa ou incompleta
preservam a seleção e a revisão. Recortar evidence de uma mensagem com duas opções
não contorna essa validação. Não há resolução de ordinais ou NLP de datas relativas;
o agente pede uma única data e hora no fuso apresentado. A interpretação de intenção
continua probabilística, mas a associação entre data/hora explícitas e slot é determinística.

Mesma seleção não incrementa revisão. Outra seleção válida incrementa uma vez e
invalida a prévia anterior no commit do turno. Trocar curso limpa o horário. O
patch interno ganhou esse campo; os contratos públicos permanecem inalterados.
O atendimento recebe o contexto atualizado antes de selecionar tools. Corrigir
cadastro ainda exige confirmação separada antes de propor aula.

A confirmação encaminha somente IDs ao lifecycle, depois ao executor escolar e
`reserveSlot`. O core salva primeiro o recibo determinístico concluído. Só depois
o callback do módulo `confirmation-reply.ts` usa o modelo sem tools para explicar
o resultado da aula. Erro, tool call, conteúdo não textual/vazio ou resposta fora
do schema conserva a mensagem determinística e todos os resultados, com HTTP 200.
Uma redação válida altera somente reply e é salva no recibo. Retry do mesmo actionId
recupera esse snapshot sem escrita nem nova chamada ao modelo. A confirmação de
cadastro continua com redação determinística e não autoriza a aula.

Testes novos: `chat-trial-class.test.ts` cobre slots oficiais, seleção e revisão,
propostas, Sim, ação antiga, lead divergente, atomicidade em falha, conflito,
existing, prosa divergente e fallback após escrita. `pending-actions.test.ts`
verifica que o recibo já é recuperável durante a redação e protege resultados contra
mutação pelo redator. Correções reais pelo chat de contato/objetivo/curso/horário e
update confirmado do lead deixam a reserva e o recibo anterior intactos.

## Solicitação local de atendimento humano — task 6.1

`HandoffRepository` possui apenas `findOpenByConversationId(conversationId)` e
`requestForConversation(conversationId, { reason })`. O primeiro consulta a
solicitação; o segundo registra ou devolve a original numa única operação.
`InMemoryHandoffRepository` usa Map por conversa, gera o ID no backend, valida o
registro completo antes da escrita e devolve cópias defensivas. Não há await entre
consulta e inserção: chamadas concorrentes não abrem solicitações duplicadas.
Repetição preserva ID, motivo e status originais, mesmo com outro reason.
Outra conversa pode registrar o mesmo motivo e recebe seu próprio ID.

O caso de uso `application/transfer-to-human.ts` recebe o escopo do backend
separadamente: `conversationId` e `visitorIntent: request | accepted_offer | null`.
Esse sinal representa pedido do visitante ou aceitação de uma oferta já identificados
pelo chamador; null impede o registro. Não é argumento da LLM nem uma segunda
confirmação. A interpretação conversacional e seu vínculo à mensagem/oferta serão
validados na integração 6.2 descrita abaixo; a operação da 6.1 permanece independente
de LLM, catálogo, lead, agenda e ações pendentes.

`infrastructure/handoff-tool.ts` aceita somente `{ reason }`, valida entrada e
resultado com os contratos existentes e delega ao caso de uso/repository. Reason
é preservado sem normalização. Entrada inválida, extras ou ausência de intenção
produzem `INVALID_INPUT`; exceções e saída fora do schema produzem
`OPERATION_FAILED`, sem protocolo inventado ou detalhes internos. Sucesso usa
exclusivamente `{ ok: true, data: { request: { id, reason, status: requested } } }`
recuperado do repository. Não há outcome adicional no contrato público.

`app.requestHumanHandoff(conversationId, input, visitorIntent)` é um ponto interno
de composição, sem endpoint público. Usa a fila existente da conversa, verifica
que ela existe e não modifica histórico, contexto ou ações pendentes. Conversa
inexistente nesse acesso interno resulta em `OPERATION_FAILED`, sem criar estado.
A garantia contra duplicação também existe no repository, independentemente da fila.

Exemplo sem cadastro: para “Não quero me cadastrar. Prefiro falar com alguém.”,
o backend pode chamar essa operação com o ID da conversa, `{ reason: "Prefiro
falar com alguém." }` e `request`. Nome, contato, curso, lead e slot podem continuar
null. Aceitação de oferta usa `accepted_offer`. Nenhum lead ou agendamento é criado,
e a revisão não muda. Não se cria ou consome pendingAction.

`requested` significa somente solicitação registrada na agenda interna
demonstrativa de encaminhamentos. Não informa recebimento por uma pessoa,
atribuição, disponibilidade de operadores, atendimento ao vivo ou prazo.
Não existe integração externa, persistência em arquivo/banco ou encerramento.
O registro se perde com o reinício, como os demais repositories em memória.

Testes: `handoff-repository.test.ts` cobre isolamento, cópias, falha antes da escrita
e concorrência; `handoff-tool.test.ts` cobre schemas, intenção interna, idempotência
e falhas sanitizadas; `handoff-composition.test.ts` verifica pedido/aceitação com e
sem lead, preservação de contexto, reservas e prévia, funcionamento sem modelo e
preservação do conjunto explícito de tools do agente. Tudo funciona sem rede/LLM real.


## Handoff no chat e recuperação de redação — task 6.2

As sete tools estão registradas explicitamente. `transfer_to_human` expõe somente
`reason`; seu adapter recebe mensagem atual, histórico anterior e conversationId
pelo escopo interno do runner. Nenhum desses campos entra no schema público.
O domínio resolve a intenção sem nova chamada à LLM em `handoff-intent.ts`:

- Pedidos diretos como “Quero falar com alguém”, “Prefiro um atendente” e
  “Pode me passar para uma pessoa?” são reconhecidos conservadoramente.
- Negativas, hipóteses, citações e formas não reconhecidas não autorizam escrita.
  O agente pede esclarecimento. Isto não pretende ser um classificador NLP geral.
- Uma aceitação curta, inclusive “Sim”, exige que a última resposta final já salva
  seja uma oferta inequívoca de handoff. O prompt orienta uma pergunta canônica;
  duas variantes explícitas também são reconhecidas. A oferta expira após outro
  turno. Ofertas de cadastro/reserva, outra conversa, ToolMessages e a própria
  seleção atual da LLM não contam. Não há estado novo no ConversationContext,
  nem revisão por oferecer/registrar handoff.

A operação da 6.1 registra antes da redação, preservando ID e motivo originais.
Seu resultado Zod válido entra no ToolMessage associado e no array oficial de
results. OPERATION_FAILED deste adapter é um resultado controlado, sem protocolo;
as políticas anteriores de falha das outras ferramentas foram preservadas.

`handoff-reply.ts` produz a apresentação determinística a partir dos resultados.
Ela substitui a prosa sobre handoff mesmo quando a LLM responde normalmente, para
não prometer recebimento, atendimento ao vivo ou envio externo. O runner continua
com uma rodada de tools e uma redação sem tools, sem retry ou segundo agente.

Se a redação lançar, vier vazia/não textual ou pedir outra tool, só um sucesso de
registro já validado habilita a recuperação: HTTP 200, protocolo original, results
intactos e AIMessage determinística salva no histórico. O contexto validado do turno
é salvo junto desse histórico; alterações reais ainda seguem a revisão normal.
Falhas anteriores ao registro não usam esse fallback. Uma falha de registro retorna
somente seu erro; se a redação também falhar, continua CHAT_ERROR.

Em lote misto, uma proposta de cadastro/reserva continua local. Se a redação falhar
após o handoff, essa proposta é descartada; a prévia anterior permanece quando a
revisão não mudou. Registrar a solicitação não chama confirmação, não cria lead ou
booking e não invalida ações por si só. A recuperação é específica da etapa de
redação, não um mecanismo transacional ou recuperação genérica de todas as falhas.

Testes novos: `handoff-intent.test.ts` cobre pedidos, aceitação condicionada,
negativas e ambiguidade. `chat-handoff.test.ts` cobre as sete tools/schemas,
escopo servidor, oferta realmente apresentada, repetição/isolamento, sem/com lead,
prévia e reserva preservadas, falha anterior à escrita, saída inválida e recuperação
após escrita com erro/conteúdo inválido/tool call. Também verifica histórico coerente
e descarte de proposta de cadastro em lote com redação fracassada.
