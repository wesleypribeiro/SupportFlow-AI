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
