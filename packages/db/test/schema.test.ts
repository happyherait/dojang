import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalPolicies,
  auditEvents,
  connect,
  runMigrations,
  seed,
  users,
  vendors,
} from '../src/index.ts';

const url =
  process.env.TEST_DATABASE_URL ?? 'postgres://dojang:dojang@localhost:5432/dojang_test';
const { db, close } = connect(url);

beforeAll(() => runMigrations(db));
beforeEach(() => seed(db));
afterAll(() => close());

describe('시드 데이터', () => {
  it('사용자, 거래처, 활성 규정을 만든다', async () => {
    expect(await db.select().from(users)).toHaveLength(5);
    expect(await db.select().from(vendors)).toHaveLength(3);
    const active = await db.select().from(approvalPolicies).where(eq(approvalPolicies.active, true));
    expect(active).toHaveLength(1);
  });

  it('다시 실행해도 같은 상태가 된다', async () => {
    await seed(db);
    expect(await db.select().from(users)).toHaveLength(5);
  });
});

describe('데이터베이스 제약', () => {
  it('활성 규정을 두 개 만들 수 없다', async () => {
    await expect(
      db.insert(approvalPolicies).values({ version: 2, rules: [], riskyPayeeRoles: [], active: true }),
    ).rejects.toThrow();
  });

  it('감사 로그는 수정할 수 없다', async () => {
    const [event] = await db
      .insert(auditEvents)
      .values({ actorType: 'system', action: 'test', subjectType: 'test', subjectId: '1' })
      .returning();
    await expect(
      db.update(auditEvents).set({ action: 'changed' }).where(eq(auditEvents.id, event!.id)),
    ).rejects.toThrow();
  });

  it('감사 로그는 삭제할 수 없다', async () => {
    const [event] = await db
      .insert(auditEvents)
      .values({ actorType: 'system', action: 'test', subjectType: 'test', subjectId: '1' })
      .returning();
    await expect(db.delete(auditEvents).where(eq(auditEvents.id, event!.id))).rejects.toThrow();
  });
});
