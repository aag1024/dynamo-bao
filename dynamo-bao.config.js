const path = require("path");

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
