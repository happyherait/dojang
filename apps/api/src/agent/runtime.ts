import { approvals, type Db } from '@dojang/db';
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { inArray } from 'drizzle-orm';
import { expireOverdue } from '../approvals/service.ts';
import { wrapUntrustedDocument } from '../documents/pdf.ts';
import { buildAgentGraph, type GraphDeps } from './graph.ts';

const RECURSION_LIMIT = 25;

const runConfig = (threadId: string) => ({
  configurable: { thread_id: threadId },
  recursionLimit: RECURSION_LIMIT,
});

export interface ThreadView {
  status: 'idle' | 'waiting_approval' | 'interrupted';
  approvalId: string | null;
  messages: { role: 'user' | 'assistant'; content: string; attachmentName?: string }[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface TurnInput {
  content: string;
  document?: { name: string; text: string } | undefined;
}

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'step'; node: string };

export async function createAgentRuntime(deps: GraphDeps & { db: Db; databaseUrl: string }) {
  const checkpointer = PostgresSaver.fromConnString(deps.databaseUrl, { schema: 'langgraph' });
  await checkpointer.setup();
  const graph = buildAgentGraph(deps, checkpointer);

  const getThread = async (threadId: string): Promise<ThreadView> => {
    const snapshot = await graph.getState(runConfig(threadId));
    const values = snapshot.values as {
      messages?: {
        text: string;
        getType(): string;
        additional_kwargs?: { display?: string; attachmentName?: string };
        usage_metadata?: { input_tokens: number; output_tokens: number };
      }[];
      approvalId?: string | null;
    };
    const waiting = snapshot.tasks.some((task) => task.interrupts.length > 0);
    return {
      status: waiting ? 'waiting_approval' : snapshot.next.length > 0 ? 'interrupted' : 'idle',
      approvalId: values.approvalId ?? null,
      messages: (values.messages ?? []).flatMap((message): ThreadView['messages'] => {
        const type = message.getType();
        if (type === 'human') {
          // 격리 태그가 붙은 원문 대신 사용자가 입력한 문장만 보여 준다.
          const { display, attachmentName } = message.additional_kwargs ?? {};
          return [
            {
              role: 'user',
              content: display ?? message.text,
              ...(attachmentName ? { attachmentName } : {}),
            },
          ];
        }
        if (type === 'ai' && message.text) return [{ role: 'assistant', content: message.text }];
        return [];
      }),
      usage: (values.messages ?? []).reduce(
        (total, message) => ({
          inputTokens: total.inputTokens + (message.usage_metadata?.input_tokens ?? 0),
          outputTokens: total.outputTokens + (message.usage_metadata?.output_tokens ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0 },
      ),
    };
  };

  async function* streamTurn(
    threadId: string,
    requesterId: string,
    turn: TurnInput,
  ): AsyncGenerator<StreamEvent> {
    const message = new HumanMessage({
      content: turn.document
        ? `${turn.content}\n\n${wrapUntrustedDocument(turn.document.name, turn.document.text)}`
        : turn.content,
      additional_kwargs: {
        display: turn.content,
        ...(turn.document ? { attachmentName: turn.document.name } : {}),
      },
    });
    const stream = await graph.stream(
      { messages: [message], requesterId, approvalId: null, nextStep: 'end' },
      { ...runConfig(threadId), streamMode: ['messages', 'updates'] },
    );
    for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === 'messages') {
        const [message, metadata] = chunk as [{ text?: string }, { langgraph_node?: string }];
        if (metadata.langgraph_node === 'agent' && message.text) {
          yield { type: 'token', text: message.text };
        }
      } else {
        for (const node of Object.keys(chunk as object)) {
          if (!node.startsWith('__')) yield { type: 'step', node };
        }
      }
    }
  }

  /** 결재가 끝난 대화를 이어서 실행한다. */
  const resume = async (threadId: string): Promise<void> => {
    await graph.invoke(new Command({ resume: true }), runConfig(threadId));
  };

  /**
   * 기한이 지난 결재를 정리하고, 서버가 멈춘 사이 결재가 끝났거나 지급 노드가 중단된 대화를 재개한다.
   * 지급은 멱등하므로 같은 대화를 다시 실행해도 안전하다.
   */
  const recover = async (): Promise<string[]> => {
    await expireOverdue(deps.db);
    const rows = await deps.db
      .selectDistinct({ threadId: approvals.threadId })
      .from(approvals)
      .where(inArray(approvals.status, ['approved', 'rejected', 'expired']));

    const recovered: string[] = [];
    for (const { threadId } of rows) {
      const snapshot = await graph.getState(runConfig(threadId));
      if (snapshot.next.length === 0) continue;
      const waiting = snapshot.tasks.some((task) => task.interrupts.length > 0);
      await graph.invoke(waiting ? new Command({ resume: true }) : null, runConfig(threadId));
      recovered.push(threadId);
    }
    return recovered;
  };

  return { getThread, streamTurn, resume, recover, close: () => checkpointer.end() };
}

export type AgentRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;
