# SupportFlow SDD Agent

Automação local para executar uma única task OpenSpec por vez usando o Codex.

## Objetivo

Substituir o fluxo manual de copiar prompts para o Codex.

O agente:

1. localiza a raiz do SupportFlow;
2. encontra a change OpenSpec ativa com task pendente;
3. lê `tasks.md`;
4. seleciona a primeira task não concluída;
5. monta um prompt curto baseado em `AGENTS.md` + OpenSpec;
6. pede confirmação humana;
7. executa exatamente uma thread do Codex;
8. para ao final da task.

Ele **não** faz commit, push, merge ou archive.

## Instalação

Na raiz do repositório:

```bash
npm run sdd:setup
```

Isso instala `@openai/codex-sdk` somente dentro de `tools/sdd-agent`, sem adicioná-lo aos workspaces da aplicação.

O SDK oficial encapsula a própria Codex CLI. A autenticação segue as credenciais/configuração suportadas pelo Codex no computador local.

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

## Human gate

A primeira versão executa **uma única task** e para.

Ela não inicia a task seguinte automaticamente, mesmo que o Codex marque a atual como concluída.

A revisão automática e o loop de correção serão adicionados em uma etapa posterior, depois de validarmos este caminho básico de ponta a ponta.

## OpenSpec ignorado pelo Git

O agente lê os arquivos locais diretamente.

Portanto, `openspec/` pode permanecer no `.gitignore`; ele ainda precisa existir no checkout local.

## Segurança

- Não coloque API keys no código.
- Não faça commit de `.env`.
- O SDD Agent não lê nem imprime segredos.
- As permissões efetivas do Codex seguem a configuração local do Codex e as políticas disponíveis na instalação do usuário.
- O `AGENTS.md` continua sendo a política persistente do projeto.
