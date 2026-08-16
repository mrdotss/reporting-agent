CREATE TYPE "public"."fidelity_tier" AS ENUM('baseline', 'enhanced');--> statement-breakpoint
CREATE TYPE "public"."run_error_code" AS ENUM('AUTH_EXPIRED', 'AUTH_FAILED', 'SCOPE_UNVERIFIED', 'SECRET_UNREADABLE', 'EMPTY_SCOPE', 'CATALOG_UNUSABLE', 'NO_STATISTICS', 'REGION_UNREACHABLE', 'THROTTLED', 'TIMEOUT');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'claimed', 'collecting', 'compiling', 'rendering', 'verifying', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('pending', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "connected_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"subscription_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"scope_verified" boolean DEFAULT false NOT NULL,
	"fidelity_tier" "fidelity_tier" DEFAULT 'baseline' NOT NULL,
	"secret_expires_at" timestamp with time zone NOT NULL,
	"status" "subscription_status" DEFAULT 'pending' NOT NULL,
	"log_analytics_workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_subscriptions_user_id_subscription_id_uq" UNIQUE("user_id","subscription_id")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"email_normalized" text NOT NULL,
	"success" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connected_subscription_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"scope" jsonb NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"dedupe_key" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase_deadline" timestamp with time zone,
	"error_code" "run_error_code",
	"error_message" text,
	"progress_token_hash" text NOT NULL,
	"progress_current" integer,
	"progress_total" integer,
	"progress_label" text,
	"snapshot_id" text,
	"resource_count" integer,
	"gap_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_runs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "report_runs_error_code_ck" CHECK (("report_runs"."status" = 'failed' AND "report_runs"."error_code" IS NOT NULL) OR
          ("report_runs"."status" <> 'failed' AND "report_runs"."error_code" IS NULL)),
	CONSTRAINT "report_runs_dedupe_key_ck" CHECK (length("report_runs"."dedupe_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_token_hash" text NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_normalized_unique" UNIQUE("email_normalized")
);
--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD CONSTRAINT "connected_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_connected_subscription_id_connected_subscriptions_id_fk" FOREIGN KEY ("connected_subscription_id") REFERENCES "public"."connected_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_subscriptions_user_id_idx" ON "connected_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_attempts_email_normalized_created_at_idx" ON "login_attempts" USING btree ("email_normalized","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "report_runs_user_id_idx" ON "report_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "report_runs_status_created_at_idx" ON "report_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_phase_deadline_idx" ON "report_runs" USING btree ("phase_deadline");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");