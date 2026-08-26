CREATE TABLE "report_profile_authored_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"template_version_id" text NOT NULL,
	"scan_id" text NOT NULL,
	"section_id" text NOT NULL,
	"matched_count" integer NOT NULL,
	"matched_resource_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_profile_authored_matches_version_section_uq" UNIQUE("template_version_id","section_id")
);
--> statement-breakpoint
ALTER TABLE "report_profile_authored_matches" ADD CONSTRAINT "report_profile_authored_matches_template_version_id_report_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."report_template_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_profile_authored_matches" ADD CONSTRAINT "report_profile_authored_matches_scan_id_subscription_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."subscription_scans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_profile_authored_matches_scan_id_idx" ON "report_profile_authored_matches" USING btree ("scan_id");