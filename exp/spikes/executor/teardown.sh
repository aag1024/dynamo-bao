#!/usr/bin/env bash
# Delete everything setup.sh created, and nothing else.
#
# Every deletion names one resource from resources.sh exactly; nothing is
# found by prefix or pattern. AWS resources are deleted only if they carry
# the project=executor-spike tag. Without --yes it prints the plan and stops.
#
#   ./teardown.sh          show what would be deleted
#   ./teardown.sh --yes    delete it
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/resources.sh"
spike_load_env
cd "$here"

echo "Executor spike teardown will delete exactly:"
echo "  Workers:      ${SPIKE_WORKERS_DERIVED[*]} $SPIKE_WORKER_MAIN (and the SpikeDO storage the last one owns)"
echo "  DynamoDB:     table $SPIKE_DDB_TABLE in $SPIKE_DDB_REGION (only if tagged $SPIKE_AWS_TAG_KEY=$SPIKE_AWS_TAG_VALUE)"
echo "  IAM:          user $SPIKE_IAM_USER, its inline policy $SPIKE_IAM_POLICY and its access keys (only if tagged)"
echo "  Local:        $SPIKE_TOKEN_FILE"
[[ "${1:-}" == "--yes" ]] || { echo; echo "Re-run with --yes to delete."; exit 0; }

failed=0
step() { echo "== $*"; }
warn() { echo "  !! $*"; failed=1; }

step "Workers (edge scripts first: they bind spike-edge's DO class and spike-data)"
spike_wrangler delete --env use1 --force || warn "delete spike-edge-use1 failed"
spike_wrangler delete --force || warn "delete $SPIKE_WORKER_MAIN failed"
spike_wrangler delete --env data --force || warn "delete spike-data failed"

step "DynamoDB table"
arn=$(aws dynamodb describe-table --region "$SPIKE_DDB_REGION" --table-name "$SPIKE_DDB_TABLE" --query Table.TableArn --output text 2>/dev/null)
if [[ -z "$arn" ]]; then
  echo "  absent"
else
  tag=$(aws dynamodb list-tags-of-resource --region "$SPIKE_DDB_REGION" --resource-arn "$arn" \
    --query "Tags[?Key=='$SPIKE_AWS_TAG_KEY'].Value | [0]" --output text)
  if [[ "$tag" != "$SPIKE_AWS_TAG_VALUE" ]]; then
    warn "$SPIKE_DDB_TABLE is not tagged $SPIKE_AWS_TAG_KEY=$SPIKE_AWS_TAG_VALUE; left alone"
  else
    aws dynamodb delete-table --region "$SPIKE_DDB_REGION" --table-name "$SPIKE_DDB_TABLE" >/dev/null && echo "  deleted"
  fi
fi

step "IAM user"
if aws iam get-user --user-name "$SPIKE_IAM_USER" >/dev/null 2>&1; then
  tag=$(aws iam list-user-tags --user-name "$SPIKE_IAM_USER" --query "Tags[?Key=='$SPIKE_AWS_TAG_KEY'].Value | [0]" --output text)
  if [[ "$tag" != "$SPIKE_AWS_TAG_VALUE" ]]; then
    warn "$SPIKE_IAM_USER is not tagged; left alone"
  else
    for k in $(aws iam list-access-keys --user-name "$SPIKE_IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
      aws iam delete-access-key --user-name "$SPIKE_IAM_USER" --access-key-id "$k"
    done
    aws iam delete-user-policy --user-name "$SPIKE_IAM_USER" --policy-name "$SPIKE_IAM_POLICY" 2>/dev/null || true
    aws iam delete-user --user-name "$SPIKE_IAM_USER" && echo "  deleted $SPIKE_IAM_USER"
  fi
else
  echo "  absent"
fi

rm -f "$SPIKE_TOKEN_FILE"

step "Verify nothing is left"
"$here/check-resources.sh" --expect-none || failed=1
exit $failed
