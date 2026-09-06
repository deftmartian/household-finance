#!/bin/sh
set -eu
result=$(mktemp)
trap 'rm -f "$result"' EXIT
FINANCE_IMAGE=household-finance:verification FINANCE_CONFIG_SOURCE=./config/finance.example.json docker compose config --format json > "$result"
node --input-type=module - "$result" <<'JS'
import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
assert.deepEqual(Object.keys(c.services).sort(),['actual-server','finance-bot']);
assert.equal(c.services['actual-server'].image,'actualbudget/actual-server:26.8.1');
assert(c.services['finance-bot'].read_only);
assert(!JSON.stringify(c).includes('/var/run/docker.sock'));
process.stdout.write('Compose contract passed\n');
JS
