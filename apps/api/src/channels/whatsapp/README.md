# Fronteira WhatsApp — implementação incremental

Esta etapa disponibiliza configuração backend, tipos de transporte e um webhook
de validação. `createApplication(environment)` compõe `config.whatsapp` e registra
GET/POST `/webhooks/whatsapp/meta` somente quando habilitado. Desabilitado, ambos
retornam 404. Projeta eventos validados e admite mensagens na inbox local antes do
ACK. Desde a task 4.3, a composição padrão conecta texto ao serviço compartilhado,
ao apresentador escolar e ao cliente Cloud API. O primeiro texto válido abre
a sessão vazia; a resposta/erro fica salva na inbox antes da apresentação.
Avisos demonstrativos também são enviados pelo transporte composto.
O core, as sete tools, os contratos públicos e o frontend permanecem independentes.

## Configuração

Use apenas [apps/api/.env.example](../../../.env.example) como referência. O loader
recebe `environment` por composição; não lê `process.env`, `.env` ou a rede.

- `WHATSAPP_ENABLED` ausente, vazio, somente whitespace ou exatamente `false`
  devolve `{ enabled: false }` sem ler/validar os outros campos Meta.
- Somente o literal `true` habilita. `1`, `yes`, `TRUE` e booleanos com espaços
  nas bordas são rejeitados; não há coerção permissiva.
- Habilitado exige `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
  `META_ACCESS_TOKEN`, `META_WABA_ID`, `META_PHONE_NUMBER_ID`,
  `META_GRAPH_API_VERSION` e `WHATSAPP_DEMO_RECIPIENTS`.
- Segredos e IDs removem apenas whitespace externo, como a configuração existente
  da API. Conteúdo interno e caixa são preservados. IDs continuam strings opacas,
  inclusive zeros iniciais e valores maiores que a precisão numérica do JavaScript.
- A versão aceita nesta etapa é explicitamente **v26.0**, verificada em
  [compatibilidade Meta](meta/compatibility.md). Sem default, `latest`, descoberta
  em rede ou atualização automática. Outra versão exige rever essa evidência e o loader.
- Erros incluem somente nomes de variáveis; não incluem ZodError, valores ou cause.
  A configuração contém segredos e não deve ser registrada nem enviada ao browser.

## Participantes demonstrativos

`WHATSAPP_DEMO_RECIPIENTS` usa CSV simples, sem quoting/escape. Vírgula é o
separador; remove-se whitespace externo de cada item. Lista vazia e itens vazios
(inclusive vírgula final ou repetida) são inválidos. Duplicatas exatas são eliminadas
preservando a primeira ocorrência e a ordem. O restante de cada ID é preservado,
sem conversão numérica, normalização de telefone ou extração de dados comerciais.
A lista retornada é independente do env e congelada. A composição descarta
mensagens de remetentes não listados antes da inbox, sem abrir sessão ou enviar
resposta; o webhook reconhece esses itens com ACK.

São exclusivamente participantes autorizados da demonstração. Isso não define
tenant, autenticação comercial, nome/contact do lead ou vínculo de conversa.
A allowlist não preenche contexto comercial nem associa sessões web.

## Transporte interno

`WhatsAppTransport.send({ recipientId, message })` recebe texto (`type: text`,
`body`) ou mensagem de botões (`type: reply_buttons`, `body`, `buttons` com `id`
e `title`). São tipos internos readonly, sem modelos escolares, action args ou
credenciais. A task 4.2 implementa essa fronteira em
[`meta/cloud-api-client.ts`](meta/cloud-api-client.ts), conectado à apresentação
textual pela task 4.3.

O resultado distingue:

- `accepted`: aceite válido com `messageId`; não significa entrega ao visitante.
- `rejected`: rejeição conhecida, representada por categoria local sanitizada.
- `unknown`: timeout, erro de rede ou resposta inválida; não é seguro afirmar
  que o provedor recusou o envio. Não há garantia de exactly-once.

`createMetaCloudApiClient(config, { fetch, timeoutMs? })` recebe somente a
configuração backend de envio (`accessToken`, `phoneNumberId`, `graphApiVersion`)
e exige `fetch` injetado. Não lê env ou rede na construção. Envia um POST para
`https://graph.facebook.com/v26.0/<phoneNumberId>/messages`, codificando o ID
como segmento de URL. O Bearer fica exclusivamente no header `Authorization`;
redirects são recusados. Não há SDK Meta, WAHA ou retry automático.

