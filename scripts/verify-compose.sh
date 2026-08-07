#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rendered="$(mktemp)"
rendered_json="$(mktemp)"
published_rendered_json="$(mktemp)"
trap 'rm -f -- "$rendered" "$rendered_json" "$published_rendered_json"' EXIT

docker compose \
  --project-directory "$repo_root" \
  --env-file "$repo_root/.env.example" \
  -f "$repo_root/compose.yaml" \
  config >"$rendered"

docker compose \
  --project-directory "$repo_root" \
  --env-file "$repo_root/.env.example" \
  -f "$repo_root/compose.yaml" \
  config --format json >"$rendered_json"

default_services="$(
  docker compose \
    --project-directory "$repo_root" \
    --env-file "$repo_root/.env.example" \
    -f "$repo_root/compose.yaml" \
    config --services
)"

if ! rg -qx -- 'actual-writer' <<<"$default_services"; then
  printf 'compose verification failed: actual-writer must be active in the default Arcane render\n' >&2
  exit 1
fi

require() {
  local pattern="$1"
  local message="$2"
  if ! rg -q -- "$pattern" "$rendered"; then
    printf 'compose verification failed: %s\n' "$message" >&2
    exit 1
  fi
}

reject() {
  local pattern="$1"
  local message="$2"
  if rg -q -- "$pattern" "$rendered"; then
    printf 'compose verification failed: %s\n' "$message" >&2
    exit 1
  fi
}

require 'read_only: true' 'finance-bot must use a read-only root filesystem'
require 'no-new-privileges:true' 'no-new-privileges must be enabled'
require 'source: talk_bot_secret' 'the Talk bot secret must be a Compose secret'
require 'source: nextcloud_app_password' 'the Nextcloud app password must be a Compose secret'
require 'source: actual_oidc_config' 'the Actual OIDC configuration must be a Compose secret'
require 'source: xai_api_key' 'the xAI key must be a Compose secret'
require 'ACTUAL_CONFIG_PATH: /run/secrets/actual_oidc_config\.json' 'Actual must read OIDC configuration from the mounted secret'
require 'ACTUAL_AUTO_APPROVAL_ENABLED: "false"' 'Actual update auto-approval must default off'
require 'INTAKE_MODE: disabled' 'Talk intake must default disabled'
require 'com.getarcaneapp.arcane.updater: "false"' 'Arcane per-container updates must be disabled'
require 'pull_policy: build' 'the source-build example must rebuild the local application images'
require 'source: attachment-shadow-data' 'attachment shadow state must use a dedicated named volume'
require 'source: actual-data' 'Actual state must use a named volume'
require 'source: actual-reader-data' 'the Actual reader must use separate state storage'
require 'source: actual_server_password' 'the Actual reader password must be a Compose secret'
require 'source: actual_read_contract' 'the Actual reader contract must be a separate Compose secret'
require 'source: actual-writer-data' 'the Actual writer must use separate state storage'
require 'source: actual_server_password' 'the Actual writer password must be a Compose secret'
require 'source: actual_production_contract' 'the production contract must be a Compose secret'
require 'source: actual_update_signing_key' 'the update signing key must be a Compose secret'
require 'nocopy: true' 'Actual data volume must disable image copy-up'
require 'name: vlan100_household-finance' 'Actual ingress must use the project-scoped service VLAN'
require 'driver: ipvlan' 'Actual ingress must use IPVLAN'
require 'parent: eth0\.100' 'the generic VLAN trunk must render correctly'
require 'ipv4_address: 192\.168\.100\.10' 'Actual must have the fixed reverse-proxy address'
require 'ipv4_address: 192\.168\.100\.11' 'finance-bot must have the fixed signed-webhook address'
require 'subnet: 192\.168\.100\.0/24' 'the service VLAN subnet must render correctly'
require 'gateway: 192\.168\.100\.1' 'the service VLAN gateway must render correctly'
reject 'source: /var/run/docker.sock' 'Docker socket mounts are forbidden'
reject 'source: /mnt/ncdata' 'direct Nextcloud data mounts are forbidden'
reject 'source: /home/' 'home-directory mounts are forbidden'
reject 'published:' 'host ports are forbidden; ingress must use the service VLAN and reverse proxy'
reject 'ACTUAL_OPENID_CLIENT_SECRET' 'the Actual OIDC client secret must not be exposed through container environment variables'

