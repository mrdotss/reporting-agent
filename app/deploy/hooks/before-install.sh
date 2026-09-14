#!/usr/bin/env bash
# Start every release from an empty landing directory, so a file removed from the app
# cannot survive from the previous bundle.
source "$(dirname "$0")/common.sh"

install -d -m 755 "$ROOT" "$RELEASES" "$STATE"
rm -rf "$INCOMING"
log "incoming directory cleared"
