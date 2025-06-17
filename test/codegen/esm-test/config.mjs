import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  aws: {
    region: "us-west-2",
  },
  db: {
    tableName: "dynamo-bao-test-esm",
  },
  codegen: {
    moduleSystem: 'esm',
  },
  logging: {
    level: "ERROR",
  },
  paths: {
    modelsDir: path.resolve(__dirname, "./generated"),
    modelsDefinitionPath: path.resolve(__dirname, "./models.yaml"),
    fieldsDir: path.resolve(__dirname, "./custom-fields"),
  },
};