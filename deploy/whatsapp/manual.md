# Guia do ensaio manual WhatsApp — task 7.3

Este guia prepara a **homologação restrita da task 7.4**, que exige autorização
própria. A entrega do harness e seus testes locais não comprovam envio, entrega,
compatibilidade da conta ou acesso HTTPS real. Nenhuma execução Meta é parte de
`npm test`, `dev`, `start` ou `build`.

Use uma única instância, o número oficial de teste da Meta e participantes que
aceitaram participar. Escola, nomes, emails e reservas são fictícios. **Handoff
é somente uma solicitação registrada localmente**, com protocolo e `requested`;
não conecta uma pessoa, não cria ticket externo, não notifica equipe e não
promete prazo. O responsável deve fornecer aos participantes um contato real
para suporte ao ensaio por um meio separado, fora das fixtures e do repositório.

## Preparação segura

1. Use Node.js 24 e npm 11; execute `npm ci` na raiz. O harness usa as dependências
   de desenvolvimento, portanto precisa de `tsx`. Não execute o frontend nem a
   API normal simultaneamente na porta 3001.
2. Prepare app, WABA e número oficial de teste no painel da Meta. Confirme a
   vinculação ao app, permissões de envio/gerenciamento aplicáveis, validade do
   token e destinatários verificados/permitidos no painel. A lista local não
   substitui a autorização da Meta. Confira limites, políticas e eventuais custos
   vigentes na conta; este guia não promete gratuidade nem fixa cotas da plataforma.
3. Copie o conteúdo de [apps/api/.env.example](../../apps/api/.env.example) para
   um arquivo privado **fora do checkout**, acessível somente ao seu usuário
   (diretório `700`, arquivo `600`). Não sobrescreva arquivos existentes. Edite no
   arquivo os campos abaixo; não passe valores secretos na linha de comando,
   no chat, em screenshots ou no histórico do shell. O harness não lê `.env`
   implicitamente e não usa as credenciais OpenAI do arquivo.

| Campo privado | Valor/configuração necessária |
| --- | --- |
| `WHATSAPP_ENABLED` | Literal `true`; `false` impede o harness |
| `META_APP_SECRET` | Segredo do app para HMAC dos bytes originais do POST |
| `META_WEBHOOK_VERIFY_TOKEN` | Segredo escolhido para o handshake GET |
| `META_ACCESS_TOKEN` | Token autorizado da conta, exclusivamente Bearer backend |
| `META_WABA_ID` | ID textual da conta de teste permitida |
| `META_PHONE_NUMBER_ID` | ID textual do número empresarial de teste, não seu número discável |
| `META_GRAPH_API_VERSION` | Exatamente `v26.0`, fixada pelo adapter; sem `latest` |
| `WHATSAPP_DEMO_RECIPIENTS` | IDs de remetentes autorizados, separados por vírgula; sem itens vazios |

Os três segredos são distintos. IDs permanecem strings opacas. Números/IDs reais
necessários ao transporte ficam somente na configuração privada; **não são
copiados para o contato comercial do lead**. Use `ana@example.com` e
`bruno@example.com` no diálogo. Nunca crie variáveis `NEXT_PUBLIC_*` para segredos.
Não imprima o arquivo, `process.env`, configuração, payloads ou exceções brutas.

## Harness isolado e relógios

Na raiz, este comando imprime orientação e termina sem socket, arquivo de
credenciais ou transporte ativo, mesmo com variáveis Meta no ambiente:

```bash
npm run whatsapp:manual
```

Somente na execução da 7.4 autorizada, com arquivo privado preparado, use o
comando explícito abaixo. O caminho é ilustrativo, não uma credencial:

```bash
npm run whatsapp:manual -- --real-meta --env-file=/caminho/privado/whatsapp.env
```

[whatsapp.ts](../../apps/api/manual/whatsapp.ts) carrega apenas esse arquivo após
validar as opções e desabilita tracing LangChain/LangSmith antes dos imports.
[whatsapp-harness.ts](../../apps/api/manual/whatsapp-harness.ts) fixa
`127.0.0.1:3001`, `school_demo` e injeta
[ScriptedChatModel](../../apps/api/test/helpers/scripted-chat-model.ts) na mesma
`createApplication` usada pela API. Não há segunda implementação de negócio:
webhook/HMAC, inbox, contexto, tools, lifecycle, repositories, apresentador e
outbox são reais. Somente a geração segue o
[roteiro exato](../../apps/api/manual/whatsapp-model.ts), sem OpenAI ou avaliação
de linguagem natural. O transporte é o cliente Cloud API existente com `fetch`
real; **pode enviar mensagens e gerar custos** depois que os eventos chegarem.

