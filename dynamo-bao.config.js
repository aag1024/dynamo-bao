import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export default config;
