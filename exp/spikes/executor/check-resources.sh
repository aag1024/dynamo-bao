#!/usr/bin/env bash
# List which spike resources currently exist, by exact name.
# With --expect-none, exits 1 if any do (teardown's final check).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/resources.sh"
spike_load_env

found=0
report() { # name exists?
  if [[ "$2" == yes ]]; then echo "  present  $1"; found=1; else echo "  absent   $1"; fi
}
cf() { curl -sS -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/$1"; }
ok() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.success?"yes":"no")})'; }

for w in "$SPIKE_WORKER_MAIN" "${SPIKE_WORKERS_DERIVED[@]}"; do
  report "worker $w" "$(cf "workers/scripts/$w/settings" | ok)"
done
ns=$(cf "workers/durable_objects/namespaces?per_page=1000" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log((JSON.parse(s).result??[]).some(n=>n.script===process.argv[1])?"yes":"no")})' "$SPIKE_WORKER_MAIN")
report "DO namespace of $SPIKE_WORKER_MAIN" "$ns"
if aws dynamodb describe-table --region "$SPIKE_DDB_REGION" --table-name "$SPIKE_DDB_TABLE" >/dev/null 2>&1; then e=yes; else e=no; fi
report "DynamoDB $SPIKE_DDB_REGION/$SPIKE_DDB_TABLE" "$e"
if aws iam get-user --user-name "$SPIKE_IAM_USER" >/dev/null 2>&1; then e=yes; else e=no; fi
report "IAM user $SPIKE_IAM_USER" "$e"

if [[ "${1:-}" == "--expect-none" && $found == 1 ]]; then
  echo "Some spike resources still exist."
  exit 1
fi
exit 0