if ! jq -e '
  .services["finance-bot"].image == "household-finance-bot:local" and
  .services["document-preparer"].image == "household-finance-document-preparer:local" and
  .services["actual-reader"].image == "household-finance-actual-reader:local" and
  .services["actual-writer"].image == "household-finance-actual-writer:local" and
  ([
    .services["finance-bot"],
    .services["document-preparer"],
    .services["actual-reader"],
    .services["actual-writer"]
  ] | all(.pull_policy == "build"))
' "$rendered_json" >/dev/null; then
  printf 'compose verification failed: the local image defaults are incorrect\n' >&2
  exit 1
fi

published_revision='0123456789abcdef0123456789abcdef01234567'
finance_bot_image="ghcr.io/deftmartian/household-finance-bot:${published_revision}@sha256:1111111111111111111111111111111111111111111111111111111111111111"
document_preparer_image="ghcr.io/deftmartian/household-finance-document-preparer:${published_revision}@sha256:2222222222222222222222222222222222222222222222222222222222222222"
actual_reader_image="ghcr.io/deftmartian/household-finance-actual-reader:${published_revision}@sha256:3333333333333333333333333333333333333333333333333333333333333333"
actual_writer_image="ghcr.io/deftmartian/household-finance-actual-writer:${published_revision}@sha256:4444444444444444444444444444444444444444444444444444444444444444"

env \
  HOUSEHOLD_FINANCE_IMAGE_PULL_POLICY=missing \
  FINANCE_BOT_IMAGE="$finance_bot_image" \
  DOCUMENT_PREPARER_IMAGE="$document_preparer_image" \
  ACTUAL_READER_IMAGE="$actual_reader_image" \
  ACTUAL_WRITER_IMAGE="$actual_writer_image" \
  docker compose \
  --project-directory "$repo_root" \
  --env-file "$repo_root/.env.example" \
  -f "$repo_root/compose.yaml" \
  config --format json >"$published_rendered_json"

if ! jq -e \
  --arg finance_bot_image "$finance_bot_image" \
  --arg document_preparer_image "$document_preparer_image" \
  --arg actual_reader_image "$actual_reader_image" \
  --arg actual_writer_image "$actual_writer_image" '
  .services["finance-bot"].image == $finance_bot_image and
  .services["document-preparer"].image == $document_preparer_image and
  .services["actual-reader"].image == $actual_reader_image and
  .services["actual-writer"].image == $actual_writer_image and
  ([
    .services["finance-bot"],
    .services["document-preparer"],
    .services["actual-reader"],
    .services["actual-writer"]
  ] | all(.pull_policy == "missing")) and
  .services["finance-bot"].build.target == "finance-runtime" and
  .services["document-preparer"].build.target == "document-preparer-runtime" and
  .services["actual-reader"].build.target == "actual-reader-runtime" and
  .services["actual-writer"].build.target == "actual-writer-runtime" and
  .services["actual-server"].image == "actualbudget/actual-server:26.7.0"
' "$published_rendered_json" >/dev/null; then
  printf 'compose verification failed: the published-image overrides are incorrect\n' >&2
  exit 1
fi