O request normalizado é validado estritamente antes de qualquer I/O. Texto aceita
até 4.096 unidades UTF-16, corpo interativo até 1.024, de 1 a 3 botões, título
até 20 e referência até 256. IDs e títulos dos botões devem ser distintos na
mensagem. Campos vazios/em branco, extras e tipos incompatíveis são recusados;
valores válidos são preservados, sem trim, coerção ou truncamento. IDs de
destinatário/aceite têm limite local de 1.024 unidades e permanecem opacos.
A divisão de texto pertence ao apresentador; uma chamada envia uma única parte.

O timeout padrão é **10 segundos**, ajustável na composição interna como inteiro
positivo de até 2.147.483.647 ms. Cobre fetch e leitura do corpo, aborta a tentativa
e retorna `unknown / timeout` mesmo se o transporte injetado não concluir ao
receber abort. O timer é liberado ao terminar; respostas tardias não substituem
o resultado. Erros de rede retornam `unknown / network_error`.

HTTP 2xx só vira `accepted` com produto WhatsApp e exatamente um `messages[].id`
válido, sem erro conflitante. Extensões de entrega/leitura não constituem
evidência de entrega. HTTP 4xx/5xx exige um objeto `error` validado para virar
`rejected`: 401/403 usam `unauthorized`, 429 usa `rate_limited`, demais rejeições
usam `provider_rejection`. `invalid_request` indica recusa local antes de envio.
JSON inválido, corpo sem ID, rejeição malformada ou resposta contraditória são
`unknown / invalid_response`, inclusive erros HTML de proxy. Nenhuma mensagem,
stack, cause ou payload bruto de erro é retornado ou registrado em log.

A suíte [`whatsapp-cloud-api-client.test.ts`](../../../test/whatsapp-cloud-api-client.test.ts)
usa `fetch` simulado, bloqueia o fetch global e controla timers/Promises. Cobre
payload/destinatário, limites inclusive Unicode, aceite sem alegar entrega,
rejeições, respostas inválidas, timeout e falhas tardias, sem chamadas à Meta.
Referências de confirmação, outbox, status e janela geral continuam nas tasks
posteriores.

## Webhook incremental — task 2.2

GET aceita exclusivamente `hub.mode`, `hub.verify_token` e `hub.challenge`, todos
strings escalares. O modo deve ser `subscribe` e o token deve corresponder a
`META_WEBHOOK_VERIFY_TOKEN`. Sucesso retorna 200 `text/plain; charset=utf-8` com
o challenge exato após decodificação da query: sem trim, conversão numérica,
JSON ou newline adicional. Zeros iniciais e whitespace são preservados.

Ausência, repetição, campos extras, challenge vazio ou encoding malformado são
400. Modo/token incorretos em query bem formada produzem o mesmo 403 vazio,
inclusive token de outro comprimento. O token é comparado como bytes UTF-8,
usando `timingSafeEqual` somente depois de conferir comprimentos iguais.

POST usa um parser Fastify **encapsulado**, exclusivo desse escopo, com
`parseAs: buffer`. O limite local é **1.048.576 bytes (1 MiB)**, inclusive;
excedê-lo produz 413 antes de HMAC/JSON. Fastify verifica os bytes recebidos,
inclusive sem Content-Length, e preserva o Buffer original. Esse número é uma
decisão de proteção do produto, não um limite oficial da Meta.

O header `X-Hub-Signature-256` deve conter exatamente `sha256=` e 64 caracteres
hexadecimais. Ausência, valores múltiplos, whitespace adicional e digest inválido
produzem 403. A chave do **HMAC-SHA256 é `META_APP_SECRET`**, nunca o verify token
nem o access token. O digest esperado é calculado sobre o Buffer completo e
comparado como 32 bytes com `timingSafeEqual`, guardado por igualdade de tamanho.
Não há parse/restringificação antes da assinatura.

