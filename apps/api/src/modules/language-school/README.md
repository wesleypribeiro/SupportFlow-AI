# Módulo de escolas de idiomas

Catálogo de leitura das tasks 2.2 e 2.3 de `language-school-sales-mvp`, conectado
ao chat na task 3.1, com contexto vigente na task 3.2 e política de atendimento
consolidada na task 3.4. A task 4.2 acrescenta a preparação de cadastro e a criação
do primeiro lead por confirmação. Usa os contratos aprovados na task 2.1.

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
O prompt proíbe afirmar cadastro, agendamento, reserva ou transferência concluídos
nesta etapa do agente, que ainda recebe somente as tools de leitura de catálogo.

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

## Primeiro cadastro de lead — task 4.2

`domain/lead-repository.ts` define somente:

| Método | Retorno |
| --- | --- |
| `findByConversationId(conversationId)` | `Promise<Lead \| null>` da própria conversa |
| `createForConversation(conversationId, input)` | `Promise<Lead \| null>`; null se já existe lead, sem substituí-lo |

`InMemoryLeadRepository` usa um Map por conversa e gera o ID no backend. Valida o
registro inteiro antes de escrever, sem intercalar awaits na verificação/criação.
Entrada e retornos são copiados defensivamente. Contatos iguais em conversas
diferentes geram leads distintos. A atualização por conversa será acrescentada
com a política da task 4.3; não há upsert, CRM ou busca global antecipados.

`application/create-lead.ts` separa duas operações determinísticas. A preparação
valida os campos obrigatórios do contexto e compara nome, contato, curso e objetivo
com o input, sem normalização. Consulta o curso ativo através da operação de catálogo
e verifica se a conversa já tem lead. Retorna uma prévia formada dos dados oficiais
do contexto. `createFirstLead` repete essas verificações antes da criação e retorna
`created` exclusivamente com o registro salvo.

`infrastructure/lead-tool.ts` valida entrada/saída com os schemas existentes e
encaminha a prévia à infraestrutura da 4.1. Retorna somente `CONFIRMATION_REQUIRED`,
sem gravar. Na composição, `prepareLead(conversationId, input)` obtém o contexto
atual dentro da fila e retorna `{ result, pendingAction }`. O `conversationId` é
um parâmetro separado do backend, nunca campo da entrada pública da tool.

`infrastructure/lead-confirmation.ts` é o executor padrão para `create_lead`.
Após vínculo e revisão serem verificados pelo core, usa os argumentos capturados,
revalida o contexto/catálogo e cria o primeiro lead. Associa o ID salvo a `leadId`,
sem incrementar revisão, dentro da mesma serialização. A infraestrutura conserva
o recibo antes do envio HTTP. Uma confirmação repetida devolve o snapshot anterior,
inclusive depois de corrigir o contexto; não modifica o lead já salvo.

Mapeamento da preparação: entrada ou contexto incompletos/divergentes →
`INVALID_INPUT`; curso ausente/inativo → `NOT_FOUND`; prévia preparada →
`CONFIRMATION_REQUIRED`; exceção/saída interna incompatível → `OPERATION_FAILED`.
Conversa já cadastrada também retorna `OPERATION_FAILED` com mensagem própria,
sem aplicar `existing`/`updated`. Falhas esperadas na confirmação ficam no resultado
estruturado `create_lead` com HTTP 200, sem sucesso de negócio; falhas técnicas
anteriores à escrita seguem `500/CHAT_ERROR` e mantêm a ação disponível para retry.
As respostas não expõem detalhes internos. Apenas resultados concluídos são
conservados pela infraestrutura de recibos.

O caso de uso não conhece LangChain, Fastify ou implementações de repositório.
O core não conhece lead. Nenhuma tool de cadastro foi vinculada ao modelo, nenhuma
rota de preparação foi criada e o prompt/UI não mudaram. A integração é da 4.4.

Os testes do repository, da tool e de confirmação verificam proposta sem escrita,
contexto como autoridade, revisão, cópias defensivas, isolamento, revalidação do
curso, falhas sem registro parcial e retry sem segundo cadastro. Todos são locais;
as confirmações usam `server.inject()` e não consultam uma LLM.
