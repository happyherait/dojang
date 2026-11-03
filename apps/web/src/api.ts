export interface User {
  id: string;
  name: string;
  role: string;
  department: string;
}

export interface ThreadView {
  status: 'idle' | 'waiting_approval' | 'interrupted';
  approvalId: string | null;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

export interface InboxItem {
  approvalId: string;
  stepOrder: number;
  requesterName: string;
  vendorName: string;
  proposal: { amountKrw: number };
}

export interface ApprovalDetail {
  approvalId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  requesterName: string;
  vendorName: string;
  invoiceNumber: string;
  proposal: { bankAccount: string; amountKrw: number };
  reasons: string[];
  createdAt: string;
  decidableStep: number | null;
  steps: {
    order: number;
    role: string;
    department: string | null;
    status: 'pending' | 'approved' | 'rejected';
    decidedByName: string | null;
  }[];
  timeline: {
    id: number;
    occurredAt: string;
    actorType: 'user' | 'agent' | 'system';
    actorName: string | null;
    action: string;
    code: string | null;
  }[];
}

export type StreamEvent =
  | { event: 'token'; text: string }
  | { event: 'step'; node: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function request(path: string, token: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, payload.error ?? 'REQUEST_FAILED');
  }
  return response;
}

const getJson = async <T>(path: string, token: string | null, body?: unknown) =>
  (await (await request(path, token, body)).json()) as T;

export const listUsers = () => getJson<User[]>('/auth/demo-users', null);

export const login = async (userId: string) =>
  (await getJson<{ token: string }>('/auth/demo-login', null, { userId })).token;

export const createThread = async (token: string) =>
  (await getJson<{ threadId: string }>('/chat/threads', token, {})).threadId;

export const getThread = (token: string, threadId: string) =>
  getJson<ThreadView>(`/chat/threads/${threadId}`, token);

export const getInbox = (token: string) => getJson<InboxItem[]>('/approvals/inbox', token);

export const getApproval = (token: string, approvalId: string) =>
  getJson<ApprovalDetail>(`/approvals/${approvalId}`, token);

export const decide = (
  token: string,
  approvalId: string,
  stepOrder: number,
  decision: 'approve' | 'reject',
) => request(`/approvals/${approvalId}/steps/${stepOrder}/decision`, token, { decision });

export async function sendMessage(
  token: string,
  threadId: string,
  content: string,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await request(`/chat/threads/${threadId}/messages`, token, { content });
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new ApiError(500, 'NO_STREAM');

  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const [eventLine, dataLine] = frame.split('\n');
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice('event: '.length);
      const data = JSON.parse(dataLine.slice('data: '.length)) as Record<string, string>;
      if (event === 'error') throw new ApiError(502, data.detail ?? data.error ?? 'AGENT_FAILED');
      if (event === 'token') onEvent({ event, text: data.text ?? '' });
      if (event === 'step') onEvent({ event, node: data.node ?? '' });
    }
  }
}
