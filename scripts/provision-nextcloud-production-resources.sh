#!/usr/bin/env bash
set -euo pipefail
set +x

: "${NEXTCLOUD_CONTAINER:?set NEXTCLOUD_CONTAINER}"
: "${NEXTCLOUD_BASE_URL:?set NEXTCLOUD_BASE_URL}"
: "${NEXTCLOUD_OWNER_USER:?set NEXTCLOUD_OWNER_USER}"
: "${FINANCE_SERVICE_USER:?set FINANCE_SERVICE_USER}"
: "${FINANCE_ROOM_NAME:?set FINANCE_ROOM_NAME}"
: "${FINANCE_SECRET_DIR:?set FINANCE_SECRET_DIR}"

secret_dir="$FINANCE_SECRET_DIR"
app_password_file="$secret_dir/nextcloud_app_password.txt"
production_resource_ids_file="$secret_dir/production_resource_ids.env"
archive_root='Finance'

occ() {
  sudo docker exec -u www-data "$NEXTCLOUD_CONTAINER" php occ "$@"
}

require_protected_file() {
  local path="$1"
  if ! sudo test -s "$path"; then
    printf 'required protected file is missing: %s\n' "$path" >&2
    exit 1
  fi
}

require_installed_bot() {
  local bot_id="$1"
  local count
  count="$(
    occ talk:bot:list --output=json |
      jq \
        --arg id "$bot_id" \
        '[.[] | select((.id | tostring) == $id)] | length'
  )"
  if [[ "$count" != 1 ]]; then
    printf 'production Talk bot ID does not name exactly one installed bot\n' >&2
    exit 1
  fi
}

require_protected_file "$app_password_file"

room_created=false
if sudo test -e "$production_resource_ids_file"; then
  production_ids="$(sudo cat "$production_resource_ids_file")"
  room_token="$(
    sed -nE 's/^TALK_ROOM_TOKEN=([A-Za-z0-9]+)$/\1/p' <<<"$production_ids" |
      tail -n 1
  )"
  bot_id="$(
    sed -nE 's/^TALK_BOT_ID=([0-9]+)$/\1/p' <<<"$production_ids" |
      tail -n 1
  )"
  unset production_ids
  if [[ -z "$room_token" || -z "$bot_id" ]]; then
    printf 'production resource state is malformed\n' >&2
    exit 1
  fi
  require_installed_bot "$bot_id"
  if ! occ talk:monitor:room "$room_token" >/dev/null 2>&1; then
    printf 'recorded production Talk room does not exist\n' >&2
    exit 1
  fi
else
  if [[ "${FINANCE_CREATE_PRODUCTION_ROOM:-false}" != true ]]; then
    printf 'no production room state exists; set FINANCE_CREATE_PRODUCTION_ROOM=true for the one-time creation\n' >&2
    exit 1
  fi
  bot_id="${FINANCE_BOT_ID:-}"
  if [[ ! "$bot_id" =~ ^[0-9]+$ ]]; then
    printf 'set FINANCE_BOT_ID to the installed Talk bot ID for the one-time production room creation\n' >&2
    exit 1
  fi
  require_installed_bot "$bot_id"
  room_output="$(
    occ talk:room:create \
      --user="$NEXTCLOUD_OWNER_USER" \
      --owner="$NEXTCLOUD_OWNER_USER" \
      --description='Private household finance assistant' \
      "$FINANCE_ROOM_NAME"
  )"
  room_token="$(
    sed -nE 's/^Room token:[[:space:]]*//p' <<<"$room_output" |
      tail -n 1
  )"
  unset room_output
  if [[ ! "$room_token" =~ ^[A-Za-z0-9]+$ ]]; then
    printf 'could not parse the generated production Talk room token\n' >&2
    exit 1
  fi
  {
    printf 'TALK_ROOM_TOKEN=%s\n' "$room_token"
    printf 'TALK_BOT_ID=%s\n' "$bot_id"
  } |
    sudo install \
      -m 0600 \
      -o root \
      -g root \
      /dev/stdin \
      "$production_resource_ids_file"
  room_created=true
fi

app_password="$(sudo cat "$app_password_file")"
auth_basic="$(
  printf '%s' "$FINANCE_SERVICE_USER:$app_password" |
    base64 -w0
)"
unset app_password

service_room_status() {
  printf 'header = "Authorization: Basic %s"\n' "$auth_basic" |
    curl \
      --silent \
      --show-error \
      --output /dev/null \
      --write-out '%{http_code}' \
      --config - \
      --header 'OCS-APIRequest: true' \
      "$NEXTCLOUD_BASE_URL/ocs/v2.php/apps/spreed/api/v4/room/$room_token"
}

