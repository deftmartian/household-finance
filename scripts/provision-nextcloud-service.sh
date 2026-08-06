#!/usr/bin/env bash
set -euo pipefail
set +x

: "${NEXTCLOUD_CONTAINER:?set NEXTCLOUD_CONTAINER}"
: "${FINANCE_SERVICE_USER:?set FINANCE_SERVICE_USER}"
: "${FINANCE_SERVICE_DISPLAY_NAME:?set FINANCE_SERVICE_DISPLAY_NAME}"
: "${FINANCE_BOT_NAME:?set FINANCE_BOT_NAME}"
: "${FINANCE_BOT_CALLBACK_URL:?set FINANCE_BOT_CALLBACK_URL}"
: "${FINANCE_SECRET_DIR:?set FINANCE_SECRET_DIR}"

secret_dir="$FINANCE_SECRET_DIR"
primary_password_file="$secret_dir/nextcloud_primary_password.txt"
app_password_file="$secret_dir/nextcloud_app_password.txt"
talk_secret_file="$secret_dir/talk_bot_secret.txt"
resource_ids_file="$secret_dir/service_resource_ids.env"
runtime_uid="${FINANCE_BOT_UID:-1000}"
runtime_gid="${FINANCE_BOT_GID:-1000}"
secret_dir_created=false
primary_password_file_created=false
app_password_file_created=false
talk_secret_file_created=false
resource_ids_file_created=false
service_user_created=false
app_token_created=false
talk_bot_created=false
provisioning_complete=false
app_token_id=''
bot_id=''
bot_actor_id=''

if [[ ! "$runtime_uid" =~ ^[0-9]+$ ]] ||
  [[ ! "$runtime_gid" =~ ^[0-9]+$ ]]; then
  printf 'FINANCE_BOT_UID and FINANCE_BOT_GID must be numeric\n' >&2
  exit 1
fi

occ() {
  sudo docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ "$@"
}

rollback() {
  local status=$?
  local rollback_failed=false
  local discovered_ids=''
  local resource_id=''

  trap - EXIT HUP INT TERM
  if [[ "$provisioning_complete" == true ]]; then
    return "$status"
  fi
  if [[ "$status" == 0 ]]; then
    status=1
  fi

  set +e
  unset NC_PASS app_password app_output bot_secret bot_output
  printf 'provisioning failed; rolling back this invocation\n' >&2

  if [[ "$talk_bot_created" == true ]]; then
    if [[ "$bot_id" =~ ^[0-9]+$ ]]; then
      discovered_ids="$bot_id"
    else
      discovered_ids="$(
        occ talk:bot:list --output=json 2>/dev/null |
          jq -r --arg name "$FINANCE_BOT_NAME" \
            '.[] | select(.name == $name) | .id'
      )"
    fi
    if [[ -z "$discovered_ids" ]]; then
      printf 'rollback could not locate the created Talk bot\n' >&2
      rollback_failed=true
    else
      while IFS= read -r resource_id; do
        [[ "$resource_id" =~ ^[0-9]+$ ]] || continue
        if ! occ talk:bot:uninstall "$resource_id" >/dev/null; then
          printf 'rollback could not uninstall Talk bot %s\n' \
            "$resource_id" >&2
          rollback_failed=true
        fi
      done <<<"$discovered_ids"
    fi
  fi

  if [[ "$app_token_created" == true ]]; then
    if [[ "$app_token_id" =~ ^[0-9]+$ ]]; then
      discovered_ids="$app_token_id"
    else
      discovered_ids="$(
        occ user:auth-tokens:list \
          --output=json \
          "$FINANCE_SERVICE_USER" 2>/dev/null |
          jq -r --arg name "$FINANCE_SERVICE_USER" \
            '.[] | select(.name == $name) | .id'
      )"
    fi
    if [[ -z "$discovered_ids" ]]; then
      printf 'rollback could not locate the created app token\n' >&2
      rollback_failed=true
    else
      while IFS= read -r resource_id; do
        [[ "$resource_id" =~ ^[0-9]+$ ]] || continue
        if ! occ user:auth-tokens:delete \
          "$FINANCE_SERVICE_USER" \
          "$resource_id" >/dev/null; then
          printf 'rollback could not delete app token %s\n' \
            "$resource_id" >&2
          rollback_failed=true
        fi
      done <<<"$discovered_ids"
    fi
  fi

  if [[ "$service_user_created" == true ]] &&
    ! occ user:delete "$FINANCE_SERVICE_USER" >/dev/null; then
    printf 'rollback could not delete Nextcloud user %s\n' \
      "$FINANCE_SERVICE_USER" >&2
    rollback_failed=true
  fi

  if [[ "$resource_ids_file_created" == true ]] &&
    ! sudo rm -f -- "$resource_ids_file"; then
    printf 'rollback could not remove %s\n' "$resource_ids_file" >&2
    rollback_failed=true
  fi
  if [[ "$app_password_file_created" == true ]] &&
    ! sudo rm -f -- "$app_password_file"; then
    printf 'rollback could not remove %s\n' "$app_password_file" >&2
    rollback_failed=true
  fi
  if [[ "$talk_secret_file_created" == true ]] &&
    ! sudo rm -f -- "$talk_secret_file"; then
    printf 'rollback could not remove %s\n' "$talk_secret_file" >&2
    rollback_failed=true
  fi
  if [[ "$primary_password_file_created" == true ]] &&
    ! sudo rm -f -- "$primary_password_file"; then
    printf 'rollback could not remove %s\n' "$primary_password_file" >&2
    rollback_failed=true
  fi
  if [[ "$secret_dir_created" == true ]] &&
    ! sudo rmdir -- "$secret_dir"; then
    printf 'rollback could not remove the created secret directory %s\n' \
      "$secret_dir" >&2
    rollback_failed=true
  fi

  if [[ "$rollback_failed" == true ]]; then
    printf 'rollback was incomplete; inspect the named scoped resources before retrying\n' >&2
  else
    printf 'rollback complete; the provisioner can be rerun from a clean state\n' >&2
  fi
  return "$status"
}

trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

installed_bots="$(occ talk:bot:list --output=json)"
if ! jq -e 'type == "array"' <<<"$installed_bots" >/dev/null; then
  printf 'Talk bot inventory did not return a JSON array\n' >&2
  exit 1
fi
if jq -e --arg name "$FINANCE_BOT_NAME" \
  '.[] | select(.name == $name)' <<<"$installed_bots" >/dev/null; then
  printf 'refusing to replace existing Talk bot %s\n' \
    "$FINANCE_BOT_NAME" >&2
  exit 1
fi
unset installed_bots

installed_users="$(
  occ user:list \
    --output=json \
    --limit=2 \
    "$FINANCE_SERVICE_USER"
)"
if ! jq -e 'type == "object"' <<<"$installed_users" >/dev/null; then
  printf 'Nextcloud user inventory did not return a JSON object\n' >&2
  exit 1
fi
if jq -e --arg user "$FINANCE_SERVICE_USER" \
  'has($user)' <<<"$installed_users" >/dev/null; then
  printf 'refusing to replace existing Nextcloud user %s\n' \
    "$FINANCE_SERVICE_USER" >&2
  exit 1
fi
unset installed_users
if sudo test -e "$primary_password_file" ||
  sudo test -e "$app_password_file" ||
  sudo test -e "$talk_secret_file" ||
  sudo test -e "$resource_ids_file"; then
  printf 'refusing to replace an existing scoped resource file\n' >&2
  exit 1
fi

if sudo test -e "$secret_dir"; then
  if ! sudo test -d "$secret_dir"; then
    printf 'FINANCE_SECRET_DIR exists but is not a directory\n' >&2
    exit 1
  fi
else
  secret_dir_created=true
  sudo install -d -m 0700 -o root -g root "$secret_dir"
fi

primary_password_file_created=true
openssl rand -base64 48 |
  tr -d '\n' |
  sudo install -m 0600 -o root -g root /dev/stdin \
    "$primary_password_file"
