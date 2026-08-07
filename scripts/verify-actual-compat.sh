#!/usr/bin/env bash
set -euo pipefail

container_cli="${CONTAINER_CLI:-docker}"
smoke_dir="$(mktemp -d /tmp/hf-actual-smoke.XXXXXX)"
container_name="hf-actual-smoke-$$"

cleanup() {
  "$container_cli" stop --time 1 "$container_name" >/dev/null 2>&1 || true
  if [[ "$smoke_dir" == /tmp/hf-actual-smoke.* ]]; then
    find "$smoke_dir" -depth -delete
  fi
}
trap cleanup EXIT INT TERM

"$container_cli" run --rm --detach \
  --name "$container_name" \
  --publish 127.0.0.1::5006 \
  --tmpfs /data \
  docker.io/actualbudget/actual-server:latest >/dev/null

host_port="$($container_cli port "$container_name" 5006/tcp | sed -E 's/^.*:([0-9]+)$/\1/')"
if [[ ! "$host_port" =~ ^[0-9]+$ ]]; then
  printf 'Actual compatibility check could not resolve the server port\n' >&2
  exit 1
fi

ready=false
for ((attempt = 1; attempt <= 60; attempt++)); do
  if curl --fail --silent --show-error \
    "http://127.0.0.1:${host_port}/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  "$container_cli" logs "$container_name"
  exit 1
fi

curl --fail --silent --show-error \
  --header 'content-type: application/json' \
  --data '{"password":"actual-compat-ci-only"}' \
  "http://127.0.0.1:${host_port}/account/bootstrap" >/dev/null

mkdir -p "$smoke_dir/client-a" "$smoke_dir/client-b"
ACTUAL_SMOKE_SERVER_URL="http://127.0.0.1:${host_port}" \
  ACTUAL_SMOKE_PASSWORD='actual-compat-ci-only' \
  ACTUAL_SMOKE_DATA_ROOT="$smoke_dir" \
  node scripts/actual-compat-smoke.mjs
