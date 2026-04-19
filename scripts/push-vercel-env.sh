#!/usr/bin/env bash
# Push every non-empty var from .env.local into Vercel production env.
# Idempotent: removes existing value before adding (`vercel env rm -y`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$REPO_ROOT/.env.local}"
TARGET="${2:-production}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file $ENV_FILE not found"
  exit 1
fi

cd "$REPO_ROOT/apps/web"

while IFS='=' read -r key value; do
  # Strip whitespace/comments/blanks
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  # Trim trailing newlines/carriage returns from value
  value="${value%$'\r'}"
  # Skip empty values (nothing to set)
  [[ -z "$value" ]] && continue
  # Skip clearly-placeholder values
  if [[ "$value" == REPLACE_ME* ]]; then
    echo "⚠️  SKIP $key (placeholder)"
    continue
  fi

  # Remove existing value first (quiet if absent)
  vercel env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true

  # Pipe value in (vercel env add reads stdin for the value)
  printf '%s' "$value" | vercel env add "$key" "$TARGET" >/dev/null 2>&1 \
    && echo "✅ $key" \
    || echo "❌ $key (failed)"
done < <(grep -v '^\s*#' "$ENV_FILE" | grep '=')

echo ""
echo "Done. Check https://vercel.com/islamyousrygoldinkollars-projects/nexus/settings/environment-variables"
