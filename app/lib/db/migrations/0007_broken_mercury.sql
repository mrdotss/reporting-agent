CREATE TYPE "public"."scan_status" AS ENUM('queued', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "subscription_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connected_subscription_id" text NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"catalog_version" text,
	"sections_catalogue_version" text,
	"resource_count" integer,
	"type_counts" jsonb,
	"child_type_counts" jsonb,
	"resource_groups" jsonb,
	"regions" jsonb,
	"region_probes" jsonb,
	"truncated" boolean,
	"error_code" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_scans" ADD CONSTRAINT "subscription_scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_scans" ADD CONSTRAINT "subscription_scans_connected_subscription_id_connected_subscriptions_id_fk" FOREIGN KEY ("connected_subscription_id") REFERENCES "public"."connected_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_scans_user_id_idx" ON "subscription_scans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_scans_subscription_created_at_idx" ON "subscription_scans" USING btree ("connected_subscription_id","created_at");