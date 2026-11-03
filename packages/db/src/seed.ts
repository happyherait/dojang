import { DEFAULT_POLICY } from '@dojang/policy';
import { sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { approvalPolicies, invoices, users, vendors } from './schema.ts';

const FINANCE = '재무팀';
const PURCHASING = '구매팀';

/** 시연용 가상 데이터. 실제 회사나 인물과 무관하다. */
export const DEMO_USERS = [
  { id: 'u-kim', name: '김사원', role: 'employee', department: FINANCE },
  { id: 'u-park', name: '박팀장', role: 'team_lead', department: FINANCE },
  { id: 'u-lee', name: '이팀장', role: 'team_lead', department: PURCHASING },
  { id: 'u-choi', name: '최재무', role: 'finance_manager', department: FINANCE },
  { id: 'u-han', name: '한대표', role: 'ceo', department: '경영진' },
] as const;

export async function seed(db: Db, now = new Date()): Promise<void> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`TRUNCATE payments, approval_steps, approvals, chat_threads, approval_policies, invoices, vendors, users, audit_events RESTART IDENTITY CASCADE`,
    );

    await tx.insert(users).values([...DEMO_USERS]);

    await tx.insert(approvalPolicies).values({
      version: DEFAULT_POLICY.version,
      rules: DEFAULT_POLICY.rules,
      riskyPayeeRoles: DEFAULT_POLICY.riskyPayeeRoles,
      active: true,
    });

    await tx.insert(vendors).values([
      {
        id: 'v-alpha',
        name: '가람상사(가상)',
        businessNumber: '000-00-00001',
        bankAccount: '100-000-000001',
        firstPaidAt: daysAgo(400),
      },
      {
        id: 'v-beta',
        name: '나래테크(가상)',
        businessNumber: '000-00-00002',
        bankAccount: '100-000-000002',
      },
      {
        id: 'v-gamma',
        name: '다솜물산(가상)',
        businessNumber: '000-00-00003',
        bankAccount: '100-000-000003',
        firstPaidAt: daysAgo(200),
        bankAccountChangedAt: daysAgo(3),
      },
    ]);

    await tx.insert(invoices).values([
      {
        id: 'i-alpha-1',
        vendorId: 'v-alpha',
        invoiceNumber: 'A-2026-1101',
        department: FINANCE,
        amountKrw: 3_000_000,
        dueDate: '2026-11-30',
      },
      {
        id: 'i-alpha-2',
        vendorId: 'v-alpha',
        invoiceNumber: 'A-2026-1102',
        department: FINANCE,
        amountKrw: 800_000,
        dueDate: '2026-11-30',
      },
      {
        id: 'i-beta-1',
        vendorId: 'v-beta',
        invoiceNumber: 'B-2026-0007',
        department: FINANCE,
        amountKrw: 12_000_000,
        dueDate: '2026-12-15',
      },
      {
        id: 'i-gamma-1',
        vendorId: 'v-gamma',
        invoiceNumber: 'C-2026-0042',
        department: FINANCE,
        amountKrw: 4_500_000,
        dueDate: '2026-12-01',
      },
      {
        id: 'i-gamma-2',
        vendorId: 'v-gamma',
        invoiceNumber: 'C-2026-0043',
        department: PURCHASING,
        amountKrw: 2_000_000,
        dueDate: '2026-12-01',
      },
    ]);
  });
}
