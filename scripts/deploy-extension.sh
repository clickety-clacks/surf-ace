#!/usr/bin/env bash
set -euo pipefail

DEST="${SURF_ACE_EXTENSION_DEST:-/Users/mike/.openclaw/extensions/surf-ace/extension/src}"

echo "Deploying extension src to $DEST..."
rsync -av --delete packages/extension/src/ "$DEST/"

echo "Restarting gateway..."
launchctl stop ai.openclaw.gateway
sleep 2
launchctl start ai.openclaw.gateway

echo "Done."
