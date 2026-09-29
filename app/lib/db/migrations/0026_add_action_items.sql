CREATE TABLE "action_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"connected_subscription_id" text NOT NULL,
	"finding_key" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"title" text NOT NULL,
	"owner" text,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"first_seen_run_id" text NOT NULL,
	"first_seen_period" text NOT NULL,
	"last_seen_run_id" text NOT NULL,
	"resolved_run_id" text,
	"resolved_snapshot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_items_connector_finding_uq" UNIQUE("connected_subscription_id","finding_key"),
	CONSTRAINT "action_items_status_ck" CHECK ("action_items"."status" in ('open', 'accepted', 'wont_do', 'resolved')),
	CONSTRAINT "action_items_owner_ck" CHECK ("action_items"."owner" is null or "action_items"."owner" in ('customer', 'msp'))
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_connected_subscription_id_connected_subscriptions_id_fk" FOREIGN KEY ("connected_subscription_id") REFERENCES "public"."connected_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_items_project_idx" ON "action_items" USING btree ("project_id");