Somente depois de autenticar os bytes, o handler decodifica UTF-8 estritamente e
executa `JSON.parse`. JSON inválido, null, array ou primitivo produzem 400.
Na 2.3, o objeto também passa pela validação de envelope/origem abaixo antes do
**200 vazio**. Content-Type não suportado também gera 400
vazio. O handler de erro é local: não retorna corpo recebido, query, assinatura,
segredos ou exceções, nem introduz logs desses dados.

**Desde a task 3.2, o 200 inclui admissão/deduplicação em RAM.** Não significa
processamento concluído, envio, entrega ou persistência durável. Motor,
apresentador e transporte executam depois do ACK pela fila gerenciada.

O POST recebe somente a fronteira síncrona de admissão da inbox; GET/POST não
adquirem `runExclusive` nem executam serviço/modelo/repos/ações/transporte.
O parser e os erros de
`/api/chat` e `/api/chat/confirm` permanecem nos seus escopos originais.
Fontes e distinção dos segredos: [compatibilidade Meta](meta/compatibility.md).

## Projeção de lotes — task 2.3

`meta/webhook-projection.ts` recebe somente JSON autenticado pela rota e não faz
I/O. Valida a estrutura básica (`entry[]`, `changes[]`, `value`, metadata e arrays
opcionais `messages[]`/`statuses[]`); estrutura inválida produz 400. Verifica
`object=whatsapp_business_account`, cada WABA e cada `phone_number_id` contra a
configuração antes de projetar qualquer item. Origem divergente, inclusive no
fim de um lote misto, produz 403 sem liberar eventos parciais.

Todos os itens das alterações `field=messages` são examinados. A união Zod
estrita em `events.ts` contém:

- `text`: identidade de transporte, `text` e `replyToMessageId` opcional.
- `button_reply`: identidade, `reference` e `replyToMessageId` obrigatório,
  derivados de `interactive.button_reply.id` e `context.id`. Não confirma ações.
- `status`: ID da mensagem enviada, `sent|delivered|read|failed` e destinatário
  quando informado. Não equivale a mensagem do visitante nem aceite HTTP.

Todos carregam `provider`, `accountId`, `phoneNumberId`, `messageId` e
`occurredAt` (milissegundos Unix). IDs permanecem opacos, sem trim/conversão;
remetente vem somente de `messages[].from`. Limites locais: IDs de até 1.024,
discriminadores de até 128, referência de até 256 e texto de até 4.096 unidades
UTF-16. São limites da recepção deste adapter, não alegações sobre todos os
formatos/limites do provedor. Texto é preservado integralmente, inclusive vazio
ou acima de 2.000, para a orientação/validação do motor prevista na 4.3.

Timestamp aceita somente string de dígitos (até 16), converte segundos para
milissegundos e exige inteiro seguro não negativo representável por `Date`.
Não usa hora da reentrega, não reordena e não deduplica eventos. A inbox aplica o
marco de reinício da task 3.3; a janela geral de entrega pertence à task 6.3.

Extensões externas são descartadas em todos os níveis: perfil, contatos,
`context.from`, título do botão, billing, erros brutos, `confirmed`, IDs internos,
histórico e configuração de modelo não se tornam estado nem autorização.
Itens de mensagem/status inválidos são isolados; contagens por códigos fixos
registram `INVALID_MESSAGE`, `INVALID_STATUS` ou tipos não suportados, sem
payload/identificadores. Mídia, reação, botão de template, list reply e tipos
desconhecidos não geram evento, download, modelo ou escrita comercial. A
correlação/autorização de referências de botão permanece para o Milestone 5.

## Vínculo interno de conversa — task 3.1