talk_secret_file_created=true
openssl rand -hex 32 |
  sudo install \
    -m 0400 \
    -o "$runtime_uid" \
    -g "$runtime_gid" \
    /dev/stdin \
    "$talk_secret_file"

NC_PASS="$(sudo cat "$primary_password_file")"
export NC_PASS
sudo --preserve-env=NC_PASS docker exec \
  -u www-data \
  -e NC_PASS \
  "$NEXTCLOUD_CONTAINER" \
  php occ user:add \
  --password-from-env \
  --display-name="$FINANCE_SERVICE_DISPLAY_NAME" \
  --no-interaction \
  "$FINANCE_SERVICE_USER" >/dev/null
service_user_created=true
unset NC_PASS

NC_PASS="$(sudo cat "$primary_password_file")"
export NC_PASS
app_output="$(
  sudo --preserve-env=NC_PASS docker exec \
    -u www-data \
    -e NC_PASS \
    "$NEXTCLOUD_CONTAINER" \
    php occ user:auth-tokens:add \
    --password-from-env \
    --name="$FINANCE_SERVICE_USER" \
    --no-interaction \
    "$FINANCE_SERVICE_USER"
)"
app_token_created=true
unset NC_PASS
app_password="$(printf '%s\n' "$app_output" | tail -n 1)"
unset app_output
if [[ ! "$app_password" =~ ^[A-Za-z0-9]{72}$ ]]; then
  printf 'could not parse the generated Nextcloud app password\n' >&2
  exit 1
fi
app_token_id="$(
  occ user:auth-tokens:list --output=json "$FINANCE_SERVICE_USER" |
    jq -r --arg name "$FINANCE_SERVICE_USER" \
      '[.[] | select(.name == $name)] | if length == 1 then .[0].id else empty end'
)"
if [[ ! "$app_token_id" =~ ^[0-9]+$ ]]; then
  printf 'could not identify exactly one generated app-token ID\n' >&2
  exit 1
fi
app_password_file_created=true
printf '%s\n' "$app_password" |
  sudo install \
    -m 0400 \
    -o "$runtime_uid" \
    -g "$runtime_gid" \
    /dev/stdin \
    "$app_password_file"

bot_secret="$(sudo cat "$talk_secret_file")"
bot_output="$(
  occ talk:bot:install \
    --no-setup \
    --feature=webhook \
    --feature=response \
    "$FINANCE_BOT_NAME" \
    "$bot_secret" \
    "$FINANCE_BOT_CALLBACK_URL" \
    'Private household finance assistant'
)"
talk_bot_created=true
unset bot_secret
bot_id="$(
  printf '%s\n' "$bot_output" |
    sed -nE 's/^ID:[[:space:]]*//p' |
    tail -n 1
)"
unset bot_output
if [[ ! "$bot_id" =~ ^[0-9]+$ ]]; then
  printf 'could not parse the generated Talk bot ID\n' >&2
  exit 1
fi
bot_actor_id="bots/bot-$(
  printf '%s' "$FINANCE_BOT_CALLBACK_URL" |
    sha1sum |
    sed -nE 's/^([a-f0-9]{40})[[:space:]].*$/\1/p'
)"
if [[ ! "$bot_actor_id" =~ ^bots/bot-[a-f0-9]{40}$ ]]; then
  printf 'could not derive the Talk bot actor ID\n' >&2
  exit 1
fi

resource_ids_file_created=true
{
  printf 'FINANCE_BOT_ID=%s\n' "$bot_id"
  printf 'TALK_BOT_ACTOR_ID=%s\n' "$bot_actor_id"
  printf 'NEXTCLOUD_APP_TOKEN_ID=%s\n' "$app_token_id"
} |
  sudo install -m 0600 -o root -g root /dev/stdin "$resource_ids_file"

unset app_password
sudo rm -- "$primary_password_file"
primary_password_file_created=false
provisioning_complete=true

printf 'service_user=created\n'
printf 'app_password=created\n'
printf 'bot=installed_not_attached\n'
printf 'service_state=created\n'
printf 'FINANCE_BOT_ID=%s\n' "$bot_id"
printf 'TALK_BOT_ACTOR_ID=%s\n' "$bot_actor_id"
