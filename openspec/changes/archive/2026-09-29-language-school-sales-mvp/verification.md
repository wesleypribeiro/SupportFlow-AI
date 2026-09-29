# Verificação técnica — task 7.2

**Data:** 29/09/2026, execução dos cinco comandos entre 13:45 e 13:46 (America/Sao_Paulo).  
**Escopo:** auditoria do MVP existente; nenhuma funcionalidade, contrato ou teste alterado.  
**Revisão auditada:** `54889e5` (`feat(language-school): add journey script and corresponding test cases for API interactions`). Worktree inicialmente limpo.

## Ambiente e dependências instaladas

| Item | Verificado |
| --- | --- |
| Node.js | `v24.21.0`; atende `>=24 <25` |
| npm | `11.19.0`; atende `>=11 <12` |
| Sistema | Fedora Linux 43 Workstation, x86_64, kernel `7.2.6-100.fc43.x86_64` |
| OpenSpec | `1.13.1`, schema `spec-driven` |
| Ferramentas principais | TypeScript 5.9.3, Vitest 5.0.1, Fastify 5.12.5, Next.js 16.3.5, React 19.3.0, Zod 4.6.5 |
| Integração IA | `@langchain/core` 1.2.12 e `@langchain/openai` 1.5.13 |
| Workspaces | `@supportflow/contracts`, `@supportflow/api` e `@supportflow/web`, com vínculos locais corretos |

`npm ls --workspaces --include-workspace-root --depth=0` e `npm ls --all --json` terminaram com código 0, sem dependências ausentes, inválidas ou problemas reportados. O lockfile v3 corresponde aos manifests da raiz e dos três workspaces em versões, dependências, devDependencies, engines e workspaces. Nenhuma versão ou dependência foi modificada; não foi realizada reinstalação limpa.

## Comandos completos na raiz

| Comando | Saída | Resultado |
| --- | --- | --- |
| `npm test` | 0 | **882 testes aprovados, 39 arquivos aprovados**, nenhuma falha ou teste removido. Inclui os 11 testes da jornada 7.1. |
| `npm run typecheck` | 0 | Contratos, API e frontend aprovados; geração dos tipos de rotas Next.js concluída. |
| `npm run lint` | 0 | API, contratos, configuração Vitest e frontend aprovados. |
| `npm run build` | 0 | Contratos e API compilados; build otimizado Next.js concluído, páginas `/` e `/_not-found` pré-renderizadas. |
| `openspec validate language-school-sales-mvp --strict` | 0 | `Change 'language-school-sales-mvp' is valid`. |

Todos foram executados integralmente, sem seleção de arquivos. A contagem permanece igual à homologação 7.1. Não houve warnings de compilação, lint ou validação. O Vitest apresentou apenas uma sugestão de desempenho para reutilizar workers com `isolate: false`; a configuração de isolamento foi preservada.

Os logs desta execução estão em `/tmp/supportflow-7.2-audit/{test,typecheck,lint,build,openspec}.log`, com comandos, códigos de saída e tempos em `results.json`. São evidências temporárias; este documento registra os resultados duráveis dentro da change.

## Execução sem credenciais e serviços externos

Os cinco comandos rodaram em namespaces Linux de rede isolados, usando `unshare --user --map-root-user --net <comando>`, sem interfaces/rotas para serviços externos. O processo recebeu ambiente mínimo: somente `PATH`, `HOME` e `TMPDIR` quando existente foram herdados; foram definidos locale, fuso, CI, modo offline do npm e flags que desabilitam telemetria Next.js e tracing LangChain/LangSmith. Nenhuma variável de credencial de provedor foi herdada.

