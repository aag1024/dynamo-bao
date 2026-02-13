- [bao-init](#bao-init)
- [bao-update-table](#bao-update-table)
- [bao-delete](#bao-delete)
- [bao-codegen](#bao-codegen)
- [bao-watch](#bao-watch)

## bao-init

Creates a new DynamoDB table with the recommended single-table design schema and initializes the project structure.

`npx bao-init`

### Features

- Creates a DynamoDB table with:
  - Pay-per-request billing
  - 3 Global Secondary Indexes (GSI1, GSI2, GSI3)
  - A test GSI
  - TTL attribute support
- Generates a `dynamo-bao.config.js` file with AWS and table configurations
- Creates initial project structure:
  - `models/` directory for generated models
  - `models.yaml` template file for model definitions

### Interactive Prompts

- Table name (defaults to "dynamo-bao-dev")
- Validates AWS credentials before table creation

## bao-update-table

Updates an existing DynamoDB table to match the expected schema. This is useful when upgrading dynamo-bao to a version that requires additional GSIs or other table changes.

`npx bao-update-table`

### Features

- Checks for missing Global Secondary Indexes (GSIs) and adds them
- Enables TTL on the `ttl` attribute if not already enabled
- Adds one GSI at a time, waiting for the table to become active between each addition
- Uses configuration from `dynamo-bao.config.js`

## bao-delete

Deletes a DynamoDB table.

`npx bao-delete`

## bao-codegen

Generates model files from YAML definitions.

`npx bao-codegen [definitionsPath] [outputDir]`

### Arguments

- `definitionsPath` (optional): Path to your models definition file or directory (default: `./models.yaml`)
- `outputDir` (optional): Directory where generated models will be saved (default: `./models`)

### Features

- Supports single YAML file or directory of YAML files
- Loads custom field types from configured fields directory
- Uses configuration from `dynamo-bao.config.js` or environment variable `DYNAMO_BAO_CONFIG`

## bao-watch

Watches for changes in your model definitions and automatically regenerates model files.

`npx bao-watch`

### Features

- Initial generation of models on startup
- Watches for:
  - Changes to existing YAML files
  - New YAML files added to the watched directory
- Supports both single file and directory watching
- Uses configuration from `dynamo-bao.config.js`
- Real-time model regeneration on file changes

### Configuration

The watch command uses the following configuration hierarchy:

1. `dynamo-bao.config.js` in your project root
2. Default paths:
   - Models definition: `./models.yaml`
   - Output directory: `./models`
   - Custom fields: `./fields`

## Configuration File (dynamo-bao.config.js)

The CLI tools use a common configuration file. Here's an example structure:

```javascript
const path = require("path");

module.exports = {
  aws: {
    region: "us-east-1", // Your AWS region
  },
  db: {
    tableName: "your-table-name",
  },
  logging: {
    level: "ERROR",
  },
  paths: {
    modelsDir: path.resolve(__dirname, "./models"),
    modelsDefinitionPath: path.resolve(__dirname, "./models.yaml"),
    fieldsDir: path.resolve(__dirname, "./fields"),
  },
};
```

## Requirements

- Valid AWS credentials configured
- Node.js installed
- Project initialized with `package.json`
