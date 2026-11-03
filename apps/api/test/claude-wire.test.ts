import { connect, payments, runMigrations, seed } from '@dojang/db';
import { buildApp as buildErp } from '@dojang/mcp-erp/app';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeModel } from '../src/agent/model.ts';
import { buildApp } from '../src/app.ts';

/** Claude API를 흉내 내는 서버로 실제 ChatAnthropic의 요청 형식을 검증한다. */
const url =
  process.env.TEST_DATABASE_URL ?? 'postgres://dojang:dojang@localhost:5432/dojang_test';
const JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
const { db, close } = connect(url);

interface ClaudeRequest {
  model: string;
  stream?: boolean;
  system: unknown;
  tools: { name: string; input_schema: { type: string } }[];
  messages: { role: string; content: string | { type: string; tool_use_id?: string; id?: string }[] }[];
}

const requests: ClaudeRequest[] = [];
let script: { text?: string; tool?: { id: string; name: string; input: unknown } }[] = [];

const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

const usage = { input_tokens: 10, output_tokens: 5 };

function respond(step: (typeof script)[number]): string {
  // 실제 API처럼 응답마다 다른 ID를 쓴다. 같으면 LangGraph가 메시지를 덮어쓴다.
  const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, stop_sequence: null, usage };
  const block = step.tool
    ? [
        sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: step.tool.id, name: step.tool.name, input: {} } }),
        sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }),
      ]
    : [
        sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text ?? '' } }),
      ];
  return [
    sse('message_start', { message }),
    ...block,
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    sse('message_stop', {}),
  ].join('');
}

const claude: Server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    requests.push(JSON.parse(body) as ClaudeRequest);
    const step = script.shift();
    if (!step) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(respond(step));
  });
});

let erp: FastifyInstance;
let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations(db);
  await seed(db);
  await new Promise<void>((resolve) => claude.listen(0, '127.0.0.1', resolve));
  erp = await buildErp({ JWT_SECRET }, db);
  await erp.listen({ host: '127.0.0.1', port: 0 });
  const mcpPort = (erp.server.address() as AddressInfo).port;
  const model = createClaudeModel(
    { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'claude-sonnet-5-5' },
    { baseUrl: `http://127.0.0.1:${(claude.address() as AddressInfo).port}` },
  );
  app = await buildApp(
    { JWT_SECRET, DEMO_LOGIN: true, DATABASE_URL: url, MCP_URL: `http://127.0.0.1:${mcpPort}/mcp` },
    db,
    { model },
  );
});

afterAll(async () => {
  await app.close();
  await erp.close();
  claude.close();
  await close();
});

describe('Claude API 연동', () => {
  it('도구 호출과 결과를 올바른 형식으로 주고받고 전결 지급까지 완료한다', async () => {
    script = [
      { tool: { id: 'toolu_1', name: 'list_open_payables', input: { vendorId: 'v-alpha' } } },
      { tool: { id: 'toolu_2', name: 'propose_payment', input: { invoiceId: 'i-alpha-2', amountKrw: 800_000 } } },
    ];
    const login = await app.inject({ method: 'POST', url: '/auth/demo-login', payload: { userId: 'u-kim' } });
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const thread = await app.inject({ method: 'POST', url: '/chat/threads', headers });
    const response = await app.inject({
      method: 'POST',
      url: `/chat/threads/${thread.json().threadId as string}/messages`,
      headers,
      payload: { content: '가람상사 80만 원 지급해 줘' },
    });

    expect(response.body).toContain('800,000원 지급을 완료했습니다.');
    expect(await db.select().from(payments)).toHaveLength(1);

    expect(requests).toHaveLength(2);
    const [first, second] = requests as [ClaudeRequest, ClaudeRequest];
    expect(first.model).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(first.system)).toContain('도장');
    expect(first.messages.every((message) => message.role !== 'system')).toBe(true);
    expect(first.tools.map((tool) => tool.name).sort()).toEqual([
      'get_invoice',
      'list_open_payables',
      'propose_payment',
      'search_vendors',
    ]);
    expect(first.tools.every((tool) => tool.input_schema.type === 'object')).toBe(true);

    const toolResult = second.messages.at(-1);
    expect(toolResult?.role).toBe('user');
    expect(toolResult?.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_1' }),
    ]);
  });
});
