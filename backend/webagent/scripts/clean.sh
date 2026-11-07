#!/usr/bin/env bash
# Usage: scripts/clean.sh          -> wipe recordings, skills, results, logs, cache
#        scripts/clean.sh --all    -> also wipe model quota status + agent browser login
set -euo pipefail
cd "$(dirname "$0")/.."

for d in traces intents results logs cache; do
  rm -rf "data/$d"
  mkdir -p "data/$d"
done
echo "Cleared recordings, skills, results, logs and cache."

if [[ "${1:-}" == "--all" ]]; then
  rm -f data/model_status.json
  rm -rf ../../.agent-profile
  echo "Also cleared model quota status and the agent browser profile."
  echo "Run 'uv run python -m webagent.login' before the next demo."
fi