if ! jq -e '
  (.services["actual-server"].networks | has("finance-internal")) and
  .services["actual-server"].networks["finance-internal"].aliases == ["actual-server"] and
  .services["actual-server"].networks["finance-edge"].ipv4_address == "192.168.100.10" and
  .services["actual-server"].dns == ["192.168.1.1"] and
  .services["actual-server"].environment.ACTUAL_CONFIG_PATH == "/run/secrets/actual_oidc_config.json" and
  ([.services["actual-server"].secrets[] |
    select(
      .source == "actual_oidc_config" and
      .target == "actual_oidc_config.json"
    )] | length == 1) and
  (.secrets.actual_oidc_config.file | endswith("/secrets/actual_oidc_config.json")) and
  (.services["actual-server"].ports == null) and
  .services["actual-server"].read_only == true and
  .services["actual-server"].tmpfs == ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"] and
  .services["actual-server"].cap_drop == ["ALL"] and
  (.services["actual-server"].security_opt | index("no-new-privileges:true")) != null and
  .services["actual-server"].pids_limit == 256 and
  .services["actual-server"].mem_limit == "1073741824" and
  .services["actual-server"].cpus == 2 and
  (.services["finance-bot"].networks | has("finance-internal") | not) and
  (.services["finance-bot"].networks | has("finance-query")) and
  .services["finance-bot"].pull_policy == "build" and
  .services["finance-bot"].build.target == "finance-runtime" and
  .services["finance-bot"].read_only == true and
  .services["finance-bot"].user == "1000:1000" and
  .services["finance-bot"].tmpfs == ["/tmp:size=128m,mode=1777,noexec,nosuid,nodev"] and
  .services["finance-bot"].cap_drop == ["ALL"] and
  (.services["finance-bot"].security_opt | index("no-new-privileges:true")) != null and
  .services["finance-bot"].networks["finance-edge"].ipv4_address == "192.168.100.11" and
  (.services["finance-bot"].networks | has("document-preparation")) and
  .services["finance-bot"].dns == ["192.168.1.1"] and
  .services["finance-bot"].environment.INTAKE_MODE == "disabled" and
  .services["finance-bot"].environment.ACTUAL_READER_URL == "http://actual-reader:4370" and
  .services["finance-bot"].environment.ACTUAL_BANK_SYNC_INTERVAL_HOURS == "4" and
  .services["finance-bot"].environment.ACTUAL_AUTO_APPROVAL_ENABLED == "false" and
  .services["finance-bot"].environment.ACTUAL_UPDATE_SIGNING_KEY_FILE == "/run/secrets/actual_update_signing_key" and
  .services["finance-bot"].environment.ACTUAL_UPDATE_SIGNING_KEY_ID == "production-v1" and
  ([.services["finance-bot"].environment | keys[] | select(startswith("ACTUAL_"))] | sort ==
    ["ACTUAL_AUTO_APPROVAL_ENABLED", "ACTUAL_BANK_SYNC_INTERVAL_HOURS",
     "ACTUAL_READER_URL",
     "ACTUAL_UPDATE_SIGNING_KEY_FILE", "ACTUAL_UPDATE_SIGNING_KEY_ID"]) and
  .services["finance-bot"].depends_on["document-preparer"].condition == "service_healthy" and
  ([.services["finance-bot"].secrets[] |
    select(.source == "actual_oidc_config")] | length == 0) and
  ([.services["finance-bot"].secrets[] |
    select(.source == "xai_api_key")] | length == 1) and
  ([.services["finance-bot"].secrets[] |
    select(.source == "actual_server_password")] | length == 0) and
  ([.services["finance-bot"].secrets[] |
    select(.source == "actual_production_contract")] | length == 0) and
  ([.services["finance-bot"].secrets[] |
    select(
      .source == "actual_update_signing_key" and
      .target == "/run/secrets/actual_update_signing_key"
    )] | length == 1) and
  ([.services["finance-bot"].secrets[] |
    select(.source == "actual_read_contract")] | length == 0) and
  ([.services["finance-bot"].secrets[] |
    select(.source == "nextcloud_app_password")] | length == 1) and
  ([.services["finance-bot"].secrets[] |
    select(.source == "talk_bot_secret")] | length == 1) and
  .services["finance-bot"].volumes[0].source == "attachment-shadow-data" and
  (.services["finance-bot"].ports == null) and
  .services["finance-bot"].depends_on["actual-reader"].condition == "service_healthy" and
  .services["document-preparer"].pull_policy == "build" and
  .services["document-preparer"].build.target == "document-preparer-runtime" and
  .services["document-preparer"].read_only == true and
  .services["document-preparer"].user == "1000:1000" and
  .services["document-preparer"].tmpfs == ["/tmp:size=128m,mode=1777,noexec,nosuid,nodev"] and
  .services["document-preparer"].cap_drop == ["ALL"] and
  (.services["document-preparer"].security_opt | index("no-new-privileges:true")) != null and
  .services["document-preparer"].environment == {
    "HOST": "0.0.0.0",
    "NODE_ENV": "production",
    "PORT": "4390"
  } and
  (.services["document-preparer"].networks | keys) == ["document-preparation"] and
  (.services["document-preparer"].secrets == null) and
  (.services["document-preparer"].volumes == null) and
  (.services["document-preparer"].ports == null) and
  (.services["document-preparer"].dns == null) and
  .services["actual-reader"].pull_policy == "build" and
  .services["actual-reader"].build.target == "actual-reader-runtime" and
  .services["actual-reader"].read_only == true and
  .services["actual-reader"].user == "1000:1000" and
  .services["actual-reader"].tmpfs == ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"] and
  .services["actual-reader"].cap_drop == ["ALL"] and
  (.services["actual-reader"].security_opt | index("no-new-privileges:true")) != null and
  .services["actual-reader"].environment == {
    "ACTUAL_READ_CONTRACT_FILE": "/run/secrets/actual_read_contract",
    "ACTUAL_SERVER_PASSWORD_FILE": "/run/secrets/actual_server_password",
    "ACTUAL_SERVER_URL": "http://actual-server:5006",
    "DATA_DIR": "/reader-data",
    "HOST": "0.0.0.0",
    "NODE_ENV": "production",
    "PORT": "4370"
  } and
  ([.services["actual-reader"].secrets[] | .source] | sort) ==
    ["actual_read_contract", "actual_server_password"] and
  .services["actual-reader"].volumes == [{
    "type": "volume",
    "source": "actual-reader-data",
    "target": "/reader-data"
  }] and
  (.services["actual-reader"].networks | keys | sort) ==
    ["finance-internal", "finance-query"] and
  .services["actual-reader"].depends_on["actual-server"].condition == "service_healthy" and
  .services["actual-reader"].ports == null and
  .services["actual-reader"].expose == ["4370"] and
  .services["actual-reader"].dns == null and
  (.services["actual-server"].networks | has("document-preparation") | not) and
  .networks["document-preparation"].internal == true and
  .networks["finance-query"].internal == true and
  .networks["finance-internal"].internal == true and
  .networks["finance-edge"].name == "vlan100_household-finance" and
  .networks["finance-edge"].driver == "ipvlan" and
  .networks["finance-edge"].driver_opts.parent == "eth0.100" and
  .networks["finance-edge"].ipam.config[0].subnet == "192.168.100.0/24" and
  .networks["finance-edge"].ipam.config[0].gateway == "192.168.100.1"
