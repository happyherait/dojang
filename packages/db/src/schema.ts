import type { PaymentProposal, Role } from '@dojang/contracts';
import type { ApprovalRule } from '@dojang/policy';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'number' });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const roleEnum = pgEnum('role', ['employee', 'team_lead', 'finance_manager', 'ceo']);
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
]);
export const stepStatusEnum = pgEnum('step_status', ['pending', 'approved', 'rejected']);
export const invoiceStatusEnum = pgEnum('invoice_status', ['open', 'paid']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'agent', 'system']);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: roleEnum('role').notNull(),
  department: text('department').notNull(),
});

export const vendors = pgTable('vendors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  businessNumber: text('business_number').notNull().unique(),
  bankAccount: text('bank_account').notNull(),
  bankAccountChangedAt: timestamptz('bank_account_changed_at'),
  firstPaidAt: timestamptz('first_paid_at'),
});

export const invoices = pgTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id),
    invoiceNumber: text('invoice_number').notNull(),
    department: text('department').notNull(),
    amountKrw: money('amount_krw').notNull(),
    paidKrw: money('paid_krw').notNull().default(0),
    dueDate: date('due_date').notNull(),
    status: invoiceStatusEnum('status').notNull().default('open'),
  },
  (table) => [unique('invoices_vendor_number_unique').on(table.vendorId, table.invoiceNumber)],
);

export const approvalPolicies = pgTable(
  'approval_policies',
  {
    version: integer('version').primaryKey(),
    rules: jsonb('rules').$type<ApprovalRule[]>().notNull(),
    riskyPayeeRoles: jsonb('risky_payee_roles').$type<Role[]>().notNull(),
    active: boolean('active').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // 활성 규정은 한 번에 하나만 존재한다.
    uniqueIndex('approval_policies_single_active').on(table.active).where(sql`active`),
  ],
);

export const chatThreads = pgTable('chat_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id),
    /** 대화와 도구 호출 ID로 만든 값. 노드가 재실행되어도 결재가 중복되지 않는다. */
    proposalKey: text('proposal_key').notNull().unique(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    requesterId: text('requester_id')
      .notNull()
      .references(() => users.id),
    proposal: jsonb('proposal').$type<PaymentProposal>().notNull(),
    proposalHash: text('proposal_hash').notNull(),
    policyVersion: integer('policy_version')
      .notNull()
      .references(() => approvalPolicies.version),
    status: approvalStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('approvals_requester_idx').on(table.requesterId)],
);

export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalId: uuid('approval_id')
      .notNull()
      .references(() => approvals.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    requiredRole: roleEnum('required_role').notNull(),
    department: text('department'),
    status: stepStatusEnum('status').notNull().default('pending'),
    decidedBy: text('decided_by').references(() => users.id),
    decidedAt: timestamptz('decided_at'),
    comment: text('comment'),
  },
  (table) => [unique('approval_steps_order_unique').on(table.approvalId, table.stepOrder)],
);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  approvalId: uuid('approval_id')
    .notNull()
    .unique()
    .references(() => approvals.id),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  vendorId: text('vendor_id')
    .notNull()
    .references(() => vendors.id),
  invoiceId: text('invoice_id')
    .notNull()
    .references(() => invoices.id),
  bankAccount: text('bank_account').notNull(),
  amountKrw: money('amount_krw').notNull(),
  requestedBy: text('requested_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [index('audit_events_subject_idx').on(table.subjectType, table.subjectId)],
);
