#!/usr/bin/env node

const {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} = require("../src/dynamodb-client.js");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

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

async function writeConfigFile(tableName) {
  const region = client.region || process.env.AWS_REGION || "us-east-1";
  const configContent = `const path = require("path");

const config = {
  aws: {
    region: "${region}",
  },
  db: {
    tableName: "${tableName}",
  },
  logging: {
    level: "ERROR",
  },
  paths: {
    // Default paths:
    // models/ => generated models
    // models.yaml => model definitions
    // fields/ => custom fields
    modelsDir: path.resolve(__dirname, "./models"),
    modelsDefinitionPath: path.resolve(__dirname, "./models.yaml"),
    fieldsDir: path.resolve(__dirname, "./fields"), // optional for custom fields
  },
  tenancy: {
    enabled: false, // Set to true to enable multi-tenancy
  },
};

module.exports = config;
`;

  const configPath = path.resolve(process.cwd(), "dynamo-bao.config.js");
  fs.writeFileSync(configPath, configContent);
  console.log(`Config file written to: ${configPath}`);
}

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
        IndexName: "iter_index",
        KeySchema: [
          { AttributeName: "_iter_pk", KeyType: "HASH" },
          { AttributeName: "_iter_sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "KEYS_ONLY" },
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

    // Add this line to write the config file after table creation
    await writeConfigFile(tableName);
  } catch (error) {
    console.error("Error creating table:", error);
  }
}

async function createDirectoriesAndFiles() {
  // Create models directory
  const modelsDir = path.resolve(process.cwd(), "models");
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir);
    console.log(`Created models directory at: ${modelsDir}`);
  }

  // Create models.yaml with default content
  const modelsYamlPath = path.resolve(process.cwd(), "models.yaml");
  const yamlContent = `# Edit this file to create your models. For more information see: aag1024.github.io/dynamo-bao/
#
# Here's a simple example:
# models:
#   User: {
#   
#     modelPrefix: u
#     fields:
#       userId: {type: UlidField, autoAssign: true, required: true}
#       name: {type: StringField, required: true}
#       email: {type: EmailField, required: true}
#     primaryKey: {partitionKey: userId}
#   }
`;

  if (!fs.existsSync(modelsYamlPath)) {
    fs.writeFileSync(modelsYamlPath, yamlContent);
    console.log(`Created models.yaml at: ${modelsYamlPath}`);
  }
}

async function main() {
  await checkAwsCredentials();
  await createTable();
  // Add this line after table creation
  await createDirectoriesAndFiles();
}

// Run the main function
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