' "$rendered_json" >/dev/null; then
  printf 'compose verification failed: the VLAN ingress boundary is incorrect\n' >&2
  exit 1
fi

if ! jq -e '
  .services["actual-writer"].profiles == null and
  .services["actual-writer"].image == "household-finance-actual-writer:local" and
  .services["actual-writer"].pull_policy == "build" and
  .services["actual-writer"].build.target == "actual-writer-runtime" and
  .services["actual-writer"].restart == "unless-stopped" and
  .services["actual-writer"].init == true and
  .services["actual-writer"].read_only == true and
  .services["actual-writer"].user == "1000:1000" and
  .services["actual-writer"].tmpfs == ["/tmp:size=64m,mode=1777,noexec,nosuid,nodev"] and
  .services["actual-writer"].cap_drop == ["ALL"] and
  (.services["actual-writer"].security_opt | index("no-new-privileges:true")) != null and
  .services["actual-writer"].pids_limit == 128 and
  .services["actual-writer"].mem_limit == "805306368" and
  .services["actual-writer"].cpus == 1 and
  .services["actual-writer"].stop_grace_period == "2m30s" and
  .services["actual-writer"].environment == {
    "ACTUAL_PRODUCTION_CONTRACT_FILE": "/run/secrets/actual_production_contract",
    "ACTUAL_SERVER_PASSWORD_FILE": "/run/secrets/actual_server_password",
    "ACTUAL_SERVER_URL": "http://actual-server:5006",
    "ACTUAL_UPDATE_SIGNING_KEY_FILE": "/run/secrets/actual_update_signing_key",
    "ACTUAL_UPDATE_SIGNING_KEY_ID": "production-v1",
    "ACTUAL_WRITER_OPERATION_TIMEOUT_MS": "120000",
    "ACTUAL_WRITER_POLL_INTERVAL_MS": "1000",
    "ACTUAL_WRITER_STATE_DIR": "/writer-data",
    "DATA_DIR": "/data",
    "NODE_ENV": "production"
  } and
  .services["actual-writer"].secrets == [
    {
      "source": "actual_server_password",
      "target": "actual_server_password"
    },
    {
      "source": "actual_production_contract",
      "target": "actual_production_contract"
    },
    {
      "source": "actual_update_signing_key",
      "target": "actual_update_signing_key"
    }
  ] and
  .services["actual-writer"].volumes == [
    {
      "type": "volume",
      "source": "attachment-shadow-data",
      "target": "/data",
      "volume": {"nocopy": true}
    },
    {
      "type": "volume",
      "source": "actual-writer-data",
      "target": "/writer-data"
    }
  ] and
  (.services["actual-writer"].networks | keys) == ["finance-internal"] and
  .networks["finance-internal"].internal == true and
  .services["actual-writer"].depends_on["actual-server"].condition == "service_healthy" and
  .services["actual-writer"].ports == null and
  .services["actual-writer"].expose == null and
  .services["actual-writer"].dns == null and
  ([.services | to_entries[] |
    select(any(.value.secrets[]?; .source == "actual_server_password")) |
    .key] | sort == ["actual-reader", "actual-writer"]) and
  ([.services | to_entries[] |
    select(any(.value.secrets[]?; .source == "actual_production_contract")) |
    .key] == ["actual-writer"]) and
  ([.services | to_entries[] |
    select(any(.value.secrets[]?; .source == "actual_update_signing_key")) |
    .key] | sort == ["actual-writer", "finance-bot"]) and
  ([.services | to_entries[] |
    select(any(.value.secrets[]?; .source == "actual_read_contract")) |
    .key] == ["actual-reader"]) and
  (.secrets.actual_server_password.file |
    endswith("/secrets/actual_server_password.txt")) and
  (.secrets.actual_production_contract.file |
    endswith("/secrets/actual_production_contract.json")) and
  (.secrets.actual_update_signing_key.file |
    endswith("/secrets/actual_update_signing_key.txt")) and
  (.secrets.actual_read_contract.file |
    endswith("/secrets/actual_read_contract.json")) and
  (.volumes | has("actual-writer-data"))
