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
    const discoveredModels = {};
  
    // Find all .js files in directory and subdirectories
    const modelFiles = findModelFiles(modelsDir);
  
    modelFiles.forEach(filePath => {
      const model = require(filePath);
      
      // Each model file should export a class that extends BaseModel
      Object.entries(model).forEach(([name, exp]) => {
        if (typeof exp === 'function' && exp.prototype instanceof BaseModel) {
          registry.register(exp);
          discoveredModels[name] = exp;
        }
      });
    });
  
    return discoveredModels;
  }
  
  /**
   * Initializes the model system
   * @param {Object} config - Configuration object
   * @param {string} config.region - AWS region
   * @param {string} config.tableName - DynamoDB table name
   * @param {string} [config.modelsDir] - Directory containing model files
   */
  function initModels(config) {
    // Register models from specified directory (or default)
    const models = registerModels(config.modelsDir);
    
    // Initialize ModelManager with discovered models
    return ModelManager.getInstance().init({
      region: config.region,
      tableName: config.tableName,
      models
    });
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