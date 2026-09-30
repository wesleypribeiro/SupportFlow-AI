import { z } from 'zod';

const requiredSetting = z.string().trim().min(1);
const recipientsSchema = z.string()
  .transform((value) => value.split(',').map((item) => item.trim()))
  .pipe(z.array(z.string().min(1)).min(1))
  .transform((items) => [...new Set(items)]);

const enabledEnvironmentSchema = z.strictObject({
  META_APP_SECRET: requiredSetting,
  META_WEBHOOK_VERIFY_TOKEN: requiredSetting,
  META_ACCESS_TOKEN: requiredSetting,
  META_WABA_ID: requiredSetting,
  META_PHONE_NUMBER_ID: requiredSetting,
  // Versão verificada em meta/compatibility.md; upgrades exigem nova verificação.
  META_GRAPH_API_VERSION: z.literal('v26.0'),
  WHATSAPP_DEMO_RECIPIENTS: recipientsSchema,
});

export type WhatsAppConfig = Readonly<{ enabled: false }> | Readonly<{
  enabled: true;
  provider: 'meta';
  appSecret: string;
  webhookVerifyToken: string;
  accessToken: string;
  wabaId: string;
  phoneNumberId: string;
  graphApiVersion: 'v26.0';
  demoRecipients: readonly string[];
}>;

export function loadWhatsAppConfig(environment: NodeJS.ProcessEnv): WhatsAppConfig {
  // Ausência/branco segue a política local de env; outros valores são literais.
  const enabled = environment.WHATSAPP_ENABLED;
  if (enabled === undefined || enabled.trim() === '' || enabled === 'false') {
    return Object.freeze({ enabled: false });
  }
  if (enabled !== 'true') {
    throw new Error('Configuração WhatsApp inválida: WHATSAPP_ENABLED.');
  }

  const result = enabledEnvironmentSchema.safeParse({
    META_APP_SECRET: environment.META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: environment.META_WEBHOOK_VERIFY_TOKEN,
    META_ACCESS_TOKEN: environment.META_ACCESS_TOKEN,
    META_WABA_ID: environment.META_WABA_ID,
    META_PHONE_NUMBER_ID: environment.META_PHONE_NUMBER_ID,
    META_GRAPH_API_VERSION: environment.META_GRAPH_API_VERSION,
    WHATSAPP_DEMO_RECIPIENTS: environment.WHATSAPP_DEMO_RECIPIENTS,
  });
  if (!result.success) {
    // Não publicar ZodError, valores, mensagens de providers ou cause.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
    throw new Error(`Configuração WhatsApp inválida: ${fields.join(', ')}.`);
  }

  const settings = result.data;
  return Object.freeze({
    enabled: true,
    provider: 'meta',
    appSecret: settings.META_APP_SECRET,
    webhookVerifyToken: settings.META_WEBHOOK_VERIFY_TOKEN,
    accessToken: settings.META_ACCESS_TOKEN,
    wabaId: settings.META_WABA_ID,
    phoneNumberId: settings.META_PHONE_NUMBER_ID,
    graphApiVersion: settings.META_GRAPH_API_VERSION,
    demoRecipients: Object.freeze(settings.WHATSAPP_DEMO_RECIPIENTS),
  });
}
