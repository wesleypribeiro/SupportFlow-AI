# AGENTS.md

## Idioma

Responda sempre em português do Brasil (pt-BR).

- Relatórios de conclusão devem ser em português.
- Explicações, análises, avisos e descrições de alterações devem ser em português.
- Mantenha nomes de arquivos, APIs, tipos, funções, variáveis, comandos, mensagens técnicas e identificadores no idioma original do código.
- Não traduza código apenas para satisfazer esta regra de idioma.
- Quando citar mensagens de erro, nomes de campos ou contratos externos, preserve o texto original quando isso for tecnicamente relevante.

## Propósito

Este repositório utiliza OpenSpec/SDD e desenvolvimento assistido por Codex.

Trate este arquivo como orientação operacional persistente para tarefas de desenvolvimento neste repositório. Mantenha o foco na implementação solicitada e use o próprio repositório como fonte de verdade.

Antes de alterar código, inspecione a implementação relevante, os testes, os READMEs e os artefatos OpenSpec disponíveis no working tree.

## Projeto

SupportFlow AI é uma aplicação Full Stack de IA conversacional.

Vertical atualmente implementada:
- escolas de idiomas

Expansão atual:
- WhatsApp como canal adicional

Stack principal:
- TypeScript
- Node.js 24
- npm 11
- Fastify
- Next.js / React
- Zod
- LangChain
- repositories em memória
- Vitest

Estrutura dos workspaces:
- `apps/api` — backend e motor conversacional
- `apps/web` — frontend
- `packages/contracts` — schemas públicos e tipos compartilhados
- `openspec` — planos e especificações SDD/OpenSpec quando presentes localmente

Documentação principal:
- `README.md`
- `apps/web/README.md`
- `apps/api/src/modules/language-school/README.md`
- `packages/contracts/README.md`

## Método de desenvolvimento

O desenvolvimento é orientado a tasks e segue OpenSpec.

Quando um prompt se referir a uma change OpenSpec:
1. Leia o `proposal.md`, `design.md`, `tasks.md` e as delta specs relevantes antes de codar.
2. Leia as specs consolidadas relevantes em `openspec/specs/` quando disponíveis.
3. Implemente somente a task explicitamente solicitada.
4. Não inicie a próxima task não marcada.
5. Não amplie o escopo apenas porque uma funcionalidade futura parece simples ou relacionada.
6. Marque somente a task solicitada como concluída depois que todos os critérios de aceite forem satisfeitos.
7. Não arquive uma change OpenSpec sem solicitação explícita.

Se `openspec/` estiver ignorado pelo Git, mas existir localmente, ele continua sendo autoridade para o fluxo SDD ativo. Não interprete "ignorado pelo Git" como "irrelevante".

## Disciplina de escopo

Prefira a menor alteração correta.

Não:
- implemente milestones futuras antecipadamente;
- crie frameworks especulativos;
- adicione abstrações não relacionadas;
- renomeie contratos públicos sem requisito explícito;
- altere semântica de negócio apenas para facilitar testes;
- mude expectativas de testes existentes apenas para acomodar uma regressão.

Se o comportamento existente conflitar com a especificação solicitada, identifique o conflito e resolva-o de acordo com o requisito atual mais específico.

## Limites arquiteturais

Mantenha o core conversacional reutilizável independente das verticais de negócio e dos provedores de comunicação.

### Core

Código em camadas reutilizáveis do core não deve depender de:
- Fastify quando o componente for destinado a ser independente de transporte;
- React / Next.js;
- Meta / WhatsApp;
- regras do domínio de escolas de idiomas;
- repositories concretos de um módulo de negócio.

### Módulo language-school

Mantenha as regras de negócio dentro das fronteiras de domain/application/infrastructure do módulo language-school.

Código de domínio e aplicação não deve depender diretamente de:
- Fastify;
- React;
- LangChain, salvo quando a arquitetura existente colocar explicitamente um adapter nessa fronteira;
- repositories concretos de infraestrutura.

### Canal WhatsApp

Mantenha comportamento específico da Meta dentro do canal WhatsApp/adapters.

Não coloque payloads da Meta, lógica de webhook, tokens ou detalhes da Graph API dentro do core conversacional reutilizável.

O canal WhatsApp deve reutilizar o motor conversacional existente, em vez de criar uma segunda implementação de chatbot.

## Invariantes de negócio

A LLM interpreta e propõe. A lógica determinística do backend valida e autoriza mudanças de estado do negócio.

Nunca trate a prosa da LLM como fonte de verdade para:
- preços;
- cursos;
- slots;
- estado de lead;
- estado de reserva;
- protocolo de handoff;
- recibos.

Results estruturados oficiais e repositories são autoritativos.

Preserve:
- uma única fonte de verdade para pending actions;
- isolamento entre conversas;
- invalidação baseada em revision;
- confirmação explícita quando exigida;
- recibos históricos;
- retries idempotentes;
- semântica atômica de reserva de slot;
- fallback determinístico após uma escrita quando a redação da resposta falhar.

