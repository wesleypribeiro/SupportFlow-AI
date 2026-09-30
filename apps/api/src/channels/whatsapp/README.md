# Fronteira WhatsApp — task 2.1

Esta etapa disponibiliza somente configuração backend e tipos de transporte.
`createApplication(environment)` compõe `config.whatsapp`; ainda não instancia
cliente, registra rotas Meta, recebe eventos ou envia mensagens, mesmo habilitado.
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

## Verificação local

`npm test -- apps/api/test/whatsapp-config.test.ts apps/api/test/whatsapp-boundaries.test.ts`
exercita configuração/startup com sentinelas, contratos de transporte e isolamento
do frontend/core. Não lê `.env` nem exige rede. A inspeção de fontes inclui
Next config e contratos compartilhados, impedindo imports do backend e acesso ao env.

A validação desta etapa também executa build com segredos sentinela fornecidos
somente ao processo e inspeciona os assets de `apps/web/.next/static` para detectar
esses valores/nomes. Isso complementa o teste de dependências; não usa credenciais reais.

Registro em 2026-09-30 (Node 24.21.0, npm 11.19.0, OpenSpec 1.13.1): 69 testes
novos aprovados; suíte completa com 992 testes em 42 arquivos. Typecheck, lint,
build e validação OpenSpec estrita aprovados. Os 11 assets públicos gerados pelo
build não continham as sentinelas nem os nomes de configuração Meta/WhatsApp.
Testes e startup não fizeram chamadas externas; a consulta documental utilizou
somente páginas públicas oficiais, sem chamar a Graph API.
