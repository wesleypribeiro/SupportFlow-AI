# Support Chat — Channel Extension

## ADDED Requirements

### Requirement: Reutilizar o mesmo atendimento através de adapters de canal

O sistema SHALL permitir que web e WhatsApp utilizem a mesma execução de turnos, validação de contexto, ferramentas, preparação de ações e confirmação. Dados do transporte SHALL ser convertidos pelo backend para os contratos existentes, sem criar versões paralelas de lead, reserva, handoff ou autorização. O core MUST NOT depender de entidades da escola ou de payloads Meta. Os contratos públicos HTTP e o comportamento web existentes SHALL permanecer compatíveis.

#### Scenario: Mesma regra comercial em canais diferentes
- **WHEN** web e WhatsApp solicitam a mesma operação com dados válidos de suas respectivas conversas
- **THEN** ambos utilizam as mesmas regras e schemas, preservando isolamento, revisão, confirmação e recibos

#### Scenario: Canal desabilitado
- **WHEN** o WhatsApp não está configurado
- **THEN** o chat web e suas rotas continuam funcionando como antes, sem depender da Meta

#### Scenario: Falha de transporte depois da escrita
- **WHEN** uma confirmação conclui uma operação e o canal falha ao enviar o resultado
- **THEN** o recibo permanece recuperável no motor e nenhuma lógica do adapter repete ou desfaz a escrita

## MODIFIED Requirements

### Requirement: Fatos oficiais e confirmação visíveis no chat

A interface web SHALL apresentar histórico, entrada acessível, envio, processamento e erro recuperável. Em todo canal, os fatos oficiais de escola, cursos, preços, horários, disponibilidade e resultados de cadastro/agendamento MUST ser apresentados a partir de `results` e `pendingAction` do backend, sem extraí-los de `reply`. A interface pode apresentar a resposta natural junto desses dados, sem tratar sua prosa como recibo de uma operação.

As prévias web SHALL distinguir “Confirmar cadastro” de “Confirmar aula experimental” e mostrar os dados relevantes antes da ação. O usuário SHALL poder corrigir dados enviando outra mensagem. Após a correção, a interface web MUST desabilitar a confirmação antiga. Texto SHALL ser renderizado sem executar HTML, e envios simultâneos SHALL ser impedidos na interface web.

No WhatsApp, o canal SHALL apresentar prévia textual e resposta interativa específica de cadastro ou aula experimental, conforme `whatsapp-confirmations`. O título poderá ser abreviado para respeitar limites do provedor sem ocultar o tipo da operação no corpo. Botões antigos podem permanecer visíveis, mas o backend MUST rejeitar confirmação stale. Serialização do backend SHALL ordenar mensagens/cliques, pois o canal não pode impedir que o visitante envie enquanto outro turno processa.

#### Scenario: Revisão de reserva
- **WHEN** o backend prepara uma reserva pendente
- **THEN** o chat mostra curso, data, hora, fuso e identificação do lead a partir da prévia oficial, junto da ação explícita de confirmar

#### Scenario: Prosa não é recibo
- **WHEN** o texto do modelo contém uma alegação de sucesso sem resultado estruturado correspondente
- **THEN** a interface não cria recibo nem marca cadastro ou reserva como concluídos a partir dessa alegação

#### Scenario: Falha recuperável
- **WHEN** há erro de rede ou resposta inválida
- **THEN** a interface informa o problema e permite nova tentativa; confirmações repetidas usam o mesmo `actionId`

#### Scenario: Botão de WhatsApp permanece no histórico após correção
- **WHEN** o visitante clica numa prévia que continua visível mas foi invalidada por contexto novo
- **THEN** o backend recusa a ação antiga e o canal orienta revisão sem gravar seus dados
