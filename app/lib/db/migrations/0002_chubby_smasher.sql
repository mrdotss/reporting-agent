CREATE TABLE "report_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_template_versions_template_id_version_uq" UNIQUE("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"current_version_id" text,
	"draft_definition" jsonb,
	"seeded_starter_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_templates_user_id_seeded_starter_key_uq" UNIQUE("user_id","seeded_starter_key"),
	CONSTRAINT "report_templates_name_ck" CHECK (length("report_templates"."name") >= 1 AND length("report_templates"."name") <= 120),
	CONSTRAINT "report_templates_description_ck" CHECK (length("report_templates"."description") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "report_template_versions" ADD CONSTRAINT "report_template_versions_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_current_version_id_report_template_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."report_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_template_versions_template_id_idx" ON "report_template_versions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "report_templates_user_id_idx" ON "report_templates" USING btree ("user_id");