O clock comercial fica em **`2030-06-10T12:00:00Z`**, preservando as fixtures de
junho de 2030. O clock do canal usa **hora real** para marco de início,
timestamps, buffer de status e janela. Não altere o relógio da máquina, fixtures
ou timestamps Meta para acomodar o teste. A sincronização da máquina importa:
o canal não admite timestamps futuros e arredonda o marco inicial para o próximo
segundo; envie a primeira mensagem depois do banner de inicialização.

O harness fica em `apps/api/manual/`, incluído no typecheck e lint, excluído do
build de produção. Não muda `src/main.ts`, os contratos web ou os comandos
normais de execução. O fallback do modelo é sem estado por participante: os
IDs vêm do contexto oficial de cada conversa; não há fila global de respostas
compartilhada entre Ana e Bruno.

## HTTPS: somente a rota pública do webhook

Prepare o [proxy Nginx dedicado](README.md) e seu certificado antes do túnel.
Execute localmente `node deploy/whatsapp/verify-proxy.mjs` com Nginx/OpenSSL
disponíveis. Esse verificador usa sockets locais e não usa Meta ou credenciais.
Ele não substitui a checagem externa abaixo.

O túnel deve chegar **somente ao proxy `127.0.0.1:8443`**, validando TLS até ele.
Nunca publique as portas 3000/3001 diretamente. Somente GET/POST no caminho
exato `/webhooks/whatsapp/meta` podem chegar ao backend. `/api/chat`,
`/api/chat/confirm`, `/health`, barra final, aliases/encoding e outros métodos
devem ser negados. As rotas web continuam locais e sem autenticação nova.
Desabilite gravação/inspeção de requisições no serviço de túnel e não use logs
`combined`, debug, query, corpo ou headers em nenhuma camada.

No painel, configure o callback HTTPS exato e o verify token privado; conclua o
handshake e a assinatura do campo **`messages`** da WABA/app correspondente.
GET válido devolve o challenge exato; POST exige `X-Hub-Signature-256` com
HMAC-SHA256 dos bytes originais usando o app secret. Não coloque tokens na URL
do callback salvo ou em exemplos de `curl`; o painel envia a query de verificação.

Na 7.4, de outra máquina/rede, substitua apenas o host `.example` pelo host do
ensaio. Estes probes não contêm credenciais e não criam conversa:

```bash
WHATSAPP_PUBLIC_ORIGIN=https://webhook.example
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$WHATSAPP_PUBLIC_ORIGIN/health"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' -H 'Content-Type: application/json' -d '{}' "$WHATSAPP_PUBLIC_ORIGIN/api/chat"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' -H 'Content-Type: application/json' -d '{}' "$WHATSAPP_PUBLIC_ORIGIN/api/chat/confirm"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "$WHATSAPP_PUBLIC_ORIGIN/webhooks/whatsapp/meta"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' -H 'Content-Type: application/json' -d '{}' "$WHATSAPP_PUBLIC_ORIGIN/webhooks/whatsapp/meta"
```

Esperado: **403, 403, 403, 400, 403**, respectivamente. Um redirect, erro de DNS/TLS
ou 502 não prova a restrição. Não use `-k` nem desligue validação de certificado.
Inspecione também métodos/aliases com o verificador e valide a mesma política
externamente. O handshake válido deve ser observado no painel, sem capturar sua
query. A allowlist de participantes continua obrigatória mesmo com HMAC válido.

## Frases exatas do roteiro

Envie as frases abaixo individualmente no WhatsApp, aguardando a apresentação.
Pontuação/caixa fazem parte do roteiro; texto desconhecido pede uma frase
documentada, sem interpretar novos dados. `/reenviar` é tratado pelo canal, sem
passar pelo modelo. Botões devem ser clicados na mensagem realmente publicada;
nunca copie IDs para o chat.

