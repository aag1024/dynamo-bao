#!/usr/bin/env bash
# Create (or bring up to date) everything the spike needs, then deploy and
# seed. Safe to re-run: each step checks before it creates.
#
#   ./setup.sh            everything
#   ./setup.sh deploy     redeploy the three workers only
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/resources.sh"
spike_load_env
cd "$here"

tag_spec="Key=$SPIKE_AWS_TAG_KEY,Value=$SPIKE_AWS_TAG_VALUE"

deploy() {
  # spike-data first: the edge scripts bind it, and placement needs the
  # script to exist before a service binding to it resolves.
  spike_wrangler deploy --env data
  spike_wrangler deploy
  spike_wrangler deploy --env use1
}

if [[ "${1:-}" == "deploy" ]]; then deploy; exit 0; fi

echo "== DynamoDB table (dynamo-bao schema: _pk/_sk, gsi1..5, iter_index, ttl)"
if aws dynamodb describe-table --region "$SPIKE_DDB_REGION" --table-name "$SPIKE_DDB_TABLE" >/dev/null 2>&1; then
  echo "  $SPIKE_DDB_REGION/$SPIKE_DDB_TABLE: exists"
else
  node "$here/scripts/create-table.mjs" "$SPIKE_DDB_TABLE" "$SPIKE_DDB_REGION" "$SPIKE_AWS_TAG_KEY" "$SPIKE_AWS_TAG_VALUE"
fi

echo "== IAM user for the worker (this table and its indexes only)"
aws_account=$(aws sts get-caller-identity --query Account --output text)
if ! aws iam get-user --user-name "$SPIKE_IAM_USER" >/dev/null 2>&1; then
  aws iam create-user --user-name "$SPIKE_IAM_USER" --tags "$tag_spec" >/dev/null
  echo "  created $SPIKE_IAM_USER"
fi
table_arn="arn:aws:dynamodb:$SPIKE_DDB_REGION:$aws_account:table/$SPIKE_DDB_TABLE"
aws iam put-user-policy --user-name "$SPIKE_IAM_USER" --policy-name "$SPIKE_IAM_POLICY" --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Action\": [\"dynamodb:GetItem\", \"dynamodb:BatchGetItem\", \"dynamodb:Query\",
                 \"dynamodb:PutItem\", \"dynamodb:UpdateItem\", \"dynamodb:DeleteItem\",
                 \"dynamodb:BatchWriteItem\", \"dynamodb:TransactWriteItems\"],
    \"Resource\": [\"$table_arn\", \"$table_arn/index/*\"]
  }]
}"

echo "== Deploy"
deploy

echo "== Secrets"
if [[ ! -s "$SPIKE_TOKEN_FILE" ]]; then
  (umask 077; openssl rand -hex 24 >"$SPIKE_TOKEN_FILE")
fi
# Rotate the worker's AWS key: only this user's keys are touched.
for k in $(aws iam list-access-keys --user-name "$SPIKE_IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  aws iam delete-access-key --user-name "$SPIKE_IAM_USER" --access-key-id "$k"
done
secrets=$(mktemp)
trap 'rm -f "$secrets"' EXIT
chmod 600 "$secrets"
aws iam create-access-key --user-name "$SPIKE_IAM_USER" --output json |
  SPIKE_TOKEN="$(cat "$SPIKE_TOKEN_FILE")" DATA_HOSTNAME="${SPIKE_HOSTNAMES[1]}" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const k = JSON.parse(s).AccessKey;
      process.stdout.write(JSON.stringify({
        AWS_ACCESS_KEY_ID: k.AccessKeyId, AWS_SECRET_ACCESS_KEY: k.SecretAccessKey,
        SPIKE_TOKEN: process.env.SPIKE_TOKEN,
        DATA_HOSTNAME: process.env.DATA_HOSTNAME, // account-specific, so a secret not a var
      }));
    });' >"$secrets"
spike_wrangler secret bulk "$secrets" --env data
spike_wrangler secret bulk "$secrets"
spike_wrangler secret bulk "$secrets" --env use1
# A new IAM key takes a few seconds to be accepted everywhere.
sleep 10

echo "== Seed"
node "$here/scripts/seed.mjs"

echo
echo "Edge: https://${SPIKE_HOSTNAMES[0]}   data: https://${SPIKE_HOSTNAMES[1]}   use1: https://${SPIKE_HOSTNAMES[2]}"
echo "Token in $SPIKE_TOKEN_FILE. Next: node scripts/run.mjs --help"
