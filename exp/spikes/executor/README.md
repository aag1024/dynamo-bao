# Executor spike

A standalone measurement worker for the validation spikes in
[`design-docs/remote-procedure-executor.md`](../../../design-docs/remote-procedure-executor.md).
It is not part of the dynamo-bao package (`package.json` `files` excludes
`exp/`), it never touches js-bao-wss code or tables, and it is torn down when
the spikes are done. Scaffolding is copied from `js-bao-wss/tools/latency-lab`.

## What it is

One script, deployed three times (`wrangler.toml`):

| Script | Placement | Role |
|---|---|---|
| `spike-data` | `aws:us-west-2` | executor stand-in: runs replicas next to DynamoDB, reports its colo |
| `spike-edge` | none | hosts `SpikeDO` (one per location hint) and `SpikeWorkflow`; binds `spike-data` |
| `spike-edge-use1` | `aws:us-east-1` | a far-from-data vantage point that is not Europe |

`SpikeDO` runs each **replica** in one of three **modes**:

- `serial`: the product's call order, transcribed from js-bao-wss on 2026-10-27 (`src/replicas/*.ts`, each file's header says what it mirrors and what it leaves out).
- `parallel`: the Spike 3 restructuring, same calls under a batch context with independent reads in one round.
- `remote`: one call to `spike-data` over a chosen transport (`binding`, `rpc`, `hostname`); `spike-data` runs `serial` in process.

Every sample records the colo the code actually ran in, per-DynamoDB-call
timing, serial depth (round trips actually waited for), and for `remote` the
hop cost on top of what `spike-data` measured for itself.

The models in `src/models.cjs` mirror the js-bao-wss models on these paths,
including item shapes, so sizes and key formats match. It runs the working
tree's dynamo-bao (`file:../../..`), not a release: what it measures is what
the product would do after upgrading, which is Phase B's first step.

## Setup

```
cp .dev.vars.example .dev.vars        # account id, API token, workers.dev subdomain
npm install
./setup.sh                            # table, IAM user, deploy ×3, secrets, seed
```

`setup.sh deploy` redeploys only. `./check-resources.sh` lists what exists.
`./teardown.sh --yes` deletes exactly what `resources.sh` names.

## Running the spikes

```
node scripts/run.mjs --help
node scripts/run.mjs --replicas ping --modes remote --transports binding,rpc,hostname --hints weur,wnam   # Spike 1 from hinted DOs
node scripts/run.mjs --replicas ping --modes remote --transports binding,rpc,hostname --hints worker --edge use1   # Spike 1 from a worker placed in us-east-1
node scripts/run.mjs --replicas subscribe,message --modes serial --hints wnam                              # Spike 2
node scripts/run.mjs --replicas subscribe --modes serial,parallel,remote                                   # Spike 3
node scripts/summarize.mjs results/*.csv
curl -X POST -H "authorization: Bearer $(cat .spike-token)" https://spike-edge.<sub>.workers.dev/workflow -d '{"sleepMinutes":10}'   # Spike 5, then redeploy with a new BUILD_TAG
node audit/codec-coverage.mjs                                                                              # Spike 4
```

Spike 6 is a reading exercise; its notes go in `audit/ambient-context.md`.

The hint `worker` runs the spec in the edge worker itself instead of a DO;
`none` uses a DO created without a hint.

`GET /whereami` on either edge script reports where each hinted DO instance
landed. Check it once after the first deploy: a hint is a request, not a
guarantee, and a sample whose `colo` is not where you think it is measures
nothing.

## Fidelity caveats

The replicas are transcriptions, not the product's code. Each replica file
lists what it models and what it does not (DO-to-DO fan-out, `waitUntil`
work, caches that are off in production). Review them against the product
source before trusting a number, and re-transcribe if the product changes.
