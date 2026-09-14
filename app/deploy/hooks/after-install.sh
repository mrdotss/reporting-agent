#!/usr/bin/env bash
# Put the secrets in place, apply migrations, and unpack the release under its own id.
# Nothing here touches the running service: if a step fails, the current release keeps
# serving and the deployment is marked failed.
source "$(dirname "$0")/common.sh"

# 1. Secrets outside every release. The first deployment copies the hand-managed .env
#    from the old git checkout; after that the file is only ever edited in place.
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$LEGACY_ENV" ]]; then
    install -d -m 755 "$ETC"
    install -m 600 -o root -g root "$LEGACY_ENV" "$ENV_FILE"
    log "copied $LEGACY_ENV to $ENV_FILE (first release)"
  else
    log "no $ENV_FILE and no $LEGACY_ENV to copy it from; create $ENV_FILE first"
    exit 1
  fi
fi

# 2. Migrations, before the switch. They are additive, so the release still serving is
#    unaffected by them. Node reads the env file itself; the shell never parses secrets.
log "applying migrations"
/usr/bin/node --env-file="$ENV_FILE" "$INCOMING/deploy/migrate.cjs" "$INCOMING/deploy/migrations"

# 3. Unpack the release. It travels as one tarball because pnpm's node_modules is made of
#    symlinks, which tar keeps and CodeDeploy's own file copy does not. The deploy
#    scripts are kept beside it, so a rollback target is complete.
rm -rf "$RELEASE_DIR"
install -d -m 755 "$RELEASE_DIR"
tar -xzf "$INCOMING/release.tar.gz" -C "$RELEASE_DIR"
cp "$INCOMING/RELEASE" "$RELEASE_DIR/RELEASE"
cp -r "$INCOMING/deploy" "$RELEASE_DIR/.deploy"
chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR"
log "release unpacked at $RELEASE_DIR ($(head -1 "$RELEASE_DIR/RELEASE"))"