`conversation-bindings.ts` mantém vínculos em memória por tupla exata
`(provider, accountId, phoneNumberId, senderId)`. A composição disponibiliza
`whatsappBindings` somente quando o canal está habilitado. `get` consulta sem
criar estado; `getOrCreate` abre uma conversa vazia pelo serviço compartilhado,
com ID e defaults gerados no backend. O chamador deve fornecer identidade já
autenticada/projetada e decidir a elegibilidade antes de solicitar criação.

A reserva da abertura é síncrona por identidade, antes de aguardar o serviço:
duas primeiras chamadas compartilham a mesma abertura. Só há vínculo consultável
depois da conversa salva; falha libera a reserva sem publicar vínculo. Essa
reserva não ordena turnos nem adquire o lock do core. Mensagens e confirmações
continuam usando a serialização existente do serviço. Outras identidades podem
abrir conversas independentemente.

Entradas e retornos são cópias defensivas, inclusive para chamadores concorrentes.
A chave preserva IDs opacos e separa campos sem colisões por delimitador. Perfil,
telefone e contatos não preenchem o contexto comercial; somente o remetente do
evento projetado compõe a identidade. Não existe busca/associação por contato
comercial ou `conversationId` externo, inclusive para sessões web.

Os testes de vínculo chamam o serviço real diretamente com `ScriptedChatModel`
e repositories em memória. A inbox da task 3.2 usa a mesma tupla de identidade;
política de reinício está descrita abaixo, e a conexão de texto ao motor foi
adicionada na task 4.3.

## Inbox e fila local — task 3.2

`inbox.ts` faz `admit(event)` sincronamente, sem aguardar abertura de conversa,
modelo ou rede. Guarda snapshot e fingerprint canônico pela chave exata
`(provider, phoneNumberId, messageId)`, incluindo conta, remetente, timestamp,
tipo, texto/referência e mensagem respondida na comparação. A ordem das
propriedades não muda o fingerprint; texto/IDs não são aparados. Repetição
idêntica é no-op em qualquer estado. Colisão não substitui o original nem
agenda trabalho e produz HTTP 409 vazio, com código de log local sem dados.
Irmãos válidos do lote continuam admitidos e deduplicáveis em uma reentrega.
Falha de admissão produz 503 vazio, preservando admissões anteriores do lote.

A fila por `(provider, accountId, phoneNumberId, senderId)` preserva ordem de
admissão, sem reordenar timestamps. O início cede ao event loop para liberar o
ACK. Cada callback é aguardado antes do próximo evento da mesma identidade;
outras identidades progridem independentemente. O callback chama o serviço
compartilhado diretamente, sem envolver sua chamada em outro `runExclusive`.

Estados: `received → processing → processed` com snapshot da resposta, ou
`failed` com código controlado. Rejeições síncronas/assíncronas são capturadas
como `CHAT_ERROR`, sem mensagem/stack/cause; a fila continua e o evento falho
não é reexecutado por reentrega. Resultados retornados, eventos e leituras usam
cópias defensivas. `drain(identity?)` aguarda filas nos testes; `activeQueueCount`
permite verificar remoção das caudas ociosas, mantendo os registros de dedupe.

`createApplication` disponibiliza `whatsappInbox` somente quando habilitado e
aceita `whatsappProcessor` por composição interna. O padrão é o processador
textual; `null` isola recepção/sessão sem motor ou apresentação nos testes dessas
fronteiras, mantendo `ignored / PROCESSOR_UNAVAILABLE`. Um processador injetado
substitui as decisões, enquanto `whatsappTransport` permite simular o transporte.
Status não entra nessa inbox nem chama o processador. A resolução de botões
continua nas tasks 5.x.

O callback `onProcessed` recebe uma cópia do registro após salvar o resultado
ou erro, antes da apresentação/envio. Falha desse callback acrescenta somente
`presentationError: PRESENTATION_ERROR`, sem apagar a resposta, trocar seu estado
por falha do motor ou provocar retry. Outbox e recuperação continuam na 6.x.

## Admissão e reinício demonstrativo — task 3.3

