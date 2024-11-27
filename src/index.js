// src/index.js
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
  
  // Default models directory is relative to this file
  const DEFAULT_MODELS_DIR = path.join(__dirname, 'models');
  
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
  
  function registerModels(manager = null, modelsDir = DEFAULT_MODELS_DIR) {
    // If no manager provided, use the default instance
    if (!manager) {
      manager = ModelManager.getInstance();
    }
  
    const modelFiles = findModelFiles(modelsDir);
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
  
  function initModels(config) {  
    // Get/create manager instance with test_id
    const manager = ModelManager.getInstance(config.test_id);
    registerModels(manager);
  
    // Initialize the manager
    manager.init(config);
  
    logger.log('Models initialized:', {
      testId: config.test_id,
      managerTestId: manager.getTestId(),
      registeredModels: Array.from(manager._models.keys())
    });
  
    return manager;
  }
  
  const defaultModels = registerModels();
  
  module.exports = {
    // Initialize function
    initModels,
    registerModels,  // Expose registration function for custom directories
    
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