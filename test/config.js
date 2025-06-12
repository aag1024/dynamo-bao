const path = require("path");
const dotenv = require("dotenv");

// Load .env file
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath });

const config = {
  aws: {
    region: "us-west-2",
  },
  db: {
    tableName: "dynamo-bao-test3",
  },
  logging: {
    level: "ERROR",
  },
  paths: {
    modelsDir: path.resolve(__dirname, "./models"),
    fieldsDir: path.resolve(__dirname, "./fields"),
  },
};

module.exports = config;
