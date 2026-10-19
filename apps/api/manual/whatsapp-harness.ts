import { createApplication } from '../src/app.js';
import { loadWhatsAppConfig } from '../src/channels/whatsapp/config.js';
import { createMetaCloudApiClient } from '../src/channels/whatsapp/meta/cloud-api-client.js';
import type { WhatsAppSendResult, WhatsAppTransport } from '../src/channels/whatsapp/transport.js';
import { createManualWhatsAppModel } from './whatsapp-model.js';

export const manualBusinessTime = '2030-06-10T12:00:00Z';
export const manualUsage = 'Harness WhatsApp manual: --real-meta --env-file=/caminho/privado/whatsapp.env. Pode enviar mensagens reais e gerar custos. Consulte deploy/whatsapp/manual.md. Sem essas opções, nenhum servidor ou transporte é iniciado.';

export function parseManualArguments(args: readonly string[]): { envFile: string } | null {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return null;
  const file = args.find((argument) => argument.startsWith('--env-file='))?.slice('--env-file='.length);
  if (args.length !== 2 || !args.includes('--real-meta') || !file?.startsWith('/')) {
    throw new Error('Opções inválidas para o harness manual.');
  }
  return { envFile: file };
}

// Importar este módulo não abre socket, não lê .env e não envia mensagens.
export function createManualWhatsAppHarness(options: {
  realMeta: boolean;
  environment: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  whatsappNow?: () => Date;
  report?: (line: string) => void;
}) {
  if (options.realMeta !== true) throw new Error('O transporte manual exige --real-meta.');
  // Somente campos Meta são aproveitados do arquivo explícito. OpenAI, HOST,
  // SCHOOL_ID e configurações de tracing não são herdados por esta composição.
  const config = loadWhatsAppConfig(options.environment);
  if (!config.enabled) throw new Error('Habilite o canal no arquivo privado do harness.');
  const environment = {
    HOST: '127.0.0.1', PORT: '3001', SCHOOL_ID: 'school_demo', WHATSAPP_ENABLED: 'true',
    META_APP_SECRET: config.appSecret, META_WEBHOOK_VERIFY_TOKEN: config.webhookVerifyToken,
    META_ACCESS_TOKEN: config.accessToken, META_GRAPH_API_VERSION: config.graphApiVersion,
    META_WABA_ID: config.wabaId, META_PHONE_NUMBER_ID: config.phoneNumberId,
    WHATSAPP_DEMO_RECIPIENTS: config.demoRecipients.join(','),
  };
  const report = options.report ?? (() => {});
  const provider = createMetaCloudApiClient(config, { fetch: options.fetch ?? globalThis.fetch });
  let failNext = false;
  let sequence = 0;
  const accepted = new Map<string, { recipientId: string; label: string }>();
  const transport: WhatsAppTransport = { async send(request) {
    // Defesa adicional do harness; não permite que um uso local das rotas web
    // transforme um destinatário arbitrário em alvo de envio.
    if (!config.demoRecipients.includes(request.recipientId)) return { status: 'rejected', reason: 'invalid_request' };
    const label = `saida-${++sequence}`;
    let result: WhatsAppSendResult;
    if (failNext) {
      failNext = false;
      result = { status: 'rejected', reason: 'provider_rejection' };
      report(`WHATSAPP_MANUAL_INDUCED_FAILURE ${label}`);
    } else result = await provider.send(request);
    if (result.status === 'accepted') accepted.set(result.messageId, { recipientId: request.recipientId, label });
    report(`WHATSAPP_MANUAL_SEND ${label} ${result.status}`);
    return result;
  } };
  const model = createManualWhatsAppModel();
  const app = createApplication(environment, {
    model, now: () => new Date(manualBusinessTime),
    // Nunca usar o clock comercial de 2030 para assinatura/admissão/janela.
    whatsappNow: options.whatsappNow ?? (() => new Date()), whatsappTransport: transport,
  });
  const outbox = app.whatsappOutbox!;
  const receiveStatus = outbox.receiveStatus.bind(outbox);
  outbox.receiveStatus = (event) => {
    receiveStatus(event);
    const send = accepted.get(event.messageId);
    if (send && event.provider === config.provider && event.accountId === config.wabaId
      && event.phoneNumberId === config.phoneNumberId
      && (event.recipientId === undefined || event.recipientId === send.recipientId)) {
      // Observação de chegada, não estado final: eventos podem vir fora de ordem.
      report(`WHATSAPP_MANUAL_STATUS ${send.label} ${event.status}`);
    }
  };
  return { ...app, model,
    failNextSend: () => { failNext = true; },
    close: async () => { await app.server.close(); await app.whatsappInbox!.drain(); },
  };
}
