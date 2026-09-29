# Tasks — WhatsApp Channel MVP

Planejamento para revisão. Nenhuma implementação autorizada nesta execução. Cada task deve ser solicitada/validada incrementalmente; todas permanecem pendentes. Não alterar o archive escolar, seus contratos públicos ou regras comerciais.

## 1. Serviço compartilhado de conversa

- [ ] 1.1 Extrair de `core/chat-route.ts` a orquestração de mensagem/confirmação para serviço interno genérico, mantendo rotas como adapters; verificar com `server.inject()` os mesmos schemas, HTTP 400/404/409/500, staging/commit, atomicidade e recibos; executar a suíte existente sem alterações nas expectativas comerciais.
- [ ] 1.2 Disponibilizar abertura interna de conversa vazia e leitura consistente de prévia, mantendo a mesma serialização do motor; verificar ID gerado no backend, defaults, falha de primeiro turno sem contexto parcial, mensagens/confirmações concorrentes em ordem e ausência de deadlock por aquisição dupla; conferir que core não importa Meta ou domínio escolar.

## 2. Configuração e recepção segura Meta

- [ ] 2.1 Criar configuração opcional backend e fronteira mínima de provider/transportes normalizados; verificar startup sem Meta, habilitação incompleta recusada sem segredos, allowlist demonstrativa e nenhuma variável no bundle web; registrar versão Graph e confirmar nos exemplos oficiais dessa versão os limites de texto/botão e `context.id` exigido, sem adotar SDK arquivado ou WAHA.
- [ ] 2.2 Implementar GET de verificação e POST com bytes originais, limite de corpo e HMAC; testar challenge exato, token/mode/formato incorretos, assinatura ausente/curta/alterada, JSON equivalente com bytes diferentes, 400/403/413 e preservação do parser das rotas web.
- [ ] 2.3 Implementar projeção validada de lotes Meta para eventos internos estritos; testar múltiplas entradas/mensagens/status, origem WABA/número divergente, timestamps inválidos, extras externos não autoritativos, item malformado isolado e mídia/tipo desconhecido ignorados sem modelo/download.
- [ ] 2.4 Aplicar sanitização de logs/erros e registrar configuração de proxy HTTPS restrita ao webhook; testar que tokens, query, contatos, corpos e referências interativas não aparecem nos logs, e validar localmente que a configuração de exposição nega `/api/chat` e `/api/chat/confirm`; não adicionar autenticação ou novos contratos web.

## 3. Vínculo, inbox e processamento local

- [ ] 3.1 Implementar vínculo por provider/conta/número/remetente com cópias defensivas; testar duas primeiras mensagens concorrentes na mesma conversa, isolamento entre remetentes, perfil/telefone sem autopreenchimento do lead e ausência de associação automática com uma sessão web.
- [ ] 3.2 Implementar admissão atômica da inbox e fila local por vínculo, devolvendo ACK antes de modelo/envio; testar mesmo messageId durante/depois do processamento, colisão de conteúdo/remetente, um único turno por evento, correção antes de clique, independência entre conversas, rejeições capturadas e remoção de filas ociosas.
- [ ] 3.3 Implementar limites de admissão e política de reinício demonstrativo com clock injetado; testar 503 sem eviction de dedupe, reconhecimento de duplicatas/status conhecidos, descarte de evento anterior ao marco, novo texto iniciando sessão vazia e botão perdido sem criação de conversa ou reconstrução comercial.

## 4. Apresentação textual e conversa por WhatsApp

- [ ] 4.1 Criar apresentador escolar baseado nos contratos existentes para sete results e duas previews; testar catálogo/horários oficiais, null versus zero, fuso/data explícitos, listas vazias, created/existing/updated/SLOT_UNAVAILABLE/requested, prosa divergente, divisão Unicode e prévia grande sem botão incompleto; nenhum presenter pode gravar ou consultar regras comerciais.
- [ ] 4.2 Implementar cliente Cloud API de texto/botão com fetch injetado e timeout, versão fixa e Bearer backend; testar corpo/destinatário, limites validados, aceite com messageId, rejeição conhecida, timeout/resposta inválida como unknown e ausência de alegação de entrega; nenhum teste chama Meta real.
- [ ] 4.3 Conectar texto normalizado ao serviço existente e ao apresentador, mantendo o resultado salvo antes do envio; testar catálogo → curso → horários por webhook assinado com ScriptedChatModel e repositories reais, texto vazio/maior que 2.000 sem truncamento, handoff explícito sem lead e preservação de ação pendente; preparar o scope de apresentação anterior com ausência explícita quando não houver evidência de oferta enviada, sem mudar a regra web.

## 5. Confirmação interativa vinculada ao backend

