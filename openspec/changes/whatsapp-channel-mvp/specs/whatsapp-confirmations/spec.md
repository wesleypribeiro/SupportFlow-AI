# WhatsApp Confirmations

## Purpose

Adaptar prévias e confirmações oficiais ao WhatsApp, vinculando respostas interativas à conversa e ação corretas sem transferir autorização à linguagem natural.

## ADDED Requirements

### Requirement: Apresentar prévia oficial antes da confirmação

Cada prévia SHALL ser construída exclusivamente de pendingAction validada. Cadastro SHALL mostrar nome, contato, curso e objetivo; reserva SHALL mostrar aluno, curso, data, hora, fuso e agenda demonstrativa. Os controles SHALL distinguir cadastro de aula experimental. Nenhuma tool call, prosa ou entrega da prévia SHALL ser tratada como escrita concluída. Prévia que exceda o formato suportado MUST NOT ser truncada para habilitar confirmação incompleta.

#### Scenario: Modelo afirma sucesso antes do clique
- **WHEN** a resposta contém prosa de sucesso mas result é CONFIRMATION_REQUIRED
- **THEN** o canal apresenta a revisão pendente e não apresenta recibo de operação concluída

#### Scenario: Prévia não cabe no corpo interativo
- **WHEN** os dados completos da prévia ultrapassam o limite suportado
- **THEN** não há botão confirmável com dados omitidos e o visitante recebe orientação para revisar os dados

### Requirement: Resolver botão através de vínculo privado do backend

O botão SHALL carregar somente referência opaca gerada pelo backend. Sua resolução SHALL verificar provedor, conta/número empresarial, remetente, conversa, ação, kind e mensagem enviada que apresentou a prévia. Dados comerciais, revision, confirmed e IDs digitados MUST NOT autorizar ou substituir argumentos. Somente após a resolução SHALL ser construído o comando interno de conversationId/actionId aceito pelo motor.

#### Scenario: Botão válido da própria conversa
- **WHEN** uma resposta interativa referencia uma prévia enviada e seu vínculo corresponde ao remetente atual
- **THEN** a confirmação utiliza exatamente a ação armazenada, sem pedir à LLM que reconstrua os argumentos

#### Scenario: Referência manipulada ou estrangeira
- **WHEN** a referência pertence a outra conversa, não existe, ou referencia outra mensagem enviada
- **THEN** a confirmação é recusada sem escrita e sem revelar dados da conversa proprietária

#### Scenario: ID de ação enviado como texto ou campos adicionais
- **WHEN** o visitante envia actionId, JSON com confirmed ou texto “sim” no lugar da resposta interativa válida
- **THEN** nenhuma confirmação é autorizada por esse conteúdo

### Requirement: Preservar revisão e especificidade da autorização

A validade da ação SHALL ser decidida pelo lifecycle existente. Mudança relevante de contexto SHALL invalidar prévia anterior e uma nova proposta SHALL usar novos argumentos oficiais. Uma mensagem sem mudança MUST NOT invalidar a ação por si só. Confirmação de cadastro MUST NOT confirmar reserva; referência de um kind MUST NOT ser reaproveitada para outro. Um botão antigo pode continuar visível no WhatsApp, mas MUST NOT executar uma ação stale.

#### Scenario: Contato ou horário corrigido antes do clique
- **WHEN** a correção foi processada e depois chega o clique da prévia anterior
- **THEN** o motor produz ACTION_STALE, o canal orienta nova revisão e nenhum dado antigo é gravado

#### Scenario: Continuidade sem alteração
- **WHEN** uma nova mensagem não altera o contexto nem substitui a ação
- **THEN** a referência anterior continua ligada à mesma ação válida

#### Scenario: Cadastro não autoriza aula
- **WHEN** o visitante confirma cadastro e existe ou será preparada uma proposta de reserva
- **THEN** somente o cadastro é executado e a reserva exige sua própria resposta interativa válida

### Requirement: Recuperar recibo histórico antes de reavaliar contexto

Uma nova resposta interativa válida para ação concluída SHALL devolver seu recibo original, sem reexecutar, antes de considerar revisão atual. O canal MUST NOT exigir pendingAction atual para recuperar recibo de ação concluída. Duplicata exata de evento SHALL ser tratada pela inbox; outro clique válido poderá reapresentar o mesmo resultado. SLOT_UNAVAILABLE concluído também SHALL preservar seu recibo.

#### Scenario: Mesmo botão depois de mudança posterior
- **WHEN** uma ação foi concluída com created e a revisão/lead mudaram antes de um novo clique válido
- **THEN** o recibo continua created com os dados originais, sem converter para existing ou autorizar ação nova

#### Scenario: Confirmação concluída seguida de falha de envio
- **WHEN** a escrita terminou mas a resposta WhatsApp não foi recebida
- **THEN** nova interação válida com a mesma ação recupera o booking/lead e resultado históricos, sem duplicação

#### Scenario: Vaga perdida
- **WHEN** a confirmação foi concluída com SLOT_UNAVAILABLE e o botão é acionado novamente
- **THEN** o mesmo recibo de indisponibilidade é reapresentado sem nova tentativa de reservar

### Requirement: Registrar vínculo somente para proposta commitada

Referência de confirmação SHALL apontar para ação oficial após commit bem-sucedido do turno. Uma falha de geração antes do commit MUST NOT publicar botão utilizável, criar ação global ou invalidar a anterior. Falha posterior de envio MUST NOT concluir a ação nem conceder autorização.

#### Scenario: Redação falha após proposta
- **WHEN** o agente propõe nova reserva, mas o turno falha antes de salvar a ação
- **THEN** nenhuma referência confirma a proposta inexistente e a ação anterior permanece intacta

#### Scenario: Aceite de envio indeterminado
- **WHEN** a prévia pode ter sido enviada mas seu ID de envio não é conhecido
- **THEN** uma referência externa não é usada para inventar esse vínculo; recuperar o envio não executa a operação
