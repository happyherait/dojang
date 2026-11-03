import type { Principal } from '@dojang/contracts';
import { invoices, vendors, type Db } from '@dojang/db';
import { canAccessDepartment } from '@dojang/policy';
import { and, eq, ilike } from 'drizzle-orm';

type InvoiceRow = typeof invoices.$inferSelect;

const presentInvoice = (invoice: InvoiceRow) => ({
  id: invoice.id,
  vendorId: invoice.vendorId,
  invoiceNumber: invoice.invoiceNumber,
  department: invoice.department,
  amountKrw: invoice.amountKrw,
  outstandingKrw: invoice.amountKrw - invoice.paidKrw,
  dueDate: invoice.dueDate,
  status: invoice.status,
});

export async function searchVendors(db: Db, query: string) {
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const rows = await db
    .select()
    .from(vendors)
    .where(ilike(vendors.name, `%${escaped}%`))
    .limit(20);
  return rows.map((vendor) => ({
    id: vendor.id,
    name: vendor.name,
    bankAccount: vendor.bankAccount,
    isNewVendor: vendor.firstPaidAt === null,
    bankAccountChangedAt: vendor.bankAccountChangedAt?.toISOString() ?? null,
  }));
}

export async function listOpenPayables(db: Db, actor: Principal, vendorId?: string) {
  const conditions = [eq(invoices.status, 'open')];
  if (vendorId) conditions.push(eq(invoices.vendorId, vendorId));
  const rows = await db
    .select()
    .from(invoices)
    .where(and(...conditions))
    .orderBy(invoices.dueDate, invoices.id);
  return rows.filter((row) => canAccessDepartment(actor, row.department)).map(presentInvoice);
}

export async function getInvoice(db: Db, actor: Principal, invoiceId: string) {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  // 권한 없는 청구서는 존재 여부도 알리지 않는다.
  return invoice && canAccessDepartment(actor, invoice.department) ? presentInvoice(invoice) : null;
}
