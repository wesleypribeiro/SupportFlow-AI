import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { conversationContextSchema } from '../src/modules/language-school/domain/conversation-context.js';
import type { ContextPatch, ConversationContext } from '../src/modules/language-school/domain/conversation-context.js';
import { handoffOffer } from '../src/modules/language-school/domain/handoff-intent.js';
import { ScriptedChatModel } from '../test/helpers/scripted-chat-model.js';

type Step = {
  patch?: Partial<ContextPatch>;
  tool?: string;
  args?: (context: ConversationContext) => Record<string, unknown>;
  reply?: string;
};
const leadArgs = ({ name, contact, courseId, goal }: ConversationContext) => ({ name, contact, courseId, goal });
const courseArgs = ({ courseId }: ConversationContext) => ({ courseId });

// Roteiro exato, sem estado global por turno. Duas pessoas podem intercalar
// mensagens: somente o contexto oficial recebido no prompt fornece seus IDs.
// Não resolve disponibilidade, escreve repositories ou autoriza confirmações.
export const manualScript: Readonly<Record<string, Step>> = {
  'Quais cursos vocês oferecem?': { tool: 'get_courses' },
  'Onde fica a escola?': { tool: 'get_school_info' },
  'Quero inglês para viagem.': { patch: { courseReference: 'inglês', goal: 'viagem' }, tool: 'get_course_details', args: courseArgs },
  'Quero espanhol.': { patch: { courseReference: 'espanhol' }, tool: 'get_course_details', args: courseArgs },
  'Quero francês.': { patch: { courseReference: 'francês' }, tool: 'get_course_details', args: courseArgs },
  'Quais horários estão disponíveis?': { tool: 'get_available_slots', args: courseArgs },
  'Escolho 11/06/2030 às 10h.': {
    patch: { slotReference: { slotId: 'slot_english_a', evidence: '11/06/2030 às 10h' } },
  },
  'Escolho 12/06/2030 às 14h.': {
    patch: { slotReference: { slotId: 'slot_english_b', evidence: '12/06/2030 às 14h' } },
  },
  'Meu nome é Ana. Meu email é ana@example.com. Quero prosseguir com o cadastro.': {
    patch: { name: 'Ana', contact: { type: 'email', value: 'ana@example.com' } }, tool: 'create_lead', args: leadArgs,
  },
  'Meu nome é Bruno. Meu email é bruno@example.com. Quero prosseguir com o cadastro.': {
    patch: { name: 'Bruno', contact: { type: 'email', value: 'bruno@example.com' } }, tool: 'create_lead', args: leadArgs,
  },
  'Meu email correto é ana.novo@example.com.': {
    patch: { contact: { type: 'email', value: 'ana.novo@example.com' } }, tool: 'create_lead', args: leadArgs,
  },
  'Na verdade, quero principalmente entrevistas de emprego.': {
    patch: { goal: 'entrevistas de emprego' }, tool: 'create_lead', args: leadArgs,
  },
  'Quero revisar o cadastro.': { tool: 'create_lead', args: leadArgs },
  'Quero agendar a aula.': { tool: 'schedule_trial_class', args: ({ leadId, slotId }) => ({ leadId, slotId }) },
  'Quero falar com alguém.': { tool: 'transfer_to_human', args: () => ({ reason: 'Quero falar com alguém.' }) },
  'Quero falar com uma pessoa por outra dúvida.': {
    tool: 'transfer_to_human', args: () => ({ reason: 'Quero falar com uma pessoa por outra dúvida.' }),
  },
  'Ofereça o registro local.': { reply: handoffOffer },
  'sim': { tool: 'transfer_to_human', args: () => ({ reason: 'Aceitação da oferta de registro local.' }) },
};

function currentStep(messages: readonly BaseMessage[]): Step | undefined {
  const text = [...messages].reverse().find((message) => message.type === 'human')?.text ?? '';
  return Object.hasOwn(manualScript, text) ? manualScript[text] : undefined;
}

export function createManualWhatsAppModel(): ScriptedChatModel {
  return new ScriptedChatModel([], { fallback: {
    context: (messages) => ({ goal: null, name: null, contact: null, courseReference: null, slotReference: null,
      ...currentStep(messages)?.patch }),
    response: (messages) => {
      if (messages.at(-1)?.type === 'tool' || messages.some((message) => message.name === 'official_receipt')) {
        return new AIMessage('Consulte o resultado oficial desta demonstração.');
      }
      const step = currentStep(messages);
      if (!step) return new AIMessage('Este teste usa frases exatas do roteiro manual. Envie uma das frases documentadas; confirme somente pelos botões.');
      if (!step.tool) return new AIMessage(step.reply ?? 'Seleção recebida. Consulte os dados oficiais antes de confirmar.');
      const description = messages.find((message) => message.name === 'conversation_context')?.text;
      if (!description) throw new Error('Contexto oficial ausente no roteiro manual.');
      const context = conversationContextSchema.parse(JSON.parse(description.slice(description.indexOf('{'))));
      return new AIMessage({ content: '', tool_calls: [{
        name: step.tool, args: step.args?.(context) ?? {}, id: 'manual_call', type: 'tool_call',
      }] });
    },
  } });
}
