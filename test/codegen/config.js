const path = require("path");

module.exports = {
  aws: {
    region: "us-west-2", // Your AWS region
  },
  db: {
    tableName: "dynamo-bao-test",
  },
  logging: {
    level: "ERROR",
  },
  paths: {
    modelsDir: path.resolve(__dirname, "./generated"),
    modelsDefinitionPath: path.resolve(__dirname, "./definitions"),
    fieldsDir: path.resolve(__dirname, "./custom-fields"),
  },
};
