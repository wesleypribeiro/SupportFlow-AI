# Proposal — Estabilização da integração WhatsApp

## Why

O ensaio real relatado pelo usuário revelou rejeição do handshake com aliases e interrupção de consultas comerciais quando o interpretador propõe um objetivo sem trecho literal na mensagem. As correções locais experimentais precisam de critérios explícitos, regressões determinísticas e remoção da instrumentação temporária.

## What Changes

- Aceitar os três parâmetros oficiais do handshake ou os seis parâmetros observados, exclusivamente com aliases completos e idênticos; manter rejeição de extras, duplicatas e formatos ambíguos.
- Descartar somente a atualização de `goal` sem evidência literal, preservando o objetivo anterior e a continuidade do turno. Nome, contato, curso, horário, schemas, confirmação e atomicidade mantêm suas proteções.
- Remover logs temporários dos cinco arquivos já alterados, preservando apenas as correções necessárias.
- Verificar consultas oficiais, revisão, prévias e confirmação com modelo/transporte simulados e repositories reais, nos canais web e WhatsApp.

## Capabilities

### New Capabilities

Nenhuma capability nova.

### Modified Capabilities

- `whatsapp-webhooks`: detalhar os formatos admissíveis do handshake. Esta capability ainda está na change ativa `whatsapp-channel-mvp`; o delta desta estabilização depende dela, sem editar seus artefatos ou marcações.
- `support-chat`: distinguir uma proposta de objetivo sem evidência de uma mudança real de contexto, sem interromper isoladamente o atendimento.

## Impact

Alterações pequenas em `webhook-security.ts` e `conversation-context.ts`, limpeza de diagnóstico no runner/serviço/interpretador, testes e documentação local. Sem contratos públicos, dependências novas, mudanças no prompt ou no lifecycle. A interpretação continua probabilística; o backend não converte inferência em fato ou consentimento.

Escopo autorizado neste pedido: criar e implementar uma única task. Não inclui execução de cliques da task 5.3, tasks futuras, testes reais pagos, commits ou archive. `.env` e `.gitignore` permanecem intactos; OpenSpec local continua autoridade mesmo ignorado pelo Git.
