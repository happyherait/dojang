import { describe, expect, it } from 'vitest';
import { computeApprovalRoute, DEFAULT_POLICY, type ApprovalPolicy, type RouteInput } from '../src/index.ts';

const input = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  amountKrw: 500_000,
  requester: { role: 'employee', department: '재무팀' },
  payee: { isNewVendor: false, bankAccountChanged: false },
  ...overrides,
});

const roles = (route: ReturnType<typeof computeApprovalRoute>) => route.steps.map((s) => s.role);

describe('금액별 결재선', () => {
  it.each([
    [1, []],
    [1_000_000, []],
    [1_000_001, ['team_lead']],
    [5_000_000, ['team_lead']],
    [5_000_001, ['team_lead', 'finance_manager']],
    [30_000_000, ['team_lead', 'finance_manager']],
    [30_000_001, ['team_lead', 'finance_manager', 'ceo']],
  ])('%d원의 결재선을 계산한다', (amountKrw, expected) => {
    expect(roles(computeApprovalRoute(input({ amountKrw }), DEFAULT_POLICY))).toEqual(expected);
  });

  it('전결 한도 이내는 자동 처리로 표시한다', () => {
    expect(computeApprovalRoute(input(), DEFAULT_POLICY).kind).toBe('auto');
  });

  it('팀장 단계는 요청자 부서로 제한하고 재무 단계는 제한하지 않는다', () => {
    const route = computeApprovalRoute(input({ amountKrw: 10_000_000 }), DEFAULT_POLICY);
    expect(route.steps).toEqual([
      { order: 1, role: 'team_lead', department: '재무팀' },
      { order: 2, role: 'finance_manager', department: null },
    ]);
  });
});

describe('위험한 지급 대상', () => {
  it('소액이어도 신규 거래처는 재무 결재를 받는다', () => {
    const route = computeApprovalRoute(
      input({ payee: { isNewVendor: true, bankAccountChanged: false } }),
      DEFAULT_POLICY,
    );
    expect(roles(route)).toEqual(['finance_manager']);
  });

  it('계좌 변경 건은 금액 결재선에 재무 결재를 더한다', () => {
    const route = computeApprovalRoute(
      input({ amountKrw: 3_000_000, payee: { isNewVendor: false, bankAccountChanged: true } }),
      DEFAULT_POLICY,
    );
    expect(roles(route)).toEqual(['team_lead', 'finance_manager']);
    expect(route.reasons).toContain('최근 계좌가 변경된 거래처입니다.');
  });
});

describe('요청자 직급에 따른 상향', () => {
  it('팀장이 요청하면 팀장 단계는 재무 결재로 올라간다', () => {
    const route = computeApprovalRoute(
      input({ amountKrw: 3_000_000, requester: { role: 'team_lead', department: '구매팀' } }),
      DEFAULT_POLICY,
    );
    expect(roles(route)).toEqual(['finance_manager']);
  });

  it('상향 결과가 겹치면 한 단계로 합친다', () => {
    const route = computeApprovalRoute(
      input({ amountKrw: 10_000_000, requester: { role: 'team_lead', department: '구매팀' } }),
      DEFAULT_POLICY,
    );
    expect(roles(route)).toEqual(['finance_manager']);
  });

  it('재무 책임자가 요청하면 대표가 결재한다', () => {
    const route = computeApprovalRoute(
      input({ amountKrw: 3_000_000, requester: { role: 'finance_manager', department: '재무팀' } }),
      DEFAULT_POLICY,
    );
    expect(roles(route)).toEqual(['ceo']);
  });

  it('대표 위로 결재자가 없으면 차단한다', () => {
    const route = computeApprovalRoute(
      input({ amountKrw: 3_000_000, requester: { role: 'ceo', department: '경영진' } }),
      DEFAULT_POLICY,
    );
    expect(route.kind).toBe('blocked');
  });
});

describe('입력 검증', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('잘못된 금액 %s을 거부한다', (amountKrw) => {
    expect(() => computeApprovalRoute(input({ amountKrw }), DEFAULT_POLICY)).toThrow();
  });

  it('상한 없는 마지막 규칙이 없으면 거부한다', () => {
    const policy: ApprovalPolicy = {
      version: 2,
      rules: [{ upToKrw: 1_000, roles: [] }],
      riskyPayeeRoles: [],
    };
    expect(() => computeApprovalRoute(input(), policy)).toThrow();
  });

  it('금액 순서가 어긋난 규정을 거부한다', () => {
    const policy: ApprovalPolicy = {
      version: 2,
      rules: [
        { upToKrw: 5_000, roles: [] },
        { upToKrw: 1_000, roles: [] },
        { upToKrw: null, roles: [] },
      ],
      riskyPayeeRoles: [],
    };
    expect(() => computeApprovalRoute(input(), policy)).toThrow();
  });
});
