import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The live DynamoDB tests use the same credentials as dynamo-bao's own test
// suite (environment or ~/.aws), resolved here in Node and handed to the
// Worker as bindings. Without credentials those tests are skipped and the
// rest still run under workerd.
const require = createRequire(import.meta.url);
function localCredentials() {
  try {
    const { DynamoDBClient } = require("dynamo-bao/src/dynamodb-client.js");
    const creds = new DynamoDBClient({ region: "us-west-2" })._resolveCredentials();
    return {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
      LIVE_DYNAMODB: "1",
    };
  } catch {
    return { LIVE_DYNAMODB: "" };
  }
}

function cjsBuildsOf(names) {
  const from = { paths: [require.resolve("dynamo-bao")] };
  return Object.fromEntries(names.map((name) => [name, require.resolve(name, from)]));
}

export default defineConfig({
  // dynamo-bao is CommonJS. Two of its dependencies (aws4fetch, ulid) also
  // publish ES builds that the test runner would pick for a CommonJS
  // require() and then fail to load. Point both at their CommonJS builds.
  // wrangler's bundler needs no such setting; this is only for vitest.
  resolve: { alias: cjsBuildsOf(["aws4fetch", "ulid"]) },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          DATA_BINDING_SECRET: "test-secret",
          TABLE_NAME: process.env.TEST_TABLE_NAME || "dynamo-bao-test3",
          ...localCredentials(),
        },
      },
    }),
  ],
});
