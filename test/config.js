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
    tableName: 'dynamo-bao-dev',
  },
  logging: {
    level: 'ERROR',
  },
  paths: {
    // Resolve models directory relative to CWD if provided, otherwise null
    modelsDir: path.resolve(__dirname, "./models")
  }
};

module.exports = config;