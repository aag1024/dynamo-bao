const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

function findConfig() {
  // First check environment variable
  if (process.env.DYNAMO_BAO_CONFIG) {
    const configPath = path.resolve(
      process.cwd(),
      process.env.DYNAMO_BAO_CONFIG,
    );
    if (fs.existsSync(configPath)) {
      const rawConfig = require(configPath);
      const configDir = path.dirname(configPath);
      return normalizeConfig(rawConfig, configDir);
    }
  }

  const possibleNames = [
    "dynamo-bao.config.js",
    "dynamo-bao.config.cjs",
    ".dynamo-bao/config.js",
    "config.js",
    "config.cjs",
  ];
  const searchPaths = [
    process.cwd(), // Project root
  ];

  // Search each directory for config files
  for (const searchPath of searchPaths) {
    for (const name of possibleNames) {
      const configPath = path.join(searchPath, name);
      if (fs.existsSync(configPath)) {
        const rawConfig = require(configPath);
        const configDir = path.dirname(configPath);
        return normalizeConfig(rawConfig, configDir);
      }
    }
  }

  // If no config file found, create default config from env
  dotenv.config();
  return {
    aws: {
      region: process.env.AWS_REGION || "us-west-2",
    },
    db: {
      tableName: process.env.TABLE_NAME || "dynamo-bao-dev",
    },
    logging: {
      level: process.env.LOG_LEVEL || "ERROR",
    },
    paths: {
      modelsDir: process.env.MODELS_DIR
        ? path.resolve(process.cwd(), process.env.MODELS_DIR)
        : null,
    },
    tenancy: {
      enabled: process.env.DYNAMO_BAO_TENANCY_ENABLED === "true" || false,
    },
  };
}

function normalizeConfig(rawConfig, configDir) {
  return {
    ...rawConfig,
    models: rawConfig.models || null,
    paths: {
      ...(rawConfig.paths || {}),
      modelsDir: rawConfig.paths?.modelsDir
        ? path.resolve(configDir, rawConfig.paths.modelsDir)
        : null,
      modelsDefinitionPath: rawConfig.paths?.modelsDefinitionPath
        ? path.resolve(configDir, rawConfig.paths.modelsDefinitionPath)
        : null,
      fieldsDir: rawConfig.paths?.fieldsDir
        ? path.resolve(configDir, rawConfig.paths.fieldsDir)
        : null,
      generatedModelsManifest: rawConfig.paths?.generatedModelsManifest
        ? path.resolve(configDir, rawConfig.paths.generatedModelsManifest)
        : path.resolve(process.cwd(), ".bao/models.js"),
    },
    logging: {
      ...(rawConfig.logging || {}),
      // Allow environment variable to override config file
      level: process.env.LOG_LEVEL || rawConfig.logging?.level || "ERROR",
    },
    tenancy: {
      enabled: false,
      ...rawConfig.tenancy,
    },
  };
}

// Load config once at module level
const config = findConfig();
module.exports = config;
