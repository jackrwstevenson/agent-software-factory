#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export FACTORY_CODEX_BIN="/Users/username/.codex/packages/standalone/releases/0.154.0-aarch64-apple-darwin/bin/codex"
export FACTORY_CODEX_SHA256="4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc"
eval "$(python3 - <<'PY'
from pathlib import Path
import shlex, tomllib
c=tomllib.loads((Path.home()/'.codex/config.toml').read_text())
i=c['model_provider']; p=c['model_providers'][i]
values={
'FACTORY_CODEX_PROVIDER_ID':i,
'FACTORY_CODEX_PROVIDER_NAME':p['name'],
'FACTORY_CODEX_PROVIDER_BASE_URL':p['base_url'],
'FACTORY_CODEX_PROVIDER_WIRE_API':p['wire_api'],
'FACTORY_CODEX_PROVIDER_ENV_KEY':p['env_key'],
'FACTORY_CODEX_MODEL':c['model']}
for k,v in values.items(): print(f'export {k}={shlex.quote(str(v))}')
PY
)"
export FACTORY_CODEX_HOME="/private/tmp/asf-real-codex-home"
export FACTORY_DEMO_STATE_ROOT="/private/tmp/asf-real-codex-demo"
cd "$ROOT"
npm run build --silent
node scripts/real-codex-agents-demo.mjs
