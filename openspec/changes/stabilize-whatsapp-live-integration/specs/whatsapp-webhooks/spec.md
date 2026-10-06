# Spec Delta

## MODIFIED Requirements

### Requirement: Verificar a inscrição do webhook

O sistema SHALL oferecer `GET /webhooks/whatsapp/meta` quando o canal estiver habilitado. Mode `subscribe`, verify token correto e challenge escalar não vazio SHALL produzir HTTP 200 com o challenge em texto. Credencial/modo incorreto SHALL produzir 403; formato inválido SHALL produzir 400. O handshake MUST NOT iniciar conversa ou autorizar operações.

O handshake SHALL aceitar somente o trio `hub.mode`, `hub.verify_token`, `hub.challenge`, ou esse trio acompanhado dos três aliases `hub_mode`, `hub_verify_token`, `hub_challenge` com valores exatamente iguais aos respectivos oficiais, sem trim ou coerção. Aliases parciais, divergentes, exclusivos sem o trio oficial, extras, duplicatas ou valores não escalares SHALL resultar em 400. A comparação segura com o verify token configurado SHALL permanecer obrigatória; aliases não substituem credenciais. Queries e segredos MUST NOT aparecer em logs ou respostas de erro.

#### Scenario: Inscrição válida
- **WHEN** a Meta apresenta os parâmetros válidos e o token configurado
- **THEN** o endpoint devolve exatamente o challenge, sem chamar modelo ou repositories comerciais

#### Scenario: Token ou parâmetros incompatíveis
- **WHEN** o token diverge ou challenge é ausente ou composto por múltiplos valores
- **THEN** o endpoint rejeita a verificação, sem expor o token esperado

#### Scenario: Seis parâmetros correspondentes
- **WHEN** o trio oficial válido vem acompanhado de todos os aliases idênticos
- **THEN** o endpoint retorna 200 com challenge intacto, incluindo espaços ou zeros iniciais, sem efeito comercial

#### Scenario: Aliases não autorizam outra interpretação
- **WHEN** qualquer alias falta, diverge, se repete ou é malformado, ou existe parâmetro desconhecido
- **THEN** o endpoint retorna 400 sem registrar a query ou expor segredos

#### Scenario: Aliases iguais com credencial incorreta
- **WHEN** os seis valores são estruturalmente coerentes mas token ou mode não autorizam inscrição
- **THEN** o endpoint retorna 403 genérico, sem revelar a credencial esperada

