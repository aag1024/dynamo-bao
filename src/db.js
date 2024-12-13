// src/db.js
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

function createDbClient() {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    maxAttempts: 3,
    ...(process.env.DYNAMODB_ENDPOINT && {
      endpoint: process.env.DYNAMODB_ENDPOINT
    })
  });
  
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    }
  });
}

module.exports = { createDbClient };