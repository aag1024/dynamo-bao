#!/usr/bin/env node

const {
  DynamoDBClient,
  DescribeTableCommand,
  UpdateTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
} = require("../src/dynamodb-client.js");
const { initConfig } = require("../src/config.js");

// Expected GSI definitions - the full set that should exist on the table
const EXPECTED_GSIS = [
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
];

// All attribute definitions that GSIs may reference
const ALL_ATTRIBUTE_DEFINITIONS = [
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
];

let client;

async function waitForTableActive(tableName, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    const status = response.Table.TableStatus;
    if (status === "ACTIVE") {
      return;
    }
    console.log(`  Table status: ${status}, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(
    `Table ${tableName} did not become active within ${maxAttempts * 5} seconds`,
  );
}

async function checkAndAddMissingGSIs(tableName) {
  const response = await client.send(
    new DescribeTableCommand({ TableName: tableName }),
  );

  const existingIndexNames = (response.Table.GlobalSecondaryIndexes || []).map(
    (gsi) => gsi.IndexName,
  );

  const missingGSIs = EXPECTED_GSIS.filter(
    (gsi) => !existingIndexNames.includes(gsi.IndexName),
  );

  if (missingGSIs.length === 0) {
    console.log("All GSIs are present.");
    return;
  }

  console.log(
    `Missing GSIs: ${missingGSIs.map((g) => g.IndexName).join(", ")}`,
  );

  // DynamoDB only allows adding one GSI per UpdateTable call
  for (const gsi of missingGSIs) {
    console.log(`\nAdding GSI: ${gsi.IndexName}...`);

    // Collect attribute definitions needed for this GSI
    const neededAttrs = gsi.KeySchema.map((ks) => ks.AttributeName);
    const attrDefs = ALL_ATTRIBUTE_DEFINITIONS.filter((ad) =>
      neededAttrs.includes(ad.AttributeName),
    );

    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: attrDefs,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: gsi.IndexName,
              KeySchema: gsi.KeySchema,
              Projection: gsi.Projection,
            },
          },
        ],
      }),
    );

    console.log(
      `  GSI ${gsi.IndexName} creation initiated. Waiting for table to become active...`,
    );
    await waitForTableActive(tableName);
    console.log(`  GSI ${gsi.IndexName} is ready.`);
  }
}

async function checkAndEnableTTL(tableName) {
  const response = await client.send(
    new DescribeTimeToLiveCommand({ TableName: tableName }),
  );

  const ttlStatus = response.TimeToLiveDescription?.TimeToLiveStatus;
  const ttlAttr = response.TimeToLiveDescription?.AttributeName;

  if (ttlStatus === "ENABLED" && ttlAttr === "ttl") {
    console.log("TTL is already enabled on attribute 'ttl'.");
    return;
  }

  if (ttlStatus === "ENABLING") {
    console.log("TTL is currently being enabled. Please wait and try again.");
    return;
  }

  if (ttlStatus === "DISABLING") {
    console.log(
      "TTL is currently being disabled. Please wait for it to finish, then run this script again.",
    );
    return;
  }

  console.log("Enabling TTL on attribute 'ttl'...");
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: {
        AttributeName: "ttl",
        Enabled: true,
      },
    }),
  );
  console.log("TTL enabled successfully.");
}

async function main() {
  const config = await initConfig();
  const tableName = config.db.tableName;

  if (!tableName) {
    console.error(
      "No table name found in config. Please run bao-init first or set TABLE_NAME.",
    );
    process.exit(1);
  }

  client = new DynamoDBClient({
    region: config.aws?.region,
  });

  console.log(`Updating table: ${tableName}\n`);

  // Verify the table exists
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (error.name === "ResourceNotFoundException") {
      console.error(
        `Table '${tableName}' not found. Please run bao-init to create it first.`,
      );
      process.exit(1);
    }
    throw error;
  }

  // Check and add missing GSIs
  console.log("Checking GSIs...");
  await checkAndAddMissingGSIs(tableName);

  // Check and enable TTL
  console.log("\nChecking TTL...");
  await checkAndEnableTTL(tableName);

  console.log("\nTable update complete.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
