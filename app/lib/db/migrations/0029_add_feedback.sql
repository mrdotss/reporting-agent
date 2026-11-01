CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"user_email" text NOT NULL,
	"workspace_id" text,
	"workspace_name" text,
	"role" text,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"page_path" text,
	"can_reply" boolean NOT NULL,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"email_error" text,
	"emailed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_kind_ck" CHECK ("feedback"."kind" in ('idea', 'problem', 'question', 'praise')),
	CONSTRAINT "feedback_email_status_ck" CHECK ("feedback"."email_status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feedback_user_created_idx" ON "feedback" USING btree ("user_id","created_at");