CREATE TABLE "run_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connected_subscription_id" text NOT NULL,
	"template_id" text NOT NULL,
	"regions" text[],
	"day_of_month" integer NOT NULL,
	"hour" integer NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_attempt_month" text,
	"last_attempt_at" timestamp with time zone,
	"last_run_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_schedules_project_uq" UNIQUE("project_id"),
	CONSTRAINT "run_schedules_day_ck" CHECK ("run_schedules"."day_of_month" between 1 and 28),
	CONSTRAINT "run_schedules_hour_ck" CHECK ("run_schedules"."hour" between 0 and 23)
);
--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_connected_subscription_id_connected_subscriptions_id_fk" FOREIGN KEY ("connected_subscription_id") REFERENCES "public"."connected_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_schedules_workspace_idx" ON "run_schedules" USING btree ("workspace_id");