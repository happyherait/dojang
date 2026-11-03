import { PaymentProposalSchema, type Principal } from '@dojang/contracts';
import type { Db } from '@dojang/db';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getInvoice, listOpenPayables, searchVendors } from './erp.ts';
import { executePayment } from './payments.ts';

const toolResult = (data: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  isError,
});

/** 요청마다 호출자 권한으로 묶인 서버를 만든다. 에이전트 전용 권한은 없다. */
export function createErpServer(db: Db, actor: Principal): McpServer {
  const server = new McpServer({ name: 'dojang-erp', version: '0.1.0' });

  server.registerTool(
    'search_vendors',
    {
      description: '거래처 이름으로 거래처를 검색한다.',
      inputSchema: z.object({ query: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => toolResult(await searchVendors(db, query)),
  );

  server.registerTool(
    'list_open_payables',
    {
      description: '호출자가 볼 수 있는 미지급 청구서를 지급 기한 순으로 조회한다.',
      inputSchema: z.object({ vendorId: z.string().min(1).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ vendorId }) => toolResult(await listOpenPayables(db, actor, vendorId)),
  );

  server.registerTool(
    'get_invoice',
    {
      description: '청구서 한 건을 조회한다.',
      inputSchema: z.object({ invoiceId: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ invoiceId }) => {
      const invoice = await getInvoice(db, actor, invoiceId);
      return invoice ? toolResult(invoice) : toolResult({ code: 'INVOICE_NOT_FOUND' }, true);
    },
  );

  server.registerTool(
    'execute_payment',
    {
      description:
        '승인이 끝난 결재 건의 지급을 실행한다. 서버가 승인 상태, 처리안 해시, 결재선, 잔액을 다시 검증하며 조건이 맞지 않으면 거부한다.',
      inputSchema: z.object({
        approvalId: z.uuid(),
        idempotencyKey: z.string().min(8).max(128),
        proposal: PaymentProposalSchema,
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      const result = await executePayment(db, actor, input);
      return toolResult(result, !result.ok);
    },
  );

  return server;
}
