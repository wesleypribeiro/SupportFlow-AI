# Proposal — WhatsApp Channel MVP

## Why

O MVP escolar já conclui consultas, cadastro, reserva e solicitação humana no chat web. Adicionar o WhatsApp como canal do mesmo motor permite demonstrar essas jornadas onde o visitante já conversa, sem duplicar regras de negócio ou transformar texto livre em autorização.

## What Changes

- Adicionar adapter para a WhatsApp Business Platform — Cloud API oficial da Meta, com webhook GET/POST, assinatura sobre bytes originais e configuração exclusivamente no backend.
- Associar remetente e número empresarial autorizado a uma conversa interna; receber texto e respostas a botões, sem aceitar contexto ou identificadores comerciais como autoridade externa.
- Extrair a orquestração hoje contida em `core/chat-route.ts` para um serviço interno compartilhado com as rotas web. Preservar ChatRunner, contexto, serialização, staging, confirmação e recibos.
- Apresentar as sete tools atuais através de texto oficial, prévias e botões distintos para cadastro e reserva. Reutilizar os contratos existentes, sem novos schemas de lead/booking/handoff ou novas tools.
- Vincular cada botão a uma ação oficial; texto “sim”, referência estrangeira ou manipulada nunca autoriza escrita. Botão de ação stale é recusado; ação concluída continua recuperando seu recibo histórico.
- Separar deduplicação de entrada, processamento, resultado oficial, aceite do envio e entrega; recuperar envios usando resultados salvos, sem reexecutar operações.
- Responder somente a visitantes dentro da janela de atendimento; fora dela, bloquear envio livre e aguardar nova mensagem. Templates e campanhas não serão implementados neste MVP.
- Manter estado em memória em uma única instância demonstrativa, com limites explícitos, descarte seguro de interações antigas após reinício e sem promessa de entrega exatamente uma vez.
- Planejar testes locais completos e homologação posterior com número de teste da Meta, dados fictícios e transporte real somente por execução manual explícita.

## Capabilities

### New Capabilities

- `whatsapp-webhooks`: verificação, assinatura, origem, normalização de lotes e tratamento seguro de eventos suportados/não suportados.
- `whatsapp-conversations`: vínculo de remetentes, processamento ordenado, deduplicação e limitações da sessão em memória.
- `whatsapp-confirmations`: apresentação e resolução de botões vinculados às ações oficiais, preservando revisão e recibos.
- `whatsapp-delivery`: apresentação textual dos resultados, envio Meta, janela de atendimento, estados de entrega e recuperação de transporte.

### Modified Capabilities

- `support-chat`: motor compartilhado entre canais e delimitação da UX web versus mensagens interativas; contratos HTTP existentes permanecem iguais.
- `human-handoff`: esclarecer que enviar o protocolo ao visitante por um canal autorizado não significa encaminhar a solicitação a atendentes ou a um sistema externo de tickets.

As capabilities `support-agent-tools`, `school-catalog`, `lead-capture` e `trial-class-scheduling` são reutilizadas integralmente, sem delta de regras escolares.

## Impact

- Implementação futura concentrada em `apps/api/src/channels/whatsapp`, pequena extração em `core/chat-route.ts` e composição em `app.ts`. Apresentação escolar para o canal será composta pelo módulo, sem regras escolares no core.
- Novos endpoints propostos: `GET` e `POST /webhooks/whatsapp/meta`. O canal chama o serviço interno; não faz HTTP contra `/api/chat` ou `/api/chat/confirm` e não publica URLs de confirmação.
- Sem alteração dos contratos públicos de `packages/contracts`, das sete tools, do frontend Next.js ou das fixtures. Schemas de transporte Meta ficam na API; a fronteira de provedor é pequena, sem SDK arquivado, registry de plugins ou implementação WAHA.
- Sem banco, Redis, fila externa, multi-tenant, sincronização de sessão web/WhatsApp, calendário externo, pagamentos, notificações a atendentes, mídia, voz ou lançamento comercial.
- Homologação real requer conta/app/número e destinatários de teste, HTTPS restrito ao webhook e credenciais. Isso não é necessário à suíte automatizada e não será executado nesta fase de planejamento.
- A persistência durável de inbox/outbox, vínculos, ações, recibos e negócios é pré-requisito de uma futura operação comercial; persistir somente o canal não resolveria a volatilidade do motor.
- O ajuste de Git libera somente a nova change além dos caminhos já autorizados; o archive escolar e a change antiga permanecem intactos. Nenhum commit automático.

## Review boundary

Status: proposta técnica para revisão, em 2026-09-29, com OpenSpec 1.13.1. Nenhuma task de implementação foi executada. Detalhes, fontes oficiais, decisões de segurança e critérios de homologação estão em `design.md`; cenários normativos, em `specs/`.
