import type { PaymentProposal } from '@dojang/contracts';
import {
  approvals,
  approvalSteps,
  auditEvents,
  chatThreads,
  connect,
  invoices,
  payments,
  runMigrations,
  seed,
  users,
  vendors,
} from '@dojang/db';
import { hashProposal } from '@dojang/policy';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const url =
  process.env.TEST_DATABASE_URL ?? 'postgres://dojang:dojang@localhost:5432/dojang_test';
const JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
const { db, close } = connect(url);

let app: FastifyInstance;
let baseUrl: string;
const clients: Client[] = [];

const CLAIMS = {
  kim: { sub: 'u-kim', name: '김사원', role: 'employee', department: '재무팀' },
  park: { sub: 'u-park', name: '박팀장', role: 'team_lead', department: '재무팀' },
  choi: { sub: 'u-choi', name: '최재무', role: 'finance_manager', department: '재무팀' },
} as const;

const clientFor = async (claims: (typeof CLAIMS)[keyof typeof CLAIMS]) => {
  const client = new Client({ name: 'dojang-test', version: '0.0.0' });
  const token = app.jwt.sign(claims, { expiresIn: '5m' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, data: JSON.parse(first!.text) };
};

const proposal: PaymentProposal = {
  vendorId: 'v-alpha',
  invoiceId: 'i-alpha-1',
  bankAccount: '100-000-000001',
  amountKrw: 3_000_000,
};

/** 2주차의 결재 API가 만들 상태를 직접 구성한다. */
async function approvalFixture(options: {
  proposal?: PaymentProposal;
  status?: 'pending' | 'approved';
  decidedBy?: string | null;
  expiresAt?: Date;
} = {}) {
  const approved = options.proposal ?? proposal;
  const status = options.status ?? 'approved';
  const decidedBy = options.decidedBy === undefined ? 'u-park' : options.decidedBy;
  const [thread] = await db.insert(chatThreads).values({ ownerId: 'u-kim' }).returning();
  const [approval] = await db
    .insert(approvals)
    .values({
      threadId: thread!.id,
      proposalKey: randomUUID(),
      requesterId: 'u-kim',
      proposal: approved,
      proposalHash: hashProposal(approved),
      policyVersion: 1,
      status,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
    })
    .returning();
  await db.insert(approvalSteps).values({
    approvalId: approval!.id,
    stepOrder: 1,
    requiredRole: 'team_lead',
    department: '재무팀',
    status: decidedBy ? 'approved' : 'pending',
    decidedBy,
  });
  return approval!.id;
}

const paymentCount = async () => (await db.select().from(payments)).length;

beforeAll(async () => {
  await runMigrations(db);
  app = await buildApp({ JWT_SECRET }, db);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('주소를 찾을 수 없습니다.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => seed(db));

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await app.close();
  await close();
});

describe('MCP 연결', () => {
  it('토큰 없는 요청은 거부한다', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('삭제된 사용자의 토큰은 거부한다', async () => {
    await db.insert(users).values({ id: 'u-temp', name: '임시', role: 'ceo', department: '경영진' });
    const token = app.jwt.sign({ sub: 'u-temp', name: '임시', role: 'ceo', department: '경영진' });
    await db.delete(users).where(eq(users.id, 'u-temp'));
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('도구 목록과 쓰기 표시를 제공한다', async () => {
    const client = await clientFor(CLAIMS.kim);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'execute_payment',
      'get_invoice',
      'list_open_payables',
      'search_vendors',
    ]);
    expect(tools.find((tool) => tool.name === 'execute_payment')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'get_invoice')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('읽기 도구', () => {
  it('거래처를 검색한다', async () => {
    const { data } = await call(await clientFor(CLAIMS.kim), 'search_vendors', { query: '나래' });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'v-beta', isNewVendor: true });
  });

  it('검색어의 와일드카드를 글자로 취급한다', async () => {
    const { data } = await call(await clientFor(CLAIMS.kim), 'search_vendors', { query: '%' });
    expect(data).toEqual([]);
  });

  it('직원은 자기 부서 미지급금만 본다', async () => {
    const { data } = await call(await clientFor(CLAIMS.kim), 'list_open_payables', {});
    expect(data.map((invoice: { id: string }) => invoice.id)).not.toContain('i-gamma-2');
    expect(data).toHaveLength(4);
  });

  it('재무 책임자는 전사 미지급금을 본다', async () => {
    const { data } = await call(await clientFor(CLAIMS.choi), 'list_open_payables', {});
    expect(data).toHaveLength(5);
  });

  it('권한 없는 청구서는 없는 것처럼 응답한다', async () => {
    const result = await call(await clientFor(CLAIMS.kim), 'get_invoice', { invoiceId: 'i-gamma-2' });
    expect(result).toEqual({ isError: true, data: { code: 'INVOICE_NOT_FOUND' } });
  });
});

describe('execute_payment', () => {
  const execute = async (
    approvalId: string,
    overrides: { proposal?: PaymentProposal; key?: string } = {},
    claims: (typeof CLAIMS)[keyof typeof CLAIMS] = CLAIMS.kim,
  ) =>
    call(await clientFor(claims), 'execute_payment', {
      approvalId,
      idempotencyKey: overrides.key ?? randomUUID(),
      proposal: overrides.proposal ?? proposal,
    });

  it('승인된 건을 지급하고 청구서와 감사 로그를 갱신한다', async () => {
    const approvalId = await approvalFixture();
    const result = await execute(approvalId);

    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ ok: true, replayed: false });
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, 'i-alpha-1'));
    expect(invoice).toMatchObject({ paidKrw: 3_000_000, status: 'paid' });
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval?.status).toBe('executed');
    const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, approvalId));
    expect(events.map((event) => event.action)).toEqual(['payment.executed']);
  });

  it.each([
    ['금액', { amountKrw: 2_999_999 }],
    ['계좌', { bankAccount: '999-999-999999' }],
    ['청구서', { invoiceId: 'i-alpha-2' }],
  ])('승인 후 %s이 바뀐 처리안은 지급하지 않고 기록을 남긴다', async (_field, change) => {
    const approvalId = await approvalFixture();
    const result = await execute(approvalId, { proposal: { ...proposal, ...change } });

    expect(result).toEqual({ isError: true, data: { ok: false, code: 'PROPOSAL_MISMATCH' } });
    expect(await paymentCount()).toBe(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.subjectId, approvalId));
    expect(events[0]).toMatchObject({ action: 'payment.denied', payload: { code: 'PROPOSAL_MISMATCH' } });
  });

  it('대기 중인 결재는 지급하지 않는다', async () => {
    const approvalId = await approvalFixture({ status: 'pending', decidedBy: null });
    expect((await execute(approvalId)).data.code).toBe('APPROVAL_NOT_APPROVED');
    expect(await paymentCount()).toBe(0);
  });

  it('상태만 조작된 승인은 지급하지 않는다', async () => {
    const approvalId = await approvalFixture({ status: 'approved', decidedBy: null });
    expect((await execute(approvalId)).data.code).toBe('ROUTE_NOT_SATISFIED');
    expect(await paymentCount()).toBe(0);
  });

  it('요청자가 자기 건을 승인한 기록은 인정하지 않는다', async () => {
    const approvalId = await approvalFixture({ decidedBy: 'u-kim' });
    expect((await execute(approvalId)).data.code).toBe('SELF_APPROVAL');
  });

  it('요청자가 아닌 사용자는 실행할 수 없다', async () => {
    const approvalId = await approvalFixture();
    expect((await execute(approvalId, {}, CLAIMS.park)).data.code).toBe('NOT_REQUESTER');
  });

  it('존재하지 않는 결재는 거부한다', async () => {
    expect((await execute(randomUUID())).data.code).toBe('APPROVAL_NOT_FOUND');
  });

  it('만료된 승인은 거부한다', async () => {
    const approvalId = await approvalFixture({ expiresAt: new Date(Date.now() - 1_000) });
    expect((await execute(approvalId)).data.code).toBe('APPROVAL_EXPIRED');
  });

  it('승인 후 거래처 계좌가 바뀌면 다시 결재를 받아야 한다', async () => {
    const approvalId = await approvalFixture();
    await db
      .update(vendors)
      .set({ bankAccount: '555-555-555555', bankAccountChangedAt: new Date() })
      .where(eq(vendors.id, 'v-alpha'));
    expect((await execute(approvalId)).data.code).toBe('ROUTE_NOT_SATISFIED');
    expect(await paymentCount()).toBe(0);
  });

  it('잔액을 넘는 지급은 거부한다', async () => {
    const approvalId = await approvalFixture();
    await db.update(invoices).set({ paidKrw: 1_000_000 }).where(eq(invoices.id, 'i-alpha-1'));
    expect((await execute(approvalId)).data.code).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
  });

  it('같은 멱등키로 재시도하면 처음 결과를 돌려주고 한 번만 지급한다', async () => {
    const approvalId = await approvalFixture();
    const key = randomUUID();
    const first = await execute(approvalId, { key });
    const second = await execute(approvalId, { key });

    expect(second.data).toEqual({ ok: true, paymentId: first.data.paymentId, replayed: true });
    expect(await paymentCount()).toBe(1);
  });

  it('다른 멱등키로 다시 실행해도 한 번만 지급한다', async () => {
    const approvalId = await approvalFixture();
    await execute(approvalId);
    expect((await execute(approvalId)).data.code).toBe('ALREADY_EXECUTED');
    expect(await paymentCount()).toBe(1);
  });

  it('멱등키를 다른 결재에 재사용하면 거부한다', async () => {
    const key = randomUUID();
    await execute(await approvalFixture(), { key });
    const other: PaymentProposal = { ...proposal, invoiceId: 'i-alpha-2', amountKrw: 800_000 };
    const result = await execute(await approvalFixture({ proposal: other }), { key, proposal: other });
    expect(result.data.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('동시에 같은 멱등키로 요청해도 한 번만 지급한다', async () => {
    const approvalId = await approvalFixture();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => execute(approvalId, { key })));

    expect(results.every((result) => result.data.ok)).toBe(true);
    expect(new Set(results.map((result) => result.data.paymentId)).size).toBe(1);
    expect(await paymentCount()).toBe(1);
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, 'i-alpha-1'));
    expect(invoice?.paidKrw).toBe(3_000_000);
  });

  it('동시에 다른 멱등키로 요청해도 한 번만 지급한다', async () => {
    const approvalId = await approvalFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => execute(approvalId)));

    expect(results.filter((result) => result.data.ok)).toHaveLength(1);
    expect(await paymentCount()).toBe(1);
  });
});
