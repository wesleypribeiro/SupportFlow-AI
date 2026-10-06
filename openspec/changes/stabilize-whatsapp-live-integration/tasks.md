# Tasks — Estabilização da integração real

## 1. Correção delimitada e regressões

- [x] 1.1 Estabilizar o handshake com trio oficial ou aliases completos e idênticos, descartar somente goal sem evidência literal preservando contexto/revisão/ações, remover a instrumentação temporária dos cinco arquivos revisados e documentar os limites; verificar rejeições de handshake, consultas oficiais sem CHAT_ERROR, dados pessoais estritos, confirmação de cadastro e ausência de regressão web/WhatsApp com modelo/transporte simulados, aprovando `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `openspec validate stabilize-whatsapp-live-integration --strict` e `git diff --check`.

Critérios: sem credenciais reais, sem alteração de `.env` ou `.gitignore`, sem nova funcionalidade, sem commit/archive. A task 5.3 e todas as marcações da change `whatsapp-channel-mvp` permanecem intactas.