- Não houve chamada real à OpenAI, LangSmith, calendário, banco, WhatsApp ou outro serviço externo; nenhuma chamada paga foi feita.
- `ScriptedChatModel` substitui `_generate`, preservando `invoke`, `bindTools`, parser de structured output e mensagens reais do LangChain. As jornadas usam Fastify `server.inject()`, schemas, casos de uso e repositories reais em memória. Dublês pontuais de falha dos testes unitários não substituem a jornada integrada.
- `apps/api/test/chat-openai.test.ts` foi preservado e passou: instancia o SDK com chave fictícia e `configuration.fetch` simulado, verifica as três etapas e a associação de ToolMessage; o fetch externo é bloqueado e sua ausência de chamadas é assertada.
- Os testes de fundação verificam inicialização e healthcheck sem credenciais, além de `CHAT_ERROR` controlado para chat sem modelo.
- `npm test` executa somente o build de contratos e Vitest. Não executa os scripts `dev`/`start` que carregam `apps/api/.env`. Não há `.env` na raiz ou no frontend; o arquivo local da API não foi lido nem modificado pela auditoria.

## Isolamento arquitetural

Inspeção dos imports/exports estáticos com o parser TypeScript em **55 arquivos de produção**, complementada pela leitura da composição, adapters, casos de uso, repositories, lifecycle e transporte. Não foram encontradas dependências invertidas.

| Camada | Arquivos | Dependências e conclusão |
| --- | ---: | --- |
| `core` | 6 | LangChain, Fastify, Zod, `node:crypto`, contratos genéricos de chat e arquivos do próprio core. Recebe contexto, tools, validadores e executores pela composição; não importa o módulo escolar nem implementa regras de lead, curso, reserva ou handoff. |
| `domain` | 7 | Contratos, Zod e próprio domínio. Define interfaces de repository e validações determinísticas; não importa Fastify, React, OpenAI, LangChain ou infraestrutura. |
| `application` | 7 | Contratos, Zod, domínio e outros casos de uso. Recebe interfaces de repository e clock; não instancia repositórios concretos nem importa HTTP, LangChain ou UI. |
| `infrastructure` | 20 | Implementa as quatro interfaces de repository; contém fixtures, adapters LangChain/tools e executores de confirmação. Depende das camadas internas e dos pontos genéricos do core; a direção inversa não existe. |
| `packages/contracts/src` | 7 | Somente Zod e arquivos do próprio pacote. Tipos derivados dos schemas; não importa código das aplicações. |
| `apps/web/src` | 8 | React, Next.js, contratos públicos e componentes/helpers locais. Usa apenas `/api/chat` e `/api/chat/confirm`; não importa repositories, casos de uso ou SDK de LLM. |

A instanciação concreta permanece em `apps/api/src/app.ts`; `main.ts` inicializa o processo. O dispatcher escolar de confirmações permanece no módulo, não no core. `next.config.ts` contém somente os rewrites locais para Fastify. TypeScript strict permanece habilitado na configuração base.

## Invariantes confirmadas pela suíte existente

Todos os cenários abaixo passaram; não foram duplicados testes da 7.1. Os arquivos API citados estão em `apps/api/test/`, salvo indicação contrária.

