# Verificação técnica — whatsapp-channel-mvp, task 7.2

**Data:** 19/10/2026, America/Sao_Paulo.
**Base auditada:** `5bf10ed`, working tree inicialmente limpo.
**Estado:** task 7.2 concluída, com validações globais aprovadas no CI e
validação OpenSpec estrita aprovada localmente. Este ajuste documental registra
os resultados informados na revisão; não reexecuta esses comandos.

Escopo autorizado: somente 7.2, conforme proposal, design, tasks, seis delta
specs e seis specs consolidadas locais. Foram acrescentados três casos de
isolamento arquitetural em `whatsapp-boundaries.test.ts`. Nenhum código de
produção, contrato, fixture, dependência ou expectativa comercial foi alterado.
As tasks 7.3/7.4 não foram iniciadas; não houve commit, push, merge, rebase ou archive.

## Ambiente

| Item | Valor observado |
| --- | --- |
| Sistema | Fedora Linux 43 Workstation, Linux x86_64 |
| Node.js / npm | `v24.21.0` / `11.19.0`; atendem aos engines do repositório |
| OpenSpec | `1.13.1`, schema `spec-driven`; na inspeção inicial, change `ready` e 19/22 tasks marcadas |
| TypeScript / Vitest / ESLint | `5.9.3` / `5.0.1` / `9.39.5` |
| Fastify / Next.js / React / Zod | `5.12.5` / `16.3.5` / `19.3.0` / `4.6.5` |
| LangChain | `@langchain/core` `1.2.12`; `@langchain/openai` `1.5.13` |
| Workspaces | contracts, API e web; `npm ls --workspaces --include-workspace-root --depth=0` terminou com código 0 |

Não houve instalação ou atualização de pacotes. A verificação cobre o checkout
e as dependências instaladas, não uma instalação limpa.

## Execução focada no sandbox

Comando executado na raiz, às 09:22:42, com duração Vitest de 8,33 segundos:

```bash
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 TZ=America/Sao_Paulo CI=1 \
  NEXT_TELEMETRY_DISABLED=1 LANGCHAIN_TRACING_V2=false LANGSMITH_TRACING=false \
  npm_config_offline=true unshare --user --map-root-user --net \
  npm test -- apps/api/test/whatsapp- \
  apps/api/test/conversation-service.test.ts \
  apps/api/test/conversation-serialization.test.ts \
  apps/api/test/chat-openai.test.ts apps/api/test/foundation.test.ts \
  apps/web/src/app --reporter=default --reporter=json \
  --outputFile=/tmp/supportflow-whatsapp-7.2-focused.json
```

O `pretest` compilou somente os contratos com sucesso. O comando focado terminou
com **código 1: 827 testes aprovados e 1 falha, em 28 arquivos (27 aprovados)**,
sem testes pendentes. Não equivale à execução global de `npm test`.

| Grupo executado | Resultado |
| --- | --- |
| Canal: 20 arquivos `whatsapp-*.test.ts` | 710 aprovados / 711 casos; falha descrita abaixo |
| Novos casos de isolamento, dentro de `whatsapp-boundaries.test.ts` | 3 aprovados; arquivo completo com 13 aprovados |
| Jornada integrada 7.1, dentro do grupo do canal | 22 aprovados, com webhook assinado, motor e repositories reais |
| Serviço compartilhado e serialização | 46 aprovados em 2 arquivos |
| Fundação/startup sem credenciais | 11 aprovados |
| SDK OpenAI com transporte simulado | 1 aprovado, três requests capturados pelo fetch injetado |
| Frontend | 59 aprovados em 4 arquivos: chat 21, lead 15, trial-class 15, handoff 8 |

