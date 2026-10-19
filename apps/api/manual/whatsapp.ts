import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';

// Desabilitar antes de importar LangChain. Não carregar .env implicitamente nem
// permitir que tracing envie os prompts do ensaio a outro serviço externo.
delete process.env.LANGCHAIN_TRACING;
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';
process.env.LANGSMITH_TRACING_V2 = 'false';
process.env.LANGCHAIN_VERBOSE = 'false';

const { createManualWhatsAppHarness, manualUsage, parseManualArguments } = await import('./whatsapp-harness.js');
try {
  const args = parseManualArguments(process.argv.slice(2));
  if (!args) console.info(manualUsage);
  else {
    const environment = parseEnv(readFileSync(args.envFile, 'utf8'));
    const harness = createManualWhatsAppHarness({ realMeta: true, environment, report: (line) => console.info(line) });
    await harness.server.listen(harness.config.http);
    console.info('WHATSAPP_MANUAL_READY 127.0.0.1:3001 | ScriptedChatModel | Graph v26.0 | negócios: 2030-06-10T12:00:00Z | canal: relógio real');
    console.info('Terminal: falhar = rejeitar localmente a próxima parte; sair = encerrar. Aguarde os envios antes de armar a falha. Não digite credenciais.');
    const terminal = createInterface({ input: process.stdin, terminal: false });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      terminal.close();
      try { await harness.close(); }
      catch { console.error('WHATSAPP_MANUAL_CLOSE_FAILED'); process.exitCode = 1; }
    };
    terminal.on('line', (line) => {
      if (line === 'falhar') { harness.failNextSend(); console.info('WHATSAPP_MANUAL_FAILURE_ARMED'); }
      else if (line === 'sair') void stop();
      else console.info('Comandos locais disponíveis: falhar, sair.');
    });
    terminal.once('close', () => { void stop(); });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
  }
} catch {
  console.error('WHATSAPP_MANUAL_START_FAILED. Verifique opções, arquivo privado, configuração e porta.');
  process.exitCode = 1;
}