Uma tool call isolada não autoriza uma escrita protegida.

Texto livre genérico, como `sim`, não deve autorizar silenciosamente uma reserva quando a arquitetura exige uma pending action específica.

## Concorrência de conversas

Operações de uma mesma conversa devem permanecer serializadas pelo mecanismo existente por conversa.

Não introduza:
- lock global para todas as conversas;
- aquisição aninhada do mesmo lock de conversa;
- uma segunda fonte independente de ordenação para a mesma operação.

Conversas diferentes devem continuar podendo progredir de forma independente.

## HTTP e contratos

Contratos HTTP públicos são definidos pelos schemas compartilhados e pelo comportamento existente das rotas.

Mantenha a validação estrita.

Não adicione campos a contratos públicos de request/response sem requisito explícito da task.

Adapters internos devem chamar os serviços compartilhados diretamente. Não chame os próprios endpoints HTTP da aplicação internamente apenas para reutilizar lógica de negócio.

## Testes

Use testes determinísticos.

Prefira:
- casos de uso reais;
- repositories reais em memória;
- `server.inject()` para integração Fastify;
- `ScriptedChatModel` para comportamento de LLM;
- transportes simulados para provedores externos;
- Promises controladas para testes de concorrência.

Evite:
- sleeps arbitrários;
- chamadas reais à OpenAI na suíte normal;
- chamadas reais à Meta na suíte normal;
- dependência de credenciais locais;
- mocks que eliminem justamente o comportamento que deveria ser testado.

Não remova nem enfraqueça testes de regressão silenciosamente.

## Validação obrigatória

Para tasks de implementação, execute a partir da raiz do repositório, salvo quando a task restringir explicitamente a validação:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Quando estiver trabalhando em uma change OpenSpec ativa e o CLI estiver disponível, execute também a validação estrita correspondente, por exemplo:

```bash
openspec validate <nome-da-change> --strict
```

Execute também:

```bash
git diff --check
```

Se algum comando não puder ser executado, informe exatamente o motivo. Nunca diga que um comando passou se ele não foi executado com sucesso.

## Requisitos de runtime

Use as versões declaradas pelo repositório:

- Node.js: `>=24 <25`
- npm: `>=11 <12`

Não altere os requisitos de engine apenas porque o ambiente de execução atual utiliza versão mais antiga.

## Serviços externos

A suíte automatizada normal não deve exigir:
- credenciais OpenAI;
- credenciais Meta;
- conectividade com WhatsApp;
- bancos externos;
- calendários externos.

Quando uma task exigir validação de compatibilidade com uma API externa, priorize documentação primária atual.

Para comportamento da WhatsApp Cloud API, priorize documentação oficial da Meta e exemplos mantidos oficialmente pela Meta.

Não use WAHA nem SDK arquivado, salvo se a task solicitar explicitamente.

## Segurança

Nunca exponha, imprima, faça commit ou copie segredos reais.

Nunca faça commit de:
- `.env`;
- access tokens;
- App Secrets;
- API keys;
- verify tokens;
- credenciais de usuário.

Mantenha segredos exclusivamente no backend.

Não crie variantes `NEXT_PUBLIC_*` para credenciais de provedores backend.

Mensagens de erro e logs não devem expor valores secretos, payloads sensíveis brutos ou stack traces internos, salvo quando um teste usar sentinelas não sensíveis de forma explícita.

Trate IDs de provedores externos como strings opacas, salvo quando o contrato disser explicitamente o contrário.

## Arquivos gerados e locais

Não faça commit de artefatos gerados/locais, salvo quando houver requisito explícito:

- `node_modules/`
- `.next/`
- `dist/`
- `coverage/`
- arquivos `.env` locais
- arquivos ZIP
- arquivos temporários de debug

Não modifique histórico OpenSpec ignorado apenas para deixar o Git status limpo.

## Comportamento Git

Não faça commit, push, merge, rebase, force-push ou archive sem solicitação explícita.

Não faça amend de commits existentes sem solicitação explícita.

Antes de concluir uma task, inspecione `git diff` / `git status` e reporte alterações pré-existentes não relacionadas separadamente.

Não descarte alterações do usuário que não sejam relacionadas à task.

## Relatório de conclusão da task

Ao finalizar uma task de implementação, informe de forma concisa:
- identificador da task;
- arquivos criados/alterados;
- decisões arquiteturais importantes;
- testes adicionados;
- comandos de validação e resultados;
- total de testes, quando disponível;
- limitações ou problemas não resolvidos;
- confirmação de que tasks futuras não foram iniciadas.

Não apresente uma task como concluída se as verificações obrigatórias falharam.

## Human gate

Depois de concluir a task explicitamente solicitada, pare.

Não avance automaticamente para a próxima task OpenSpec.

O usuário/revisor decide quando continuar.
