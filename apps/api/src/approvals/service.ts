import type { PaymentProposal, Principal } from '@dojang/contracts';
import {
  approvalPolicies,
  approvals,
  approvalSteps,
  auditEvents,
  invoices,
  users,
  vendors,
  type Db,
} from '@dojang/db';
import {
  canAccessDepartment,
  canDecideStep,
  computeApprovalRoute,
  hashProposal,
  isBankAccountRecentlyChanged,
  type DenialCode,
  type StepRecord,
} from '@dojang/policy';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';

const APPROVAL_TTL_MS = 24 * 3_600_000;

export type ProposalOutcome =
  | { kind: 'invalid'; code: 'INVOICE_NOT_FOUND' | 'AMOUNT_EXCEEDS_OUTSTANDING' | 'INVOICE_PAID' }
  | { kind: 'blocked'; reasons: string[] }
  | { kind: 'auto'; approvalId: string; reasons: string[] }
  | { kind: 'approval'; approvalId: string; reasons: string[]; approverRoles: string[] };

/**
 * LLM이 지정한 청구서와 금액으로 결재를 만든다. 계좌는 거래처 원장에서만 가져오고,
 * 결재선은 서버가 확인한 사실로 계산한다. 같은 도구 호출은 결재를 하나만 만든다.
 */
export async function createPaymentApproval(
  db: Db,
  params: {
    threadId: string;
    toolCallId: string;
    requester: Principal;
    invoiceId: string;
    amountKrw: number;
    now?: Date;
  },
): Promise<ProposalOutcome> {
  const { threadId, toolCallId, requester, invoiceId, amountKrw } = params;
  const now = params.now ?? new Date();
  const proposalKey = `${threadId}:${toolCallId}`;

  return db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!invoice || !canAccessDepartment(requester, invoice.department)) {
      return { kind: 'invalid', code: 'INVOICE_NOT_FOUND' };
    }
    if (invoice.status === 'paid') return { kind: 'invalid', code: 'INVOICE_PAID' };
    if (amountKrw > invoice.amountKrw - invoice.paidKrw) {
      return { kind: 'invalid', code: 'AMOUNT_EXCEEDS_OUTSTANDING' };
    }

    const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, invoice.vendorId));
    const [policy] = await tx
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.active, true));
    if (!vendor || !policy) throw new Error('거래처 또는 활성 결재 규정이 없습니다.');

    const route = computeApprovalRoute(
      {
        amountKrw,
        requester,
        payee: {
          isNewVendor: vendor.firstPaidAt === null,
          bankAccountChanged: isBankAccountRecentlyChanged(vendor.bankAccountChangedAt, now),
        },
      },
      { version: policy.version, rules: policy.rules, riskyPayeeRoles: policy.riskyPayeeRoles },
    );
    if (route.kind === 'blocked') return { kind: 'blocked', reasons: route.reasons };

    const proposal: PaymentProposal = {
      vendorId: vendor.id,
      invoiceId: invoice.id,
      bankAccount: vendor.bankAccount,
      amountKrw,
    };

    const [created] = await tx
      .insert(approvals)
      .values({
        threadId,
        proposalKey,
        reasons: route.reasons,
        requesterId: requester.id,
        proposal,
        proposalHash: hashProposal(proposal),
        policyVersion: policy.version,
        status: route.kind === 'auto' ? 'approved' : 'pending',
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
      })
      .onConflictDoNothing({ target: approvals.proposalKey })
      .returning();

    const approval =
      created ??
      (await tx.select().from(approvals).where(eq(approvals.proposalKey, proposalKey)))[0];
    if (!approval) throw new Error('결재를 만들지 못했습니다.');

    if (created) {
      if (route.kind === 'approval') {
        await tx.insert(approvalSteps).values(
          route.steps.map((step) => ({
            approvalId: created.id,
            stepOrder: step.order,
            requiredRole: step.role,
            department: step.department,
          })),
        );
      }
      await tx.insert(auditEvents).values({
        actorType: 'agent',
        actorId: requester.id,
        action: route.kind === 'auto' ? 'approval.auto_approved' : 'approval.requested',
        subjectType: 'approval',
        subjectId: created.id,
        payload: { proposal, reasons: route.reasons },
      });
    }

    return route.kind === 'auto'
      ? { kind: 'auto', approvalId: approval.id, reasons: route.reasons }
      : {
          kind: 'approval',
          approvalId: approval.id,
          reasons: route.reasons,
          approverRoles: route.steps.map((step) => step.role),
        };
  });
}

const toStepRecord = (step: typeof approvalSteps.$inferSelect): StepRecord => ({
  order: step.stepOrder,
  role: step.requiredRole,
  department: step.department,
  status: step.status,
  decidedBy: step.decidedBy,
});

