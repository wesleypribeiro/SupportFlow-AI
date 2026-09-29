# Proposal

## Why

O SupportFlow AI precisa de uma primeira aplicação comercial concreta: atender interessados em uma escola de idiomas, esclarecer dúvidas e transformar interesse em cadastro e aula experimental. O MVP deve validar essa jornada preservando um core genérico que permita outros segmentos no futuro.

## What Changes

- Manter npm workspaces, `apps/api`, `apps/web`, `packages/contracts`, TypeScript strict, Fastify, Next.js, Zod, LangChain e testes sem rede ou LLM real.
- Separar o core de conversa e execução de ferramentas do módulo de escola de idiomas, conectado por composição simples.
- Oferecer `get_school_info`, `get_courses`, `get_course_details`, `get_available_slots`, `create_lead`, `schedule_trial_class` e `transfer_to_human`.
- Atender visitantes sem `customerId`, com contexto de conversa em memória; correções do usuário substituem preferências anteriores e invalidam ações pendentes afetadas.
- Obter preços, horários, disponibilidade, dados da escola, cursos e resultados de cadastro/agendamento exclusivamente dos dados estruturados do backend/tools. O agente não será instruído a produzir esses fatos a partir do próprio conhecimento.
- Exigir confirmação explícita da reserva vinculada pelo backend à ação pendente. Um campo `confirmed: true` produzido pela LLM não autoriza a operação.
- Manter confirmação do cadastro de lead como decisão de UX desta versão, documentada separadamente da regra obrigatória de reserva.
- Usar uma escola, fixtures fictícias e repositórios em memória. A reserva confirma apenas a agenda interna demonstrativa; a transferência registra uma solicitação local, sem integração externa.

## Capabilities

### New Capabilities

- `support-chat`: chat com contexto, atualização de preferências e apresentação de ações pendentes.
- `support-agent-tools`: execução validada de ferramentas e origem estruturada dos fatos e resultados.
- `school-catalog`: informações da escola, cursos e preços cadastrados.
- `lead-capture`: coleta, confirmação de cadastro e registro de interessados.
- `trial-class-scheduling`: consulta de horários e reserva com confirmação e disponibilidade verificadas pelo backend.
- `human-handoff`: registro e consulta do resultado de uma solicitação de atendimento humano.

### Modified Capabilities

Nenhuma: ainda não existem specs principais em `openspec/specs/`. Os caminhos `support-chat` e `support-agent-tools` aparecem em outra change pendente, mas não constituem uma base implementada.

## Impact

- Esta é a sucessora proposta para a primeira implementação; não depende da implementação de clientes/faturas. `supportflow-ai-mvp` permanece integralmente intacta e não deve ser aplicada em paralelo a esta change, pois os contratos de chat e ferramentas diferem.
- O reaproveitamento é do planejamento: não foram encontrados código de aplicação nem chat executável no diretório atual. A nova implementação preservará a interface de chat prevista.
- O design explicita os limites probabilísticos do texto livre da LLM; schemas e testes simulados não serão apresentados como garantia absoluta de ausência de invenções.
- Esta entrega cria apenas artefatos de planejamento. Não altera aplicação, infraestrutura ou a change anterior.

## Non-goals

WhatsApp, pagamentos, multi-tenant completo, billing, CRM completo, voice, múltiplos agentes, follow-up complexo, calendários externos, RAG, LangGraph, PostgreSQL, pgvector e deploy em produção. Também ficam de fora autenticação, painel de atendentes, atendimento humano ao vivo, cancelamento/remarcação de reservas, plataforma de plugins e mecanismos complexos de protocolo ou deadline global do agente.
