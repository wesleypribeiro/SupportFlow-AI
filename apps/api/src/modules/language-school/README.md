# Módulo de escolas de idiomas

Catálogo de leitura das tasks 2.2 e 2.3 de `language-school-sales-mvp`, conectado
ao chat na task 3.1 e usando integralmente os contratos aprovados na task 2.1.

## Organização

- `domain/school-repository.ts`: interface de consulta da escola configurada.
- `application/catalog-queries.ts`: operações determinísticas, dependentes
  somente da interface e dos tipos compartilhados.
- `infrastructure/catalog-fixtures.ts`: uma escola e quatro cursos fictícios.
- `infrastructure/in-memory-school-repository.ts`: armazenamento local de leitura.
- `infrastructure/catalog-tools.ts`: três funções com validação de entrada/saída e
  conversão de falhas para resultados públicos.
- `infrastructure/langchain-catalog-tools.ts`: adaptação das três consultas para
  tool calling, sem mudar domínio, casos de uso ou repositório.
- `prompt.ts`: instruções iniciais de atendimento e consulta de fatos do catálogo.

O ponto de composição `src/app.ts` instancia o repositório e expõe `catalogTools`
ao código do backend. O core continua sem importar o módulo escolar e recebe as
tools, instruções e validação da resposta pública pela composição.

O adapter LangChain usa os mesmos schemas de entrada e delega a `catalogTools`.
O resultado validado vai em JSON no conteúdo da `ToolMessage` e como objeto no
`artifact`; `tool_call_id` mantém a associação padrão da chamada. Uma cópia validada
do objeto também compõe `results` de `/api/chat`, independentemente da prosa do modelo.
Argumentos rejeitados pelo LangChain são convertidos em `INVALID_INPUT` sanitizado;
`NOT_FOUND` é um resultado normal. Falhas técnicas interrompem o turno com `CHAT_ERROR`.

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