| Invariante | Evidência existente |
| --- | --- |
| 1. Fatos comerciais vêm de registros oficiais | `language-school-journey.test.ts`, `language-school/catalog-tools.test.ts`; preço oficial preservado diante de prosa divergente. |
| 2. Prosa não autoriza operações | `chat-lead.test.ts`, `chat-trial-class.test.ts`, `chat-handoff.test.ts`; texto “Sim”, campos extras e calls sem intenção não autorizam escritas. Testes frontend verificam apresentação derivada de results. |
| 3. Escrita de cadastro exige confirmação | `lead-confirmation.test.ts`, `lead-policy.test.ts`, jornada integrada; prévia sem lead salvo, confirmação somente por IDs. |
| 4. Reserva exige confirmação específica | `trial-class-proposal.test.ts`, `chat-confirmation.test.ts`; cadastro não autoriza aula e `confirmed: true` é rejeitado. |
| 5. Ação antiga não grava dados novos/antigos indevidamente | Jornada integrada e `chat-trial-class.test.ts`; correções incrementam revisão, prévias antigas retornam 409. |
| 6. Uma única reserva por slot | `language-school/slot-reservation.test.ts`, `trial-class-confirmation.test.ts`, jornada com duas conversas; um created e um SLOT_UNAVAILABLE. Check e inserção ocorrem sem await dentro de `reserveSlot`. |
| 7. Retry devolve recibo histórico | `chat-confirmation.test.ts` e jornada; mesmo actionId preserva created ou SLOT_UNAVAILABLE, inclusive após perda da resposta e mudanças posteriores. |
| 8. Reserva concluída permanece snapshot | Jornada integrada e `chat-trial-class.test.ts`; contato, objetivo, curso, horário e update confirmado de lead não alteram o booking. |
| 9. Handoff não exige cadastro | `handoff-composition.test.ts`, `chat-handoff.test.ts` e jornada; sem criação automática de lead/reserva. |
| 10. Handoff não inicia atendimento humano | Apresentação determinística em `handoff-reply.ts`; `chat-handoff.test.ts` e `apps/web/src/app/chat-handoff.test.tsx` verificam protocolo oficial, requested e aviso local. |
| 11. Redação falha sem perder escrita concluída | Jornada e `chat-trial-class.test.ts`/`chat-handoff.test.ts`; HTTP 200, resultado oficial, contingência e retry sem duplicação. |
| 12. Isolamento entre conversas | `chat.test.ts`, `chat-context.test.ts`, `chat-confirmation.test.ts`, testes dos repositories e jornada concorrente; dados próprios e ações estrangeiras recusadas sem exposição. |

## Segurança e empacotamento

- `.gitignore` ignora `.env` e `.env.*` em todos os workspaces, excetuando `.env.example`; somente `apps/api/.env.example` é versionado entre arquivos de ambiente. Nenhuma configuração local foi alterada.
- Nenhuma referência a credenciais/configuração LLM foi encontrada no código do frontend. Os **10 chunks JavaScript** gerados em `apps/web/.next/static` também foram inspecionados: sem nomes de configuração LLM, tokens reconhecíveis ou implementações dos repositories de backend.
- Fixtures inspecionadas contêm escola/cursos fictícios e contatos demonstrativos. A varredura por padrões de tokens e chaves privadas no conteúdo versionado não encontrou indícios; nenhum valor de credencial foi impresso. Essa inspeção não equivale a uma prova universal de ausência de segredos.
- Logs de inicialização mostram apenas endereço local ou mensagens fixas. Erros públicos são controlados; exceções, stack traces e configuração do modelo não são serializados como resposta. Os testes de falhas e de configuração passaram.
- Na auditoria 7.2, `openspec/` era ignorado pelo `.gitignore`; este relatório e a marcação de tarefa não apareciam automaticamente em `git status`. A política não foi alterada naquela etapa. A correção documental da 7.3 está registrada no complemento abaixo.

## Problemas, correções e limites

**Nenhuma falha de teste, compilação, tipagem, lint, dependência invertida ou bug objetivo foi encontrada.** Não foram necessárias correções de código nem novos testes. Contratos públicos, dependências, versões e a change `supportflow-ai-mvp` permanecem intactos.

A auditoria cobre a árvore instalada e o lockfile, não uma instalação limpa em outra máquina. A memória e a atomicidade são locais a um processo; reinício perde estado, IDs não constituem autenticação e não há integração externa. O modelo simulado demonstra as invariantes determinísticas, não a qualidade ou infalibilidade da interpretação/prosa de uma LLM real. Referências linguísticas de horário continuam conservadoras, conforme hardening aprovado.

**Conclusão:** task 7.2 aprovada pelas verificações técnicas. Somente 7.2 foi marcada nesta etapa; 7.3 não foi iniciada e a change não foi arquivada. Este registro não substitui a documentação de uso da task 7.3.

## Complemento — documentação e validação final da task 7.3

**Data:** 29/09/2026, comandos completos executados entre 14:10:06 e 14:10:42 (America/Sao_Paulo), no mesmo ambiente validado acima. Nenhuma funcionalidade, contrato, fixture, dependência ou teste foi alterado.

