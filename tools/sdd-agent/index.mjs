#!/usr/bin/env node

import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Codex } from '@openai/codex-sdk';

const CHECKBOX = /^\s*-\s*\[([ xX])\]\s+(.+)$/;
const TASK_ID = /^(\d+(?:\.\d+)*)\s+(.+)$/;

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
    'Ao terminar:',
    '- execute todas as validações obrigatórias do AGENTS.md;',
    '- marque somente esta task se todos os critérios estiverem satisfeitos;',
    '- apresente o relatório de conclusão em português;',
    '- não faça commit, push, merge ou archive.',
    '',
    'Depois de concluir a task solicitada, pare.',
  ].join('\n');
}

async function confirmRun(change, task) {
  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question(
      `Executar a task ${task.id ?? task.raw} da change "${change}" com o Codex? [y/N] `,
    );
    return ['y', 'yes', 's', 'sim'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function printTask(change, task) {
  console.log('');
  console.log('════════════════════════════════════════');
  console.log(' SupportFlow SDD Agent');
  console.log('════════════════════════════════════════');
  console.log(`Change:       ${change}`);
  console.log(`Próxima task: ${task.id ?? '(sem ID)'}`);
  console.log(`Descrição:    ${task.description}`);
  console.log('════════════════════════════════════════');
  console.log('');
}

async function runCodex(root, prompt) {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: root,
  });

  console.log('Iniciando Codex...\n');

  const turn = await thread.run(prompt);

  console.log('\n════════════════════════════════════════');
  console.log(' Resposta final do Codex');
  console.log('════════════════════════════════════════\n');
  console.log(turn.finalResponse?.trim() || '(Codex não retornou resposta final em texto.)');
  console.log('');
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

  printTask(change, task);

  const prompt = buildPrompt(change, task);

  if (args.dryRun) {
    console.log('Prompt que seria enviado ao Codex:\n');
    console.log(prompt);
    return;
  }

  if (!args.yes) {
    const confirmed = await confirmRun(change, task);
    if (!confirmed) {
      console.log('Execução cancelada. Nenhum agente foi iniciado.');
      return;
    }
  }

  await runCodex(root, prompt);

  console.log('Human gate: execução encerrada após uma única task.');
  console.log('Revise as alterações antes de decidir o próximo passo.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nErro no SDD Agent: ${message}`);
  process.exitCode = 1;
});
