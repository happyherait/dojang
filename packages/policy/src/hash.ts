import { createHash } from 'node:crypto';
import type { PaymentProposal } from '@dojang/contracts';

export const normalizeBankAccount = (account: string): string =>
  account.normalize('NFKC').replace(/[\s-]/g, '');

/**
 * 승인 대상을 고정하는 해시. 필드 순서와 계좌 표기 차이에 영향을 받지 않으며,
 * 거래처, 청구서, 계좌, 금액 중 하나라도 바뀌면 값이 달라진다.
 */
export function hashProposal(proposal: PaymentProposal): string {
  const canonical = JSON.stringify([
    proposal.vendorId,
    proposal.invoiceId,
    normalizeBankAccount(proposal.bankAccount),
    proposal.amountKrw,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
