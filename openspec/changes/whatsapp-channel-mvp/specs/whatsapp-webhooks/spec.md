# WhatsApp Webhooks

## Purpose

Receber eventos da Cloud API da Meta somente após verificar origem e integridade, separando transporte externo dos dados confiáveis utilizados pelo atendimento.

## ADDED Requirements

### Requirement: Verificar a inscrição do webhook

O sistema SHALL oferecer `GET /webhooks/whatsapp/meta` quando o canal estiver habilitado. Mode `subscribe`, verify token correto e challenge escalar não vazio SHALL produzir HTTP 200 com o challenge em texto. Credencial/modo incorreto SHALL produzir 403; formato inválido SHALL produzir 400. O handshake MUST NOT iniciar conversa ou autorizar operações.

#### Scenario: Inscrição válida
- **WHEN** a Meta apresenta os parâmetros válidos e o token configurado
- **THEN** o endpoint devolve exatamente o challenge, sem chamar modelo ou repositories comerciais

#### Scenario: Token ou parâmetros incompatíveis
- **WHEN** o token diverge ou challenge é ausente ou composto por múltiplos valores
- **THEN** o endpoint rejeita a verificação, sem expor o token esperado

### Requirement: Verificar assinatura antes de interpretar eventos

`POST /webhooks/whatsapp/meta` SHALL verificar `X-Hub-Signature-256` com HMAC-SHA256 e segredo da aplicação sobre os bytes originais. Comparação SHALL evitar variação de tempo dependente dos bytes secretos. Assinatura ausente, malformada ou incorreta MUST resultar em 403 antes de produzir qualquer efeito. O corpo SHALL ter limite de tamanho com rejeição 413. JSON/estrutura básica inválidos, após assinatura válida, SHALL resultar em 400.

#### Scenario: JSON equivalente com bytes diferentes
- **WHEN** a assinatura corresponde a um corpo e outro corpo é recebido com espaços ou ordenação diferentes
- **THEN** a requisição é recusada e nenhuma mensagem é admitida

#### Scenario: Assinatura curta ou ausente
- **WHEN** o digest possui tamanho inesperado ou o header não existe
- **THEN** ocorre rejeição controlada, sem exceção interna publicada ou processamento de negócio

### Requirement: Restringir origem e projetar dados externos

O sistema SHALL aceitar somente a conta e o identificador de número empresarial configurados, com `object=whatsapp_business_account`. Origem divergente MUST resultar em rejeição sem acesso a conversa. Campos consumidos SHALL ser validados antes de sua projeção para eventos internos estritos; extensões desconhecidas de metadados SHALL ser descartadas, nunca propagadas como contexto ou autorização. IDs SHALL permanecer opacos e conversões de timestamp SHALL ser explícitas e validadas.

#### Scenario: Conta ou número estrangeiro
- **WHEN** um webhook assinado identifica WABA ou phoneNumberId diferentes da configuração
- **THEN** nenhuma conversa é criada ou recuperada e o webhook é rejeitado

#### Scenario: Metadados tentam fornecer autoridade interna
- **WHEN** campos adicionais incluem `conversationId`, `schoolId`, `confirmed`, histórico ou configuração de modelo
- **THEN** esses campos não entram no comando interno, no contexto ou na autorização de ação

### Requirement: Processar lotes sem confundir tipos de evento

Todos os itens de entradas e alterações autorizadas SHALL ser examinados. Texto e resposta a botão emitido pelo sistema SHALL ser encaminhados ao canal; status SHALL seguir tratamento de entrega independente. Outros tipos SHALL ser reconhecidos e ignorados sem download de mídia, interpretação pela LLM ou escrita comercial. Item malformado em envelope assinado válido SHALL ser descartado isoladamente, sem perder itens válidos do lote.

#### Scenario: Lote com mensagens e status
- **WHEN** o webhook contém várias mensagens válidas, status e mídia não suportada
- **THEN** todas as mensagens elegíveis são admitidas, status não vira texto e mídia não inicia tool ou download

#### Scenario: Item inválido entre mensagens válidas
- **WHEN** um item possui tipo incorreto em campo consumido e há outro item válido
- **THEN** somente o item inválido é descartado, com observação sanitizada e sem falso sucesso comercial

### Requirement: Confirmar recebimento sem prometer processamento durável

Eventos elegíveis SHALL ser admitidos e deduplicados em memória antes do HTTP 200. O ACK MUST NOT aguardar LLM ou envio de resposta. Falha de admissão/capacidade SHALL produzir 503 sem prometer recebimento. Evento ignorado válido e duplicata já admitida SHALL receber 200. O ACK SHALL significar apenas recebimento local, não conclusão, entrega ou persistência durável.

#### Scenario: Modelo bloqueado durante o processamento
- **WHEN** a admissão foi concluída e o modelo ainda aguarda resposta
- **THEN** o webhook já pode retornar 200, enquanto o trabalho permanece explicitamente pendente

#### Scenario: Capacidade esgotada
- **WHEN** novos eventos excedem o limite local de admissão
- **THEN** recebem 503 sem remover IDs processados para permitir reexecuções acidentais

### Requirement: Isolar credenciais e a superfície de demonstração

O canal SHALL ser opcional e desabilitado sem configuração; segredos SHALL permanecer exclusivamente no backend. Habilitação incompleta SHALL falhar sem publicar valores. Logs MUST NOT conter tokens, query de verificação, corpos de mensagens, contatos ou payloads de confirmação. A exposição HTTPS demonstrativa SHALL permitir somente o webhook; endpoints web internos MUST NOT ser expostos pelo túnel do canal.

#### Scenario: Execução local sem Meta
- **WHEN** o canal está desabilitado e nenhuma credencial Meta foi fornecida
- **THEN** web, API existente e testes continuam executáveis, sem chamadas externas

#### Scenario: Inspeção da superfície pública e logs
- **WHEN** um participante tenta acessar `/api/chat/confirm` pelo host do webhook e ocorrem erros de assinatura/envio
- **THEN** a rota interna não fica acessível e logs/respostas não revelam credenciais ou dados pessoais
