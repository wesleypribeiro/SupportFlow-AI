# human-handoff Specification

## Purpose
Registrar uma solicitação local de atendimento humano durante a conversa e informar seu resultado real, sem depender de uma integração com atendentes ou serviços externos.

## Requirements

### Requirement: Registrar solicitação humana a partir da intenção do visitante

O sistema SHALL disponibilizar `transfer_to_human({ reason })` quando o visitante solicitar atendimento humano explicitamente ou aceitar uma oferta de encaminhamento. O motivo SHALL ser textual não vazio. O backend SHALL associar a solicitação à conversa atual usando contexto sob seu controle; a ferramenta MUST NOT aceitar `conversationId` escolhido pela LLM. A solicitação SHALL poder ser registrada sem lead cadastrado.

#### Scenario: Visitante solicita uma pessoa antes do cadastro
- **WHEN** um visitante sem lead cadastrado pede explicitamente para falar com uma pessoa
- **THEN** o sistema registra a solicitação na conversa atual sem exigir cadastro como condição

#### Scenario: Visitante aceita uma oferta de encaminhamento
- **WHEN** o assistente oferece atendimento humano e o visitante aceita
- **THEN** o sistema registra a solicitação com um motivo correspondente ao contexto da conversa

### Requirement: Manter uma solicitação aberta por conversa

O sistema SHALL retornar o identificador da solicitação, seu motivo e o status `requested` após o registro no backend. Uma conversa SHALL ter no máximo uma solicitação aberta neste MVP. Chamadas repetidas para uma conversa com solicitação aberta SHALL devolver o mesmo registro, inclusive quando o texto do motivo for diferente, sem criar outra solicitação.

#### Scenario: Repetição do encaminhamento
- **WHEN** `transfer_to_human` é chamada novamente em uma conversa que já possui solicitação aberta
- **THEN** retorna o mesmo identificador, motivo registrado e status `requested`, sem duplicar o registro

### Requirement: Apresentar somente o estado real da solicitação

O resultado oficial do encaminhamento SHALL vir exclusivamente do registro estruturado do backend. O chat SHALL informar que a solicitação foi registrada localmente e que esse registro não inicia atendimento humano ao vivo. O sistema MUST NOT apresentar o status `requested` como evidência de que uma pessoa recebeu a conversa, está disponível, assumiu o atendimento ou confirmou prazo de resposta. Este MVP SHALL funcionar sem envio a serviços externos ou consulta a disponibilidade de atendentes.

#### Scenario: Solicitação registrada na demonstração
- **WHEN** o backend conclui o registro e retorna status `requested`
- **THEN** o chat apresenta o protocolo real e a informação de solicitação registrada, sem afirmar que um atendente iniciou o atendimento

### Requirement: Validar a solicitação e informar falhas sem falso sucesso

O sistema SHALL validar a entrada e a saída de `transfer_to_human` por schemas estritos. Entrada sem motivo válido ou com campos adicionais SHALL resultar em `INVALID_INPUT` antes de gravar. Falha inesperada ou saída inválida SHALL resultar em `OPERATION_FAILED`, sem gerar protocolo fictício ou afirmar sucesso sem resultado válido do backend.

#### Scenario: Contexto de conversa enviado como argumento da ferramenta
- **WHEN** a chamada inclui `conversationId` ou outro campo além de `reason`
- **THEN** o sistema retorna `INVALID_INPUT` e não registra uma solicitação

#### Scenario: Falha ao registrar a solicitação
- **WHEN** a gravação da solicitação falha
- **THEN** o sistema retorna `OPERATION_FAILED` e não informa que o encaminhamento foi registrado