A inbox admite no máximo **10.000 mensagens por execução** e **100 aguardando
por vínculo**, além da que já está em processamento. A verificação e a reserva
da capacidade ocorrem sincronamente antes do ACK. Limites podem ser reduzidos
na composição interna com `whatsappInboxLimits`; não são parâmetros do webhook.
O término libera contadores/filas ociosas, mas nunca IDs de dedupe ou resultados.
Inclusive falhas e eventos ignorados continuam deduplicáveis até o reinício.

Capacidade cheia produz **503 vazio** para trabalho novo. Duplicatas continuam
com 200 e colisões com 409, preservando o original. Status continuam reconhecidos
fora da inbox, inclusive sob pressão; sua correlação de entrega pertence à 6.2.
Em lote parcialmente recusado, irmãos elegíveis continuam sendo examinados e
admitidos; o lote recebe 503 e a reentrega deduplica os já admitidos.

`whatsappNow` injeta o relógio do canal, usando `now` como padrão. Assim, um
harness pode separar o relógio comercial fixo do relógio real do webhook.
Na criação da inbox, `startedAt` captura o instante uma única vez com
`Math.ceil(ms / 1000) * 1000`. Evento anterior ao marco é reconhecido com 200 e
descartado antes de ocupar capacidade, criar conversa ou chamar o processador.
O log registra apenas `WHATSAPP_BEFORE_START_IGNORED` e contagem. Eventos no
marco são elegíveis; o marco não acompanha mudanças posteriores do clock.

`demo-session.ts` prepara a sessão dentro da fila existente. Primeiro texto
válido pelo contrato de chat abre a conversa vazia pelo serviço compartilhado,
com defaults oficiais e sem preencher dados de perfil/telefone. Um botão sem
vínculo resulta em `ignored / SESSION_UNAVAILABLE`, sem chamar processador ou
abrir conversa. Nenhuma referência antiga reconstrói ação, cadastro ou reserva.
Texto inicial inválido fica `ignored / INVALID_INITIAL_TEXT`; a apresentação
da 4.3 envia orientação sem abrir conversa. Em sessão existente, texto inválido
faz o processador retornar `ignored / INVALID_TEXT`, preservando contexto e ação.

Avisos de nova sessão e confirmação indisponível são textos fixos em `notice`,
separados do envelope comercial. O callback opcional `whatsappOnNotice` recebe
cópias do evento/aviso após salvar o resultado e depois do ACK. A publicação
exige idade do evento original entre zero (inclusive) e 24 horas (exclusive),
verificada imediatamente antes do callback. Falha fica em `noticeError` com
código fixo `NOTICE_ERROR`, sem apagar resultado ou causar retry. O callback
não comprova entrega. Na composição padrão da 4.3, o callback envia texto pelo
transporte; na composição de recepção isolada, sem callback, o aviso fica local.
Os testes usam transporte simulado; outbox e janela geral de envios continuam
nas tasks próprias.

Toda a demonstração continua em RAM e em uma instância. Reiniciar descarta
conversas, vínculos, dedupe, ações, recibos, leads, reservas e handoffs. Uma nova
sessão informa que registros anteriores não foram recuperados. Descartar
mensagens anteriores ao marco sacrifica mensagens atrasadas; não oferece
deduplicação durável, recuperação comercial ou entrega exatamente uma vez.
Não utilizar reservas comerciais reais nesta demonstração.

## Texto integrado — task 4.3

`text-channel.ts` valida o texto com `chatRequestSchema`, aparando somente as
bordas. Texto vazio ou maior que 2.000 caracteres após trim recebe orientação,
sem truncamento, divisão em turnos ou chamada ao modelo. Texto válido usa o
vínculo existente e chama diretamente `ConversationService.sendMessage`, sem
HTTP interno nem aquisição adicional do lock da conversa.

A inbox salva o envelope antes de invocar o apresentador injetado. O módulo
escolar apresenta results/prévias oficiais; somente diálogo sem ambos utiliza
`reply`. Prévias são enviadas integralmente como texto, sem botão nesta etapa.
O histórico original permanece intacto. Erros do motor recebem orientação fixa,
sem publicar exceções. Cada parte tem uma tentativa; rejeição/indeterminação
interrompe as demais partes da resposta e mantém o resultado salvo.

