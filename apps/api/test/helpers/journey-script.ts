import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { conversationContextSchema } from '../../src/modules/language-school/domain/conversation-context.js';
import type { ContextPatch, ConversationContext } from '../../src/modules/language-school/domain/conversation-context.js';
import { ScriptedChatModel } from './scripted-chat-model.js';

type ModelStep = ConstructorParameters<typeof ScriptedChatModel>[0][number];
type Turn = { patch: ContextPatch; responses: ModelStep[] };
export type JourneyScript = (Turn | ModelStep)[];

// Somente roteiros de geração. Não consulta repositories, resolve referências,
// decide outcomes nem grava contexto. Os IDs são lidos do prompt real do backend.
export function modelContext(messages: readonly BaseMessage[]): ConversationContext {
  const text = messages.find((message) => message.name === 'conversation_context')?.text;
  if (!text) throw new Error('O atendimento não recebeu contexto oficial.');
  return conversationContextSchema.parse(JSON.parse(text.slice(text.indexOf('{'))));
}

export function dialogue(reply: ModelStep = new AIMessage('Qual informação você deseja?'), patch: Partial<ContextPatch> = {}): Turn {
  return { patch: { goal: null, name: null, contact: null, courseReference: null, slotReference: null, ...patch }, responses: [reply] };
}

export function query(name: string, args: Record<string, unknown> | ((context: ConversationContext) => Record<string, unknown>),
  patch: Partial<ContextPatch> = {}, reply: ModelStep = new AIMessage('Consulte o resultado oficial.'),
): Turn {
  const result = dialogue((messages) => new AIMessage({ content: '', tool_calls: [{
    name, id: `call_${name}`, type: 'tool_call', args: typeof args === 'function' ? args(modelContext(messages)) : args,
  }] }), patch);
  result.responses.push(reply);
  return result;
}

export const catalogTurn = () => query('get_courses', {});
export const courseTurn = (reference = 'inglês', goal: string | null = 'viagem') => query('get_course_details',
  (context) => ({ courseId: context.courseId }), { courseReference: reference, goal }, new AIMessage('O curso custa R$ 999.'));
export const slotsTurn = () => query('get_available_slots', (context) => ({ courseId: context.courseId }));
export const selectSlotTurn = (slotId = 'slot_english_a', evidence = '11/06/2030 às 10h') => dialogue(new AIMessage('Seleção recebida.'), { slotReference: { slotId, evidence } });
export const leadTurn = (patch: Partial<ContextPatch> = {}) => query('create_lead',
  ({ name, contact, courseId, goal }) => ({ name, contact, courseId, goal }), patch, new AIMessage('Cadastro realizado.'));
export const scheduleTurn = (patch: Partial<ContextPatch> = {}) => query('schedule_trial_class',
  ({ leadId, slotId }) => ({ leadId, slotId }), patch, new AIMessage('Sua aula está confirmada.'));
export const handoffTurn = (reason = 'Quero falar com alguém.', reply: ModelStep = new AIMessage('Um atendente assumiu sua conversa.')) => query('transfer_to_human', { reason }, {}, reply);

export function decidedStudentScript(name = 'Ana', email = 'ana@example.com'): JourneyScript {
  return [catalogTurn(), courseTurn(), slotsTurn(), selectSlotTurn(),
    leadTurn({ name, contact: { type: 'email', value: email } })];
}

export function createJourneyModel(script: JourneyScript): ScriptedChatModel {
  const responses: ModelStep[] = [];
  const contextSteps: ContextPatch[] = [];
  for (const step of script) {
    if (typeof step === 'object' && 'patch' in step) {
      contextSteps.push(step.patch); responses.push(...step.responses);
    } else responses.push(step);
  }
  return new ScriptedChatModel(responses, { contextSteps });
}
