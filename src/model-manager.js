const { DynamoDBClient, DynamoDBDocumentClient } = require("./dynamodb-client");
const { defaultLogger: logger } = require("./utils/logger");
const { pluginManager } = require("./plugin-manager");
const { ConfigurationError } = require("./exceptions");

class ModelManager {
  static _instances = new Map();

  constructor(config = {}) {
    this._initialized = false;
    this._docClient = null;
    this._tableName = null;
    this._tenantId = null; // Changed from _testId
    this._tenancyEnabled = false;
    this._models = new Map();
  }

  static getInstance(tenantId = null) {
    const key = tenantId || "default";
    if (!ModelManager._instances.has(key)) {
      const instance = new ModelManager();
      instance._tenantId = tenantId;
      ModelManager._instances.set(key, instance);
    }
    return ModelManager._instances.get(key);
  }

  init(config = {}) {
    // Validate tenant requirement
    const { TenantContext } = require('./tenant-context');
    TenantContext.validateTenantRequired(config);

    const client = new DynamoDBClient({
      region: config.aws.region,
    });
    this._docClient = DynamoDBDocumentClient.from(client);
    this._tableName = config.db.tableName;
    this._tenancyEnabled = config.tenancy?.enabled || false;
    
    // Support both tenantId and testId for backward compatibility
    this._tenantId = config.tenantId || config.testId || this._tenantId;

    // Initialize all registered models
    for (const [_, ModelClass] of this._models) {
      ModelClass._tenantId = this._tenantId;
      ModelClass._testId = this._tenantId; // Backward compatibility
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass._validateConfiguration();
    }

    this._initialized = true;
    return this;
  }

  getModel(modelName) {
    const model = this._models.get(modelName);
    if (!model) {
      throw new ConfigurationError(`Model ${modelName} not found`);
    }
    return model;
  }

  // Registry methods
  registerModel(ModelClass) {
    this._models.set(ModelClass.name, ModelClass);

    // Add plugin support to the model class
    ModelClass.registerPlugin = function (plugin) {
      pluginManager.registerPlugin(this.name, plugin);

      // Apply methods directly to the prototype
      if (plugin.methods) {
        Object.entries(plugin.methods).forEach(([methodName, methodFn]) => {
          if (ModelClass.prototype[methodName]) {
            logger.warn(
              `Method ${methodName} already exists for model ${this.name}`,
            );
          }
          ModelClass.prototype[methodName] = methodFn;
        });
      }
    };

    // Initialize as before
    ModelClass._tenantId = this._tenantId;
    ModelClass._testId = this._tenantId; // Backward compatibility
    if (this._initialized) {
      ModelClass.documentClient = this._docClient;
      ModelClass.table = this._tableName;
      ModelClass._validateConfiguration();
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

  getTenantId() {
    return this._tenantId;
  }

  // Backward compatibility
  getTestId() {
    return this._tenantId;
  }

  isTenancyEnabled() {
    return this._tenancyEnabled;
  }

  // Helper method for debugging
  listModels() {
    return Array.from(this._models.keys());
  }

  getModels() {
    return Array.from(this._models.values());
  }
}

module.exports = { ModelManager };
