CREATE TYPE "public"."verification_status" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TABLE "report_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"template_version_id" text NOT NULL,
	"status" "verification_status" NOT NULL,
	"figure_count" integer NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"docx_sha256" text NOT NULL,
	"pdf_sha256" text NOT NULL,
	"replay" jsonb NOT NULL,
	"drift_sample" jsonb NOT NULL,
	"findings" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"artifact_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_verifications_run_id_attempt_id_uq" UNIQUE("run_id","attempt_id"),
	CONSTRAINT "report_verifications_figure_count_ck" CHECK ("report_verifications"."figure_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "template_version_id" text;--> statement-breakpoint
ALTER TABLE "report_verifications" ADD CONSTRAINT "report_verifications_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_verifications" ADD CONSTRAINT "report_verifications_template_version_id_report_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."report_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_verifications_run_id_idx" ON "report_verifications" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_template_version_id_report_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."report_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_template_version_id_ck" CHECK ("report_runs"."created_at" < '2026-12-01T00:00:00Z'::timestamptz OR "report_runs"."template_version_id" IS NOT NULL);