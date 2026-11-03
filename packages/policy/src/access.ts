import type { Principal } from '@dojang/contracts';

const BANK_ACCOUNT_RISK_WINDOW_MS = 30 * 86_400_000;

/** 재무 책임자와 대표는 전사 청구서를, 그 외에는 자기 부서 청구서만 다룰 수 있다. */
export const canAccessDepartment = (actor: Principal, department: string): boolean =>
  actor.role === 'finance_manager' || actor.role === 'ceo' || actor.department === department;

export const isBankAccountRecentlyChanged = (changedAt: Date | null, now: Date): boolean =>
  changedAt !== null && now.getTime() - changedAt.getTime() < BANK_ACCOUNT_RISK_WINDOW_MS;
