import type { BaseChatModel, BindToolsInput } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage, ToolCall, ToolMessage } from '@langchain/core/messages';

type ChatComposition = {
  model: BaseChatModel | null;
  instructions: string;
  tools: BindToolsInput[];
  executeTool: (call: ToolCall) => Promise<{ message: ToolMessage; result: unknown }>;
};

export function createChatRunner({ model, instructions, tools, executeTool }: ChatComposition) {
  return async function runTurn(history: BaseMessage[], message: string) {
    if (!model?.bindTools) {
      throw new Error('Modelo de chat indisponível.');
    }

    const turnHistory = [...history, new HumanMessage(message)];
    const messages = () => [new SystemMessage(instructions), ...turnHistory];
    const selection = await model.bindTools(tools).invoke(messages());

    if (selection.invalid_tool_calls?.length) {
      throw new Error('Chamada de ferramenta inválida.');
    }

    turnHistory.push(selection);
    const results: unknown[] = [];
    const calls = selection.tool_calls ?? [];

    for (const call of calls) {
      const output = await executeTool(call);
      turnHistory.push(output.message);
      results.push(output.result);
    }

    // Uma rodada de consultas, seguida de redação sem ferramentas. Não há loop do agente.
    const response = calls.length
      ? await model.invoke(messages())
      : selection;

    if (response.tool_calls?.length || response.invalid_tool_calls?.length) {
      throw new Error('Resposta final de chat inválida.');
    }

    if (calls.length) {
      turnHistory.push(response);
    }

    return { reply: response.text, results, history: turnHistory };
  };
}
