# dynamo-bao/remote in a Cloudflare Worker

A data worker that runs next to DynamoDB and serves named procedures to
callers far away. Read `tutorials/11-remote-procedures.md` first.

| File | What it shows |
|---|---|
| `wrangler.toml` | The placement line (`[placement] region = "aws:us-west-2"`), the `DATA` self-binding, and where the ingress secret goes |
| `src/models.js` | Models built once per isolate from `env` |
| `src/procedures.js` | Three procedures with their replay classes, and the registry |
| `src/executor.js` | The mount: context resolver, ingress secret check, budget |
| `src/index.js` | The executor route, and a caller that uses `remote(env.DATA, ...)` |
| `test/workerd.test.js` | `inProcess(executor)` running inside workerd |

## Run the tests

```sh
npm install
npm test
```

The tests run in workerd through `@cloudflare/vitest-pool-workers`. The
offline tests always run. The DynamoDB tests run when AWS credentials are
available the same way dynamo-bao's own suite finds them, against the table
named by `TEST_TABLE_NAME` (default `dynamo-bao-test3`); without credentials
they are skipped.

`@cloudflare/vitest-pool-workers` has since been renamed
`@cloudflare/vitest-plugin`; the configuration is the same.

`vitest.config.js` aliases `aws4fetch` and `ulid` to their CommonJS builds.
Both publish ES builds that the test runner would otherwise pick for
dynamo-bao's `require()`. Deploys don't need this: wrangler's bundler
resolves them correctly.

## Deploy

```sh
wrangler secret put DATA_BINDING_SECRET
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
npm run deploy
```

`npm run build` is a dry run that only bundles.

The `compatibility_date` is 2025-10-01 or later so workerd provides
`node:os` natively under `nodejs_compat`. With an earlier date, wrangler's
bundler polyfills it for deploys, but the test runner does not.
