const path = require('path');
const dotenv = require('dotenv');

// Load .env file
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });

const config = {
  aws: {
    region: 'us-west-2',
  },
  db: {
    tableName: 'dynamo-bao-test',
  },
  logging: {
    level: 'ERROR',
  },
  paths: {
    modelsDir: path.resolve(__dirname, "./models")
  }
};

module.exports = config;