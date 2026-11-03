import type { ApprovalDetail } from './api.ts';
import { ROLE_LABELS } from './labels.ts';

const won = (amount: number) => `${amount.toLocaleString('ko-KR')}원`;

const STATUS_LABELS: Record<ApprovalDetail['status'], string> = {
  pending: '결재 진행 중',
  approved: '승인 완료, 지급 대기',
  rejected: '반려',
  expired: '기한 만료',
  executed: '지급 완료',
};

const ACTION_LABELS: Record<string, string> = {
  'approval.requested': '결재를 올렸습니다',
  'approval.auto_approved': '전결 한도 이내로 처리했습니다',
  'approval.step_approved': '승인했습니다',
  'approval.step_rejected': '반려했습니다',
  'approval.decision_denied': '승인을 시도했으나 거부됐습니다',
  'approval.expired': '결재 기한이 지났습니다',
  'payment.executed': '승인을 검증하고 지급했습니다',
  'payment.denied': '지급 요청을 거부했습니다',
};

const CODE_LABELS: Record<string, string> = {
  SELF_APPROVAL: '본인 건은 승인할 수 없습니다',
  WRONG_ROLE: '이 단계의 결재자가 아닙니다',
  WRONG_DEPARTMENT: '다른 부서 건입니다',
  NOT_CURRENT_STEP: '앞 단계가 끝나지 않았습니다',
  PROPOSAL_MISMATCH: '승인된 내용과 다릅니다',
  ROUTE_NOT_SATISFIED: '필요한 승인이 부족합니다',
};

const actorLabel = (event: ApprovalDetail['timeline'][number]) => {
  if (event.actorType === 'agent') return '도장';
  // 지급은 사람도 LLM도 아닌 서버 코드가 승인을 검증한 뒤 실행한다.
  if (event.actorType === 'system' || event.action.startsWith('payment.')) return '서버';
  return event.actorName ?? '알 수 없음';
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

function Seal({ name, tone = 'approve' }: { name: string; tone?: 'approve' | 'reject' }) {
  return (
    <span className={tone === 'approve' ? 'seal' : 'seal seal-reject'} aria-label={`${name} 날인`}>
      {name}
    </span>
  );
}

function SignatureGrid({ detail }: { detail: ApprovalDetail }) {
  const autoApproved = detail.steps.length === 0;
  return (
    <table className="signature-grid">
      <caption className="sr-only">결재란</caption>
      <thead>
        <tr>
          <th scope="col">기안</th>
          {detail.steps.map((step) => (
            <th scope="col" key={step.order}>
              {ROLE_LABELS[step.role] ?? step.role}
            </th>
          ))}
          {autoApproved && <th scope="col">전결</th>}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <Seal name={detail.requesterName} />
          </td>
          {detail.steps.map((step) => (
            <td key={step.order}>
              {step.status === 'approved' && step.decidedByName && <Seal name={step.decidedByName} />}
              {step.status === 'rejected' && <Seal name="반려" tone="reject" />}
              {step.status === 'pending' && <span className="unsigned">대기</span>}
            </td>
          ))}
          {autoApproved && (
            <td>
              <Seal name="전결" />
            </td>
          )}
        </tr>
      </tbody>
    </table>
  );
}

export function ApprovalSheet({
  detail,
  onDecide,
  busy,
}: {
  detail: ApprovalDetail;
  onDecide: (decision: 'approve' | 'reject') => void;
  busy: boolean;
}) {
  return (
    <article className="sheet">
      <header className="sheet-head">
        <h2>지급 품의서</h2>
        <SignatureGrid detail={detail} />
      </header>

      <p className={`sheet-status status-${detail.status}`}>{STATUS_LABELS[detail.status]}</p>

      <dl className="sheet-fields">
        <dt>지급처</dt>
        <dd>{detail.vendorName}</dd>
        <dt>지급액</dt>
        <dd className="amount">{won(detail.proposal.amountKrw)}</dd>
        <dt>청구서</dt>
        <dd>{detail.invoiceNumber}</dd>
        <dt>입금 계좌</dt>
        <dd>{detail.proposal.bankAccount}</dd>
        <dt>결재 사유</dt>
        <dd>{detail.reasons.join(' ')}</dd>
      </dl>

      {detail.decidableStep !== null && (
        <div className="decision">
          <button type="button" className="approve" disabled={busy} onClick={() => onDecide('approve')}>
            승인
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide('reject')}>
            반려
          </button>
        </div>
      )}

      <section aria-label="감사 기록">
        <h3>감사 기록</h3>
        <ol className="timeline">
          {detail.timeline.map((event) => (
            <li key={event.id} className={event.action.endsWith('denied') ? 'denied' : undefined}>
              <time dateTime={event.occurredAt}>{time(event.occurredAt)}</time>
              <span>
                <strong>{actorLabel(event)}</strong> {ACTION_LABELS[event.action] ?? event.action}
                {event.code && <em>{CODE_LABELS[event.code] ?? event.code}</em>}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