A única falha foi em `whatsapp-config.test.ts`, caso
`logs reais do startup inválido não contêm segredos nem snapshot de configuração`:
o `spawnSync` retornou `EPERM` ao iniciar Node com `--import tsx src/main.ts`.
Um subprocesso mínimo, fora do Vitest e sem `unshare`, também retornou
`error.code: EPERM` com `spawnSync(process.execPath, ['-e', 'process.exit(0)'])`.
Isso evidencia uma limitação do sandbox focado; o teste permanece intacto.
Não foi removido, ignorado ou convertido em sucesso nessa execução. Essa
limitação não representa falha da suíte global: o `npm test` completo passou
posteriormente no CI, com 1.646 testes aprovados em 60 arquivos.

Outras verificações locais:

- `node node_modules/eslint/bin/eslint.js apps/api/test/whatsapp-boundaries.test.ts`:
  código 0; lint somente do arquivo alterado.
- `vitest list --json=/tmp/supportflow-whatsapp-7.2-inventory.json`, sob o mesmo
  ambiente mínimo e namespace sem rede: código 0; **60 arquivos descobertos**
  (53 API, 3 contratos, 4 web). Coleta não executa casos e não fornece aqui uma
  contagem global de testes aprovados.
- `git diff --check`: aprovado após a correção documental, código 0, sem saída.

Os JSONs em `/tmp` são evidências temporárias. As contagens e a falha relevantes
estão preservadas neste documento, sem incorporar logs brutos ao repositório.

## Validação global

Resultados efetivamente obtidos e informados na revisão da task 7.2. Os checks
globais foram aprovados no CI; a validação OpenSpec foi executada localmente.
Esses resultados complementam a execução focada no sandbox descrita acima.

| Comando / job | Resultado registrado |
| --- | --- |
| `npm test` | Aprovado no CI: 60 arquivos de teste e 1.646 testes aprovados |
| `npm run typecheck` | Aprovado no CI |
| `npm run lint` | Aprovado no CI |
| `npm run build` | Aprovado no CI |
| `openspec validate whatsapp-channel-mvp --strict` | Executado localmente e aprovado: `Change 'whatsapp-channel-mvp' is valid` |
| Job `proxy` | Aprovado no CI |
| `git diff --check` | Aprovado após a correção documental, código 0, sem saída |

A task 7.2 está concluída. Esta correção altera somente o relatório, sem modificar
checkboxes de tasks ou antecipar as tasks 7.3/7.4.

## Ausência de serviços reais

A seleção focada e a coleta ocorreram em namespace Linux de rede novo, criado
por `unshare --user --map-root-user --net`, sem acesso à rede externa. `env -i`
herdou somente PATH/HOME; credenciais e configurações de provedores do processo
chamador não foram propagadas. Tracing LangChain/LangSmith e telemetria Next
foram desabilitados, e npm operou em modo offline.

A configuração Vitest inclui API, contratos e os quatro arquivos web. `npm test`
executa build de contratos e Vitest; não invoca `dev`/`start` nem o carregamento
de `.env` desses scripts. Nenhum arquivo `.env` local foi lido, copiado ou alterado
pela auditoria. A inspeção da suíte confirma as seguintes fronteiras:

- Jornadas usam `ScriptedChatModel`, clock fixo `2030-06-10T12:00:00Z`, fixtures,
  schemas, lifecycle e repositories reais em memória. Spies da jornada observam
  as escritas, sem fabricar retornos comerciais.
- Webhooks usam `server.inject()` e HMAC com segredos fictícios. A jornada 7.1
  percorre também o cliente Cloud API real com `fetch` injetado e simulado;
  não envia requests à Meta. Os testes do transporte verificam rejeição,
  timeout, resposta inválida e sanitização com Promises/timers controlados.
- `chat-openai.test.ts` mantém `ChatOpenAI`, chave fictícia e
  `configuration.fetch` simulado; preserva as assertions de tool calling,
  structured output e associação de mensagens, além do bloqueio do fetch global.
- Os quatro testes web mantêm jsdom/Testing Library e fetch simulado.
  Os testes de jornada/SDK verificam que o fetch externo não foi chamado.

Nenhuma chamada real/paga à Meta, OpenAI, LangSmith, banco ou calendário ocorreu
na seleção executada. A suíte global foi aprovada no CI, conforme registrado acima.
Não houve homologação com conta/número Meta, túnel ou modelo real.

