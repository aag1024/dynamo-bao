#!/usr/bin/env node

const resolve = require("./lib/resolve");
const {
  DynamoDBClient,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
} = resolve("src/dynamodb-client.js");
const { TABLE_PARAMS, waitForTableActive } = require("./lib/create-table-params");

const tableName = process.argv[2];

if (!tableName) {
  console.error("Usage: bao-create-table <table-name>");
  process.exit(1);
}

const client = new DynamoDBClient();

async function main() {
  const params = { ...TABLE_PARAMS, TableName: tableName };

  const response = await client.send(new CreateTableCommand(params));
  console.log(
    "Table created successfully:",
    response.TableDescription.TableName,
  );

  console.log("Waiting for table to become active...");
  await waitForTableActive(client, tableName);

  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: {
        AttributeName: "ttl",
        Enabled: true,
      },
    }),
  );
  console.log("TTL enabled on attribute 'ttl'");
}

main().catch((error) => {
  console.error("Error creating table:", error);
  process.exit(1);
});
