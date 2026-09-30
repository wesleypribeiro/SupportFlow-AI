# Fronteira WhatsApp — tasks 2.1 e 2.2

Esta etapa disponibiliza configuração backend, tipos de transporte e um webhook
de validação. `createApplication(environment)` compõe `config.whatsapp` e registra
GET/POST `/webhooks/whatsapp/meta` somente quando habilitado. Desabilitado, ambos
retornam 404. Ainda não instancia cliente, processa eventos ou envia mensagens.
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
executa `JSON.parse`. JSON inválido, null, array ou primitivo produzem 400;
objeto JSON produz **200 vazio**. Content-Type não suportado também gera 400
vazio. O handler de erro é local: não retorna corpo recebido, query, assinatura,
segredos ou exceções, nem introduz logs desses dados.

**O 200 da task 2.2 significa apenas aceite criptográfico/formal.** Não valida
WABA/número empresarial, não projeta mensagens/status, não admite inbox, não
deduplica e não persiste eventos. A projeção pertence à 2.3; admissão antes do
ACK, ao Milestone 3. Este estágio não oferece a garantia final da spec de
recepção/processamento. Não é uma integração WhatsApp funcional.

GET/POST não recebem dependências de serviço/modelo/repos/ações/transporte, não
adquirem `runExclusive` e não criam conversa. O parser e os erros de
`/api/chat` e `/api/chat/confirm` permanecem nos seus escopos originais.
Fontes e distinção dos segredos: [compatibilidade Meta](meta/compatibility.md).

## Verificação local

`npm test -- apps/api/test/whatsapp-config.test.ts apps/api/test/whatsapp-boundaries.test.ts apps/api/test/whatsapp-webhook.test.ts`
exercita configuração/startup com sentinelas, contratos de transporte e isolamento
do frontend/core. Não lê `.env` nem exige rede. A inspeção de fontes inclui
Next config e contratos compartilhados, impedindo imports do backend e acesso ao env.

A suíte do webhook utiliza `server.inject()`, HMAC de buffers de teste e spies
sobre repositories reais para verificar ausência de efeitos. Cobre queries,
assinaturas, ordem da validação, UTF-8, corpos equivalentes com bytes diferentes,
limite exato/excedido/streaming e regressão dos dois endpoints web.

A validação desta etapa também executa build com segredos sentinela fornecidos
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