O scope interno `previousPresentation` atravessa o serviço/core até o adapter
escolar. `undefined` mantém a regra web baseada na última resposta do histórico;
`null` declara ausência de oferta apresentada. O canal passa sempre `null` nesta
etapa: aceite HTTP, status ainda não correlacionado ou `context.id` externo não
comprovam apresentação. Pedido explícito de handoff continua funcionando sem
lead, inclusive com contingência após falha de redação; não confirma nem altera
por si só a ação pendente. Nenhum contrato HTTP público ganhou esse campo.

Botões/referências (5.x), outbox/`/reenviar`, correlação de entrega e janela geral
(6.x) permanecem pendentes. O envio ainda é aguardado pela fila do vínculo;
a separação para permitir correções durante envio lento pertence à 6.1.
Não há retry automático, evidência de entrega ou recuperação após reinício.

## Verificação local

### Logs e exposição — implementação da task 2.4

O escopo `/webhooks/whatsapp` substitui serializers de request, response e erro
por campos permitidos: canal constante, status e código fixo. A correlação de log
usa UUID local, inclusive se uma composição aceitar `X-Request-ID` externo.
Query/URL, headers, tokens, texto, nome, contato, referências, previews e
mensagem/stack/cause de exceções não são registrados. O 404 local também é vazio,
evitando que o comportamento padrão do Fastify devolva/registre a query de uma
rota ou método inexistente. Os handlers web permanecem inalterados.

Rejeições registram `WHATSAPP_WEBHOOK_REJECTED` e status; exceções controladas
registram `WHATSAPP_WEBHOOK_ERROR` e status. Observações de itens ignorados
continuam limitadas a contagens por código local. Os bytes originais deixam de
ficar associados ao request quando o POST começa a verificá-los e são liberados
ao encerrar o handler; o hook de envio também limpa o corpo em caminhos de erro.
O logger da aplicação mantém seu padrão desabilitado.

[whatsapp-logging.test.ts](../../../test/whatsapp-logging.test.ts) captura o logger
Pino real habilitado, inclusive entrada/conclusão automáticas e serializers
herdados deliberadamente inseguros. Cobre sucesso, 400/403/404/413/500,
contatos/botões, exceção HTTP aninhada, limpeza do corpo e correlação local.

O [proxy HTTPS dedicado](../../../../../deploy/whatsapp/README.md) fornece a
configuração Nginx, a política de logs e um verificador local com proxy real que
nega `/api/chat`, `/api/chat/confirm` e outros caminhos/métodos. A execução
inicial do verificador ficou impedida no sandbox por ausência do Nginx e 
restrições de sockets. Posteriormente, a validação foi concluída com sucesso no 
ambiente local Fedora em 05/10/2026, confirmando o bloqueio de 30 acessos 
indevidos, a preservação das requisições autorizadas, o tratamento de falha 502 
e a sanitização dos logs.

### Suíte do canal

`npm test -- apps/api/test/whatsapp-admission-limits.test.ts apps/api/test/whatsapp-demo-restart.test.ts`
cobre limites reais e reduzidos, 503 sem eviction, duplicatas/status, lotes
parciais, concorrência, arredondamento do marco, logs sanitizados e reinício com
repositories reais. Verifica perda de cadastro/reserva/handoff/recibo, botão
perdido sem conversa, nova sessão vazia e avisos com transporte simulado.

`npm test -- apps/api/test/whatsapp-inbox.test.ts apps/api/test/whatsapp-inbox-webhook.test.ts`
cobre admissão/dedupe, colisões, ACK antes de modelo/envio, um turno por evento,
correção antes de clique com `ACTION_STALE` no lifecycle real, independência,
falhas antes de commit, captura de rejeições e remoção de filas. Usa Promises
controladas, webhook assinado e `ScriptedChatModel`, sem sleeps ou rede externa.