Os quatro READMEs foram revisados: raiz (instalação/operação/jornada), frontend (estado e apresentação), módulo escolar (camadas e invariantes) e contratos (schemas e fronteiras). Foram removidas descrições antigas de conjunto parcial de tools, `pendingAction` sempre nulo, execução de reserva/handoff ainda futura e confirmação sem qualquer redação de LLM. Agora distinguem execução determinística da confirmação e redação opcional posterior da reserva, incluindo a exceção de apresentação controlada de erro do handoff.

A documentação separa a confirmação de cadastro como decisão de UX da autorização obrigatória de reserva. Explicita memória volátil, agenda fixa de junho de 2030, preço nulo versus zero, protocolos locais, recibos históricos e limites probabilísticos. Inclui avaliação manual opcional com modelo real e custos possíveis; WhatsApp consta somente como futura change independente.

| Validação da 7.3 | Resultado |
| --- | --- |
| `npm test` | Código 0; **882 testes / 39 arquivos aprovados** |
| `npm run typecheck` | Código 0; três workspaces aprovados |
| `npm run lint` | Código 0 |
| `npm run build` | Código 0; contratos/API/Next.js compilados |
| `openspec validate language-school-sales-mvp --strict` | Código 0; change válida |
| Links locais dos quatro READMEs | 70 destinos/âncoras conferidos, sem link quebrado |
| Exemplos e tabelas | 3 exemplos JSON e 1 corpo de curl validados pelos schemas; 7 tools, 4 cursos e 6 slots conferidos contra o código |
| Comandos e URLs | Scripts/engines conferidos nos manifests; endereços e rewrites conferidos na configuração, healthcheck coberto pela suíte |
| `git diff --check` | Sem erros de whitespace |

Os cinco comandos rodaram novamente em namespaces Linux sem acesso à rede externa, com ambiente mínimo sem credenciais herdadas, tracing/telemetria desabilitados e npm offline. Não foi feita chamada real/paga ao modelo. Logs temporários: `/tmp/supportflow-7.3-validation/`. O aviso de desempenho dos workers do Vitest não exigiu mudança; não houve falhas ou warnings de compilação/lint. Não foram executados `npm ci` ou instalação global durante esta revisão; esses comandos foram documentados, sem reinstalar o ambiente auditado.

### Investigação e ajuste do ignore

Antes do ajuste, `git check-ignore -v openspec/changes/language-school-sales-mvp/tasks.md` apontou **`.gitignore:27:openspec/`**. `git ls-files openspec` estava vazio, e `git status --short` não mostrava os artefatos. A regra responsável era do projeto; `core.excludesfile` não estava configurado e `.git/info/exclude` continha somente comentários.

A correção mínima substituiu o bloqueio integral por regras restritas:

```gitignore
/openspec/*
!/openspec/changes/
/openspec/changes/*
!/openspec/changes/language-school-sales-mvp/
```

Os **11 arquivos existentes** da change ativa, incluindo `.openspec.yaml`, proposta, design, seis specs, tarefas e este relatório, passaram a aparecer como não rastreados/versionáveis. Nenhum foi adicionado ao index e nenhum commit foi feito. O restante de OpenSpec continua ignorado; os arquivos da change antiga `supportflow-ai-mvp` foram comparados por hash e permanecem intactos.

As exceções liberam diretórios, sem sobrepor os ignores globais de arquivos sensíveis/gerados. Foram conferidos 17 caminhos representativos: `.env`, variantes/backups, `node_modules`, `.next`, `dist`, `coverage`, logs, arquivos de swap e ZIPs, inclusive dentro da change ativa; todos permanecem ignorados. `.env.example` continua versionável e sem credenciais reais. O `.env` local não foi lido, copiado ou modificado. A varredura de padrões de tokens/chaves nos documentos e artefatos agora expostos não encontrou indícios, sem imprimir valores.

**Estado final:** somente a task 7.3 foi marcada nesta revisão; **22/22 tasks concluídas**. Nenhum archive foi executado. A change aguarda revisão final do usuário antes de qualquer arquivamento.
