# trial-class-scheduling Specification

## Purpose
Consultar horários e reservar aulas experimentais na agenda interna demonstrativa da escola, com confirmação explícita do visitante e disponibilidade decidida pelo backend.

## Requirements

### Requirement: Query structured future availability by course

O sistema SHALL disponibilizar `get_available_slots({ courseId })` para um curso existente e ativo, retornando exclusivamente horários futuros e disponíveis cadastrados para esse curso. Curso inexistente ou inativo SHALL produzir `NOT_FOUND`. Cada horário SHALL identificar `slotId`, `courseId`, `startsAt` em formato ISO com deslocamento e `timezone` da escola. Cada horário SHALL comportar uma vaga neste MVP. A consulta MUST NOT reservar a vaga, e a ausência de vagas SHALL produzir uma lista vazia, sem gerar horários alternativos fictícios.

#### Scenario: Course has available and unavailable slots

- **WHEN** o interessado consulta os horários de um curso que tem vagas livres, ocupadas e passadas
- **THEN** o backend retorna somente os horários futuros livres daquele curso com data, hora e fuso cadastrados

#### Scenario: Course has no available slots

- **WHEN** nenhum horário futuro está disponível para o curso
- **THEN** a consulta retorna lista vazia e o sistema não apresenta um horário inventado como disponível

### Requirement: Require explicit backend-bound authorization for every new reservation

O sistema SHALL disponibilizar `schedule_trial_class({ leadId, slotId })` com schemas estritos. Uma nova reserva MUST depender de confirmação explícita do visitante vinculada pelo backend a uma ação pendente imutável, à conversa, aos argumentos apresentados e à revisão do contexto. Uma proposta válida ainda não confirmada SHALL produzir `CONFIRMATION_REQUIRED` e a prévia pendente, como continuação esperada da conversa, sem reservar a vaga. A prévia SHALL apresentar os dados do lead, o curso, a data, a hora, o fuso e o caráter demonstrativo da agenda. O comando de confirmação SHALL enviar apenas os identificadores da conversa e da ação. Um `confirmed: true` produzido pela LLM, uma confirmação de cadastro ou uma confirmação de outra ação MUST NOT autorizar a reserva.

#### Scenario: Visitor confirms a valid reservation preview

- **WHEN** o visitante confirma a prévia da reserva vinculada à sua conversa
- **THEN** o backend executa a ação vinculada aos dados apresentados e somente confirma o agendamento após validar e registrar a reserva

#### Scenario: Reservation has no valid explicit confirmation

- **WHEN** uma chamada tenta reservar usando apenas autorização produzida pela LLM, a confirmação do cadastro ou uma ação de outra conversa
- **THEN** o backend recusa a reserva e nenhuma vaga é ocupada

### Requirement: Invalidate pending reservations when context changes

Uma alteração de nome, contato, curso, objetivo ou horário selecionado pelo visitante MUST invalidar as ações pendentes anteriores. As próximas decisões SHALL usar as informações mais recentes, e uma reserva SHALL exigir nova prévia e nova confirmação. Alterar o contexto depois de uma reserva concluída MUST NOT cancelar, remarcar ou modificar essa reserva; cancelamento e remarcação ficam fora deste MVP.

#### Scenario: Visitor changes preference before confirming the reservation

- **WHEN** o visitante muda o objetivo de viagem para entrevistas de emprego ou seleciona outro curso ou horário antes da confirmação
- **THEN** a ação antiga é recusada com `ACTION_STALE`, o sistema considera a preferência mais recente e uma reserva depende de nova prévia confirmada

### Requirement: Validate and reserve availability atomically

Antes de uma nova reserva, o backend MUST verificar que o lead pertence à conversa, que o horário corresponde ao curso ativo mais recente selecionado, que o lead registra esse curso e os dados atuais de nome, contato e objetivo, que o horário está no futuro e que a vaga permanece disponível. Se o contexto corrigido divergir do lead cadastrado, o sistema SHALL solicitar a confirmação da atualização de cadastro antes de preparar nova reserva. A verificação de disponibilidade e a ocupação da vaga MUST formar uma operação atômica. Uma vaga ocupada por outro lead SHALL resultar em `SLOT_UNAVAILABLE`, sem confirmar a reserva. Referências inexistentes ou incompatíveis MUST ser recusadas sem escrita.

#### Scenario: Referenced lead or course is incompatible

- **WHEN** a ação aponta para um lead de outra conversa ou para um horário que não corresponde ao curso do lead e à seleção atual
- **THEN** o backend recusa a operação e não ocupa a vaga

#### Scenario: Two leads attempt to reserve the same slot

- **WHEN** dois leads confirmam ações para a mesma vaga após ambos terem consultado sua disponibilidade
- **THEN** somente uma reserva é registrada e a outra operação retorna `SLOT_UNAVAILABLE`

#### Scenario: Registered lead still contains superseded information

- **WHEN** o visitante corrige contato ou objetivo antes da reserva, mas o lead ainda contém os dados anteriores
- **THEN** o sistema prepara a atualização de cadastro para confirmação e somente depois utiliza o lead atualizado na nova prévia de reserva

### Requirement: Preserve successful reservations and avoid duplicates

Uma reserva concluída SHALL retornar resultado estruturado com ID de agendamento, lead, curso, horário e status confirmado gerados ou recuperados pelo backend. Repetir a confirmação já consumida SHALL retornar seu recibo registrado; repetir a reserva do mesmo lead e horário SHALL devolver a reserva existente antes de tratá-la como vaga ocupada. Essa repetição MUST NOT criar nova reserva nem servir como autorização para um horário diferente. O resultado SHALL ser registrado antes da redação pela LLM e SHALL permanecer disponível se ela falhar. A confirmação SHALL referir-se somente à agenda interna demonstrativa, sem alegar integração com calendário externo.

#### Scenario: Confirmation is retried after a successful reservation

- **WHEN** a reserva já foi concluída e a confirmação é reenviada após uma falha de transporte
- **THEN** o sistema retorna o mesmo recibo, mesmo que a vaga agora apareça ocupada pela própria reserva, sem duplicação

#### Scenario: Model response fails after the reservation is stored

- **WHEN** o backend conclui a reserva e a LLM falha ao redigir a resposta
- **THEN** o chat apresenta o resultado estruturado registrado e uma mensagem baseada nesse resultado, preservando a reserva concluída
