import { z } from 'zod';

const optionalSetting = z.string().trim().min(1).optional();

const environmentSchema = z.strictObject({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.string().regex(/^\d+$/).default('3001')
    .transform(Number).pipe(z.number().int().min(1).max(65535)),
  OPENAI_API_KEY: optionalSetting,
  OPENAI_MODEL: optionalSetting,
});

export function loadCoreConfig(environment: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse({
    HOST: environment.HOST,
    PORT: environment.PORT,
    OPENAI_API_KEY: environment.OPENAI_API_KEY?.trim() || undefined,
    OPENAI_MODEL: environment.OPENAI_MODEL?.trim() || undefined,
  });

  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Configuração inválida: ${fields.join(', ')}.`);
  }

  const { HOST, PORT, OPENAI_API_KEY, OPENAI_MODEL } = result.data;

  if (Boolean(OPENAI_API_KEY) !== Boolean(OPENAI_MODEL)) {
    throw new Error('Configure OPENAI_API_KEY e OPENAI_MODEL juntos no backend.');
  }

  return {
    http: { host: HOST, port: PORT },
    llm: OPENAI_API_KEY && OPENAI_MODEL
      ? { provider: 'openai' as const, apiKey: OPENAI_API_KEY, model: OPENAI_MODEL }
      : null,
  };
}
