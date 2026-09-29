# WhatsApp Conversations

## Purpose

Manter conversas de WhatsApp isoladas e ordenadas sobre o motor existente, com deduplicação local e limites explícitos da demonstração sem persistência.

## ADDED Requirements

### Requirement: Associar remetente validado a uma conversa interna

O sistema SHALL vincular provedor, conta, número empresarial e remetente autenticados pelo transporte a uma conversa com ID gerado pelo backend. Lookup/criação inicial SHALL ser indivisível para evitar duas conversas do mesmo vínculo. Nome de perfil, telefone e dados externos MUST NOT preencher automaticamente nome/contato do lead. O canal MUST NOT aceitar um conversationId indicado pelo visitante ou mesclar sessões web por contato.

#### Scenario: Duas primeiras mensagens simultâneas
- **WHEN** duas mensagens novas do mesmo remetente são admitidas ao mesmo tempo
- **THEN** ambas utilizam uma única conversa e são processadas em ordem

#### Scenario: Remetentes independentes com contato igual
- **WHEN** duas identidades de transporte distintas fornecem o mesmo contato comercial
- **THEN** continuam com conversas, leads, ações e recibos separados

#### Scenario: Perfil não é dado de cadastro
- **WHEN** o remetente envia uma saudação e o webhook contém nome de perfil e telefone
- **THEN** o contexto comercial continua sem nome/contato até validação de informação fornecida pelo visitante

### Requirement: Deduplicar mensagens por identidade de transporte

Cada mensagem SHALL ser identificada por provedor, número empresarial e messageId. A primeira admissão SHALL guardar identidade/conteúdo normalizados e estado de processamento; a repetição idêntica MUST NOT gerar novo turno, nova chamada de modelo ou novo envio. Mesmo ID com conteúdo/remetente incompatíveis MUST NOT substituir o registro original. Resultado e falha de processamento SHALL ser separados de falha de entrega.

#### Scenario: Duplicata em andamento e depois da conclusão
- **WHEN** o mesmo messageId é recebido enquanto processa e novamente depois de concluído
- **THEN** há um único turno e um único conjunto inicial de envios

#### Scenario: Colisão de conteúdo
- **WHEN** um messageId conhecido aparece com outro texto ou remetente
- **THEN** o original permanece e a colisão não executa novo trabalho

### Requirement: Serializar decisões da mesma conversa

Mensagens, correções e cliques SHALL chegar ao motor na ordem de admissão da mesma identidade e compartilhar a exclusão por conversa. Conversas diferentes MUST poder progredir independentemente. Falhas SHALL liberar a fila sem salvar contexto/histórico parcial; a exceção já prevista de escrita concluída com contingência SHALL ser preservada. O canal MUST NOT prometer reconstruir a ordem original da rede a partir de eventos atrasados.

#### Scenario: Correção admitida antes do clique
- **WHEN** uma correção aguarda processamento e depois chega confirmação de uma prévia antiga
- **THEN** a confirmação observa a revisão atualizada e não grava os argumentos obsoletos

#### Scenario: Remetente lento não bloqueia outro
- **WHEN** o modelo da conversa A está aguardando e B envia mensagem
- **THEN** B pode completar seu turno sem depender da fila de A

#### Scenario: Falha anterior ao commit
- **WHEN** um turno que propôs ação falha na redação antes de qualquer escrita concluída
- **THEN** contexto/histórico e ação anterior permanecem como antes, sem ação órfã

### Requirement: Preservar o contrato de mensagens do motor

Texto SHALL respeitar a mensagem aparada de 1 a 2.000 caracteres já aceita pelo motor. Texto inválido MUST NOT ser truncado silenciosamente ou distribuído em múltiplos turnos. Respostas interativas e comandos de recuperação SHALL ter caminhos separados, sem inserir um falso “sim” no histórico para confirmar. Eventos não suportados MUST NOT executar o agente.

#### Scenario: Mensagem longa ou vazia
- **WHEN** o texto contém apenas espaços ou ultrapassa o limite do chat
- **THEN** o canal apresenta orientação controlada, sem alterar o contexto nem chamar o modelo

#### Scenario: Palavra de consentimento em texto
- **WHEN** o visitante escreve “sim” enquanto existe prévia de cadastro/reserva
- **THEN** isso continua sendo diálogo e não executa a confirmação da ação

### Requirement: Reiniciar sem recuperar autoridade perdida

O canal SHALL declarar memória volátil e execução em uma instância. Reinício SHALL perder vínculos, inbox/outbox, ações e recibos junto dos registros comerciais existentes. Mensagem anterior ao marco de início SHALL ser descartada sem reprocessar negócios. Botão sem vínculo preservado MUST NOT criar conversa ou reconstruir ação; uma nova mensagem textual poderá iniciar sessão vazia. O sistema MUST NOT prometer recuperação comercial, deduplicação entre reinícios ou entrega exatamente uma vez.

#### Scenario: Reentrega de evento da execução anterior
- **WHEN** um evento com timestamp anterior à inicialização é recebido após reinício
- **THEN** é reconhecido sem recriar turno, lead, handoff ou reserva

#### Scenario: Botão antigo depois de reiniciar
- **WHEN** o visitante clica em botão cujo vínculo se perdeu
- **THEN** nenhuma escrita ocorre; o canal informa indisponibilidade quando puder responder e pede nova mensagem, sem alegar recuperação do recibo

#### Scenario: Nova sessão demonstrativa
- **WHEN** um texto novo válido chega após o reinício
- **THEN** começa uma conversa vazia e o visitante é informado de que registros anteriores não foram recuperados

### Requirement: Conservar evidência de processamento durante a execução

IDs deduplicados e vínculos necessários a confirmações/recibos SHALL ser preservados durante a execução corrente. Limite de capacidade SHALL recusar trabalho novo em vez de apagar silenciosamente evidências. Filas ociosas e buffers auxiliares SHALL ser liberados de forma controlada, sem invalidar recibos comerciais.

#### Scenario: Pressão de memória controlada
- **WHEN** o limite de eventos é alcançado e chegam mensagem nova, duplicata e status conhecido
- **THEN** a nova admissão é recusada e a duplicata/status continuam reconhecíveis sem reexecutar negócios
