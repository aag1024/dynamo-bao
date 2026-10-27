# Every resource the spike creates, by exact name. setup.sh creates these,
# teardown.sh deletes these, and neither touches anything not listed here.
# Sourced, not run.
#
# Account-specific values come from .dev.vars (gitignored), never from here:
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SPIKE_WORKERS_SUBDOMAIN
# AWS credentials come from the ambient `aws` CLI profile.

# Worker scripts. The first owns the SpikeDO class and SpikeWorkflow; the
# others bind them by script_name, so they deploy after it and delete first.
SPIKE_WORKER_MAIN=spike-edge
SPIKE_WORKER_ENVS=(data use1)                 # wrangler --env names
SPIKE_WORKERS_DERIVED=(spike-data spike-edge-use1)

# AWS. Every AWS resource carries this tag, and teardown refuses to delete
# one that does not.
SPIKE_AWS_TAG_KEY=project
SPIKE_AWS_TAG_VALUE=executor-spike
SPIKE_DDB_TABLE=executor-spike
SPIKE_DDB_REGION=us-west-2
SPIKE_IAM_USER=executor-spike-worker
SPIKE_IAM_POLICY=executor-spike-table

# Local, gitignored: the bearer token the scripts send.
SPIKE_TOKEN_FILE="$(dirname "${BASH_SOURCE[0]}")/.spike-token"

spike_load_env() {
  local envfile
  envfile="$(dirname "${BASH_SOURCE[0]}")/.dev.vars"
  [[ -f "$envfile" ]] || { echo "missing $envfile (copy .dev.vars.example)" >&2; return 1; }
  set -a; source "$envfile"; set +a
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${SPIKE_WORKERS_SUBDOMAIN:-}" ]] ||
    { echo "need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SPIKE_WORKERS_SUBDOMAIN in $envfile" >&2; return 1; }
  SPIKE_HOSTNAMES=()
  for w in "$SPIKE_WORKER_MAIN" "${SPIKE_WORKERS_DERIVED[@]}"; do
    SPIKE_HOSTNAMES+=("$w.$SPIKE_WORKERS_SUBDOMAIN.workers.dev")
  done
}

spike_wrangler() { npx --no-install wrangler "$@"; }