| Frase | Resultado esperado |
| --- | --- |
| `Quais cursos vocês oferecem?` | Catálogo ativo e aviso de memória/recuperação na primeira resposta |
| `Onde fica a escola?` | Dados fictícios oficiais da escola |
| `Quero inglês para viagem.` | Contexto de inglês/viagem e preço oficial |
| `Quero espanhol.` | Curso com preço não informado (`null`) |
| `Quero francês.` | Curso com preço zero; não confundir com `null` |
| `Quais horários estão disponíveis?` | Horários do curso atual com data, hora e `America/Sao_Paulo` |
| `Escolho 11/06/2030 às 10h.` | Seleção explícita A, se elegível; não reserva |
| `Escolho 12/06/2030 às 14h.` | Seleção explícita B, se elegível; invalida prévia anterior |
| `Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.` | Prévia de Ana, sem gravar lead |
| `Meu nome é Bruno. Meu email é bruno@example.com. Quero prosseguir com o cadastro.` | Prévia de Bruno na conversa do segundo participante |
| `Meu email correto é ana.novo@example.com.` | Nova prévia com contato corrigido |
| `Na verdade, quero principalmente entrevistas de emprego.` | Novo objetivo literal e prévia de cadastro/atualização |
| `Quero revisar o cadastro.` | Prévia ou resultado `existing`, conforme o estado real |
| `Quero agendar a aula.` | Prévia de reserva somente com lead vigente confirmado e horário selecionado |
| `Quero falar com alguém.` | Solicitação local com protocolo, inclusive sem lead |
| `Quero falar com uma pessoa por outra dúvida.` | Mesmo protocolo e motivo originais na mesma conversa |
| `Ofereça o registro local.` | Oferta canônica de registro local, sem escrita |
| `sim` | Não confirma cadastro/reserva; só registra handoff se houver oferta com evidência válida |

Fluxo principal: catálogo → inglês → horários → seleção A → dados de Ana →
correção do email → clique antigo recusado → **Confirmar cadastro** na nova
prévia → pedido de aula → **Confirmar aula** → recibo. Cadastro não reserva.
Para corrigir o horário antes da reserva, selecione B, peça a aula novamente,
teste o botão antigo e confirme somente a nova prévia. Para corrigir o objetivo
de um lead já salvo, confirme primeiro a atualização de cadastro.

Para disputa, dois participantes autorizados escolhem inglês e A, cadastram
Ana/Bruno nas próprias conversas e **ambos preparam a prévia de aula antes de
qualquer confirmação**. Um confirma, depois o outro: deve haver um `created`
e um `SLOT_UNAVAILABLE`. Não reinicie entre essas duas confirmações. Reinício
zera a agenda e invalida a evidência anterior.

## Falha induzida, recuperação e observação

No **terminal local do harness**, após o fim dos envios da prévia de aula, digite
`falhar` e aguarde `WHATSAPP_MANUAL_FAILURE_ARMED`. Só então clique no botão
de aula no WhatsApp. A próxima parte de saída será rejeitada **localmente antes
de chamar a Meta**, uma única vez. A reserva já decidida permanece salva. Envie
`/reenviar` no WhatsApp para recuperar o mesmo recibo; não há nova escrita nem
modelo. `falhar` não é comando WhatsApp nem endpoint HTTP. Em ensaio com várias
pessoas, pause as demais: a falha vale para a próxima parte de qualquer uma.

O terminal registra somente códigos, aliases locais (`saida-1`, etc.) e estados.
`WHATSAPP_MANUAL_SEND ... accepted` é aceite HTTP, não entrega.
`WHATSAPP_MANUAL_STATUS ... delivered/read` observa status correlacionado a um
aceite conhecido, sem expor ID ou destinatário. As linhas são eventos de chegada,
não o estado final: `read` seguido de `sent` atrasado não significa regressão.
Status que chega antes do retorno HTTP pode ser conciliado pela outbox sem linha
nesse observador; ausência de linha não prova ausência de entrega. Não invente
status para preencher o relatório; registre o que pôde ser observado e compare
com a mensagem no aplicativo, respeitando a disponibilidade de recibos de leitura.

Falha induzida não é prova de rejeição real da Meta nem reproduz timeout após
aceite. Um timeout real gera `unknown`; `/reenviar` pode duplicar apenas a
apresentação no WhatsApp. Partes `accepted`/`sent`/`delivered`/`read` são
preservadas; status `failed` pode tornar uma parte recuperável. Sem registro
elegível, o comando informa a limitação. Prévia substituída não é reenviada como
botão válido. Recibo concluído é histórico e pode também ser recuperado por novo
clique no botão original enquanto a instância existir.

