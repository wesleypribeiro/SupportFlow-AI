#!/usr/bin/env node

import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';

const execFile = promisify(execFileCallback);
const CHECKBOX = /^\s*-\s*\[([ xX])\]\s+(.+)$/;
const TASK_ID = /^(\d+(?:\.\d+)*)\s+(.+)$/;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

function parseArgs(argv) {
  const result = { change: null, yes: false, dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--change') {
      result.change = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--yes' || arg === '-y') {
      result.yes = true;
      continue;
    }

    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Argumento desconhecido: ${arg}`);
  }

  return result;
}

function printHelp() {
  console.log(`
SupportFlow SDD Agent

Uso:
  npm run sdd
  npm run sdd -- --change whatsapp-channel-mvp
  npm run sdd -- --dry-run
  npm run sdd -- --yes

Opções:
  --change <nome>  Escolhe explicitamente a change OpenSpec.
  --dry-run        Mostra a próxima task e o prompt, sem chamar o Codex.
  --yes, -y        Não pede confirmação antes de chamar o Codex.
  --help, -h       Mostra esta ajuda.

Segurança:
  Execução real é bloqueada em main/master e em HEAD destacado.
  Use uma branch de feature/chore antes de iniciar o Codex.
`.trim());
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot(start = process.cwd()) {
  let current = resolve(start);

  while (true) {
    if (
      await exists(join(current, 'package.json')) &&
      await exists(join(current, 'AGENTS.md'))
    ) {
      return current;
    }

    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }

  throw new Error('Não foi possível localizar a raiz do repositório (package.json + AGENTS.md).');
}

async function currentBranch(root) {
  const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  return stdout.trim();
}

async function ensureSafeBranch(root) {
  const branch = await currentBranch(root);

  if (!branch || branch === 'HEAD') {
    throw new Error(
      'Execução bloqueada em HEAD destacado. Crie/troque para uma branch antes de executar o SDD Agent.',
    );
  }

  if (PROTECTED_BRANCHES.has(branch)) {
    throw new Error(
      [
        `Execução bloqueada na branch protegida "${branch}".`,
        'Crie uma branch para a task antes de continuar, por exemplo:',
        '  git switch -c feat/whatsapp-task-X.Y',
      ].join('\n'),
    );
  }

  return branch;
}

async function activeChanges(root) {
  const changesDir = join(root, 'openspec', 'changes');

  if (!(await exists(changesDir))) {
    throw new Error(
      'openspec/changes não existe localmente. O SDD Agent depende dos artefatos OpenSpec locais.',
    );
  }

  const entries = await readdir(changesDir, { withFileTypes: true });

  const changes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive') continue;

    const tasksPath = join(changesDir, entry.name, 'tasks.md');
    if (await exists(tasksPath)) changes.push(entry.name);
  }

  return changes.sort();
}

async function chooseChange(root, requested) {
  const changes = await activeChanges(root);

  if (requested) {
    if (!changes.includes(requested)) {
      throw new Error(
        `Change "${requested}" não encontrada entre as changes ativas: ${changes.join(', ') || '(nenhuma)'}.`,
      );
    }
    return requested;
  }

  const withPending = [];

  for (const change of changes) {
    const tasksPath = join(root, 'openspec', 'changes', change, 'tasks.md');
    const tasks = parseTasks(await readFile(tasksPath, 'utf8'));
    if (tasks.some((task) => !task.done)) withPending.push(change);
  }

  if (withPending.length === 0) {
    throw new Error('Nenhuma change ativa possui tasks pendentes.');
  }

  if (withPending.length > 1) {
    throw new Error(
      [
        'Há mais de uma change com tasks pendentes.',
        'Informe explicitamente qual deseja executar:',
        ...withPending.map((change) => `  npm run sdd -- --change ${change}`),
      ].join('\n'),
    );
  }

  return withPending[0];
}

function parseTasks(source) {
  const tasks = [];

  for (const line of source.split(/\r?\n/)) {
    const checkbox = CHECKBOX.exec(line);
    if (!checkbox) continue;

    const body = checkbox[2].trim();
    const parsed = TASK_ID.exec(body);

    tasks.push({
      done: checkbox[1].trim().toLowerCase() === 'x',
      id: parsed?.[1] ?? null,
      description: parsed?.[2]?.trim() ?? body,
      raw: body,
    });
  }

  return tasks;
}

function nextTask(tasks) {
  return tasks.find((task) => !task.done) ?? null;
}

function buildPrompt(change, task) {
  const taskLabel = task.id ?? task.raw;

  return [
    `Implemente SOMENTE a task ${taskLabel} da change \`${change}\`.`,
    '',
    'Siga integralmente o AGENTS.md e os artefatos OpenSpec locais da change.',
    '',
    'Antes de alterar código, leia:',
    `- openspec/changes/${change}/proposal.md`,
    `- openspec/changes/${change}/design.md`,
    `- openspec/changes/${change}/tasks.md`,
    '- as delta specs relevantes da change;',
    '- as specs consolidadas relevantes em openspec/specs/, quando existirem.',
    '',
    'Descrição da task:',
    task.raw,
    '',
    'Implemente exatamente os critérios dessa task e os testes correspondentes.',
    'Não avance para a próxima task.',
    '',
    'Durante a implementação, você pode executar testes focados e inspeções necessárias.',
    'NÃO marque a checkbox da task como concluída.',
    'NÃO faça commit, push, merge, rebase ou archive.',
    '',
    'As validações globais obrigatórias e a marcação final da task serão executadas pelo processo pai do SDD Agent, fora do sandbox do Codex.',
    'Ao concluir a implementação, apresente o relatório em português e pare.',
  ].join('\n');
}

