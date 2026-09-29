# Human Handoff — Channel Presentation

## MODIFIED Requirements

### Requirement: Apresentar somente o estado real da solicitação

O resultado oficial do encaminhamento SHALL vir exclusivamente do registro estruturado do backend. O chat SHALL informar que a solicitação foi registrada localmente e que esse registro não inicia atendimento humano ao vivo. O sistema MUST NOT apresentar o status `requested` como evidência de que uma pessoa recebeu a conversa, está disponível, assumiu o atendimento ou confirmou prazo de resposta. O registro da solicitação SHALL funcionar sem envio operacional a serviços externos de atendimento ou consulta a disponibilidade de atendentes.

Um canal autorizado poderá enviar o protocolo oficial ao próprio visitante como apresentação do resultado. Esse envio SHALL ser distinguido de encaminhamento a uma equipe: aceite, entrega ou leitura da mensagem no WhatsApp MUST NOT alterar o status `requested` ou significar que um atendente recebeu a solicitação. A semântica local e a independência de cadastro SHALL permanecer inalteradas.

#### Scenario: Solicitação registrada na demonstração
- **WHEN** o backend conclui o registro e retorna status `requested`
- **THEN** o chat apresenta o protocolo real e a informação de solicitação registrada, sem afirmar que um atendente iniciou o atendimento

#### Scenario: Protocolo entregue ao visitante pelo WhatsApp
- **WHEN** o canal entrega ao visitante uma mensagem com o protocolo registrado
- **THEN** o status permanece requested e nenhuma equipe, ticket externo ou atendimento ao vivo é presumido

#### Scenario: Transporte falha após registro
- **WHEN** o registro local existe mas o envio do protocolo ao visitante falha
- **THEN** o protocolo original permanece recuperável, sem registrar nova solicitação para tentar reenviá-lo
