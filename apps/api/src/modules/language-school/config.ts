import { z } from 'zod';

const schoolConfigurationSchema = z.strictObject({
  schoolId: z.string().trim().min(1),
});

export function loadLanguageSchoolConfig(environment: NodeJS.ProcessEnv) {
  const result = schoolConfigurationSchema.safeParse({
    schoolId: environment.SCHOOL_ID ?? 'school_demo',
  });

  if (!result.success) {
    throw new Error('Configuração inválida: SCHOOL_ID deve identificar uma escola.');
  }

  return Object.freeze(result.data);
}
