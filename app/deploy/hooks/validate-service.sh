#!/usr/bin/env bash
# Wait for the new release to answer /api/health with its own id. If it does not, put the
# previous release back and fail, so CodeDeploy marks the deployment failed.
source "$(dirname "$0")/common.sh"

for attempt in $(seq 1 60); do
  body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  if [[ "$body" == *"\"release\":\"$DEPLOYMENT_ID\""* && "$body" == *"\"status\":\"ok\""* ]]; then
    log "healthy after $attempt check(s)"
    exit 0
  fi
  sleep 2
done

log "not healthy after 120s; last response: ${body:-none}"
journalctl -u "$SERVICE" -n 40 --no-pager || true

PREVIOUS="$(cat "$STATE/previous-release" 2>/dev/null || true)"
if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
  ln -sfn "$PREVIOUS" "$CURRENT.next"
  mv -Tf "$CURRENT.next" "$CURRENT"
  printf 'RPT_RELEASE_ID=%s\n' "$(basename "$PREVIOUS")" > "$RELEASE_ENV"
  systemctl restart "$SERVICE"
  log "rolled back: current -> $PREVIOUS"
elif [[ -f "$STATE/original.service" ]]; then
  # The first cutover failed: restore the service as it was before releases existed.
  install -m 644 "$STATE/original.service" "$UNIT_FILE"
  rm -f "$CURRENT"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
  log "rolled back to the original service definition"
fi
exit 1