async function confirmRun(change, task, branch) {
  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question(
      `Executar a task ${task.id ?? task.raw} da change "${change}" na branch "${branch}"? [y/N] `,
    );
    return ['y', 'yes', 's', 'sim'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function printTask(change, task, branch = null) {
  console.log('');
  console.log('════════════════════════════════════════');
  console.log(' SupportFlow SDD Agent');
  console.log('════════════════════════════════════════');
  console.log(`Change:       ${change}`);
  console.log(`Próxima task: ${task.id ?? '(sem ID)'}`);
  console.log(`Descrição:    ${task.description}`);
  if (branch) console.log(`Branch:       ${branch}`);
  console.log('════════════════════════════════════════');
  console.log('');
}

function formatFileChanges(changes) {
  return changes.map((change) => `${change.kind}:${change.path}`).join(', ');
}

async function runCodex(root, prompt) {
  const codex = new Codex();
  const thread = codex.startThread({ workingDirectory: root });

  console.log('Iniciando Codex...\n');

  const { events } = await thread.runStreamed(prompt);
  let finalResponse = '';
  let completed = false;

  for await (const event of events) {
    if (event.type === 'item.started') {
      if (event.item.type === 'command_execution') {
        console.log(`→ comando: ${event.item.command}`);
      } else if (event.item.type === 'web_search') {
        console.log(`→ pesquisa: ${event.item.query}`);
      } else if (event.item.type === 'mcp_tool_call') {
        console.log(`→ ferramenta: ${event.item.server}/${event.item.tool}`);
      }
      continue;
    }

    if (event.type === 'item.completed') {
      const item = event.item;

      if (item.type === 'reasoning' && item.text.trim()) {
        console.log(`→ ${item.text.trim()}`);
      } else if (item.type === 'file_change') {
        console.log(`→ arquivos: ${formatFileChanges(item.changes)}`);
      } else if (item.type === 'command_execution') {
        const ok = item.status === 'completed' && item.exit_code === 0;
        console.log(`${ok ? '✓' : '✗'} comando concluído (exit ${item.exit_code ?? '?'})`);
      } else if (item.type === 'todo_list') {
        const completedItems = item.items.filter((todo) => todo.completed).length;
        console.log(`→ plano: ${completedItems}/${item.items.length} itens concluídos`);
      } else if (item.type === 'agent_message') {
        finalResponse = item.text;
      } else if (item.type === 'error') {
        console.error(`✗ Codex: ${item.message}`);
      }
      continue;
    }

    if (event.type === 'turn.failed') {
      throw new Error(`Codex falhou: ${event.error.message}`);
    }

    if (event.type === 'turn.completed') {
      completed = true;
    }
  }

  if (!completed) {
    throw new Error('A execução do Codex terminou sem evento turn.completed.');
  }

  console.log('\n════════════════════════════════════════');
  console.log(' Resposta final do Codex');
  console.log('════════════════════════════════════════\n');
  console.log(finalResponse.trim() || '(Codex não retornou resposta final em texto.)');
  console.log('');

  return finalResponse;
}

function executable(name) {
  if (process.platform !== 'win32') return name;
  if (name === 'npm') return 'npm.cmd';
  if (name === 'openspec') return 'openspec.cmd';
  return name;
}

async function runCommand(root, label, command, args) {
  console.log('');
  console.log(`▶ ${label}`);
  console.log(`  $ ${command} ${args.join(' ')}`);

  return new Promise((resolveResult) => {
    const child = spawn(executable(command), args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (error) => {
      console.error(`✗ ${label}: não foi possível iniciar (${error.message})`);
      resolveResult(false);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        console.log(`✓ ${label}`);
        resolveResult(true);
      } else {
        console.error(`✗ ${label} (exit ${code ?? '?' }${signal ? `, signal ${signal}` : ''})`);
        resolveResult(false);
      }
    });
  });
}

async function runValidations(root, change) {
  console.log('\n════════════════════════════════════════');
  console.log(' Validação local pós-Codex');
  console.log('════════════════════════════════════════');

  const checks = [
    ['Testes', 'npm', ['test']],
    ['Typecheck', 'npm', ['run', 'typecheck']],
    ['Lint', 'npm', ['run', 'lint']],
    ['Build', 'npm', ['run', 'build']],
    ['OpenSpec strict', 'openspec', ['validate', change, '--strict']],
    ['git diff --check', 'git', ['diff', '--check']],
  ];

  const results = [];

  for (const [label, command, args] of checks) {
    const passed = await runCommand(root, label, command, args);
    results.push({ label, passed });
  }

  console.log('\nResumo das validações:');
  for (const result of results) {
    console.log(`  ${result.passed ? '✓' : '✗'} ${result.label}`);
  }

  return results.every((result) => result.passed);
}

async function setTaskStatus(tasksPath, task, done) {
  const source = await readFile(tasksPath, 'utf8');
  const lines = source.split(/\r?\n/);
  let updated = false;

  const next = lines.map((line) => {
    if (updated) return line;

    const checkbox = CHECKBOX.exec(line);
    if (!checkbox) return line;

    const body = checkbox[2].trim();
    const parsed = TASK_ID.exec(body);
    const sameTask = task.id ? parsed?.[1] === task.id : body === task.raw;

    if (!sameTask) return line;

    updated = true;
    return line.replace(/\[([ xX])\]/, done ? '[x]' : '[ ]');
  });

  if (!updated) {
    throw new Error(`Não foi possível localizar a task ${task.id ?? task.raw} em tasks.md para atualizar o status.`);
  }

  await writeFile(tasksPath, next.join('\n'), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = await findRepoRoot();
  const change = await chooseChange(root, args.change);
  const tasksPath = join(root, 'openspec', 'changes', change, 'tasks.md');
  const tasks = parseTasks(await readFile(tasksPath, 'utf8'));
  const task = nextTask(tasks);

  if (!task) {
    console.log(`A change "${change}" não possui tasks pendentes.`);
    return;
  }

  const branch = args.dryRun ? await currentBranch(root) : await ensureSafeBranch(root);
  printTask(change, task, branch);

  const prompt = buildPrompt(change, task);

  if (args.dryRun) {
    console.log('Prompt que seria enviado ao Codex:\n');
    console.log(prompt);
    return;
  }

  if (!args.yes) {
    const confirmed = await confirmRun(change, task, branch);
    if (!confirmed) {
      console.log('Execução cancelada. Nenhum agente foi iniciado.');
      return;
    }
  }

  await runCodex(root, prompt);

  // A task precisa permanecer pendente até a validação local externa ao Codex.
  await setTaskStatus(tasksPath, task, false);

  const valid = await runValidations(root, change);

  if (!valid) {
    console.error('');
    console.error(`Task ${task.id ?? task.raw} NÃO foi marcada como concluída porque há validações com falha.`);
    console.error('Corrija os problemas e execute novamente as validações antes de avançar.');
    process.exitCode = 1;
    return;
  }

  await setTaskStatus(tasksPath, task, true);

  console.log('');
  console.log(`✓ Task ${task.id ?? task.raw} marcada como concluída em tasks.md.`);
  console.log('Human gate: execução encerrada após uma única task.');
  console.log('Revise as alterações e faça commit/push somente quando decidir prosseguir.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nErro no SDD Agent: ${message}`);
  process.exitCode = 1;
});
