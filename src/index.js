// src/index.js
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { ModelManager } = require('./model-manager');
const { defaultLogger: logger } = require('./utils/logger');

const { 
    BaseModel,
    PrimaryKeyConfig,
    IndexConfig,
    UniqueConstraintConfig,
    GSI_INDEX_ID1,
    GSI_INDEX_ID2,
    GSI_INDEX_ID3,
    GSI_INDEX_ID4,
    UNIQUE_CONSTRAINT_ID1,
    UNIQUE_CONSTRAINT_ID2,
    UNIQUE_CONSTRAINT_ID3,
    UNIQUE_CONSTRAINT_ID4,
  } = require('./model');

// Replace MODELS_DIR constant with config reference
const MODELS_DIR = config.paths.modelsDir;
  
function findModelFiles(dir) {
    let results = [];
    const items = fs.readdirSync(dir);
  
    items.forEach(item => {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
  
      if (stat.isDirectory()) {
        // Recursively search subdirectories
        results = results.concat(findModelFiles(fullPath));
      } else if (item.endsWith('.js')) {
        results.push(fullPath);
      }
    });
  
    return results;
  }
  
  function _registerModels(manager = null) {
    if (!MODELS_DIR) {
      return;
    }
  
    const modelFiles = findModelFiles(MODELS_DIR);
    const models = {};
  
    modelFiles.forEach(file => {
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
            ...(userConfig.aws || {})
        },
        db: {
            ...config.db,
            ...(userConfig.db || {})
        },
        logging: {
            ...config.logging,
            ...(userConfig.logging || {})
        },
        paths: {
            ...config.paths,
            ...(userConfig.paths || {})
        }
    };

    // Get/create manager instance with testId
    const manager = ModelManager.getInstance(finalConfig.testId);

    // First pass to register models
    const registeredModels = _registerModels(manager);
  
    // Initialize the manager & 2nd model registration pass
    manager.init(finalConfig);
  
    logger.log('Models initialized:', {
        testId: finalConfig.testId,
        managerTestId: manager.getTestId(),
        registeredModels: Array.from(manager._models.keys())
    });

    manager.models = registeredModels;
  
    return manager;
}
  
  const defaultModels = initModels(config).models;
  
  module.exports = {
    // Initialize function
    initModels,
    
    // Core classes
    BaseModel,
    ModelManager,
    
    // All models (automatically exported)
    ...defaultModels,
    
    // Configurations
    PrimaryKeyConfig,
    IndexConfig,
    UniqueConstraintConfig,
    
    // Constants
    GSI_INDEX_ID1,
    GSI_INDEX_ID2,
    GSI_INDEX_ID3,
    GSI_INDEX_ID4,
    UNIQUE_CONSTRAINT_ID1,
    UNIQUE_CONSTRAINT_ID2,
    UNIQUE_CONSTRAINT_ID3,
    UNIQUE_CONSTRAINT_ID4,
  };