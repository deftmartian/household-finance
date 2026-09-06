#!/bin/sh
set -eu
engine=${CONTAINER_ENGINE:-docker}
image=${1:?Provide the image to verify}
probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
chmod 755 "$probe"
printf 'synthetic marker' > "$probe/probe"
chmod 644 "$probe/probe"
cp scripts/container-probe.mjs "$probe/container-probe.mjs"
chmod 644 "$probe/container-probe.mjs"
set --
if [ -n "${FINANCE_APPARMOR_PROFILE:-}" ]; then
  set -- --security-opt "apparmor=$FINANCE_APPARMOR_PROFILE"
fi
"$engine" run "$@" --rm --cap-drop=ALL --security-opt=no-new-privileges --security-opt=seccomp=./config/document-seccomp.json --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m -e FINANCE_TEST_SECRET=synthetic -v "$probe/probe:/run/secrets/probe:ro,Z" -v "$probe:/data:ro,Z" -v "$probe/container-probe.mjs:/app/container-probe.mjs:ro,Z" --entrypoint node "$image" /app/container-probe.mjs
