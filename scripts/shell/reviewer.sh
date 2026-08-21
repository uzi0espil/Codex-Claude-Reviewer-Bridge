#!/usr/bin/env bash
set -euo pipefail

reviewer_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$reviewer_script_dir/../reviewer.mjs" "$@"
