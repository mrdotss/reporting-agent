#!/usr/bin/env bash
# Assemble the CodeDeploy bundle from a finished `next build`.
#
#   bash app/deploy/package.sh <out-dir>
#
# buildspec.yml runs this and pushes <out-dir>; it runs the same on a workstation, which
# is how to look at exactly what a deployment would ship. The bundle is small on purpose:
#
#   appspec.yml        CodeDeploy's instructions (deploy/appspec.yml)
#   RELEASE            commit, build number, build time
#   release.tar.gz     .next/standalone with .next/static and public beside server.js
#   deploy/            hooks, the systemd unit, migrate.cjs and the committed migrations
#
# The server is one tarball rather than loose files because pnpm's node_modules is made of
# symlinks: tar keeps them, CodeDeploy's per-file copy does not.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: package.sh <out-dir>}"
ESBUILD_VERSION="${ESBUILD_VERSION:-0.28.1}"

if [[ ! -f "$APP/.next/standalone/app/server.js" ]]; then
  echo "no standalone build under $APP/.next; run \`pnpm build\` first" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT/deploy"

# 1. The server. The standalone output leaves static assets and public/ to the caller.
cp -a "$APP/.next/standalone/." "$STAGE/"
cp -a "$APP/.next/static" "$STAGE/app/.next/static"
if [[ -d "$APP/public" ]]; then
  cp -a "$APP/public" "$STAGE/app/public"
fi
# Next copies any .env it finds into the standalone output. A release never carries one:
# the server reads /etc/reporting-agent/app.env.
find "$STAGE" -maxdepth 2 -name '.env*' -type f -print -delete
tar -czf "$OUT/release.tar.gz" -C "$STAGE" .

# 2. Migrations. drizzle-kit is not in the standalone output, so the migrator is bundled.
(
  cd "$APP"
  pnpm dlx "esbuild@$ESBUILD_VERSION" scripts/migrate.ts \
    --bundle --platform=node --format=cjs --target=node24 \
    --external:pg-native --log-level=warning \
    --outfile="$OUT/deploy/migrate.cjs"
)
cp -a "$APP/lib/db/migrations" "$OUT/deploy/migrations"

# 3. How to install it.
cp -a "$APP/deploy/hooks" "$APP/deploy/reporting-agent.service" "$OUT/deploy/"
cp "$APP/deploy/appspec.yml" "$OUT/appspec.yml"

printf 'commit %s\nbuild %s\nbuilt %s\n' \
  "${CODEBUILD_RESOLVED_SOURCE_VERSION:-$(git -C "$APP" rev-parse HEAD)}" \
  "${CODEBUILD_BUILD_NUMBER:-local}" \
  "$(date -u +%FT%TZ)" > "$OUT/RELEASE"

du -sh "$OUT/release.tar.gz" "$OUT/deploy"
