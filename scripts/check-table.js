const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
require('dotenv').config();

async function checkTable() {
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION
  });

  try {
    console.log(`Checking table: ${process.env.TABLE_NAME}`);
    console.log(`Region: ${process.env.AWS_REGION}`);
    
    const command = new DescribeTableCommand({
      TableName: process.env.TABLE_NAME
    });
    
    const response = await client.send(command);
    console.log('Table status:', response.Table.TableStatus);
    return true;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      console.error(`Table ${process.env.TABLE_NAME} does not exist!`);
      console.error('Please create the table using: npm run deploy');
      return false;
    }
    throw error;
  }
}

if (require.main === module) {
  checkTable()
    .then(exists => {
      if (!exists) {
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = { checkTable };