if [[ "$(service_room_status)" != 200 ]]; then
  occ talk:room:add \
    --user="$FINANCE_SERVICE_USER" \
    "$room_token" >/dev/null
fi
if [[ "$(service_room_status)" != 200 ]]; then
  printf 'finance service identity cannot access the production Talk room\n' >&2
  exit 1
fi

webdav_request() {
  local method="$1"
  local url="$2"
  printf 'header = "Authorization: Basic %s"\n' "$auth_basic" |
    curl \
      --silent \
      --show-error \
      --output /dev/null \
      --write-out '%{http_code}' \
      --config - \
      --request "$method" \
      "$url"
}

for path in \
  'Finance' \
  'Finance/Context' \
  'Finance/Receipts' \
  'Finance/Receipts/Inbox' \
  'Finance/Receipts/Review'; do
  status="$(
    webdav_request \
      MKCOL \
      "$NEXTCLOUD_BASE_URL/remote.php/dav/files/$FINANCE_SERVICE_USER/$path"
  )"
  case "$status" in
    201 | 405) ;;
    *)
      printf 'production WebDAV collection creation failed with HTTP %s\n' \
        "$status" >&2
      exit 1
      ;;
  esac
done

share_response="$(mktemp)"
trap 'rm -f -- "$share_response"' EXIT
share_status="$(
  {
    printf 'header = "Authorization: Basic %s"\n' "$auth_basic"
    printf 'header = "OCS-APIRequest: true"\n'
    printf 'header = "Accept: application/json"\n'
  } |
    curl \
      --silent \
      --show-error \
      --output "$share_response" \
      --write-out '%{http_code}' \
      --config - \
      --get \
      --data-urlencode "path=/$archive_root" \
      "$NEXTCLOUD_BASE_URL/ocs/v2.php/apps/files_sharing/api/v1/shares"
)"
if [[ "$share_status" != 200 ]] ||
  [[ "$(jq -r '.ocs.meta.status' "$share_response")" != ok ]]; then
  printf 'production Nextcloud share lookup failed with HTTP %s\n' \
    "$share_status" >&2
  exit 1
fi
share_exists="$(
  jq \
    --arg owner "$FINANCE_SERVICE_USER" \
    --arg recipient "$NEXTCLOUD_OWNER_USER" \
    '[
      .ocs.data[] |
      select(
        .uid_owner == $owner and
        .share_type == 0 and
        .share_with == $recipient and
        .permissions == 1
      )
    ] | length' \
    "$share_response"
)"
if [[ "$share_exists" == 0 ]]; then
  share_status="$(
    {
      printf 'header = "Authorization: Basic %s"\n' "$auth_basic"
      printf 'header = "OCS-APIRequest: true"\n'
      printf 'header = "Accept: application/json"\n'
    } |
      curl \
        --silent \
        --show-error \
        --output "$share_response" \
        --write-out '%{http_code}' \
        --config - \
        --request POST \
        --data-urlencode "path=/$archive_root" \
        --data-urlencode 'shareType=0' \
        --data-urlencode "shareWith=$NEXTCLOUD_OWNER_USER" \
        --data-urlencode 'permissions=1' \
        "$NEXTCLOUD_BASE_URL/ocs/v2.php/apps/files_sharing/api/v1/shares"
  )"
  if [[ "$share_status" != 200 ]] ||
    [[ "$(jq -r '.ocs.meta.status' "$share_response")" != ok ]]; then
    printf 'production Nextcloud share creation failed with HTTP %s\n' \
      "$share_status" >&2
    exit 1
  fi
elif [[ "$share_exists" != 1 ]]; then
  printf 'production archive has ambiguous duplicate owner shares\n' >&2
  exit 1
fi
unset auth_basic

bot_attached="$(
  occ talk:bot:list --output=json "$room_token" |
    jq \
      --arg id "$bot_id" \
      '[.[] | select((.id | tostring) == $id)] | length'
)"
if [[ "$bot_attached" == 0 ]]; then
  occ talk:bot:setup "$bot_id" "$room_token" >/dev/null
elif [[ "$bot_attached" != 1 ]]; then
  printf 'production Talk room has ambiguous duplicate bot attachment\n' >&2
  exit 1
fi
if [[ "$(
  occ talk:bot:list --output=json "$room_token" |
    jq \
      --arg id "$bot_id" \
      '[.[] | select((.id | tostring) == $id)] | length'
)" != 1 ]]; then
  printf 'Talk bot attachment could not be verified\n' >&2
  exit 1
fi

printf 'room=%s\n' "$([[ "$room_created" == true ]] && printf created || printf reused)"
printf 'service_user_room_membership=verified\n'
printf 'production_archive=verified\n'
printf 'production_share=verified_read_only\n'
printf 'bot_attachment=verified\n'