- [ ] 5.1 Implementar referências opacas ligadas a vínculo, conversa, actionId, kind e messageIds das prévias aceitas; testar geração backend sem PII/args, correlação com mensagem de origem, referência desconhecida/manipulada/estrangeira, título sem autoridade e resposta interativa incompleta rejeitada; nenhum ID digitado pode chamar confirmação.
- [ ] 5.2 Publicar botões somente para ações commitadas, distintos para cadastro/aula; testar CONFIRMATION_REQUIRED sem escrita, mesmos dados preservando ação, correção de contato/objetivo/slot substituindo prévia, falha de redação sem referência órfã, “sim” sem consentimento e botão stale visível mas recusado.
- [ ] 5.3 Resolver clique para os dois IDs internos e chamar a confirmação compartilhada; testar cadastro created/updated/existing, reserva created/existing/conflito, isolamento, confirmação de cadastro sem reserva, retry de ação concluída após revisão nova, recibo SLOT_UNAVAILABLE histórico e garantia de que pendingAction atual não é pré-requisito para recuperar recibo concluído.

## 6. Entrega, status e recuperação

- [ ] 6.1 Implementar outbox local e `/reenviar` sem retry automático de envio; testar reserva concluída seguida de falha/unknown, mesmo receipt/booking sem modelo ou nova escrita, partes já aceitas preservadas, unknown com possível duplicação apenas visual, prévia superseded não reenviada, falta de estado sem sucesso inventado e envio lento sem bloquear correção de contexto.
- [ ] 6.2 Correlacionar status e evidência mínima de apresentação; testar accepted distinto de delivered/read, duplicatas/fora de ordem sem regressão, status antes do retorno HTTP conciliado por vínculo, destinatário desconhecido sem efeito e failed sem alterar reserva; testar aceitação de oferta de handoff entregue/correlacionada e rejeição de “sim” quando oferta foi omitida ou não possui evidência, preservando pedido explícito independente.
- [ ] 6.3 Aplicar janela de atendimento com clock injetado antes de cada parte/reenvio; testar mensagem original versus reentrega, limites antes/exatamente/depois de 24 horas, status/saída sem reabertura, blocked_window sem template e recuperação após novo texto; preservar o timestamp original sem estender janela por retry.

## 7. Homologação e documentação do canal

- [ ] 7.1 Adicionar suíte integrada identificável de webhook assinado → motor real → transporte simulado → clique → recibo, com relógio fixo e fixtures existentes; cobrir jornada completa, correções de objetivo/contato/horário, dois remetentes disputando vaga, duplicatas, botão antigo/estrangeiro, falhas de redação e envio, handoff sem lead, oferta não apresentada, reinício e preservação de reservas/recibos; não simular retornos de repositories/casos de uso.
- [ ] 7.2 Executar `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `openspec validate whatsapp-channel-mvp --strict` e auditoria de isolamento/segredos; registrar ambiente, contagens, resultados e ausência de serviços reais na suíte, preservando testes web e SDK OpenAI com transporte simulado.
- [ ] 7.3 Documentar setup seguro, arquitetura, estados de inbox/outbox, comando `/reenviar`, janela/templates fora de escopo, limites/volatilidade e checklist de número de teste; entregar harness manual isolado com ScriptedChatModel e transporte real opt-in, verificar exemplos/links, rota pública restrita, dados fictícios e instruções sem credenciais reais; documentação não deve chamar handoff local de atendimento humano.
- [ ] 7.4 Executar homologação manual explicitamente autorizada com número de teste Meta e participantes permitidos: handshake, catálogo, duas confirmações, correções/botão antigo, handoff, status e falha/reenvio; registrar expected/actual expurgados e versão Graph, verificando a superfície pública e custos; se conta, credenciais ou HTTPS não estiverem disponíveis, registrar impedimento e manter esta task pendente, sem substituir a homologação por mocks.

## Rastreabilidade

| Milestone | Specs principais | Evidência |
| --- | --- | --- |
| 1 | `support-chat` | Regressão HTTP/serviço, staging e recibos existentes |
| 2 | `whatsapp-webhooks` | Assinatura, origem, lotes, configuração e logs |
| 3 | `whatsapp-conversations` | Concorrência, dedupe e ciclo de execução |
| 4 | `whatsapp-delivery`, `human-handoff` | Fatos textuais e adapter Meta simulado |
| 5 | `whatsapp-confirmations`, `support-chat` | Botões oficiais, revisão e recibos históricos |
| 6 | `whatsapp-delivery`, `whatsapp-conversations` | Transporte, janela, oferta apresentada e recuperação |
| 7 | Todas as deltas e seis specs consolidadas | Jornada real local, checks e ensaio Meta separado |
