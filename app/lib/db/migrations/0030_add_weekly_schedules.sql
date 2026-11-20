ALTER TABLE "run_schedules" DROP CONSTRAINT "run_schedules_project_uq";--> statement-breakpoint
ALTER TABLE "run_schedules" ALTER COLUMN "day_of_month" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD COLUMN "cadence" text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD COLUMN "day_of_week" integer;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD COLUMN "auto_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD COLUMN "last_sent_run_id" text;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD COLUMN "last_send_error" text;--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_project_cadence_uq" UNIQUE("project_id","cadence");--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_weekday_ck" CHECK ("run_schedules"."day_of_week" between 1 and 7);--> statement-breakpoint
ALTER TABLE "run_schedules" ADD CONSTRAINT "run_schedules_cadence_ck" CHECK (("run_schedules"."cadence" = 'monthly' and "run_schedules"."day_of_month" is not null) or ("run_schedules"."cadence" = 'weekly' and "run_schedules"."day_of_week" is not null));