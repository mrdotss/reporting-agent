CREATE TYPE "public"."source_provider" AS ENUM('azure', 'aws', 'onprem');--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD COLUMN "provider" "source_provider" DEFAULT 'azure' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_templates" ADD COLUMN "provider" "source_provider" DEFAULT 'azure' NOT NULL;