const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { defaultLogger: logger } = require('./utils/logger');

class ModelManager {
  static _instances = new Map();
  
  constructor(config = {}) {
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

  init(config = {}) {
    const client = new DynamoDBClient({ 
      region: config.aws.region
    });
    this._docClient = DynamoDBDocument.from(client);
    this._tableName = config.db.tableName;
    this._test_id = config.test_id || this._test_id;

    // Initialize all registered models
    for (const [_, ModelClass] of this._models) {
      ModelClass._test_id = this._test_id;
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass.validateConfiguration();
      ModelClass.registerRelatedIndexes();
      ModelClass.registerUniqueConstraintLookups();
    }

    this._initialized = true;
    return this;
  }

  getModel(modelName) {
    const ModelClass = this._models.get(modelName);
    if (!ModelClass) {
      throw new Error(`Model ${modelName} not found`);
    }
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
      ModelClass.registerUniqueConstraintLookups();
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