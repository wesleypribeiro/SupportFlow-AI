import { z } from 'zod';

// Valida sem reescrever o texto ou normalizar identificadores opacos.
export const nonEmptyStringSchema = z.string().min(1).regex(/\S/);
export const identifierSchema = nonEmptyStringSchema;
