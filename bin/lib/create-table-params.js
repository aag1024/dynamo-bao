const TABLE_PARAMS = {
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    { AttributeName: "_pk", AttributeType: "S" },
    { AttributeName: "_sk", AttributeType: "S" },
    { AttributeName: "_gsi1_pk", AttributeType: "S" },
    { AttributeName: "_gsi1_sk", AttributeType: "S" },
    { AttributeName: "_gsi2_pk", AttributeType: "S" },
    { AttributeName: "_gsi2_sk", AttributeType: "S" },
    { AttributeName: "_gsi3_pk", AttributeType: "S" },
    { AttributeName: "_gsi3_sk", AttributeType: "S" },
    { AttributeName: "_gsi4_pk", AttributeType: "S" },
    { AttributeName: "_gsi4_sk", AttributeType: "S" },
    { AttributeName: "_gsi5_pk", AttributeType: "S" },
    { AttributeName: "_gsi5_sk", AttributeType: "S" },
    { AttributeName: "_iter_pk", AttributeType: "S" },
    { AttributeName: "_iter_sk", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "_pk", KeyType: "HASH" },
    { AttributeName: "_sk", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "gsi1",
      KeySchema: [
        { AttributeName: "_gsi1_pk", KeyType: "HASH" },
        { AttributeName: "_gsi1_sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "gsi2",
      KeySchema: [
        { AttributeName: "_gsi2_pk", KeyType: "HASH" },
        { AttributeName: "_gsi2_sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "gsi3",
      KeySchema: [
        { AttributeName: "_gsi3_pk", KeyType: "HASH" },
        { AttributeName: "_gsi3_sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "gsi4",
      KeySchema: [
        { AttributeName: "_gsi4_pk", KeyType: "HASH" },
        { AttributeName: "_gsi4_sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "gsi5",
      KeySchema: [
        { AttributeName: "_gsi5_pk", KeyType: "HASH" },
        { AttributeName: "_gsi5_sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
    {
      IndexName: "iter_index",
      KeySchema: [
        { AttributeName: "_iter_pk", KeyType: "HASH" },
        { AttributeName: "_iter_sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "KEYS_ONLY" },
    },
  ],
};

async function waitForTableActive(client, tableName, { maxAttempts = 30, intervalMs = 2000 } = {}) {
  const resolve = require("./resolve");
  const { DescribeTableCommand } = resolve("src/dynamodb-client.js");
  for (let i = 0; i < maxAttempts; i++) {
    const response = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    const status = response.Table.TableStatus;
    if (status === "ACTIVE") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Table ${tableName} did not become active within ${maxAttempts * (intervalMs / 1000)} seconds`,
  );
}

module.exports = { TABLE_PARAMS, waitForTableActive };