' "$rendered_json" >/dev/null; then
  printf 'compose verification failed: the isolated Actual writer boundary is incorrect\n' >&2
  exit 1
fi

if ! rg -q '^FROM runtime-base AS actual-writer-runtime$' "$repo_root/Dockerfile" ||
  ! rg -q '^CMD \["node", "dist/actual-writer-service\.js"\]$' "$repo_root/Dockerfile" ||
  ! rg -q '^FROM runtime-base AS actual-reader-runtime$' "$repo_root/Dockerfile" ||
  ! rg -q '^CMD \["node", "dist/actual-reader-service\.js"\]$' "$repo_root/Dockerfile"; then
  printf 'compose verification failed: an Actual service image target or command is incorrect\n' >&2
  exit 1
fi

tracked_sensitive="$(
  git -C "$repo_root" ls-files |
    rg '(^|/)(\\.env(\\..*)?|secrets|fixtures/private|samples/private)(/|$)|\\.(sqlite|db)(-|$)' |
    rg -v '(^|/)\\.env\\.example$' ||
    true
)"
if [[ -n "$tracked_sensitive" ]]; then
  printf 'tracked sensitive paths are forbidden:\n%s\n' "$tracked_sensitive" >&2
  exit 1
fi

printf 'compose security contract verified\n'
