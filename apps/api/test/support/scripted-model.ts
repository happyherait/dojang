import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/** 정해진 응답을 순서대로 돌려주는 모델. 공격자가 조종한 LLM 출력도 재현할 수 있다. */
export class ScriptedModel extends BaseChatModel {
  readonly boundToolNames: string[][] = [];
  readonly received: BaseMessage[][] = [];

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType() {
    return 'scripted';
  }

  override bindTools(tools: unknown[]) {
    this.boundToolNames.push(tools.map((tool) => (tool as { name: string }).name));
    return this as never;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.received.push(messages);
    const message = this.script.shift();
    if (!message) throw new Error('스크립트가 끝났습니다.');
    return { generations: [{ text: message.text, message }] };
  }
}

let callCounter = 0;

export const callTool = (name: string, args: Record<string, unknown>) =>
  new AIMessage({
    content: '',
    tool_calls: [{ id: `call-${++callCounter}`, name, args, type: 'tool_call' }],
  });

export const say = (text: string) => new AIMessage(text);
