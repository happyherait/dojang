export const ROLE_ORDER = ['employee', 'team_lead', 'finance_manager', 'ceo'];

export const ROLE_LABELS: Record<string, string> = {
  employee: '담당',
  team_lead: '팀장',
  finance_manager: '재무',
  ceo: '대표',
};

export const STEP_LABELS: Record<string, string> = {
  agent: '답변을 작성하고 있습니다',
  read_tools: 'ERP를 조회하고 있습니다',
  prepare_proposal: '전결 규정을 확인하고 있습니다',
  execute_payment: '지급을 실행하고 있습니다',
};
