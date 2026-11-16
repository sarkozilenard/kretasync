#!/bin/bash
# Betölti a relay.env fájlt és lefuttatja a relay-t. Cron/launchd is ezt hívja.
cd "$(dirname "$0")" || exit 1
set -a
. ./relay.env
set +a
exec python3 kreta_relay.py
