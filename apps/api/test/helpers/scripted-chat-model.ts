import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelCallOptions,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

type ScriptedStep = AIMessage | Error | ((messages: readonly BaseMessage[]) => AIMessage);

// Exercita invoke/generate do LangChain, substituindo somente a geração externa.
export class ScriptedChatModel extends BaseChatModel {
  readonly calls: { messages: BaseMessage[]; options: BaseChatModelCallOptions }[] = [];
  boundTools: BindToolsInput[] = [];
  private readonly steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    super({});
    this.steps = [...steps];
  }

  _llmType() {
    return 'scripted-chat-test';
  }

  bindTools(tools: BindToolsInput[]) {
    this.boundTools = [...tools];
    return this;
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    this.calls.push({ messages: [...messages], options: { ...options } });
    const step = this.steps.shift();
    if (!step) throw new Error('O teste não definiu resposta para esta chamada do modelo.');
    if (step instanceof Error) throw step;
    const message = typeof step === 'function' ? step(messages) : step;
    return {
      generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }],
    };
  }
}
