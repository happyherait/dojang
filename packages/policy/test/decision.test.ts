import type { PaymentProposal, Principal } from '@dojang/contracts';
import { describe, expect, it } from 'vitest';
import {
  canDecideStep,
  computeApprovalRoute,
  DEFAULT_POLICY,
  hashProposal,
  verifyExecutionGrant,
  type ApprovalRecord,
  type StepRecord,
} from '../src/index.ts';

const now = new Date('2026-11-03T00:00:00Z');
const later = new Date('2026-11-04T00:00:00Z');

const employee: Principal = { id: 'u-kim', name: '김사원', role: 'employee', department: '재무팀' };
const lead: Principal = { id: 'u-park', name: '박팀장', role: 'team_lead', department: '재무팀' };
const otherLead: Principal = { id: 'u-lee', name: '이팀장', role: 'team_lead', department: '구매팀' };
const finance: Principal = { id: 'u-choi', name: '최재무', role: 'finance_manager', department: '재무팀' };

const proposal: PaymentProposal = {
  vendorId: 'v-a',
  invoiceId: 'i-1',
  bankAccount: '110-123-456789',
  amountKrw: 3_000_000,
};

const approval = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  requesterId: employee.id,
  status: 'pending',
  proposalHash: hashProposal(proposal),
  expiresAt: later,
  ...overrides,
});

const leadStep = (overrides: Partial<StepRecord> = {}): StepRecord => ({
  order: 1,
  role: 'team_lead',
  department: '재무팀',
  status: 'pending',
  decidedBy: null,
  ...overrides,
});

describe('canDecideStep', () => {
  const decide = (actor: Principal, overrides: Partial<ApprovalRecord> = {}, steps = [leadStep()], stepOrder = 1) =>
    canDecideStep({ actor, approval: approval(overrides), steps, stepOrder, now });

  it('같은 부서 팀장은 승인할 수 있다', () => {
    expect(decide(lead)).toEqual({ ok: true });
  });

  it('요청자 본인은 직급과 무관하게 승인할 수 없다', () => {
    expect(decide(lead, { requesterId: lead.id })).toEqual({ ok: false, code: 'SELF_APPROVAL' });
  });

  it('직급이 다르면 거부한다', () => {
    expect(decide(finance)).toEqual({ ok: false, code: 'WRONG_ROLE' });
  });

  it('다른 부서 팀장은 거부한다', () => {
    expect(decide(otherLead)).toEqual({ ok: false, code: 'WRONG_DEPARTMENT' });
  });

  it('만료된 결재는 거부한다', () => {
    expect(decide(lead, { expiresAt: now })).toEqual({ ok: false, code: 'APPROVAL_EXPIRED' });
  });

  it('이미 끝난 결재는 거부한다', () => {
    expect(decide(lead, { status: 'approved' })).toEqual({ ok: false, code: 'APPROVAL_NOT_PENDING' });
  });

  it('앞 단계를 건너뛸 수 없다', () => {
    const steps = [
      leadStep(),
      leadStep({ order: 2, role: 'finance_manager', department: null }),
    ];
    expect(decide(finance, {}, steps, 2)).toEqual({ ok: false, code: 'NOT_CURRENT_STEP' });
  });

  it('같은 사람이 두 단계를 승인할 수 없다', () => {
    const steps = [
      leadStep({ status: 'approved', decidedBy: lead.id }),
      leadStep({ order: 2 }),
    ];
    expect(decide(lead, {}, steps, 2)).toEqual({ ok: false, code: 'SEPARATION_OF_DUTIES' });
  });
});

describe('verifyExecutionGrant', () => {
  const route = computeApprovalRoute(
    {
      amountKrw: proposal.amountKrw,
      requester: employee,
      payee: { isNewVendor: false, bankAccountChanged: false },
    },
    DEFAULT_POLICY,
  );
  const approvedStep = leadStep({ status: 'approved', decidedBy: lead.id });

  const verify = (overrides: Partial<Parameters<typeof verifyExecutionGrant>[0]> = {}) =>
    verifyExecutionGrant({
      actor: employee,
      approval: approval({ status: 'approved' }),
      steps: [approvedStep],
      proposal,
      requiredRoute: route,
      now,
      ...overrides,
    });

  it('승인이 완료된 처리안을 통과시킨다', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('계좌 표기만 다르면 같은 처리안으로 본다', () => {
    expect(verify({ proposal: { ...proposal, bankAccount: '110 123 456789' } })).toEqual({ ok: true });
  });

  it.each([
    ['금액', { amountKrw: 3_000_001 }],
    ['계좌', { bankAccount: '999-999-999999' }],
    ['거래처', { vendorId: 'v-b' }],
    ['청구서', { invoiceId: 'i-2' }],
  ])('승인 후 %s이 바뀌면 거부한다', (_field, change) => {
    expect(verify({ proposal: { ...proposal, ...change } })).toEqual({
      ok: false,
      code: 'PROPOSAL_MISMATCH',
    });
  });

  it('승인되지 않은 결재는 거부한다', () => {
    expect(verify({ approval: approval() })).toEqual({ ok: false, code: 'APPROVAL_NOT_APPROVED' });
  });

  it('요청자 외의 사용자는 실행할 수 없다', () => {
    expect(verify({ actor: lead })).toEqual({ ok: false, code: 'NOT_REQUESTER' });
  });

  it('상태만 승인으로 바뀌고 단계 승인이 없으면 거부한다', () => {
    expect(verify({ steps: [leadStep()] })).toEqual({ ok: false, code: 'ROUTE_NOT_SATISFIED' });
  });

  it('요청자가 승인한 기록이 있으면 거부한다', () => {
    const steps = [leadStep({ status: 'approved', decidedBy: employee.id })];
    expect(verify({ steps })).toEqual({ ok: false, code: 'SELF_APPROVAL' });
  });

  it('승인 후 결재선이 높아지면 다시 결재를 받아야 한다', () => {
    const stricter = computeApprovalRoute(
      {
        amountKrw: proposal.amountKrw,
        requester: employee,
        payee: { isNewVendor: false, bankAccountChanged: true },
      },
      DEFAULT_POLICY,
    );
    expect(verify({ requiredRoute: stricter })).toEqual({ ok: false, code: 'ROUTE_NOT_SATISFIED' });
  });

  it('만료된 승인은 거부한다', () => {
    expect(verify({ approval: approval({ status: 'approved', expiresAt: now }) })).toEqual({
      ok: false,
      code: 'APPROVAL_EXPIRED',
    });
  });
});

describe('hashProposal', () => {
  it('같은 내용이면 필드 순서와 무관하게 같다', () => {
    const reordered: PaymentProposal = {
      amountKrw: proposal.amountKrw,
      bankAccount: proposal.bankAccount,
      invoiceId: proposal.invoiceId,
      vendorId: proposal.vendorId,
    };
    expect(hashProposal(reordered)).toBe(hashProposal(proposal));
  });
});
