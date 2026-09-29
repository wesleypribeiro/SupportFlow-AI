# support-chat Specification

## Purpose
Oferecer uma conversa de atendimento escolar que preserve contexto, aceite correções do interessado e apresente dados e ações de backend na interface web de chat.

## Requirements

### Requirement: Conversa anônima com contexto isolado

O sistema SHALL permitir iniciar uma conversa sem `customerId` ou cadastro prévio. O backend SHALL gerar `conversationId` e manter mensagens e contexto em memória, isolados de outras conversas. O navegador SHALL enviar a mensagem atual e o identificador da conversa, sem fornecer mensagens de sistema, resultados de ferramentas ou autorização da LLM. O contexto SHALL incluir as preferências atuais, referências de curso/horário, lead da conversa e eventual ação pendente.

#### Scenario: Primeiro contato
- **WHEN** um visitante pergunta quais cursos a escola oferece
- **THEN** uma conversa é iniciada e o catálogo pode ser consultado sem exigir identificação do visitante

#### Scenario: Continuidade e isolamento
- **WHEN** o usuário se refere ao curso selecionado anteriormente
- **THEN** o sistema usa o contexto da mesma conversa, sem importar preferências, lead ou ações de outra conversa

### Requirement: Informação mais recente substitui o contexto anterior

Quando o usuário corrigir uma preferência ou informação, o sistema SHALL atualizar o contexto atual, preservando o histórico apenas como registro. Próximas decisões, perguntas, consultas e prévias de ação MUST usar a informação mais recente, sem tratar o valor substituído como preferência vigente. Alterações em objetivo, nome, contato, curso ou horário SHALL invalidar a ação pendente associada ao contexto anterior e exigir uma nova prévia antes de confirmar. A alteração de contexto MUST NOT modificar silenciosamente uma reserva já concluída.

#### Scenario: Mudança de objetivo
- **WHEN** o usuário informa “Quero inglês para viagem” e depois “Na verdade, quero principalmente para entrevistas de emprego”
- **THEN** o objetivo vigente passa a ser entrevistas de emprego, e as próximas decisões e o cadastro proposto usam esse objetivo

#### Scenario: Correção antes de confirmar
- **WHEN** existe ação pendente e o usuário corrige seu contato, objetivo, curso ou horário
- **THEN** a prévia anterior deixa de poder ser confirmada e a próxima ação apresenta os dados atualizados

#### Scenario: Histórico não altera reserva existente
- **WHEN** o usuário muda uma preferência depois de uma reserva concluída
- **THEN** o contexto é atualizado para a conversa, mas a reserva permanece como registrada e nenhuma remarcação é realizada

### Requirement: API de mensagens e confirmação separadas

`POST /api/chat` SHALL aceitar objeto estrito `{ message, conversationId? }`, com mensagem aparada de 1 a 2.000 caracteres. `POST /api/chat/confirm` SHALL aceitar somente `{ conversationId, actionId }`, sem novos argumentos de negócio. Ambos SHALL retornar sucesso com `{ conversationId, reply, results, pendingAction }`: `reply` é texto não vazio; `results` contém os resultados estruturados validados das ferramentas; `pendingAction` é a prévia armazenada pelo backend ou `null`. O schema de cada item de `results` MUST associar a ferramenta ao seu contrato de saída.

Uma confirmação SHALL primeiro verificar vínculo com a conversa. Se a ação já foi concluída nessa conversa, a repetição SHALL devolver o recibo original antes de avaliar a revisão atual, sem nova escrita. Para uma ação ainda pendente, a confirmação SHALL verificar tipo, argumentos armazenados e revisão atual do contexto. Ação pendente inválida ou desatualizada MUST ser rejeitada, sem executar os argumentos antigos.

#### Scenario: Corpo inválido
- **WHEN** a requisição tem mensagem vazia, tipo incorreto ou campo extra
- **THEN** a API retorna HTTP 400 com `INVALID_REQUEST` sem executar modelo ou operação

