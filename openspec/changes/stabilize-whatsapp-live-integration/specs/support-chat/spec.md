# Spec Delta

## MODIFIED Requirements

### Requirement: Informação mais recente substitui o contexto anterior

Quando o usuário corrigir uma preferência ou informação, o sistema SHALL atualizar o contexto atual, preservando o histórico apenas como registro. Próximas decisões, perguntas, consultas e prévias de ação MUST usar a informação mais recente, sem tratar o valor substituído como preferência vigente. Alterações em objetivo, nome, contato, curso ou horário SHALL invalidar a ação pendente associada ao contexto anterior e exigir uma nova prévia antes de confirmar. A alteração de contexto MUST NOT modificar silenciosamente uma reserva já concluída.

Uma proposta de objetivo novo sem trecho literal correspondente na mensagem atual SHALL ser descartada, mantendo o objetivo vigente ou `null`, sem causar falha do turno apenas por essa ausência. Repetir o objetivo vigente SHALL continuar sendo no-op. Descartar uma inferência MUST NOT incrementar revision nem invalidar uma ação por si só; outras alterações válidas do turno continuam sujeitas ao commit e à revisão. Schemas e validações de nome, contato, curso e horário MUST permanecer estritos. Dados inferidos MUST NOT se tornar dados oficiais de cadastro, reserva ou autorização.

#### Scenario: Mudança de objetivo
- **WHEN** o usuário informa “Quero inglês para viagem” e depois “Na verdade, quero principalmente para entrevistas de emprego”
- **THEN** o objetivo vigente passa a ser entrevistas de emprego, e as próximas decisões e o cadastro proposto usam esse objetivo

#### Scenario: Correção antes de confirmar
- **WHEN** existe ação pendente e o usuário corrige seu contato, objetivo, curso ou horário
- **THEN** a prévia anterior deixa de poder ser confirmada e a próxima ação apresenta os dados atualizados

#### Scenario: Histórico não altera reserva existente
- **WHEN** o usuário muda uma preferência depois de uma reserva concluída
- **THEN** o contexto é atualizado para a conversa, mas a reserva permanece como registrada e nenhuma remarcação é realizada

#### Scenario: Consulta simples com objetivo inferido
- **WHEN** o visitante pergunta pelos cursos ou preços e o modelo propõe um objetivo que não aparece na mensagem
- **THEN** a consulta continua usando o catálogo oficial, sem persistir o objetivo inferido ou executar escrita protegida

#### Scenario: Objetivo antigo reaparece depois da correção
- **WHEN** o modelo propõe um objetivo substituído no histórico sem nova evidência na mensagem atual
- **THEN** o atendimento continua com o objetivo vigente e a mesma revisão, preservando a ação pendente se não houver outra alteração

#### Scenario: Inferência junto de dados pessoais sem fonte
- **WHEN** o patch contém um objetivo inferido e nome ou contato novo não informado pelo visitante
- **THEN** a validação de dados pessoais continua recusando o patch inteiro, sem salvar contexto, histórico ou ação parcial

#### Scenario: Objetivo explícito permanece uma mudança real
- **WHEN** o visitante informa literalmente um novo objetivo válido na mensagem atual
- **THEN** o contexto usa esse objetivo, incrementa revisão uma vez no commit e invalida a prévia antiga, sem gravar cadastro ou reserva automaticamente

