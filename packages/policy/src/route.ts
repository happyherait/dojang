import { ROLES, type Principal, type Role } from '@dojang/contracts';

export interface ApprovalRule {
  /** 이 금액 이하에 적용한다. `null`은 상한 없음. */
  upToKrw: number | null;
  roles: Role[];
}

export interface ApprovalPolicy {
  version: number;
  /** `upToKrw` 오름차순. 마지막 규칙은 상한이 없어야 한다. */
  rules: ApprovalRule[];
  /** 신규 거래처나 계좌 변경처럼 위험한 지급에 추가되는 결재자. */
  riskyPayeeRoles: Role[];
}

export const DEFAULT_POLICY: ApprovalPolicy = {
  version: 1,
  rules: [
    { upToKrw: 1_000_000, roles: [] },
    { upToKrw: 5_000_000, roles: ['team_lead'] },
    { upToKrw: 30_000_000, roles: ['team_lead', 'finance_manager'] },
    { upToKrw: null, roles: ['team_lead', 'finance_manager', 'ceo'] },
  ],
  riskyPayeeRoles: ['finance_manager'],
};

export interface RouteInput {
  amountKrw: number;
  requester: Pick<Principal, 'role' | 'department'>;
  payee: { isNewVendor: boolean; bankAccountChanged: boolean };
}

export interface RouteStep {
  order: number;
  role: Role;
  /** 값이 있으면 해당 부서의 결재자만 승인할 수 있다. */
  department: string | null;
}

export type ApprovalRoute =
  | { kind: 'auto'; steps: []; reasons: string[] }
  | { kind: 'approval'; steps: RouteStep[]; reasons: string[] }
  | { kind: 'blocked'; steps: []; reasons: string[] };

const rankOf = (role: Role): number => ROLES.indexOf(role);

const won = (amount: number): string => `${amount.toLocaleString('ko-KR')}원`;

function assertValidPolicy(policy: ApprovalPolicy): void {
  const last = policy.rules.at(-1);
  if (!last || last.upToKrw !== null) {
    throw new Error('결재 규정의 마지막 규칙은 상한이 없어야 합니다.');
  }
  policy.rules.slice(0, -1).forEach((rule, index) => {
    const next = policy.rules[index + 1];
    const ascending =
      rule.upToKrw !== null && (next?.upToKrw === null || rule.upToKrw < (next?.upToKrw ?? 0));
    if (!ascending) {
      throw new Error('결재 규정은 금액 오름차순이어야 합니다.');
    }
  });
}

/**
 * 결재선을 계산한다. 입력은 서버가 확인한 사실만 받으며 LLM 출력을 받지 않는다.
 * 같은 입력에는 항상 같은 결과를 돌려주는 순수 함수다.
 */
export function computeApprovalRoute(input: RouteInput, policy: ApprovalPolicy): ApprovalRoute {
  assertValidPolicy(policy);
  if (!Number.isSafeInteger(input.amountKrw) || input.amountKrw <= 0) {
    throw new Error('금액은 1원 이상의 정수여야 합니다.');
  }

  const rule = policy.rules.find((r) => r.upToKrw === null || input.amountKrw <= r.upToKrw);
  // assertValidPolicy가 상한 없는 규칙의 존재를 보장한다.
  const required = new Set<Role>(rule?.roles ?? []);
  const reasons =
    required.size > 0 ? [`${won(input.amountKrw)}은 담당자 전결 한도를 초과합니다.`] : [];

  if (input.payee.isNewVendor) {
    policy.riskyPayeeRoles.forEach((role) => required.add(role));
    reasons.push('신규 거래처 지급은 추가 결재가 필요합니다.');
  }
  if (input.payee.bankAccountChanged) {
    policy.riskyPayeeRoles.forEach((role) => required.add(role));
    reasons.push('최근 계좌가 변경된 거래처입니다.');
  }

  if (required.size === 0) {
    return { kind: 'auto', steps: [], reasons: ['담당자 전결 한도 이내입니다.'] };
  }

  // 결재는 요청자보다 높은 직급만 할 수 있으므로 낮거나 같은 단계는 위로 올린다.
  const requesterRank = rankOf(input.requester.role);
  const escalated = new Set<Role>();
  for (const role of required) {
    if (rankOf(role) > requesterRank) {
      escalated.add(role);
      continue;
    }
    const next = ROLES[requesterRank + 1];
    if (!next) {
      return {
        kind: 'blocked',
        steps: [],
        reasons: [...reasons, '요청자보다 높은 결재자가 없어 자동 처리할 수 없습니다.'],
      };
    }
    escalated.add(next);
    reasons.push('요청자 본인이 결재할 수 없어 결재선을 상향했습니다.');
  }

  const steps = [...escalated]
    .sort((a, b) => rankOf(a) - rankOf(b))
    .map((role, index) => ({
      order: index + 1,
      role,
      department: role === 'team_lead' ? input.requester.department : null,
    }));

  return { kind: 'approval', steps, reasons: [...new Set(reasons)] };
}
