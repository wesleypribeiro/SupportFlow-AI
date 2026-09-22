import { z } from 'zod';
import { activeCourseSummarySchema } from '@supportflow/contracts/language-school';
import {
  applyContextPatch,
  contextPatchSchema,
  type ConversationContext,
} from '../domain/conversation-context.js';
import type { SchoolRepository } from '../domain/school-repository.js';

export async function updateConversationContext(
  repository: SchoolRepository,
  current: ConversationContext,
  input: unknown,
  message: string,
): Promise<ConversationContext> {
  const patch = contextPatchSchema.parse(input);
  const courses = patch.courseReference === null
    ? []
    : z.array(activeCourseSummarySchema).parse(await repository.listActiveCourses());

  return applyContextPatch(current, patch, message, courses);
}
