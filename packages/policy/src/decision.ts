import type {
  ApprovalStatus,
  PaymentProposal,
  Principal,
  Role,
  StepStatus,
} from '@dojang/contracts';
import { hashProposal } from './hash.ts';
import type { ApprovalRoute } from './route.ts';

export interface ApprovalRecord {
  requesterId: string;
  status: ApprovalStatus;
  proposalHash: string;
  expiresAt: Date;
}

export interface StepRecord {
  order: number;
  role: Role;
  department: string | null;
  status: StepStatus;
  decidedBy: string | null;
}

export type DenialCode =
  | 'APPROVAL_NOT_PENDING'
  | 'APPROVAL_EXPIRED'
  | 'SELF_APPROVAL'
  | 'WRONG_ROLE'
  | 'WRONG_DEPARTMENT'
  | 'NOT_CURRENT_STEP'
  | 'NOT_REQUESTER'
  | 'APPROVAL_NOT_APPROVED'
  | 'PROPOSAL_MISMATCH'
  | 'ROUTE_BLOCKED'
  | 'ROUTE_NOT_SATISFIED'
  | 'SEPARATION_OF_DUTIES';

export type Decision = { ok: true } | { ok: false; code: DenialCode };

const deny = (code: DenialCode): Decision => ({ ok: false, code });

const isExpired = (approval: ApprovalRecord, now: Date): boolean =>
  approval.expiresAt.getTime() <= now.getTime();

/** 결재자가 지정한 단계를 처리할 수 있는지 판단한다. */
export function canDecideStep(params: {
  actor: Principal;
  approval: ApprovalRecord;
  steps: StepRecord[];
  stepOrder: number;
  now: Date;
}): Decision {
  const { actor, approval, steps, stepOrder, now } = params;
  if (approval.status !== 'pending') return deny('APPROVAL_NOT_PENDING');
  if (isExpired(approval, now)) return deny('APPROVAL_EXPIRED');
  if (actor.id === approval.requesterId) return deny('SELF_APPROVAL');

  const current = [...steps].sort((a, b) => a.order - b.order).find((s) => s.status === 'pending');
  if (!current || current.order !== stepOrder) return deny('NOT_CURRENT_STEP');
  if (actor.role !== current.role) return deny('WRONG_ROLE');
  if (current.department !== null && current.department !== actor.department) {
    return deny('WRONG_DEPARTMENT');
  }
  if (steps.some((step) => step.decidedBy === actor.id)) return deny('SEPARATION_OF_DUTIES');
  return { ok: true };
}

/**
 * 지급 직전의 마지막 관문. 승인 행의 상태만 믿지 않고, 서버가 다시 계산한
 * 결재선과 실제 승인 단계를 대조한다.
 */
export function verifyExecutionGrant(params: {
  actor: Principal;
  approval: ApprovalRecord;
  steps: StepRecord[];
  proposal: PaymentProposal;
  requiredRoute: ApprovalRoute;
  now: Date;
}): Decision {
  const { actor, approval, steps, proposal, requiredRoute, now } = params;
  if (actor.id !== approval.requesterId) return deny('NOT_REQUESTER');
  if (approval.status !== 'approved') return deny('APPROVAL_NOT_APPROVED');
  if (isExpired(approval, now)) return deny('APPROVAL_EXPIRED');
  if (hashProposal(proposal) !== approval.proposalHash) return deny('PROPOSAL_MISMATCH');
  if (requiredRoute.kind === 'blocked') return deny('ROUTE_BLOCKED');

  const approvers = steps.flatMap((step) => (step.decidedBy ? [step.decidedBy] : []));
  if (approvers.includes(approval.requesterId)) return deny('SELF_APPROVAL');
  if (new Set(approvers).size !== approvers.length) return deny('SEPARATION_OF_DUTIES');

  const satisfied = requiredRoute.steps.every((required) =>
    steps.some(
      (step) =>
        step.status === 'approved' &&
        step.decidedBy !== null &&
        step.role === required.role &&
        step.department === required.department,
    ),
  );
  return satisfied ? { ok: true } : deny('ROUTE_NOT_SATISFIED');
}
