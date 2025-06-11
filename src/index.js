// src/index.js
const config = require("./config");
const fs = require("fs");
const path = require("path");
const { ModelManager } = require("./model-manager");
const { defaultLogger: logger } = require("./utils/logger");
const fields = require("./fields");
const constants = require("./constants");
const exceptions = require("./exceptions");
const { ConfigurationError } = require("./exceptions");

const {
  BaoModel,
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
    throw new ConfigurationError("modelsDir is required");
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
    tenancy: {
      ...config.tenancy,
      ...(userConfig.tenancy || {}),
    },
  };

  // Validate tenant context if tenancy enabled
  if (finalConfig.tenancy?.enabled) {
    const { TenantContext } = require('./tenant-context');
    TenantContext.validateTenantRequired(finalConfig);
  }

  const modelsDir = finalConfig.paths.modelsDir;

  // Get/create manager instance with tenantId
  const { TenantContext } = require('./tenant-context');
  const tenantId = TenantContext.getCurrentTenant() || finalConfig.testId;
  const manager = ModelManager.getInstance(tenantId);

  // First pass to register models
  const registeredModels = _registerModels(manager, modelsDir);

  // Initialize the manager & 2nd model registration pass
  manager.init(finalConfig);

  logger.log("Models initialized:", {
    testId: finalConfig.testId,
    tenantId: manager.getTenantId(),
    managerTestId: manager.getTestId(),
    registeredModels: Array.from(manager._models.keys()),
  });

  manager.models = registeredModels;

  return manager;
}

const { TenantContext } = require('./tenant-context');

const firstExport = {
  // Initialize function
  initModels,

  // Core classes
  BaoModel,
  ModelManager,
  fields,

  // Tenant management
  TenantContext,

  // Configurations
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,

  // Export the constants module directly
  constants,

  // Export the exceptions module
  exceptions,

  models: {},
};

module.exports = firstExport;

if (config.paths.modelsDir) {
  const manager = initModels(config);
  Object.assign(firstExport.models, manager.models);
}
