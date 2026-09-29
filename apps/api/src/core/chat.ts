import type { BaseChatModel, BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage, ToolCall, ToolMessage } from '@langchain/core/messages';
import type { Conversation } from './conversations.js';

export type ToolExecutionScope<Context> = {
  conversationId: string;
  context: Context;
  // Dados do turno mantidos pelo servidor, fora dos argumentos do modelo.
  message: string;
  history: readonly BaseMessage[];
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
  describeResults?: (results: readonly unknown[]) => { reply: string; hasRecordedWrite: boolean } | undefined;
};

export function createChatRunner<Context>({
  model, instructions, tools, executeTool, updateContext, describeContext, describeResults,
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
        message,
        history: [...conversation.history],
        proposeAction: (proposal) => { actionProposal = structuredClone(proposal); },
      });
      turnHistory.push(output.message);
      results.push(output.result);
    }

    // Uma rodada de tools, seguida de redação sem ferramentas. Não há loop do agente.
    const presentation = describeResults?.(structuredClone(results));
    let response;
    try {
      response = calls.length ? await model.invoke(messages()) : selection;
      if (response.tool_calls?.length || response.invalid_tool_calls?.length
        || (presentation && (typeof response.content !== 'string' || !response.content.trim()))) {
        throw new Error('Resposta final de chat inválida.');
      }
      if (presentation) response = new AIMessage(presentation.reply);
    } catch (error) {
      // Recupera somente a redação posterior a um resultado já registrado.
      // Outras falhas e turnos sem escrita continuam atômicos como antes.
      if (!presentation?.hasRecordedWrite) throw error;
      response = new AIMessage(presentation.reply);
      // Propostas de outras operações não sobrevivem a uma redação fracassada.
      actionProposal = undefined;
    }

    if (calls.length) {
      turnHistory.push(response);
    }

    return { reply: response.text, results, history: turnHistory, context, actionProposal };
  };
}
