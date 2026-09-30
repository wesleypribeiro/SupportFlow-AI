# SupportFlow SDD Agent

Automação local para executar uma única task OpenSpec por vez usando o Codex.

## Objetivo

Substituir o fluxo manual de copiar prompts para o Codex e separar claramente duas responsabilidades:

1. **Codex implementa a task**.
2. **O processo pai valida localmente** e só então marca a task como concluída.

O agente:

1. localiza a raiz do SupportFlow;
2. encontra a change OpenSpec ativa com task pendente;
3. lê `tasks.md`;
4. seleciona a primeira task não concluída;
5. verifica se a execução está em uma branch segura;
6. monta o prompt com base em `AGENTS.md` + OpenSpec;
7. pede confirmação humana;
8. executa uma única thread do Codex com progresso em streaming;
9. força a task a permanecer pendente antes das validações;
10. executa as validações obrigatórias fora do sandbox do Codex;
11. marca a task como concluída somente se todas passarem;
12. para no human gate.

Ele **não** faz commit, push, merge, rebase ou archive.

## Instalação

Na raiz do repositório:

```bash
npm run sdd:setup
```

Isso instala `@openai/codex-sdk` somente dentro de `tools/sdd-agent`, sem adicioná-lo aos workspaces da aplicação.

O `package-lock.json` deste diretório é versionado para tornar a instalação reproduzível.

## Uso

Detecção automática quando há apenas uma change ativa com tasks pendentes:

```bash
npm run sdd
```

Escolha explícita:

```bash
npm run sdd -- --change whatsapp-channel-mvp
```

Visualizar sem executar:

```bash
npm run sdd -- --change whatsapp-channel-mvp --dry-run
```

Execução sem a confirmação inicial:

```bash
npm run sdd -- --change whatsapp-channel-mvp --yes
```

Use `--yes` somente quando você já tiver revisado a task.

## Proteção de branch

A execução real é bloqueada em:

- `main`;
- `master`;
- detached HEAD.

Antes de executar, crie uma branch específica da task, por exemplo:

```bash
git switch -c feat/whatsapp-task-2.4
npm run sdd -- --change whatsapp-channel-mvp
```

O modo `--dry-run` pode ser usado na `main`, pois não altera código nem chama o Codex.

## Progresso em streaming

Durante a execução, o agente mostra eventos úteis emitidos pelo Codex, como:

- comandos executados;
- pesquisas;
- alterações de arquivos;
- progresso de planos;
- resposta final.

O objetivo é dar visibilidade ao trabalho sem depender apenas da resposta final da thread.

## Validação fora do Codex

Depois que o Codex termina, o processo Node pai executa sequencialmente, a partir da raiz:

```bash
npm test
npm run typecheck
npm run lint
npm run build
openspec validate <change-name> --strict
git diff --check
```

Esses comandos são executados pelo processo do SDD Agent no terminal local, e não dentro da thread do Codex.

Se qualquer validação falhar:

- a task permanece `[ ]`;
- o processo retorna código de erro;
- nenhuma task seguinte é iniciada.

Se todas passarem:

- somente a task atual é marcada como `[x]`;
- o agente encerra no human gate.

## Human gate

O agente executa **uma única task por invocação**.

Mesmo depois de todas as validações passarem, ele não:

- inicia a próxima task;
- cria commit;
- faz push;
- abre ou mergeia PR.

A decisão de avançar continua humana.

## OpenSpec ignorado pelo Git

O agente lê os arquivos locais diretamente.

Portanto, `openspec/` pode permanecer no `.gitignore`; ele ainda precisa existir no checkout local.

A marcação em `tasks.md` também pode continuar sendo local quando o OpenSpec estiver ignorado pelo Git.

## Segurança

- Não coloque API keys no código.
- Não faça commit de `.env`.
- O SDD Agent não imprime segredos por conta própria.
- As permissões efetivas do Codex seguem a configuração local da instalação.
- O `AGENTS.md` continua sendo a política persistente do projeto.
- O agente não executa tarefas reais diretamente na `main`.
