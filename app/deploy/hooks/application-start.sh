#!/usr/bin/env bash
# Switch `current` to the new release and restart the service on it.
source "$(dirname "$0")/common.sh"

# Remember what was serving, for the validate hook's rollback.
if [[ -L "$CURRENT" ]]; then
  readlink -f "$CURRENT" > "$STATE/previous-release"
else
  : > "$STATE/previous-release"
fi

# The unit this release expects. The one it replaces is kept once, the first time, so a
# failed first cutover can put back the service exactly as it was before releases.
if ! cmp -s "$RELEASE_DIR/.deploy/reporting-agent.service" "$UNIT_FILE"; then
  if [[ -f "$UNIT_FILE" && ! -f "$STATE/original.service" ]]; then
    cp "$UNIT_FILE" "$STATE/original.service"
  fi
  install -m 644 "$RELEASE_DIR/.deploy/reporting-agent.service" "$UNIT_FILE"
  systemctl daemon-reload
  log "installed the release's systemd unit"
fi

# The release id the health check must see come back.
install -d -m 755 "$ETC"
printf 'RPT_RELEASE_ID=%s\n' "$DEPLOYMENT_ID" > "$RELEASE_ENV"

# Atomic switch: a new symlink renamed over the old one.
ln -sfn "$RELEASE_DIR" "$CURRENT.next"
mv -Tf "$CURRENT.next" "$CURRENT"
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
log "current -> $RELEASE_DIR; $SERVICE restarted"

# Keep the newest releases, and never the ones serving or rolled back to.
PREVIOUS="$(cat "$STATE/previous-release")"
ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | tail -n +"$((KEEP_RELEASES + 1))" | while read -r old; do
  if [[ "$old" != "$RELEASE_DIR" && "$old" != "$PREVIOUS" ]]; then
    rm -rf "$old"
    log "pruned $old"
  fi
done
