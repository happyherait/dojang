import { z } from 'zod';

/** 낮은 직급에서 높은 직급 순서. 결재선 정렬과 상향 조정의 기준이다. */
export const ROLES = ['employee', 'team_lead', 'finance_manager', 'ceo'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const PrincipalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: RoleSchema,
  department: z.string().min(1),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const JwtClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  role: RoleSchema,
  department: z.string().min(1),
});
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;

export const claimsToPrincipal = (claims: JwtClaims): Principal => ({
  id: claims.sub,
  name: claims.name,
  role: claims.role,
  department: claims.department,
});

export const principalToClaims = (principal: Principal): JwtClaims => ({
  sub: principal.id,
  name: principal.name,
  role: principal.role,
  department: principal.department,
});

export const PaymentProposalSchema = z.object({
  vendorId: z.string().min(1),
  invoiceId: z.string().min(1),
  bankAccount: z.string().min(1),
  amountKrw: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type PaymentProposal = z.infer<typeof PaymentProposalSchema>;

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'executed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const StepStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type StepStatus = z.infer<typeof StepStatusSchema>;
