const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { ModelRegistry } = require('./model-registry');

class ModelManager {
  static _instance = null;
  _initialized = false;
  _docClient = null;
  _tableName = null;

  static getInstance() {
    if (!ModelManager._instance) {
      ModelManager._instance = new ModelManager();
    }
    return ModelManager._instance;
  }

  init(config = {}) {
    if (this._initialized) {
      return this;
    }

    // Set up DynamoDB client
    const client = new DynamoDBClient({ 
      region: config.region || process.env.AWS_REGION 
    });
    this._docClient = DynamoDBDocument.from(client);
    this._tableName = config.tableName || process.env.TABLE_NAME;

    // Initialize all registered models
    const registry = ModelRegistry.getInstance();
    const models = registry.listModels();
    
    models.forEach(modelName => {
      const ModelClass = registry.get(modelName);
      // Set documentClient directly on the model class
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass.validateConfiguration();
      ModelClass.registerRelatedIndexes();
    });

    this._initialized = true;
    return this;
  }

  get documentClient() {
    if (!this._initialized) {
      throw new Error('ModelManager not initialized. Call init() first.');
    }
    return this._docClient;
  }

  get tableName() {
    if (!this._initialized) {
      throw new Error('ModelManager not initialized. Call init() first.');
    }
    return this._tableName;
  }
}

module.exports = { ModelManager }; 