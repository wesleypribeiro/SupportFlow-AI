# Exposição HTTPS restrita ao webhook — task 2.4

[nginx.conf](nginx.conf) é uma configuração **completa de uma instância dedicada**
de Nginx com suporte SSL. Não depende da configuração global de sites. A API
continua em `127.0.0.1:3001`, o frontend em `127.0.0.1:3000` e este proxy escuta
HTTPS em `127.0.0.1:8443`. O túnel de homologação deve apontar exclusivamente para
esse proxy e validar seu certificado; não pode encaminhar diretamente às portas
da API ou do frontend. Nenhum túnel ou host público foi criado nesta task.

Somente **GET e POST no caminho exato `/webhooks/whatsapp/meta`** são encaminhados.
A query do handshake chega intacta à API. A allowlist verifica a URI original,
antes de permitir o `location` exato, rejeitando também aliases com encoding,
barras repetidas, segmentos `..`, subcaminhos e barra final. `/api/chat`,
`/api/chat/confirm`, `/health` e qualquer outro caminho recebem 403 sem chegar
ao backend. Outros métodos são negados (403 ou 405 do próprio Nginx).

O limite de corpo é 1 MiB. O proxy preserva bytes do corpo e
`X-Hub-Signature-256`; a API continua responsável por HMAC, token e projeção.
Não há retries automáticos no proxy. Authorization, Cookie e X-Request-ID do
visitante não são encaminhados. Isso não introduz autenticação nem modifica os
contratos web. `WHATSAPP_DEMO_RECIPIENTS` continua obrigatório ao habilitar o
canal, mas a aplicação dessa allowlist aos eventos pertence às próximas tasks.
Este estágio ainda não é uma demonstração conversacional utilizável.

## Logs

O access log contém somente `code`, `status` e `duration`. Não usa request line,
URI, query, headers, IP, corpo, nome/contato ou referência interativa. O error log
nativo do Nginx pode incluir dados de requisição e não oferece sanitização por
campo; nesta instância ele é descartado em `/dev/null`. Falhas do upstream
continuam observáveis pelo status 502/504 no access log, sem detalhes brutos.
Não habilitar debug, `combined` ou um segundo access/error log nessa instância.
O serviço de túnel também deve desabilitar captura/inspeção de requests e logs
de URL/query/body; a configuração local não controla os logs de terceiros.

Na API, serializers e tratamento de erro ficam encapsulados no canal. Logs usam
códigos/contagens locais, status, duração e `reqId` aleatório gerado no backend.
Não registrar a configuração, o evento normalizado, o objeto de erro original
ou `error.message` como texto de log. O logger da aplicação continua desabilitado
por padrão; os testes habilitam o Pino real para provar a sanitização.

## Preparação local do proxy

Requisitos: Nginx compilado com SSL, Node.js 24 e OpenSSL. Use um diretório de
runtime privado **fora do repositório** contendo `certificate.pem`,
`private-key.pem`, `logs/`, `body-temp/`, `proxy-temp/`, `fastcgi-temp/`,
`uwsgi-temp/` e `scgi-temp/`; restrinja seu acesso ao
usuário que executará o processo. O certificado deve corresponder ao hostname
utilizado pelo túnel para chegar ao proxy. Não versionar certificados privados,
credenciais ou logs. Mantenha HOST da API em `127.0.0.1`. A cópia de `nginx.conf`
deve ficar nesse mesmo diretório para resolver os caminhos dos certificados.

No Fedora, o Nginx pode tentar utilizar diretórios temporários do sistema, como 
/var/lib/nginx/tmp/fastcgi, causando erros de permissão. Por isso, todos os 
diretórios temporários utilizados pelo proxy são configurados dentro do 
diretório privado de runtime. Dessa forma, o serviço pode ser executado sem 
sudo e sem alterar as permissões dos diretórios do sistema.

Na raiz do repositório, substitua o caminho ilustrativo pelo diretório preparado:

```bash
WHATSAPP_PROXY_RUNTIME=/caminho/privado/whatsapp-proxy
cp deploy/whatsapp/nginx.conf "$WHATSAPP_PROXY_RUNTIME/nginx.conf"
nginx -p "$WHATSAPP_PROXY_RUNTIME/" -c "$WHATSAPP_PROXY_RUNTIME/nginx.conf" -e /dev/null -t
nginx -p "$WHATSAPP_PROXY_RUNTIME/" -c "$WHATSAPP_PROXY_RUNTIME/nginx.conf" -e /dev/null -g 'daemon off;'
```

Após copiar a configuração, `-t` a verifica e o último comando inicia somente
o proxy local em primeiro plano. Não adicionar `include` de sites, redirects HTTP,
`location` adicionais ou outro upstream. Habilitar conta Meta, publicar o túnel
e validar a superfície externa permanecem parte da homologação futura.

## Verificador local, sem credenciais

Na raiz:

```bash
node deploy/whatsapp/verify-proxy.mjs
```

`NGINX_BIN` pode indicar o executável caso não esteja no PATH. O script cria uma
chave/certificado descartáveis em diretório temporário, executa `nginx -t` e usa
**a configuração versionada**, alterando somente as duas portas locais para
portas livres. Inicia Nginx real e um upstream local que responde 200 a qualquer
caminho: assim um 403 não pode ser atribuído à aplicação. O certificado gerado
é confiado explicitamente apenas pelo cliente do ensaio, sem desligar TLS.

Verifica GET/challenge/query, POST/bytes/assinatura, 30 combinações de caminhos e
métodos proibidos, ausência dessas requisições no upstream, 502 após encerrar o
upstream e ausência de sentinelas nos logs. Encerra os processos e remove o
diretório temporário inclusive em falha. Não lê `.env`, não inicia negócios e
não usa Meta, OpenAI, conta, certificado real ou rede externa.

Esse teste de infraestrutura é separado da suíte Vitest para não torná-la
dependente de Nginx/OpenSSL/sockets. Saída diferente de zero significa que a
validação **não foi concluída**; testes de logger ou inspeção do arquivo não
substituem a execução do proxy. Tampouco esse ensaio substitui a homologação
externa da task 7.4.

A validação inicial no sandbox não pôde ser concluída devido à ausência do Nginx (`ENOENT`) e às restrições de abertura de sockets (`EPERM`).

Em 05/10/2026, o verificador foi executado com sucesso em ambiente local Fedora,
sem `sudo`. Foi necessário configurar os diretórios temporários do Nginx dentro
do runtime isolado para evitar erros de permissão.

O teste confirmou a preservação das requisições GET/POST, o bloqueio de 30
acessos não autorizados, o retorno HTTP 502 diante da indisponibilidade do
upstream e a sanitização dos logs.

Resultado:`Proxy HTTPS validado: GET/POST preservados, 30 acessos negados, falha 502 e logs sanitizados.`
Nenhuma aprovação dessa validação é alegada.

Referências primárias consultadas em 2026-10-05: [location e URI normalizada](https://nginx.org/en/docs/http/ngx_http_core_module.html#location),
[proxy_pass e preservação da URI](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass),
[log_format](https://nginx.org/en/docs/http/ngx_http_log_module.html#log_format) e
[configuração SSL](https://nginx.org/en/docs/http/ngx_http_ssl_module.html).
