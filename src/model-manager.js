require('dotenv').config();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { defaultLogger: logger } = require('./utils/logger');

class ModelManager {
  static _instances = new Map();
  
  constructor() {
    this._initialized = false;
    this._docClient = null;
    this._tableName = null;
    this._test_id = null;
    this._models = new Map();
  }

  static getInstance(test_id = null) {
    const key = test_id || 'default';
    if (!ModelManager._instances.has(key)) {
      const instance = new ModelManager();
      instance._test_id = test_id;
      ModelManager._instances.set(key, instance);
    }
    return ModelManager._instances.get(key);
  }

  registerModel(ModelClass) {
    logger.log('Registering model:', {
      name: ModelClass.name,
      testId: this._test_id
    });
    
    this._models.set(ModelClass.name, ModelClass);
    ModelClass._test_id = this._test_id;
    
    if (this._initialized) {
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass.validateConfiguration();
      ModelClass.registerRelatedIndexes();
    }
    return ModelClass;
  }

  init(config = {}) {
    const client = new DynamoDBClient({ 
      region: config.region || process.env.AWS_REGION 
    });
    this._docClient = DynamoDBDocument.from(client);
    this._tableName = config.tableName || process.env.TABLE_NAME;
    this._test_id = config.test_id || this._test_id;

    // Initialize all registered models
    for (const [_, ModelClass] of this._models) {
      ModelClass._test_id = this._test_id;
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass.validateConfiguration();
      ModelClass.registerRelatedIndexes();
    }

    this._initialized = true;
    return this;
  }

  getModel(modelName) {
    const ModelClass = this._models.get(modelName);
    if (!ModelClass) {
      throw new Error(`Model ${modelName} not found`);
    }
    // logger.log('Getting model:', {
    //   name: modelName,
    //   testId: this._test_id,
    //   modelTestId: ModelClass._test_id,
    //   managerInstance: this === ModelManager.getInstance(this._test_id)
    // });
    return ModelClass;
  }

  // Registry methods
  registerModel(ModelClass) {
    this._models.set(ModelClass.name, ModelClass);
    ModelClass._test_id = this._test_id;
    if (this._initialized) {
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass.validateConfiguration();
      ModelClass.registerRelatedIndexes();
    }
    return ModelClass;
  }

  // Accessors
  get documentClient() {
    return this._docClient;
  }

  get tableName() {
    return this._tableName;
  }

  getTestId() {
    return this._test_id;
  }

  // Helper method for debugging
  listModels() {
    return Array.from(this._models.keys());
  }
}

module.exports = { ModelManager }; 