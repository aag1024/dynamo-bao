#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { generateModelFiles } = require("./generators/model");
const { generateManifestFile } = require("./generators/manifest");
const { createLogger } = require("./utils/scriptLogger");
const FieldResolver = require("../src/fieldResolver");
const logger = createLogger("CodeGen");
const config = require("../src/config");

function loadModelDefinitions(definitionsPath, fieldResolver) {
  const models = {};

  if (fs.statSync(definitionsPath).isDirectory()) {
    // Load all .yaml files from directory
    const files = fs
      .readdirSync(definitionsPath)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));

    logger.debug("Found YAML files:", files);

    files.forEach((file) => {
      const filePath = path.join(definitionsPath, file);
      logger.debug(`Loading file: ${filePath}`);

      const fileContents = fs.readFileSync(filePath, "utf8");
      const definition = yaml.load(fileContents);

      logger.debug(`Loaded definition from ${file}:`, definition);

      // Merge models from this file
      if (definition && definition.models) {
        Object.assign(models, definition.models);
      } else {
        console.warn(`Warning: No models found in ${file}`);
      }
    });
  } else {
    // Load single file
    const fileContents = fs.readFileSync(definitionsPath, "utf8");
    const definition = yaml.load(fileContents);
    if (definition && definition.models) {
      Object.assign(models, definition.models);
    }
  }

  // Process models to set defaults and handle mapping tables
  for (const [modelName, modelDef] of Object.entries(models)) {
    // Default 'iterable' based on tableType
    if (modelDef.iterable === undefined) {
      if (modelDef.tableType === "mapping") {
        logger.debug(
          `Model "${modelName}" is a mapping table, defaulting 'iterable' to false.`,
        );
        modelDef.iterable = false;
      } else {
        logger.debug(
          `Model "${modelName}" is a standard table, defaulting 'iterable' to true.`,
        );
        modelDef.iterable = true;
      }
    }

    // Default 'iterationBuckets'
    if (modelDef.iterationBuckets === undefined) {
      if (modelDef.iterable) {
        logger.debug(
          `Model "${modelName}" is iterable, defaulting 'iterationBuckets' to 10.`,
        );
        modelDef.iterationBuckets = 10;
      } else {
        logger.debug(
          `Model "${modelName}" is not iterable, defaulting 'iterationBuckets' to 0.`,
        );
        modelDef.iterationBuckets = 0;
      }
    }

    if (modelDef.mapping) {
      // For mapping tables, merge mapping properties with regular model properties
      models[modelName] = {
        ...modelDef,
        // Keep mapping specific properties
        mapping: modelDef.mapping,
        // Ensure other standard model properties are present
        fields: modelDef.fields || {},
        indexes: modelDef.indexes || {},
        methods: modelDef.methods || {},
        // Any other standard model properties you want to include
      };
    }
  }

  logger.debug("Final merged models:", models);
  return { models, fieldResolver };
}

function main() {
  const args = process.argv.slice(2);

  // Paths should be pre-resolved by the config loader.
  let definitionsPath =
    config?.paths?.modelsDefinitionPath ||
    path.resolve(process.cwd(), "./models.yaml");

  let outputDir =
    config?.paths?.modelsDir || path.resolve(process.cwd(), "./models");

  // Override with command line arguments if provided
  if (args.length >= 1) {
    definitionsPath = path.resolve(process.cwd(), args[0]);
  }
  if (args.length >= 2) {
    outputDir = path.resolve(process.cwd(), args[1]);
  }

  console.log("codegen definitionsPath", definitionsPath);
  try {
    // Built-in fields are in fields.js
    const builtInFieldsPath = path.resolve(__dirname, "../src/fields.js");

    const fieldResolver = new FieldResolver(
      builtInFieldsPath,
      config?.paths?.fieldsDir,
    );

    const definitions = loadModelDefinitions(definitionsPath, fieldResolver);
    generateModelFiles(
      definitions.models,
      outputDir,
      definitions.fieldResolver,
    );

    // After generating models, generate the manifest file
    const manifestPath = config?.paths?.generatedModelsManifest;
    if (outputDir && manifestPath) {
      generateManifestFile(outputDir, manifestPath);
    } else {
      logger.warn(
        "outputDir or generatedModelsManifest path not configured. Skipping manifest generation.",
      );
    }
  } catch (error) {
    console.error("Error generating models:", error);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  }
}

function run() {
  main();
}

if (require.main === module) {
  run();
}

module.exports = { loadModelDefinitions, run };
