// src/index.js
const config = require("./config");
const fs = require("fs");
const path = require("path");
const { ModelManager } = require("./model-manager");
const { defaultLogger: logger } = require("./utils/logger");
const fields = require("./fields");
const constants = require("./constants");

const {
  BaseModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("./model");

function findModelFiles(dir) {
  let results = [];
  const items = fs.readdirSync(dir);

  items.forEach((item) => {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      // Recursively search subdirectories
      results = results.concat(findModelFiles(fullPath));
    } else if (item.endsWith(".js")) {
      results.push(fullPath);
    }
  });

  return results;
}

function _registerModels(manager = null, modelsDir = null) {
  if (!modelsDir) {
    throw new Error("modelsDir is required");
    return;
  }

  const modelFiles = findModelFiles(modelsDir);
  const models = {};

  modelFiles.forEach((file) => {
    const model = require(file);
    Object.entries(model).forEach(([name, ModelClass]) => {
      manager.registerModel(ModelClass);
      models[name] = ModelClass;
    });
  });

  return models;
}

function initModels(userConfig = {}) {
  // Merge user config with default config
  const finalConfig = {
    ...config,
    ...userConfig,
    // Preserve nested configs if provided
    aws: {
      ...config.aws,
      ...(userConfig.aws || {}),
    },
    db: {
      ...config.db,
      ...(userConfig.db || {}),
    },
    logging: {
      ...config.logging,
      ...(userConfig.logging || {}),
    },
    paths: {
      ...config.paths,
      ...(userConfig.paths || {}),
    },
  };

  const modelsDir = finalConfig.paths.modelsDir;

  // Get/create manager instance with testId
  const manager = ModelManager.getInstance(finalConfig.testId);

  // First pass to register models
  const registeredModels = _registerModels(manager, modelsDir);

  // Initialize the manager & 2nd model registration pass
  manager.init(finalConfig);

  logger.log("Models initialized:", {
    testId: finalConfig.testId,
    managerTestId: manager.getTestId(),
    registeredModels: Array.from(manager._models.keys()),
  });

  manager.models = registeredModels;

  return manager;
}

const firstExport = {
  // Initialize function
  initModels,

  // Core classes
  BaseModel,
  ModelManager,
  fields,

  // Configurations
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,

  // Export the constants module directly
  constants,

  models: {},
};

module.exports = firstExport;

if (config.paths.modelsDir) {
  const manager = initModels(config);
  Object.assign(firstExport.models, manager.models);
}
