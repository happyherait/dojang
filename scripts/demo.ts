/** 김사원이 요청하고 박팀장이 승인하는 과정을 터미널에서 재현한다. */
export {};

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const request = process.argv[2] ?? '가람상사 청구서 A-2026-1101 300만 원 지급해 줘';

const api = async (path: string, token?: string, body?: unknown) => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${API}${path}`, init);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
};

const json = async <T>(response: Response) => (await response.json()) as T;

const login = async (userId: string) =>
  (await json<{ token: string }>(await api('/auth/demo-login', undefined, { userId }))).token;

interface Done {
  status: string;
  approvalId: string | null;
  reply: string;
}

async function chat(threadId: string, token: string, content: string): Promise<Done> {
  const response = await api(`/chat/threads/${threadId}/messages`, token, { content });
  const decoder = new TextDecoder();
  let buffer = '';
  let done: Done | undefined;

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const [eventLine, dataLine] = frame.split('\n');
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice('event: '.length);
      const data = JSON.parse(dataLine.slice('data: '.length));
      if (event === 'token') process.stdout.write(data.text);
      if (event === 'step') console.log(`\n  [단계] ${data.node}`);
      if (event === 'done') done = data;
      if (event === 'error') throw new Error(`에이전트 오류: ${data.detail ?? data.error}`);
    }
  }
  if (!done) throw new Error('응답이 끝나지 않았습니다.');
  return done;
}

const employee = await login('u-kim');
const { threadId } = await json<{ threadId: string }>(await api('/chat/threads', employee, {}));

console.log(`\n김사원: ${request}\n`);
const result = await chat(threadId, employee, request);
console.log(`\n도장: ${result.reply}`);
console.log(`상태: ${result.status}`);

if (result.status === 'waiting_approval') {
  const lead = await login('u-park');
  const inbox = await json<{ approvalId: string; stepOrder: number; vendorName: string; reasons: string[] }[]>(
    await api('/approvals/inbox', lead),
  );
  const item = inbox.find((entry) => entry.approvalId === result.approvalId);
  if (!item) {
    console.log('\n박팀장의 결재함에 없는 건입니다. 다른 결재자가 처리해야 합니다.');
  } else {
    console.log(`\n박팀장 결재함: ${item.vendorName} / ${item.reasons.join(' ')}`);
    const decision = await json<{ status: string }>(
      await api(`/approvals/${item.approvalId}/steps/${item.stepOrder}/decision`, lead, { decision: 'approve' }),
    );
    console.log(`박팀장 승인 결과: ${decision.status}`);
    const thread = await json<{ messages: { content: string }[] }>(await api(`/chat/threads/${threadId}`, employee));
    console.log(`\n도장: ${thread.messages.at(-1)?.content}`);
  }
}