## Auditoria de isolamento e segredos

| Fronteira | Evidência e resultado local |
| --- | --- |
| Core reutilizável | Novo teste percorre imports do serviço e demais componentes reutilizáveis, impedindo dependência dos adapters `chat-route.ts`/`server.ts`, Fastify, UI ou módulo escolar. Os adapters HTTP continuam permitidos em seus próprios arquivos. |
| Domínio/aplicação escolar | Dois novos casos verificam direção dos imports: domínio usa domínio/contratos/Zod; aplicação usa aplicação/domínio/contratos/Zod, sem infraestrutura, canal ou frameworks. |
| Canal e apresentação | Testes existentes verificam dependências internas do canal, import somente de tipos do serviço e apresentador sem acesso a repositories, escrita ou I/O. A composição permanece em `app.ts`; o canal chama o serviço diretamente. |
| Web e contratos | Teste de fronteiras inclui `next.config.ts`: sem imports da API, acesso a env ou nomes de configuração Meta/WhatsApp. Nenhum contrato HTTP ou teste web/SDK foi alterado. |
| Identidade e consentimento | Testes de vínculo/referências, inbox, execução e jornada passaram: troca de conta/número/remetente/referência/messageId recusada; perfil não preenche cadastro; sessões web separadas; título/“sim” não autorizam escrita. |
| Concorrência e recibos | Serviço, serialização, outbox, status e jornada passaram: ordem por conversa, independência entre remetentes, reserva atômica, recibos históricos e reenvio sem nova escrita. |
| Logs e erros | 17 testes com Pino real passaram: query, tokens, headers, corpo, contatos, referências, stack/cause e requestId externo não são publicados. Os 97 testes do cliente Cloud API também passaram. O EPERM do subprocesso de startup ficou restrito à execução focada no sandbox; a suíte global completa passou no CI. |
| Exposição | Inspeção de `deploy/whatsapp/nginx.conf`: GET/POST no caminho exato do webhook, outros caminhos negados, logs limitados e upstream local. O job `proxy` foi aprovado no CI. Isso não equivale à homologação da superfície HTTPS externa, não realizada nesta auditoria. |

Varredura local do conteúdo de **183 arquivos textuais rastreados**, sem ler
arquivos de ambiente sensíveis, não encontrou padrões reconhecíveis de chaves
privadas, tokens OpenAI/Meta/GitHub ou access key IDs AWS. A saída da inspeção
limitou-se a contagens/categorias e caminhos, nunca valores. Não há `.env`
sensível rastreado; `apps/api/.env.example` é o único template de ambiente
rastreado. `git check-ignore` confirmou proteção de `.env`, `.env.local`,
`node_modules`, `.next`, `dist` e `coverage`, mantendo o template versionável.
Isso é uma varredura por padrões, não uma prova universal de ausência de segredos.

Os **11 assets públicos já existentes** em `apps/web/.next/static` foram
inspecionados por nomes de configuração de provedores, sentinelas fictícias,
classes de repositories e os padrões de segredos acima, sem ocorrências.
São artefatos anteriores: **não representam o bundle do build da 7.2 aprovado
no CI**. Não há registro de uma varredura adicional do bundle gerado nesse build.

`openspec/` continua ignorado pela regra local, inclusive `tasks.md`, apesar das
exceções posteriores no `.gitignore`. Seus artefatos foram respeitados como
autoridade e não foram alterados. Este registro fica junto do canal para ser
versionável sem modificar a política de ignore ou o histórico OpenSpec.

**Limites do registro:** o EPERM permanece documentado como restrição do sandbox
focado, sem invalidar a aprovação global no CI. A inspeção de assets descrita
acima não cobre o bundle recém-gerado no CI. `git diff --check`: aprovado após
a correção documental, código 0, sem saída. A auditoria não autoriza operação comercial nem
substitui as tasks futuras de documentação e homologação manual.
