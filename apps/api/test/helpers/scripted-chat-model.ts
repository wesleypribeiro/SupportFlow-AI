import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelCallOptions,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

type ScriptedStep = AIMessage | Error | ((messages: readonly BaseMessage[]) => AIMessage | Promise<AIMessage>);
type ScriptedCallOptions = BaseChatModelCallOptions & { tools?: BindToolsInput[] };
type RecordedCall = { messages: BaseMessage[]; options: ScriptedCallOptions };

function isContextTool(tool: BindToolsInput) {
  return 'function' in tool && tool.function?.name === 'interpret_context_patch';
}

// Exercita invoke/generate do LangChain, substituindo somente a geração externa.
export class ScriptedChatModel extends BaseChatModel<ScriptedCallOptions> {
  readonly calls: RecordedCall[] = [];
  readonly contextCalls: RecordedCall[] = [];
  boundTools: BindToolsInput[] = [];
  private readonly steps: ScriptedStep[];
  private readonly contextSteps: unknown[];

  constructor(steps: ScriptedStep[], options: { contextSteps?: unknown[] } = {}) {
    super({});
    this.steps = [...steps];
    this.contextSteps = [...options.contextSteps ?? []];
  }

  _llmType() {
    return 'scripted-chat-test';
  }

  bindTools(tools: BindToolsInput[], kwargs?: Partial<ScriptedCallOptions>) {
    if (!tools.some(isContextTool)) this.boundTools = [...tools];
    return this.withConfig({ ...kwargs, tools: [...tools] });
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    if (options.tools?.some(isContextTool)) {
      this.contextCalls.push({ messages: [...messages], options: { ...options } });
      const patch = this.contextSteps.length
        ? this.contextSteps.shift()
        : { goal: null, name: null, contact: null, courseReference: null };
      if (patch instanceof Error) throw patch;

      // O parser de structured output do LangChain processa a resposta simulada.
      const message = new AIMessageChunk({
        content: '',
        tool_calls: [{
          name: 'interpret_context_patch',
          // Roteiros anteriores à agenda omitem o novo campo; o transporte
          // simulado fornece a ausência explícita exigida pelo structured output.
          args: patch && typeof patch === 'object' && !Array.isArray(patch)
            ? { slotReference: null, ...patch } : patch as Record<string, unknown>,
          id: `call_context_${this.contextCalls.length}`,
          type: 'tool_call',
        }],
      });
      return { generations: [{ message, text: '' }] };
    }

    this.calls.push({ messages: [...messages], options: { ...options } });
    const step = this.steps.shift();
    if (!step) throw new Error('O teste não definiu resposta para esta chamada do modelo.');
    if (step instanceof Error) throw step;
    const message = typeof step === 'function' ? await step(messages) : step;
    return {
      generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }],
    };
  }
}