`npm test -- apps/api/test/whatsapp-conversation-bindings.test.ts apps/api/test/whatsapp-boundaries.test.ts apps/api/test/conversation-service.test.ts apps/api/test/conversation-serialization.test.ts`
cobre o vínculo, cópias defensivas, primeiras mensagens concorrentes, isolamento
por conta/número/remetente, metadados sem cadastro e separação de sessões web.
Também verifica falhas de abertura/primeiro turno e preservação de ações e recibos
de remetentes que informam o mesmo contato comercial.

`npm test -- apps/api/test/whatsapp-config.test.ts apps/api/test/whatsapp-boundaries.test.ts apps/api/test/whatsapp-webhook.test.ts apps/api/test/whatsapp-projection.test.ts apps/api/test/whatsapp-logging.test.ts`
exercita configuração/startup com sentinelas, contratos de transporte e isolamento
do frontend/core. Não lê `.env` nem exige rede. A inspeção de fontes inclui
Next config e contratos compartilhados, impedindo imports do backend e acesso ao env.

A suíte do webhook utiliza `server.inject()`, HMAC de buffers de teste e spies
sobre repositories reais para verificar ausência de efeitos. Cobre queries,
assinaturas, ordem da validação, UTF-8, corpos equivalentes com bytes diferentes,
limite exato/excedido/streaming e regressão dos dois endpoints web.
Os testes de projeção cobrem lotes completos, origem divergente, timestamps,
extensões sem autoridade, descarte isolado e tipos ignorados. As fixtures dos
testes anteriores agora usam envelope autorizado; todas as expectativas de
assinatura, bytes, limite e contratos web permanecem preservadas. Apenas o
aceite provisório de objetos sem estrutura Meta mudou de 200 para 400.

A validação da task 2.1 também executou build com segredos sentinela fornecidos
somente ao processo e inspeciona os assets de `apps/web/.next/static` para detectar
esses valores/nomes. Isso complementa o teste de dependências; não usa credenciais reais.

Registro da task 2.1 em 2026-09-30 (Node 24.21.0, npm 11.19.0, OpenSpec 1.13.1): 69 testes
novos aprovados; suíte completa com 992 testes em 42 arquivos. Typecheck, lint,
build e validação OpenSpec estrita aprovados. Os 11 assets públicos gerados pelo
build não continham as sentinelas nem os nomes de configuração Meta/WhatsApp.
Testes e startup não fizeram chamadas externas; a consulta documental utilizou
somente páginas públicas oficiais, sem chamar a Graph API.

Registro da task 2.2 em 2026-09-30: 88 testes novos do webhook; execução focada
do canal com 157 testes aprovados em 3 arquivos. Suíte completa: 1.080 testes
aprovados em 43 arquivos. Typecheck, lint, build, OpenSpec estrito e
`git diff --check` aprovados. Nenhum teste utilizou Meta, LLM ou rede externa.
Os testes da 2.1 passaram a esperar a rota somente quando enabled e a permitir
as dependências locais/Fastify/node:crypto do novo adapter; expectativas comerciais
e schemas públicos permanecem iguais.

Verificação da implementação da task 2.3 em 2026-09-30 (Node 24.21.0, npm 11.19.0):
105 testes adicionados; os 193 testes de webhook/projeção passam. A suíte completa
executada após a revisão final teve 1.184 aprovados e 1 falha em 44 arquivos:
`whatsapp-config.test.ts`, teste preexistente de logs do startup, recebeu
`spawnSync ... node EPERM`. O mesmo erro foi reproduzido num subprocesso Node
mínimo, fora da suíte. O teste não foi alterado ou enfraquecido.

`npm run typecheck`, `npm run lint`, `openspec validate whatsapp-channel-mvp --strict`
e `git diff --check` passaram. `npm run build` compilou contratos/API e o bundle
web, mas falhou na etapa TypeScript do Next com
`Could not parse output from TypeScript's --showConfig.`; executar `tsc --showConfig`
diretamente produziu JSON válido. Nenhuma configuração de build foi flexibilizada.
A task 2.3 permanece desmarcada até aprovação de todas as validações obrigatórias;
tasks posteriores não foram iniciadas. Nenhum teste chamou Meta/OpenAI reais.
