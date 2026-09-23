import type { BaseChatModel, BindToolsInput } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage, ToolCall, ToolMessage } from '@langchain/core/messages';
import type { Conversation } from './conversations.js';

export type ToolExecutionScope<Context> = {
  conversationId: string;
  context: Context;
  // undefined: preservar; null: retirar a prévia; objeto: propor substituição.
  proposeAction: (proposal: unknown | null) => void;
};

type ChatComposition<Context> = {
  model: BaseChatModel | null;
  instructions: string;
  tools: BindToolsInput[];
  executeTool: (call: ToolCall, scope: ToolExecutionScope<Context>) => Promise<{ message: ToolMessage; result: unknown }>;
  updateContext: (current: Context, history: BaseMessage[], message: string) => Promise<Context>;
  describeContext: (context: Context) => string;
};

export function createChatRunner<Context>({
  model, instructions, tools, executeTool, updateContext, describeContext,
}: ChatComposition<Context>) {
  return async function runTurn(conversation: Conversation<Context>, message: string) {
    if (!model?.bindTools) {
      throw new Error('Modelo de chat indisponível.');
    }

    const context = await updateContext(
      structuredClone(conversation.context), conversation.history, message,
    );
    const turnHistory = [...conversation.history, new HumanMessage(message)];
    const messages = () => [
      new SystemMessage(instructions),
      new SystemMessage({ name: 'conversation_context', content: describeContext(context) }),
      ...turnHistory,
    ];
    const selection = await model.bindTools(tools).invoke(messages());

    if (selection.invalid_tool_calls?.length) {
      throw new Error('Chamada de ferramenta inválida.');
    }

    turnHistory.push(selection);
    const results: unknown[] = [];
    const calls = selection.tool_calls ?? [];
    let actionProposal: unknown = undefined;

    for (const call of calls) {
      const output = await executeTool(call, {
        conversationId: conversation.id,
        context: structuredClone(context),
        proposeAction: (proposal) => { actionProposal = structuredClone(proposal); },
      });
      turnHistory.push(output.message);
      results.push(output.result);
    }

    // Uma rodada de tools, seguida de redação sem ferramentas. Não há loop do agente.
    const response = calls.length
      ? await model.invoke(messages())
      : selection;

    if (response.tool_calls?.length || response.invalid_tool_calls?.length) {
      throw new Error('Resposta final de chat inválida.');
    }

    if (calls.length) {
      turnHistory.push(response);
    }

    return { reply: response.text, results, history: turnHistory, context, actionProposal };
  };
}
