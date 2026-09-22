import { z } from 'zod';
import { identifierSchema, nonEmptyStringSchema } from '@supportflow/contracts';
import {
  contactSchema,
  leadSchema,
  type ActiveCourseSummary,
} from '@supportflow/contracts/language-school';

export const conversationContextSchema = z.strictObject({
  goal: leadSchema.shape.goal,
  name: leadSchema.shape.name.nullable(),
  contact: contactSchema.nullable(),
  courseId: identifierSchema.nullable(),
  slotId: identifierSchema.nullable(),
  leadId: identifierSchema.nullable(),
  revision: z.number().int().nonnegative(),
});

// Todos os campos são obrigatórios para structured output. Null significa não alterar.
// Referências propostas ainda não são IDs oficiais; somente o catálogo pode resolvê-las.
export const contextPatchSchema = z.strictObject({
  goal: leadSchema.shape.goal,
  name: leadSchema.shape.name.nullable(),
  contact: contactSchema.nullable(),
  courseReference: nonEmptyStringSchema.nullable(),
});

export type ConversationContext = z.infer<typeof conversationContextSchema>;
export type ContextPatch = z.infer<typeof contextPatchSchema>;

export function createConversationContext(): ConversationContext {
  return {
    goal: null,
    name: null,
    contact: null,
    courseId: null,
    slotId: null,
    leadId: null,
    revision: 0,
  };
}

function literalPattern(value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`;
}

function containsLiteral(message: string, value: string, ignoreCase = false): boolean {
  return new RegExp(literalPattern(value), ignoreCase ? 'iu' : 'u').test(message);
}

function resolveCourse(
  reference: string,
  message: string,
  courses: readonly ActiveCourseSummary[],
): string | null {
  if (!containsLiteral(message, reference, true)) return null;

  const normalizedReference = reference.toLocaleLowerCase('pt-BR');
  const activeCourses = courses.filter((course) => course.active === true);
  const candidates = activeCourses.filter((course) =>
    course.id === reference
    || course.name.toLocaleLowerCase('pt-BR') === normalizedReference
    || course.language.toLocaleLowerCase('pt-BR') === normalizedReference,
  );
  if (candidates.length !== 1) return null;

  // Várias opções explícitas pedem esclarecimento. Retirar nomes/IDs já reconhecidos
  // evita contar o idioma contido no nome de um curso como outra escolha.
  const mentionedIds = new Set<string>();
  let remainingMessage = message;
  for (const course of activeCourses) {
    if (containsLiteral(message, course.id) || containsLiteral(message, course.name, true)) {
      mentionedIds.add(course.id);
      remainingMessage = remainingMessage
        .replace(new RegExp(literalPattern(course.id), 'gu'), ' ')
        .replace(new RegExp(literalPattern(course.name), 'giu'), ' ');
    }
  }
  for (const course of activeCourses) {
    if (containsLiteral(remainingMessage, course.language, true)) mentionedIds.add(course.id);
  }

  const candidate = candidates[0];
  return candidate && mentionedIds.size === 1 && mentionedIds.has(candidate.id)
    ? candidate.id
    : null;
}

export function applyContextPatch(
  current: ConversationContext,
  input: unknown,
  message: string,
  courses: readonly ActiveCourseSummary[],
): ConversationContext {
  const patch = contextPatchSchema.parse(input);
  const previous = conversationContextSchema.parse(current);

  for (const value of [patch.goal, patch.name, patch.contact?.value ?? null]) {
    if (value !== null && !containsLiteral(message, value)) {
      throw new Error('Atualização de contexto sem informação correspondente do visitante.');
    }
  }

  const courseId = patch.courseReference === null
    ? previous.courseId
    : resolveCourse(patch.courseReference, message, courses) ?? previous.courseId;
  const next = {
    ...previous,
    goal: patch.goal ?? previous.goal,
    name: patch.name ?? previous.name,
    contact: patch.contact ?? previous.contact,
    courseId,
    slotId: courseId === previous.courseId ? previous.slotId : null,
  };
  const changed = next.goal !== previous.goal
    || next.name !== previous.name
    || next.contact?.type !== previous.contact?.type
    || next.contact?.value !== previous.contact?.value
    || next.courseId !== previous.courseId
    || next.slotId !== previous.slotId;

  return conversationContextSchema.parse({ ...next, revision: previous.revision + Number(changed) });
}
