// src/db.js
const { DynamoDBClient, DynamoDBDocumentClient } = require("./dynamodb-client");

function createDbClient() {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || "us-east-1",
    ...(process.env.DYNAMODB_ENDPOINT && {
      endpoint: process.env.DYNAMODB_ENDPOINT,
    }),
  });

  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
}

module.exports = { createDbClient };
