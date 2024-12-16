#!/usr/bin/env node

const {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} = require("@aws-sdk/client-dynamodb");
const readline = require("readline");

// Create DynamoDB client at the top level
const client = new DynamoDBClient();

async function checkAwsCredentials() {
  try {
    // Make a simple request that requires authentication
    await client.send(new ListTablesCommand({}));
    console.log("AWS credentials found and valid");
    return true;
  } catch (error) {
    if (
      error.name === "UnrecognizedClientException" ||
      error.name === "AccessDeniedException" ||
      error.name === "CredentialsNotFound"
    ) {
      console.error(
        "AWS credentials not found or invalid. Please run aws configure to set your credentials.",
        error.message,
      );
      return false;
    }
    // If it's a different error (like network issues), throw it
    throw error;
  }
}

// Function to prompt user for input
const prompt = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
};

async function createTable() {
  // Prompt user for table name
  const defaultTableName = "dynamo-bao-dev";
  const tableName =
    (await prompt(`Enter table name [${defaultTableName}]: `)) ||
    defaultTableName;

  // Define table parameters
  const params = {
    TableName: tableName,
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
      { AttributeName: "_gsi_test_id", AttributeType: "S" },
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
        IndexName: "gsi_test",
        KeySchema: [{ AttributeName: "_gsi_test_id", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    TimeToLiveSpecification: {
      AttributeName: "ttl",
      Enabled: true,
    },
  };

  try {
    // Create table
    const command = new CreateTableCommand(params);
    const response = await client.send(command);
    console.log(
      "Table created successfully:",
      response.TableDescription.TableName,
    );
  } catch (error) {
    console.error("Error creating table:", error);
  }
}

async function main() {
  await checkAwsCredentials();
  await createTable();
}

// Run the main function
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
