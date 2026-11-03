import type { PaymentProposal, Principal, Role } from '@dojang/contracts';
import {
  approvalPolicies,
  approvals,
  approvalSteps,
  auditEvents,
  invoices,
  payments,
  vendors,
  type Db,
} from '@dojang/db';
import {
  computeApprovalRoute,
  hashProposal,
  normalizeBankAccount,
  verifyExecutionGrant,
  type DenialCode,
  type StepRecord,
} from '@dojang/policy';
import { eq, sql } from 'drizzle-orm';
import { canAccessDepartment } from './erp.ts';

const BANK_ACCOUNT_RISK_WINDOW_MS = 30 * 86_400_000;

export type PaymentDenialCode =
  | DenialCode
  | 'APPROVAL_NOT_FOUND'
  | 'ALREADY_EXECUTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVOICE_ACCESS_DENIED'
  | 'INVOICE_VENDOR_MISMATCH'
  | 'BANK_ACCOUNT_MISMATCH'
  | 'AMOUNT_EXCEEDS_OUTSTANDING'
  | 'NO_ACTIVE_POLICY';

export interface ExecutePaymentInput {
  approvalId: string;
  idempotencyKey: string;
  proposal: PaymentProposal;
}

export type ExecutePaymentResult =
  | { ok: true; paymentId: string; replayed: boolean }
  | { ok: false; code: PaymentDenialCode };

class PaymentDenied extends Error {
  constructor(readonly code: PaymentDenialCode) {
    super(code);
  }
}

const presentStep = (step: typeof approvalSteps.$inferSelect): StepRecord => ({
  order: step.stepOrder,
  role: step.requiredRole satisfies Role,
  department: step.department,
  status: step.status,
  decidedBy: step.decidedBy,
});

/**
 * 지급을 실행한다. 승인 행을 잠가 동시 요청을 직렬화하고, 모든 사실을
 * 데이터베이스에서 다시 읽는다. 호출자가 보낸 처리안은 승인 내용과 대조만 한다.
 */
export async function executePayment(
  db: Db,
  actor: Principal,
  input: ExecutePaymentInput,
  now = new Date(),
): Promise<ExecutePaymentResult> {
  try {
    return await db.transaction(async (tx) => {
      const [approval] = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, input.approvalId))
        .for('update');
      if (!approval) throw new PaymentDenied('APPROVAL_NOT_FOUND');

      const [existing] = await tx
        .select()
        .from(payments)
        .where(eq(payments.idempotencyKey, input.idempotencyKey));
      if (existing) {
        const sameRequest =
          existing.approvalId === approval.id &&
          existing.requestedBy === actor.id &&
          hashProposal(input.proposal) === approval.proposalHash;
        if (!sameRequest) throw new PaymentDenied('IDEMPOTENCY_CONFLICT');
        return { ok: true, paymentId: existing.id, replayed: true } as const;
      }
      if (approval.status === 'executed') throw new PaymentDenied('ALREADY_EXECUTED');

      const approved = approval.proposal;
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, approved.invoiceId))
        .for('update');
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, approved.vendorId));
      const [policy] = await tx
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.active, true));
      if (!policy) throw new PaymentDenied('NO_ACTIVE_POLICY');
      if (!invoice || !vendor || invoice.vendorId !== vendor.id) {
        throw new PaymentDenied('INVOICE_VENDOR_MISMATCH');
      }

      const changedAt = vendor.bankAccountChangedAt?.getTime();
      const requiredRoute = computeApprovalRoute(
        {
          amountKrw: approved.amountKrw,
          requester: actor,
          payee: {
            isNewVendor: vendor.firstPaidAt === null,
            bankAccountChanged:
              changedAt !== undefined && now.getTime() - changedAt < BANK_ACCOUNT_RISK_WINDOW_MS,
          },
        },
        {
          version: policy.version,
          rules: policy.rules,
          riskyPayeeRoles: policy.riskyPayeeRoles,
        },
      );

      const steps = await tx
        .select()
        .from(approvalSteps)
        .where(eq(approvalSteps.approvalId, approval.id));

      const grant = verifyExecutionGrant({
        actor,
        approval,
        steps: steps.map(presentStep),
        proposal: input.proposal,
        requiredRoute,
        now,
      });
      if (!grant.ok) throw new PaymentDenied(grant.code);

      if (!canAccessDepartment(actor, invoice.department)) {
        throw new PaymentDenied('INVOICE_ACCESS_DENIED');
      }
      if (normalizeBankAccount(approved.bankAccount) !== normalizeBankAccount(vendor.bankAccount)) {
        throw new PaymentDenied('BANK_ACCOUNT_MISMATCH');
      }
      const outstanding = invoice.amountKrw - invoice.paidKrw;
      if (approved.amountKrw > outstanding) {
        throw new PaymentDenied('AMOUNT_EXCEEDS_OUTSTANDING');
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          approvalId: approval.id,
          idempotencyKey: input.idempotencyKey,
          vendorId: vendor.id,
          invoiceId: invoice.id,
          bankAccount: vendor.bankAccount,
          amountKrw: approved.amountKrw,
          requestedBy: actor.id,
        })
        .returning({ id: payments.id });
      if (!payment) throw new Error('지급 기록을 만들지 못했습니다.');

      const paidKrw = invoice.paidKrw + approved.amountKrw;
      await tx
        .update(invoices)
        .set({ paidKrw, status: paidKrw === invoice.amountKrw ? 'paid' : 'open' })
        .where(eq(invoices.id, invoice.id));
      await tx
        .update(vendors)
        .set({ firstPaidAt: sql`COALESCE(${vendors.firstPaidAt}, ${now.toISOString()}::timestamptz)` })
        .where(eq(vendors.id, vendor.id));
      await tx
        .update(approvals)
        .set({ status: 'executed' })
        .where(eq(approvals.id, approval.id));
      await tx.insert(auditEvents).values({
        actorType: 'user',
        actorId: actor.id,
        action: 'payment.executed',
        subjectType: 'approval',
        subjectId: approval.id,
        payload: { paymentId: payment.id, amountKrw: approved.amountKrw, vendorId: vendor.id },
      });

      return { ok: true, paymentId: payment.id, replayed: false } as const;
    });
  } catch (error) {
    if (!(error instanceof PaymentDenied)) throw error;
    await db.insert(auditEvents).values({
      actorType: 'user',
      actorId: actor.id,
      action: 'payment.denied',
      subjectType: 'approval',
      subjectId: input.approvalId,
      payload: { code: error.code, proposal: input.proposal },
    });
    return { ok: false, code: error.code };
  }
}