export type DecisionResult =
  | { ok: true; status: 'pending' | 'approved' | 'rejected'; threadId: string }
  | { ok: false; code: DenialCode | 'APPROVAL_NOT_FOUND' };

/** 결재 단계 하나를 처리한다. 승인 행을 잠가 동시 결재를 직렬화한다. */
export async function decideStep(
  db: Db,
  params: {
    actor: Principal;
    approvalId: string;
    stepOrder: number;
    decision: 'approve' | 'reject';
    comment?: string | undefined;
    now?: Date;
  },
): Promise<DecisionResult> {
  const { actor, approvalId, stepOrder, decision, comment } = params;
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .for('update');
    if (!approval) return { ok: false, code: 'APPROVAL_NOT_FOUND' };

    const steps = await tx
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.approvalId, approvalId));

    const verdict = canDecideStep({
      actor,
      approval,
      steps: steps.map(toStepRecord),
      stepOrder,
      now,
    });
    if (!verdict.ok) {
      await tx.insert(auditEvents).values({
        actorType: 'user',
        actorId: actor.id,
        action: 'approval.decision_denied',
        subjectType: 'approval',
        subjectId: approvalId,
        payload: { code: verdict.code, stepOrder },
      });
      return { ok: false, code: verdict.code };
    }

    const stepStatus = decision === 'approve' ? 'approved' : 'rejected';
    await tx
      .update(approvalSteps)
      .set({ status: stepStatus, decidedBy: actor.id, decidedAt: now, comment: comment ?? null })
      .where(and(eq(approvalSteps.approvalId, approvalId), eq(approvalSteps.stepOrder, stepOrder)));

    const remaining = steps.filter((s) => s.status === 'pending' && s.stepOrder !== stepOrder);
    const status =
      decision === 'reject' ? 'rejected' : remaining.length === 0 ? 'approved' : 'pending';
    if (status !== 'pending') {
      await tx.update(approvals).set({ status }).where(eq(approvals.id, approvalId));
    }

    await tx.insert(auditEvents).values({
      actorType: 'user',
      actorId: actor.id,
      action: `approval.step_${stepStatus}`,
      subjectType: 'approval',
      subjectId: approvalId,
      payload: { stepOrder, comment: comment ?? null },
    });

    return { ok: true, status, threadId: approval.threadId };
  });
}

/** 유효 기간이 지난 대기 결재를 만료 처리한다. */
export async function expireOverdue(db: Db, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const expired = await tx
      .update(approvals)
      .set({ status: 'expired' })
      .where(and(eq(approvals.status, 'pending'), lte(approvals.expiresAt, now)))
      .returning({ id: approvals.id });
    if (expired.length === 0) return;
    await tx.insert(auditEvents).values(
      expired.map(({ id }) => ({
        actorType: 'system' as const,
        action: 'approval.expired',
        subjectType: 'approval',
        subjectId: id,
      })),
    );
  });
}

/** 현재 사용자가 지금 처리할 수 있는 결재만 돌려준다. */
export async function listInbox(db: Db, actor: Principal, now = new Date()) {
  const pending = await db
    .select({ approval: approvals, requesterName: users.name })
    .from(approvals)
    .innerJoin(users, eq(users.id, approvals.requesterId))
    .where(eq(approvals.status, 'pending'))
    .orderBy(asc(approvals.createdAt));
  if (pending.length === 0) return [];

  const steps = await db
    .select()
    .from(approvalSteps)
    .where(
      inArray(
        approvalSteps.approvalId,
        pending.map((row) => row.approval.id),
      ),
    );

  const vendorRows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(
      inArray(
        vendors.id,
        pending.map((row) => row.approval.proposal.vendorId),
      ),
    );
  const vendorNames = new Map(vendorRows.map((vendor) => [vendor.id, vendor.name]));

  return pending.flatMap(({ approval, requesterName }) => {
    const records = steps.filter((s) => s.approvalId === approval.id).map(toStepRecord);
    const current = records.filter((s) => s.status === 'pending').sort((a, b) => a.order - b.order)[0];
    if (!current) return [];
    const verdict = canDecideStep({
      actor,
      approval,
      steps: records,
      stepOrder: current.order,
      now,
    });
    if (!verdict.ok) return [];
    return [
      {
        approvalId: approval.id,
        stepOrder: current.order,
        requesterName,
        vendorName: vendorNames.get(approval.proposal.vendorId) ?? approval.proposal.vendorId,
        proposal: approval.proposal,
        reasons: approval.reasons,
        expiresAt: approval.expiresAt.toISOString(),
      },
    ];
  });
}
