CREATE TABLE "live_metric_pulls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"project_id" text,
	"user_id" text NOT NULL,
	"connected_subscription_id" text NOT NULL,
	"resource_ids" jsonb NOT NULL,
	"resource_names" jsonb NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"timezone" text NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"resource_count" integer,
	"gap_count" integer,
	"error_code" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_metric_pulls" ADD CONSTRAINT "live_metric_pulls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_metric_pulls" ADD CONSTRAINT "live_metric_pulls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_metric_pulls" ADD CONSTRAINT "live_metric_pulls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_metric_pulls" ADD CONSTRAINT "live_metric_pulls_connected_subscription_id_connected_subscriptions_id_fk" FOREIGN KEY ("connected_subscription_id") REFERENCES "public"."connected_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_metric_pulls_workspace_created_at_idx" ON "live_metric_pulls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "live_metric_pulls_subscription_idx" ON "live_metric_pulls" USING btree ("connected_subscription_id");