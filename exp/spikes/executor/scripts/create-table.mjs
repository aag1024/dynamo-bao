#!/usr/bin/env node
// Create the spike table with dynamo-bao's own schema (bin/lib/create-table-params),
// tagged so teardown.sh will delete it, with TTL on `ttl`. Uses the ambient
// AWS credentials, like the rest of setup.sh.
//   node scripts/create-table.mjs <table> <region> <tagKey> <tagValue>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { TABLE_PARAMS, waitForTableActive } = require("../../../../bin/lib/create-table-params");
const { DynamoDBClient, CreateTableCommand, UpdateTimeToLiveCommand } = require("../../../../src/dynamodb-client");

const [table, region, tagKey, tagValue] = process.argv.slice(2);
if (!table || !region || !tagKey || !tagValue) {
  console.error("usage: create-table.mjs <table> <region> <tagKey> <tagValue>");
  process.exit(1);
}
const client = new DynamoDBClient({ region });
await client.send(new CreateTableCommand({ ...TABLE_PARAMS, TableName: table, Tags: [{ Key: tagKey, Value: tagValue }] }));
await waitForTableActive(client, table);
await client.send(new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }));
console.log(`  ${region}/${table}: created`);
