-- Preserve all existing row IDs, artifact actor prefixes and immutable versions.
INSERT INTO workspaces(id,name,created_by,imported_for_user_id)
SELECT 'imported-'||id,'My workspace',id,id FROM users ON CONFLICT(imported_for_user_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO workspace_members(id,workspace_id,user_id,role)
SELECT 'imported-member-'||id,'imported-'||id,id,'owner' FROM users ON CONFLICT(workspace_id,user_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO projects(id,workspace_id,name,description)
SELECT 'imported-project-'||id,'imported-'||id,'Imported','Existing reporting data' FROM users ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
UPDATE connected_subscriptions SET workspace_id='imported-'||user_id,project_id='imported-project-'||user_id WHERE workspace_id IS NULL;
--> statement-breakpoint
UPDATE report_templates SET workspace_id='imported-'||user_id,project_id='imported-project-'||user_id WHERE workspace_id IS NULL;
--> statement-breakpoint
UPDATE report_runs SET workspace_id='imported-'||user_id,project_id='imported-project-'||user_id WHERE workspace_id IS NULL;
--> statement-breakpoint
UPDATE subscription_scans SET workspace_id='imported-'||user_id,project_id='imported-project-'||user_id WHERE workspace_id IS NULL;
--> statement-breakpoint
-- Fail the transaction rather than reinterpret inconsistent historical relationships.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM report_runs r JOIN connected_subscriptions c ON c.id=r.connected_subscription_id WHERE r.project_id<>c.project_id)
 OR EXISTS(SELECT 1 FROM report_runs r JOIN report_template_versions v ON v.id=r.template_version_id JOIN report_templates t ON t.id=v.template_id WHERE r.project_id<>t.project_id)
 THEN RAISE EXCEPTION 'Workspace backfill validation failed'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE connected_subscriptions DROP CONSTRAINT connected_subscriptions_user_id_subscription_id_uq;
--> statement-breakpoint
ALTER TABLE connected_subscriptions ADD CONSTRAINT connected_subscriptions_workspace_subscription_uq UNIQUE(workspace_id,subscription_id);
--> statement-breakpoint
-- Parent consistency is enforced even for writes outside the application.
ALTER TABLE connected_subscriptions ADD CONSTRAINT connected_subscription_project_scope_fk FOREIGN KEY(project_id,workspace_id) REFERENCES projects(id,workspace_id);
ALTER TABLE report_templates ADD CONSTRAINT report_template_project_scope_fk FOREIGN KEY(project_id,workspace_id) REFERENCES projects(id,workspace_id);
ALTER TABLE report_runs ADD CONSTRAINT report_run_project_scope_fk FOREIGN KEY(project_id,workspace_id) REFERENCES projects(id,workspace_id);
ALTER TABLE subscription_scans ADD CONSTRAINT subscription_scan_project_scope_fk FOREIGN KEY(project_id,workspace_id) REFERENCES projects(id,workspace_id);
--> statement-breakpoint
-- Compatibility default for old writers during the additive rollout; explicit scopes win.
CREATE FUNCTION reporting_scope_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS NULL AND NEW.project_id IS NULL THEN
  NEW.workspace_id := 'imported-'||NEW.user_id;
  NEW.project_id := 'imported-project-'||NEW.user_id;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER connected_subscription_scope BEFORE INSERT ON connected_subscriptions FOR EACH ROW EXECUTE FUNCTION reporting_scope_defaults();
CREATE TRIGGER report_template_scope BEFORE INSERT ON report_templates FOR EACH ROW EXECUTE FUNCTION reporting_scope_defaults();
CREATE TRIGGER report_run_scope BEFORE INSERT ON report_runs FOR EACH ROW EXECUTE FUNCTION reporting_scope_defaults();
CREATE TRIGGER subscription_scan_scope BEFORE INSERT ON subscription_scans FOR EACH ROW EXECUTE FUNCTION reporting_scope_defaults();
--> statement-breakpoint
ALTER TABLE connected_subscriptions ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE report_templates ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE report_runs ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE subscription_scans ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL;
--> statement-breakpoint
-- New users receive the same compatibility workspace before legacy starter seeding.
CREATE FUNCTION reporting_new_user_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO workspaces(id,name,created_by,imported_for_user_id) VALUES('imported-'||NEW.id,'My workspace',NEW.id,NEW.id);
 INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES('imported-member-'||NEW.id,'imported-'||NEW.id,NEW.id,'owner');
 INSERT INTO projects(id,workspace_id,name) VALUES('imported-project-'||NEW.id,'imported-'||NEW.id,'Imported');
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER reporting_user_workspace AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION reporting_new_user_workspace();
