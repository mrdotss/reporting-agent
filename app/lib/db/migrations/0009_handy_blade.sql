CREATE TYPE "public"."density" AS ENUM('compact', 'normal', 'relaxed');--> statement-breakpoint
CREATE TYPE "public"."page_size" AS ENUM('A4', 'Letter');--> statement-breakpoint
CREATE TYPE "public"."table_style" AS ENUM('hairline', 'banded', 'bordered');--> statement-breakpoint
CREATE TYPE "public"."theme_preset" AS ENUM('editorial', 'corporate', 'technical', 'minimal');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"theme_preset" "theme_preset" DEFAULT 'editorial' NOT NULL,
	"accent_color" text DEFAULT '#1f6f78' NOT NULL,
	"logo_key" text,
	"density" "density" DEFAULT 'normal' NOT NULL,
	"table_style" "table_style" DEFAULT 'hairline' NOT NULL,
	"page_size" "page_size" DEFAULT 'A4' NOT NULL,
	"number_format" jsonb DEFAULT '{"decimal_places":2,"group_thousands":true}'::jsonb NOT NULL,
	"cover_page" boolean DEFAULT true NOT NULL,
	"default_approver_names" jsonb,
	"confidentiality_notice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_name_ck" CHECK (length("brands"."name") >= 1 AND length("brands"."name") <= 120)
);
--> statement-breakpoint
ALTER TABLE "report_templates" ADD COLUMN "brand_id" text;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brands_user_id_idx" ON "brands" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;