Digite `sair` no terminal ou use Ctrl+C para fechar a entrada e drenar trabalho
admitido. Ao reiniciar, **todo o estado é perdido**; botão antigo não cria
conversa nem reconstrói reserva. Novo texto inicia sessão vazia. Remova o túnel
e a assinatura/configuração de callback de teste ao encerrar; trate os tokens
conforme a política da conta. Não publique este ensaio como operação comercial.

## Checklist de número de teste — a executar somente na 7.4

- [ ] Autorização registrada, operador/contato externo definidos, dois participantes permitidos e informados sobre memória, dados fictícios e custos.
- [ ] App/WABA/número de teste corretos, Graph v26.0 conferida na conta, token/permissões válidos, destinatários verificados e allowlist local mínima.
- [ ] Certificado/túnel/proxy validados, logging/captura desabilitados, provas externas de bloqueio de `/api/chat` e `/api/chat/confirm`.
- [ ] Handshake real concluído, `messages` assinado, assinatura POST preservada e remetente não permitido sem resposta.
- [ ] Catálogo/preço/horários oficiais, nome/contato fictícios e duas confirmações independentes.
- [ ] Correções de contato, objetivo e slot; “sim” sem autorização, botão stale recusado e botão concluído recuperando recibo original.
- [ ] Handoff sem/com lead, repetição com mesmo protocolo/motivo e aviso local; oferta só aceita com entrega/leitura ou resposta correlacionada.
- [ ] Dois participantes disputando uma vaga, sem misturar cadastro, referência ou recibo.
- [ ] Aceite separado de status de entrega/leitura; falha local após reserva, `/reenviar`, recibo preservado e nenhuma promessa de exactly-once.
- [ ] Reinício, botão antigo indisponível e novo texto iniciando sessão vazia; remoção do túnel/callback ao final.

Registre data, runtime, versão Graph, passos, expected/actual e impedimentos com
aliases de participantes/mensagens. Screenshots devem ocultar telefones, nomes
reais, tokens, IDs e referências interativas. Modelo de registro (não é evidência):

| Caso | Expected | Actual | Evidência expurgada/impedimento |
| --- | --- | --- | --- |
| Confirmação A | Um recibo oficial | Não executado | Preencher na 7.4 |
| Reenvio A | Mesmo recibo após falha | Não executado | Preencher na 7.4 |
| Superfície pública | Rotas web negadas | Não executado | Preencher na 7.4 |

Sem conta, credenciais, participantes ou HTTPS disponíveis, registre o impedimento
e mantenha a 7.4 pendente. Testes locais não substituem essa evidência.

## Referências e verificação documental

Arquitetura, estados, limites e volatilidade estão no [README do canal](../../apps/api/src/channels/whatsapp/README.md).
A [compatibilidade Meta](../../apps/api/src/channels/whatsapp/meta/compatibility.md)
registra as fontes e a versão fixada anteriormente.

Consulta em **2026-10-19**, sem credenciais ou chamadas Graph:

- [Política oficial do WhatsApp](https://whatsappbusiness.com/policy/) acessível:
  janela de 24 horas, templates aprovados fora dela e caminho de escalonamento.
  O MVP bloqueia envio fora da janela; templates/campanhas/follow-up não estão implementados.
- Links do workspace oficial Meta no Postman abriram: [envio de texto](https://www.postman.com/meta/whatsapp-business-platform/request/8gvd47s/send-text-message),
  [reply buttons](https://www.postman.com/meta/whatsapp-business-platform/request/ne00kt6/send-reply-button),
  [texto recebido](https://www.postman.com/meta/whatsapp-business-platform/request/cy6hnq7/received-text-message)
  e [status](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications).
  O conteúdo acessível confirma páginas/endpoints parametrizados; não revalida
  sozinho todos os corpos/limites da v26.0 ou a configuração de uma conta.
- [Sample oficial de HMAC](https://github.com/fbsamples/whatsapp-api-examples/blob/main/signature-validation-with-webhooks-payloads/app.py) acessível;
  não copiar o logging de payloads de exemplos para este ensaio.
- Páginas diretas de [texto](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages),
  [botões](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages)
  e [endpoint webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/)
  retornaram HTTP 429. O [changelog v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0/)
  não pôde ser aberto pela ferramenta. Mantida a evidência anterior, sem alegar
  nova confirmação desses conteúdos. Revalidar disponibilidade/permissões no
  painel e documentação oficial antes do ensaio real; não trocar a versão silenciosamente.
