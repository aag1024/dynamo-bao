// src/index.js
const fs = require('fs');
const path = require('path');
const { ModelManager } = require('./model-manager');
const { ModelRegistry } = require('./model-registry');

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
  
  /**
   * Recursively discovers model files in a directory
   * @param {string} dir - Directory to search
   * @returns {string[]} Array of file paths
   */
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
  
  /**
   * Registers models from the specified directory
   * @param {string} [modelsDir] - Directory containing model files
   * @returns {Object} Object containing all discovered models
   */
  function registerModels(modelsDir = DEFAULT_MODELS_DIR) {
    const registry = ModelRegistry.getInstance();
    const modelFiles = findModelFiles(modelsDir);
    const models = {};
  
    modelFiles.forEach(file => {
      const model = require(file);
      Object.entries(model).forEach(([name, ModelClass]) => {
        registry.register(ModelClass);
        models[name] = ModelClass;
      });
    });
  
    return models;
  }
  
  /**
   * Initializes the model system
   * @param {Object} config - Configuration object
   * @param {string} config.region - AWS region
   * @param {string} config.tableName - DynamoDB table name
   * @param {string} [config.modelsDir] - Directory containing model files
   */
  function initModels(config) {
    // First register all models with the registry
    const models = registerModels();
  
    // Get/create manager instance with test_id
    const manager = ModelManager.getInstance(config.test_id);
  
    // Register all models with this manager instance
    Object.values(models).forEach(ModelClass => {
      manager.registerModel(ModelClass);
    });
  
    // Initialize the manager
    manager.init(config);
  
    console.log('Models initialized:', {
      testId: config.test_id,
      managerTestId: manager.getTestId(),
      registeredModels: Array.from(manager._models.keys())
    });
  
    return manager;
  }
  
  // Register models from default directory for direct import support
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