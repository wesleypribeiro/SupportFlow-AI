# lead-capture Specification

## Purpose
Registrar o interesse de um potencial aluno com os dados que ele forneceu, preservando suas correções e uma confirmação de cadastro específica desta primeira versão.

## Requirements

### Requirement: Collect structured lead data supplied by the visitor

O sistema SHALL disponibilizar `create_lead({ name, contact: { type, value }, courseId, goal })`, com `type` limitado a `email` ou `phone`, `goal` como texto ou `null` e schemas estritos. Nome e contato MUST vir do visitante; o curso MUST existir e estar ativo no catálogo consultado, e o objetivo MUST refletir a informação mais recente do visitante, ou `null` quando não informado. A conversa SHALL ser vinculada pelo backend, sem aceitar um identificador de conversa produzido pela LLM como argumento da tool.

#### Scenario: Required information is missing or invalid

- **WHEN** o visitante ainda não forneceu nome ou contato válido, ou o curso não existe
- **THEN** o sistema solicita os dados faltantes ou informa o erro de referência, sem cadastrar um lead nem inventar os campos

#### Scenario: Visitor supplies valid information

- **WHEN** o visitante fornece nome e contato válidos e escolhe um curso retornado pelo catálogo
- **THEN** o sistema prepara a prévia com esses dados e com o objetivo mais recente, sem gravar o cadastro antes da confirmação

### Requirement: Confirm lead registration as a separate MVP UX decision

Nesta versão, o sistema SHALL exigir confirmação explícita do cadastro por uma ação pendente preparada pelo backend, vinculada à conversa, aos argumentos apresentados e à revisão do contexto. Uma proposta válida ainda não confirmada SHALL produzir `CONFIRMATION_REQUIRED` e a prévia pendente, como continuação esperada da conversa, sem gravar o lead. A confirmação SHALL identificar essa ação, sem reenviar argumentos de cadastro editáveis. Um `confirmed: true` gerado pela LLM MUST NOT autorizar a gravação. Esta confirmação SHALL ser tratada como decisão de UX do cadastro, independente da confirmação obrigatória de uma reserva; sua eventual remoção exigirá revisão própria desta capability e MUST NOT enfraquecer a autorização de agendamento.

#### Scenario: Visitor confirms the registration preview

- **WHEN** o visitante confirma uma prévia válida do cadastro na conversa correspondente
- **THEN** o backend registra os dados daquela ação e retorna o resultado estruturado, sem autorizar nenhuma reserva de aula

#### Scenario: Model attempts to authorize registration

- **WHEN** a LLM tenta gravar o cadastro usando um campo de confirmação ou sem uma confirmação válida da ação pendente
- **THEN** o backend não realiza a gravação

### Requirement: Replace outdated draft information before confirmation

O sistema SHALL substituir informações anteriores pelas correções mais recentes do visitante antes de preparar as próximas decisões. Mudanças em nome, contato, curso, objetivo ou horário selecionado MUST invalidar ações pendentes anteriores; o cadastro atualizado SHALL exigir uma nova prévia e uma nova confirmação nesta versão. A confirmação anterior MUST NOT ser reaproveitada para os novos dados.

#### Scenario: Visitor changes the learning goal before confirming

- **WHEN** o visitante informa "Quero inglês para viagem" e, antes de confirmar, corrige para "Na verdade, quero principalmente para entrevistas de emprego"
- **THEN** o próximo rascunho usa o objetivo de entrevistas de emprego, a ação pendente anterior fica inválida e o sistema apresenta nova prévia para confirmação

### Requirement: Reuse or update only the lead of the current conversation

O sistema SHALL manter no máximo um lead por conversa. Uma solicitação idêntica aos dados já registrados SHALL devolver esse registro, sem duplicação. Novos dados confirmados SHALL atualizar somente o lead da própria conversa, com resultado `updated`; o cadastro inicial SHALL retornar `created`, e a repetição sem alteração SHALL retornar `existing`. IDs e resultados MUST ser gerados pelo backend. Atualizar o lead MUST NOT modificar uma reserva já concluída nem oferecer operações gerais de CRM.

#### Scenario: Registration is repeated with the same data

- **WHEN** a mesma conversa solicita novamente o cadastro com os dados já registrados
- **THEN** o sistema retorna o mesmo lead com resultado `existing`, sem criar outro registro

#### Scenario: Visitor corrects an already registered lead

- **WHEN** o visitante corrige o contato ou o interesse após o cadastro e confirma a nova prévia
- **THEN** o backend atualiza o lead da própria conversa, retorna `updated` e preserva qualquer reserva já concluída

### Requirement: Preserve the registered result independently of model prose

O resultado de cadastro SHALL conter somente dados estruturados efetivamente registrados pelo backend. Depois de concluir a escrita, o sistema MUST preservar esse resultado para a conversa e para a repetição da confirmação consumida. Uma falha da LLM ao redigir a resposta MUST NOT transformar um cadastro concluído em falha nem exigir nova gravação.

#### Scenario: Model response fails after registration

- **WHEN** o cadastro é concluído e a LLM falha ao formular a resposta
- **THEN** o sistema apresenta o resultado registrado pelo backend e uma repetição da mesma confirmação retorna o recibo anterior, sem duplicar o lead
