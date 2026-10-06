# Compatibilidade Meta verificada — 2026-09-30

Versão escolhida: **Graph API v26.0**. O
[changelog oficial](https://developers.facebook.com/docs/graph-api/changelog/)
lista essa versão como disponível, lançada em 2026-07-29. O
[registro v26.0](https://developers.facebook.com/docs/graph-api/changelog/version26.0/)
confirma o lançamento. A configuração exige essa versão explícita; não usa `latest`.

As páginas primárias abaixo foram lidas diretamente em `developers.facebook.com`
por HTTP GET público, sem tokens. O navegador de pesquisa retornou 429 em algumas
tentativas; o acesso direto retornou HTTP 200 e permitiu ler as tabelas e exemplos.
Ambos os exemplos de envio consultados usam `/v26.0/.../messages`.
Não houve chamada à Graph API nem envio real ao WhatsApp.

## Limites documentados

| Campo | Limite | Fonte oficial |
| --- | ---: | --- |
| `text.body` | 4.096 caracteres | [Mensagens de texto](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages) (página atualizada em 2026-07-02) |
| `interactive.action.buttons` | 3 reply buttons | [Reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages) (página atualizada em 2026-05-21) |
| `interactive.body.text` | 1.024 caracteres | Mesma tabela de parâmetros de reply buttons |
| `reply.title` | 20 caracteres | Mesma tabela de parâmetros de reply buttons |
| `reply.id` | 256 caracteres, identificador único por botão | Mesma tabela de parâmetros de reply buttons |

Os limites provisórios do design (4.096/1.024/20) foram confirmados, sem mudança
de contrato. Esses valores ficam como evidência documental nesta task, não como
constantes ou validação de um sender ainda inexistente. A futura implementação
deverá validar a mensagem antes do envio e seguir a política de divisão Unicode
do design. A evidência documental não substitui a homologação real prevista na 7.4.

## Correlação da resposta

Na seção **Webhooks / Exemplo de webhook** da mesma página oficial de reply
buttons, `entry[].changes[].value.messages[]` contém simultaneamente:

- `type: interactive` e `interactive.type: button_reply`;
- `interactive.button_reply.id`: identificador do botão selecionado;
- `interactive.button_reply.title`: texto de apresentação;
- `context.id`: identificador da mensagem de origem;
- `id`: identificador distinto da própria mensagem recebida.

O exemplo confirma os campos necessários para o vínculo previsto em D7. A futura
resolução deve exigir `context.id` associado a uma prévia cujo envio foi aceito,
além da referência opaca em `button_reply.id` e do vínculo/remetente correto.
O título não autoriza nada. Campo ausente, referência divergente ou evento
incompleto deve ser rejeitado, não interpretado como confirmação por texto.

O exemplo de resposta ao envio também contém `messages[].id`, permitindo
registrar o ID aceito. Esse aceite não prova entrega, leitura ou execução comercial.
Nenhum schema inbound, botão funcional ou mecanismo de confirmação foi adicionado.

Referências do SDK Node arquivado no planejamento anterior são somente históricas.
A versão, os limites e a correlação acima foram verificados na documentação atual
da Meta, sem utilizar aquele SDK como autoridade ou dependência.

## Handshake e assinatura — task 2.2

Fonte primária consultada em 2026-09-30:
[Meta — criar endpoint de webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/).
Acesso direto à página pública, sem credenciais ou chamadas à Graph API.

- **GET:** `hub.mode=subscribe`, `hub.verify_token` configurado pelo desenvolvedor
  e `hub.challenge`; verificar e devolver exatamente o challenge. No projeto, a
  configuração correspondente é `META_WEBHOOK_VERIFY_TOKEN`.
- **POST:** `X-Hub-Signature-256: sha256=<digest>`; autenticar a carga com
  HMAC-SHA256 e a chave secreta do app, `META_APP_SECRET`. Os bytes originais são
  a entrada do HMAC; não usar JSON reserializado. O access token não participa.

A comparação usa `node:crypto/timingSafeEqual`, com comprimentos conferidos
antes da chamada. O [parser documentado do Fastify](https://fastify.dev/docs/latest/Reference/ContentTypeParser/)
permite encapsular `parseAs: buffer` e aplicar limite em bytes antes do callback.
O limite de 1 MiB é local. Graph v26.0 permanece fixada; o webhook não descobre
versão em rede nem depende de `latest`.

O HTTP 200 implementado na 2.2 era somente validação formal/criptográfica de objeto
JSON. A task 2.3 adiciona origem e projeção, ainda sem processamento. As garantias
finais de admissão/deduplicação da spec dependem das tasks seguintes.

## Subset de recepção — task 2.3

Consulta em 2026-09-30 aos exemplos mantidos pela Meta no workspace oficial Postman:

- [Received Text Message](https://www.postman.com/meta/whatsapp-business-platform/request/cy6hnq7/received-text-message):
  envelope com WABA, número empresarial, `messages[].from`, ID, timestamp textual
  e `text.body`; contatos/perfil ficam fora da projeção.
- [Message Status Update Notifications](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications):
  array `statuses` separado de mensagens, com ID, status, timestamp textual e
  destinatário; nenhuma ordenação de entrega é pressuposta.
- [Statuses Object](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object):
  tipos dos campos e erros externos de falha. Este MVP consome somente
  `sent`, `delivered`, `read` e `failed`; outros estados são ignorados.

Para botão, a correlação `context.id`/`button_reply.id` segue a evidência da
v26.0 registrada acima na 2.1. Nesta consulta, páginas diretas de
developers.facebook.com retornaram 429; o acesso HTTP pelo shell não resolveu
DNS. Os exemplos Postman confirmam o subset de texto/status, mas não são
homologação específica da conta/v26.0. A versão fixada permanece v26.0 e a task
manual 7.4 continua necessária; nenhuma Graph API real foi chamada.

## Cliente de envio — task 4.2 (2026-10-06)

O cliente fixa a v26.0 já verificada na 2.1 e aplica os limites acima, com
contagem conservadora em UTF-16 coerente com o apresentador. Exemplos de
[texto](https://www.postman.com/meta/whatsapp-business-platform/request/8gvd47s/send-text-message)
e [reply buttons](https://www.postman.com/meta/whatsapp-business-platform/request/ne00kt6/send-reply-button)
do workspace oficial Meta no Postman foram consultados para conferir endpoint,
Bearer, corpo interativo e resposta com `messages[].id`. Os exemplos são
parametrizados por versão; não constituem homologação da conta na v26.0.

Nesta consulta, as páginas diretas de texto, botões e erros em
developers.facebook.com retornaram HTTP 429; o acesso pelo shell não resolveu
DNS. Mantida a evidência de limites/versão registrada na 2.1. O adapter classifica
rejeições por categoria local, sem reproduzir uma tabela de códigos Meta ou
expor erros externos. Resposta não validável permanece indeterminada. Todos os
testes usam transporte simulado; nenhum envio ou Graph API real foi executado.