#### Scenario: Confirmação não pertence à conversa
- **WHEN** o navegador envia uma ação inexistente ou associada a outra conversa
- **THEN** o backend rejeita a confirmação sem consultar a LLM para decidir autorização

#### Scenario: Confirmação desatualizada
- **WHEN** o navegador confirma uma ação invalidada por correção do contexto
- **THEN** a API retorna HTTP 409 com `ACTION_STALE`, e a interface orienta a revisar a nova prévia

#### Scenario: Recibo concluído após mudança de contexto
- **WHEN** a mesma conversa reenvia uma confirmação já concluída depois de corrigir seus dados
- **THEN** o backend devolve o recibo original como registro da ação anterior, sem reexecutar ou aplicar essa confirmação aos novos dados

### Requirement: Fatos oficiais e confirmação visíveis no chat

A interface SHALL apresentar histórico, entrada acessível, envio, processamento e erro recuperável. Os fatos oficiais de escola, cursos, preços, horários, disponibilidade e resultados de cadastro/agendamento MUST ser apresentados a partir de `results` e `pendingAction` do backend, sem extraí-los de `reply`. A interface pode apresentar a resposta natural junto desses dados, sem tratar sua prosa como recibo de uma operação.

As prévias SHALL distinguir “Confirmar cadastro” de “Confirmar aula experimental” e mostrar os dados relevantes antes da ação. O usuário SHALL poder corrigir dados enviando outra mensagem. Após a correção, a interface MUST desabilitar a confirmação antiga. Texto SHALL ser renderizado sem executar HTML, e envios simultâneos SHALL ser impedidos na interface.

#### Scenario: Revisão de reserva
- **WHEN** o backend prepara uma reserva pendente
- **THEN** o chat mostra curso, data, hora, fuso e identificação do lead a partir da prévia oficial, junto da ação explícita de confirmar

#### Scenario: Prosa não é recibo
- **WHEN** o texto do modelo contém uma alegação de sucesso sem resultado estruturado correspondente
- **THEN** a interface não cria recibo nem marca cadastro ou reserva como concluídos a partir dessa alegação

#### Scenario: Falha recuperável
- **WHEN** há erro de rede ou resposta inválida
- **THEN** a interface informa o problema e permite nova tentativa; confirmações repetidas usam o mesmo `actionId`

### Requirement: Ambiente demonstrativo e falhas controladas

O chat SHALL indicar dados fictícios, agenda interna e armazenamento em memória. Recarregar a página SHALL iniciar nova conversa nesta versão; reiniciar o backend SHALL descartar conversas, leads, reservas e solicitações e restaurar as fixtures. Conversa desconhecida SHALL ser informada como indisponível, sem herdar outro contexto. Credenciais e execução das ferramentas MUST permanecer no backend.

Erros HTTP SHALL usar `{ error: { code, message } }`, sem detalhes internos: 400 `INVALID_REQUEST`, 404 `NOT_FOUND`, 409 `ACTION_STALE`, e 500 `CHAT_ERROR`. Ausência de preço, cursos ou horários e a preparação de confirmação SHALL ser resultados normais do atendimento, não falhas HTTP. Conforme a política de recibo da task 5.3, indisponibilidade de vaga durante a execução confirmada SHALL produzir HTTP 200 com `SLOT_UNAVAILABLE` no resultado estruturado de `schedule_trial_class`; esse recibo SHALL concluir a ação e ser recuperado sem nova execução em retries.

#### Scenario: Disputa de vaga produz recibo de indisponibilidade
- **WHEN** outra conversa ocupa a vaga antes da execução de uma confirmação válida
- **THEN** a confirmação retorna HTTP 200 com `SLOT_UNAVAILABLE` em `results`, e repetir o mesmo actionId devolve o recibo salvo sem tentar reservar novamente

#### Scenario: Reinício do backend
- **WHEN** o usuário tenta continuar uma conversa removida pelo reinício
- **THEN** o sistema informa que ela não está disponível e permite iniciar outra, sem presumir que reservas anteriores continuam registradas
