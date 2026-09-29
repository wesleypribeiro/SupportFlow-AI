# Tasks

## 1. Fundação Full Stack e separação do segmento

- [x] 1.1 Criar npm workspaces com `apps/api`, `apps/web` e `packages/contracts`, TypeScript strict, Fastify, Next.js, Zod, LangChain e Vitest; verificar instalação, typecheck e build, sem alterar a change `supportflow-ai-mvp`.
- [x] 1.2 Criar composição manual do core e módulo `language-school`, configuração de escola única e ambiente do provedor apenas no backend; verificar inicialização local, ausência de segredos no frontend e testes sem credenciais de LLM.

## 2. Contratos e catálogo escolar

- [x] 2.1 Definir schemas estritos de escola, curso, preço, lead, slot, reserva, handoff e envelopes de tools/chat; verificar rejeição de extras e tipos incorretos e aceitação de preço `null`, sem coerção ou geração de campos pela LLM.
- [x] 2.2 Implementar `SchoolRepository` em memória e fixtures fictícias com cursos ativos/inativos e preços conhecidos/ausentes; verificar consultas por ID, oferta apenas de ativos e distinção entre preço ausente e zero.
- [x] 2.3 Implementar `get_school_info`, `get_courses` e `get_course_details` sobre os casos de uso; verificar entrada/saída por schema e resultados comerciais idênticos aos registros, com falha controlada para referências inválidas.

## 3. Chat, contexto e fatos estruturados

- [x] 3.1 Implementar conversas em memória, `POST /api/chat` e composição LangChain com tools e prompt do módulo; verificar início sem cadastro, continuidade e isolamento usando modelo simulado e injeção HTTP local.
- [x] 3.2 Implementar atualização validada do contexto atual antes das próximas decisões e revisão de contexto; verificar “inglês para viagem” seguido de “entrevistas de emprego”, preservando campos não alterados e substituindo o objetivo vigente.
- [x] 3.3 Criar a interface de chat Next.js com envio, processamento, erro recuperável e exibição de `results` do backend junto ao texto natural; verificar manualmente teclado/tela estreita e testar que prosa simulada divergente não preenche dados oficiais ou estados de operação.
- [x] 3.4 Definir instruções de consulta às tools como fonte de fatos e fluxo por turnos sem loop aberto; verificar com modelo simulado saudações sem consulta, consulta de catálogo, encaminhamento dos resultados e ausência de instruções para gerar fatos comerciais do próprio conhecimento.

## 4. Ações pendentes e cadastro de lead

- [x] 4.1 Implementar ação pendente com argumentos imutáveis, revisão e vínculo à conversa, e `POST /api/chat/confirm` recebendo somente IDs; verificar rejeição de ação inexistente/estrangeira, argumentos reenviados e confirmação antiga após mudança de contexto, com processamento em ordem por conversa.
- [x] 4.2 Implementar `LeadRepository`, caso de uso e `create_lead`, preparando prévia sem gravar até confirmação de cadastro; verificar nome/contato fornecidos, curso ativo, objetivo atual e resultado `CONFIRMATION_REQUIRED` antes da gravação.
- [x] 4.3 Implementar a política de UX “Confirmar cadastro”, retorno `created`/`existing`/`updated` somente para o lead da conversa e recibo de confirmação; verificar correção de dados antes/depois do cadastro, repetição sem duplicação e que confirmar cadastro não autoriza reserva.
- [x] 4.4 Conectar as prévias de cadastro ao chat e invalidar/desabilitar a ação antiga após correções; verificar que a nova prévia usa as informações mais recentes e que confirmar uma prévia obsoleta não grava dados anteriores.

## 5. Horários e confirmação obrigatória de aula experimental

- [x] 5.1 Implementar slots fictícios, `TrialClassRepository` e `get_available_slots`; verificar curso ativo, horário futuro com relógio injetado, vaga livre, lista vazia e ausência de ocupação durante a consulta.
- [x] 5.2 Implementar a proposta de `schedule_trial_class` e a confirmação obrigatória vinculada pelo backend; verificar prévia com lead/curso/data/hora/fuso, rejeição de `confirmed: true` da LLM, confirmação de cadastro inadequada e ação invalidada por mudança de preferência.
- [x] 5.3 Implementar verificação e reserva atômica, com recibo registrado e repetição para o mesmo lead/slot; verificar uma única reserva para dois leads disputando a vaga, referências incompatíveis, indisponibilidade posterior à consulta e reenvio da mesma confirmação sem duplicação.
- [x] 5.4 Apresentar confirmação de aula e recibo oficial no chat; verificar que alteração posterior do contexto ou do lead não modifica a reserva concluída, e que falha da LLM após escrita retorna o resultado e mensagem de contingência do backend.

## 6. Solicitação de atendimento humano

- [x] 6.1 Implementar `HandoffRepository` e `transfer_to_human` após pedido do visitante ou aceitação da oferta; verificar funcionamento sem lead, vínculo à conversa e retorno da solicitação aberta original em repetições.
- [x] 6.2 Exibir protocolo local e status `requested` sem afirmar atendimento ao vivo ou envio externo; verificar falha sem falso sucesso e recuperação do resultado se a redação do modelo falhar após a gravação.

## 7. Jornada integrada e documentação

- [x] 7.1 Verificar a jornada catálogo → escolha → horários → cadastro confirmado → reserva confirmada, com modelo simulado; incluir mudança de objetivo/contato/horário antes da confirmação, conflito de vaga, ação antiga, falha de transporte e preservação dos recibos.
- [x] 7.2 Executar `npm test`, `npm run typecheck`, `npm run lint` e `npm run build`; confirmar suíte principal sem rede/LLM real e dependências do domínio isoladas de infraestrutura, registrando os resultados.
- [x] 7.3 Documentar comandos locais, fixtures, perda de memória no reinício, agenda demonstrativa e limite probabilístico do texto livre; separar no README a escolha atual de confirmação do cadastro da regra obrigatória de reserva e registrar procedimento manual opcional de avaliação com modelo real.
