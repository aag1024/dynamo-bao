// src/db.js
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');

function createDbClient() {
  const client = new DynamoDBClient({
    maxAttempts: 3,
    retryMode: 'standard',
    retryStrategy: defaultRetryStrategy(() => ({
      // Custom retry strategy if needed
      maxAttempts: 3,
      retryDelay: (attempt) => Math.pow(2, attempt) * 100,
    })),
    region: process.env.AWS_REGION || 'us-east-1',
    ...(process.env.DYNAMODB_ENDPOINT && {
      endpoint: process.env.DYNAMODB_ENDPOINT
    })
  });
  return DynamoDBDocument.from(client);
}

module.exports = { createDbClient };