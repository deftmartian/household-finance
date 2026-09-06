#!/bin/sh
set -eu
umask 077
# All production instances share this directory. flock is released by the
# kernel after a crash, and prevents a second writer during restart/recovery.
mkdir -p /data
exec /usr/bin/flock --exclusive --nonblock /data/writer.lock "$@"
