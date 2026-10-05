# Fronteira WhatsApp — implementação incremental

Esta etapa disponibiliza configuração backend, tipos de transporte e um webhook
de validação. `createApplication(environment)` compõe `config.whatsapp` e registra
GET/POST `/webhooks/whatsapp/meta` somente quando habilitado. Desabilitado, ambos
retornam 404. Projeta eventos validados, mas ainda não os admite/processa nem envia mensagens.
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
A lista retornada é independente do env e congelada.

São exclusivamente participantes autorizados da demonstração. Isso não define
tenant, autenticação comercial, nome/contact do lead ou vínculo de conversa.
A aplicação da allowlist a eventos pertence às próximas tasks.

## Transporte interno

`WhatsAppTransport.send({ recipientId, message })` recebe texto (`type: text`,
`body`) ou mensagem de botões (`type: reply_buttons`, `body`, `buttons` com `id`
e `title`). São tipos internos readonly, sem modelos escolares, action args ou
credenciais. Não existe implementação HTTP nesta etapa.

O resultado distingue:

- `accepted`: aceite válido com `messageId`; não significa entrega ao visitante.
- `rejected`: rejeição conhecida, representada por categoria local sanitizada.
- `unknown`: timeout, erro de rede ou resposta inválida; não é seguro afirmar
  que o provedor recusou o envio. Não há garantia de exactly-once.

Limites e validação do envio serão aplicados no adapter futuro com `fetch`
injetável. Nenhum SDK Meta arquivado ou WAHA foi adicionado.

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

**O 200 atual significa validação criptográfica, de origem e projeção.** Ainda
não admite inbox, deduplica ou persiste eventos. Admissão antes do ACK pertence
ao Milestone 3. Este estágio não oferece a garantia final da spec de
recepção/processamento. Não é uma integração WhatsApp funcional.

GET/POST não recebem dependências de serviço/modelo/repos/ações/transporte, não
adquirem `runExclusive` e não criam conversa. O parser e os erros de
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
Não usa hora da reentrega, não reordena e não deduplica eventos. Marco de reinício
e avaliação temporal com clock/janela pertencem às tasks 3.3 e 6.3.

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

O webhook continua somente validando/projetando eventos. Inbox, fila de admissão,
política de reinício e conexão de texto ao motor pertencem às tasks seguintes.
Os testes de vínculo chamam o serviço real diretamente com `ScriptedChatModel`
e repositories em memória, sem implementar esses fluxos antecipadamente.

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
