#!/usr/bin/env bash
# Shared settings for the CodeDeploy hooks. Sourced, never run on its own.
set -euo pipefail

ROOT=/opt/reporting-agent-app
INCOMING="$ROOT/incoming"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
STATE="$ROOT/state"

ETC=/etc/reporting-agent
ENV_FILE="$ETC/app.env"
RELEASE_ENV="$ETC/release.env"

SERVICE=reporting-agent
UNIT_FILE=/etc/systemd/system/reporting-agent.service
APP_USER=mrdotss

# Where the secrets lived before releases existed; copied once, then never read again.
LEGACY_ENV=/opt/reporting-agent/app/.env

HEALTH_URL=http://127.0.0.1:3000/api/health
KEEP_RELEASES=5

# CodeDeploy sets DEPLOYMENT_ID for every hook; it names the release directory.
: "${DEPLOYMENT_ID:?CodeDeploy did not set DEPLOYMENT_ID}"
RELEASE_DIR="$RELEASES/$DEPLOYMENT_ID"

log() { printf '[deploy %s] %s\n' "$DEPLOYMENT_ID" "$*"; }
