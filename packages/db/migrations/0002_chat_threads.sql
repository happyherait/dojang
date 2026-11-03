-- 프로토타입 단계의 기존 결재 데이터는 대화와 연결할 수 없으므로 비운다.
TRUNCATE approvals, approval_steps, payments;--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "thread_id" SET DATA TYPE uuid USING thread_id::uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "proposal_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_key_unique" UNIQUE("proposal_key");