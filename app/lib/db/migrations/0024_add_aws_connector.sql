ALTER TABLE "connected_subscriptions" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ALTER COLUMN "client_secret_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ALTER COLUMN "secret_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD COLUMN "role_arn" text;--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD COLUMN "regions" text[];--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD CONSTRAINT "connected_subscriptions_external_id_uq" UNIQUE("external_id");--> statement-breakpoint
ALTER TABLE "connected_subscriptions" ADD CONSTRAINT "connected_subscriptions_provider_fields_ck" CHECK (("connected_subscriptions"."provider" = 'azure'
        and "connected_subscriptions"."tenant_id" is not null and "connected_subscriptions"."client_id" is not null
        and "connected_subscriptions"."client_secret_enc" is not null and "connected_subscriptions"."secret_expires_at" is not null
        and "connected_subscriptions"."role_arn" is null and "connected_subscriptions"."external_id" is null)
      or ("connected_subscriptions"."provider" = 'aws'
        and "connected_subscriptions"."role_arn" is not null and "connected_subscriptions"."external_id" is not null
        and "connected_subscriptions"."tenant_id" is null and "connected_subscriptions"."client_id" is null
        and "connected_subscriptions"."client_secret_enc" is null and "connected_subscriptions"."secret_expires_at" is null)
      or "connected_subscriptions"."provider" = 'onprem');