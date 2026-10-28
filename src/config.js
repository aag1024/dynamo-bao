const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

async function findConfig() {
  // First check environment variable
  if (process.env.DYNAMO_BAO_CONFIG) {
    const configPath = path.resolve(
      process.cwd(),
      process.env.DYNAMO_BAO_CONFIG,
    );
    if (fs.existsSync(configPath)) {
      const rawConfig = await loadConfigFile(configPath);
      const configDir = path.dirname(configPath);
      return normalizeConfig(rawConfig, configDir);
    }
  }

  const possibleNames = [
    "dynamo-bao.config.js",
    "dynamo-bao.config.mjs",
    "dynamo-bao.config.cjs",
    ".dynamo-bao/config.js",
    ".dynamo-bao/config.mjs",
  ];
  // Older versions also loaded these generic names, which meant running any
  // project's config.js. Refuse them rather than silently using defaults.
  const legacyNames = ["config.js", "config.mjs", "config.cjs"];
  const searchPaths = [
    process.cwd(), // Project root
  ];

  // Search each directory for config files
  for (const searchPath of searchPaths) {
    for (const name of possibleNames) {
      const configPath = path.join(searchPath, name);
      if (fs.existsSync(configPath)) {
        const rawConfig = await loadConfigFile(configPath);
        const configDir = path.dirname(configPath);
        return normalizeConfig(rawConfig, configDir);
      }
    }
    for (const name of legacyNames) {
      if (fs.existsSync(path.join(searchPath, name))) {
        throw new Error(
          `Found ${name} but no dynamo-bao.config.js in ${searchPath}. ` +
            "dynamo-bao no longer loads generic config file names: rename it " +
            `to dynamo-bao.config.js, or set DYNAMO_BAO_CONFIG=${name}.`,
        );
      }
    }
  }

  // If no config file found, create default config from env. Only the CLI
  // tools reach this, so loading .env here doesn't affect library users.
  require("dotenv").config();
  return {
    aws: {
      region: process.env.AWS_REGION || "us-west-2",
    },
    db: {
      tableName: process.env.TABLE_NAME || "dynamo-bao-dev",
    },
    codegen: {
      moduleSystem: "commonjs",
    },
    logging: {
      level: process.env.DYNAMO_BAO_LOG_LEVEL || "ERROR",
    },
    paths: {
      modelsDir: process.env.MODELS_DIR
        ? path.resolve(process.cwd(), process.env.MODELS_DIR)
        : null,
    },
    tenancy: {
      enabled: process.env.DYNAMO_BAO_TENANCY_ENABLED === "true" || false,
    },
    batchContext: {
      requireBatchContext:
        process.env.DYNAMO_BAO_REQUIRE_BATCH_CONTEXT === "true" || false,
    },
  };
}

async function loadConfigFile(configPath) {
  if (configPath.endsWith(".cjs")) {
    // Use require for CommonJS files
    return require(configPath);
  } else if (configPath.endsWith(".mjs") || configPath.endsWith(".js")) {
    // Use dynamic import for ESM files
    const module = await import(pathToFileURL(configPath).href);
    return module.default || module;
  } else {
    // Default to require for legacy files
    return require(configPath);
  }
}

function normalizeConfig(rawConfig, configDir) {
  return {
    ...rawConfig,
    models: rawConfig.models || null,
    codegen: {
      moduleSystem: "commonjs",
      ...(rawConfig.codegen || {}),
    },
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
      level:
        process.env.DYNAMO_BAO_LOG_LEVEL || rawConfig.logging?.level || "ERROR",
    },
    tenancy: {
      enabled: false,
      ...rawConfig.tenancy,
    },
    batchContext: {
      requireBatchContext: false,
      ...rawConfig.batchContext,
    },
  };
}

// Synchronous initialization
let config = null;

function getConfig() {
  if (!config) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  return config;
}

async function initConfig() {
  config = await findConfig();
  return config;
}

// Defaults read from the environment when the library is imported. This
// deliberately doesn't load .env: a library shouldn't change process.env, or
// pick its table and credentials from whatever .env is in the working
// directory. Apps that use .env should load it themselves.
try {
  config = {
    aws: {
      region: process.env.AWS_REGION || "us-west-2",
    },
    db: {
      tableName: process.env.TABLE_NAME || "dynamo-bao-dev",
    },
    codegen: {
      moduleSystem: "commonjs",
    },
    logging: {
      level: process.env.DYNAMO_BAO_LOG_LEVEL || "ERROR",
    },
    paths: {
      modelsDir: process.env.MODELS_DIR
        ? path.resolve(process.cwd(), process.env.MODELS_DIR)
        : null,
    },
    tenancy: {
      enabled: process.env.DYNAMO_BAO_TENANCY_ENABLED === "true" || false,
    },
    batchContext: {
      requireBatchContext:
        process.env.DYNAMO_BAO_REQUIRE_BATCH_CONTEXT === "true" || false,
    },
  };
} catch (err) {
  console.error("Error loading config:", err);
}

module.exports = config || {
  aws: { region: "us-west-2" },
  db: { tableName: "dynamo-bao-dev" },
  codegen: { moduleSystem: "commonjs" },
  logging: { level: "ERROR" },
  paths: { modelsDir: null },
  tenancy: { enabled: false },
  batchContext: { requireBatchContext: false },
};

module.exports.initConfig = initConfig;
module.exports.getConfig = getConfig;
