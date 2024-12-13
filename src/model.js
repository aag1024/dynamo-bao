// src/model.js
const { RelatedFieldClass, StringField, TtlFieldClass } = require('./fields');
const { ModelManager } = require('./model-manager');
const { defaultLogger: logger } = require('./utils/logger');
const { ObjectNotFound } = require('./object-not-found');
const ValidationMethods = require('./mixins/validation-mixin');
const UniqueConstraintMethods = require('./mixins/unique-constraint-mixin');
const QueryMethods = require('./mixins/query-mixin');
const MutationMethods = require('./mixins/mutation-mixin');
const { 
  BatchLoadingMethods,
  BATCH_REQUESTS,
  BATCH_REQUEST_TIMEOUT
} = require('./mixins/batch-loading-mixin');

const {
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig
} = require('./model-config');

const GID_SEPARATOR = "##__SK__##";
const { UNIQUE_CONSTRAINT_KEY, SYSTEM_FIELDS } = require('./constants');

class BaseModel {
  static _testId = null;
  static table = null;
  static documentClient = null;
  
  // These should be overridden by child classes
  static modelPrefix = null;
  static fields = {};
  static primaryKey = null;
  static indexes = {};
  static uniqueConstraints = {};

  static defaultQueryLimit = 100;

  static {
    // Initialize methods
    Object.assign(BaseModel, ValidationMethods);
    Object.assign(BaseModel, UniqueConstraintMethods);
    Object.assign(BaseModel, QueryMethods);
    Object.assign(BaseModel, MutationMethods);
    Object.assign(BaseModel, BatchLoadingMethods); 
  }

  static setTestId(testId) {
    this._testId = testId;
    const manager = ModelManager.getInstance(testId);
    this.documentClient = manager.documentClient;
    this.table = manager.tableName;
  }

  static get manager() {
    return ModelManager.getInstance(this._testId);
  }

  static _getField(fieldName) {
    let fieldDef;
    if (SYSTEM_FIELDS.includes(fieldName) || fieldName === 'modelPrefix') {
      fieldDef = StringField();
    } else {
      fieldDef = this.fields[fieldName];
    }

    if (!fieldDef) {
      throw new Error(`Field ${fieldName} not found in ${this.name} fields`);
    }

    return fieldDef;
  }

  static _getPkValue(data) {
    if (!data) {
      throw new Error('Data object is required for static _getPkValue call');
    }

    const pkValue = this.primaryKey.pk === 'modelPrefix' ? 
      this.modelPrefix : 
      data[this.primaryKey.pk];

    logger.debug('_getPkValue', pkValue);

    return pkValue;
  }

  static _getSkValue(data) {
    if (!data) {
      throw new Error('Data object is required for static _getSkValue call');
    }
    
    if (this.primaryKey.sk === 'modelPrefix') {
      return this.modelPrefix;
    }
    return data[this.primaryKey.sk];
  }

  _getPkValue() {
    return this.constructor._getPkValue(this._data);
  }

  _getSkValue() {
    return this.constructor._getSkValue(this._data);
  }

  static _formatGsiKey(modelPrefix, indexId, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${modelPrefix}#${indexId}#${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static _formatPrimaryKey(modelPrefix, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${modelPrefix}#${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static _formatUniqueConstraintKey(constraintId, modelPrefix, field, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${UNIQUE_CONSTRAINT_KEY}#${constraintId}#${modelPrefix}#${field}:${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static _getDyKeyForPkSk(pkSk) {
    if (this.primaryKey.sk === 'modelPrefix') {
      return {
        _pk: this._formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: this.modelPrefix
      };
    }
    else if (this.primaryKey.pk === 'modelPrefix') {
      return {
        _pk: this.modelPrefix,
        _sk: pkSk.sk
      };
    } else {
      return {
        _pk: this._formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: pkSk.sk
      };
    }
  }
  
  constructor(data = {}) {
    // Initialize data object with all DynamoDB attributes
    this._data = {};
    SYSTEM_FIELDS.forEach(key => {
      if (data[key] !== undefined) {
        this._data[key] = data[key];
      }
    });

    this._originalData = {};
    this._changes = new Set();
    this._relatedObjects = {};
    this._consumedCapacity = [];

    // Initialize fields with data
    Object.entries(this.constructor.fields).forEach(([fieldName, field]) => {
      let value;
      if (data[fieldName] === undefined) {
        value = field.getInitialValue();
      } 
      
      if (value === undefined) {
        value = field.fromDy(data[fieldName]);
      }

      this._data[fieldName] = value;
      
      // Define property getter/setter for converted value
      Object.defineProperty(this, fieldName, {
        get: () => value,
        set: (newValue) => {
          if (newValue !== value) {
            value = newValue;
            this._data[fieldName] = field.toDy(newValue);  // Update raw value
            this._changes.add(fieldName);
            if (field instanceof RelatedFieldClass) {
              delete this._relatedObjects[fieldName];
            }
          }
        }
      });
    });

    // Store original data for change tracking
    this._originalData = { ...this._data };
  }

  clearRelatedCache(fieldName) {
    delete this._relatedObjects[fieldName];
  }

  // Returns the pk and sk values for a given object. These are encoded to work with
  // dynamo string keys. No test prefix or model prefix is applied.
  static _getPrimaryKeyValues(data) {
    if (!data) {
      throw new Error('Data object is required for _getPrimaryKeyValues call');
    }

    const pkField = this._getField(this.primaryKey.pk);
    const skField = this._getField(this.primaryKey.sk);

    if (skField === undefined && this.primaryKey.sk !== 'modelPrefix') {
      throw new Error(`SK field is required for getPkSk call`);
    }

    if (pkField === undefined && this.primaryKey.pk !== 'modelPrefix') {
      throw new Error(`PK field is required for getPkSk call`);
    }

    // If the field is set, use the GSI value, otherwise use the raw value
    const pkValue = pkField ? pkField.toGsi(this._getPkValue(data)) : this._getPkValue(data);
    const skValue = skField ? skField.toGsi(this._getSkValue(data)) : this._getSkValue(data);

    if (pkValue === undefined || skValue === undefined || pkValue === null || skValue === null) {
      throw new Error(`PK and SK must be defined to get a PkSk`);
    }

    let key = {
      pk: pkValue,
      sk: skValue
    }

    logger.debug("_getPrimaryKeyValues", key);

    return key;
  }

  static getPrimaryId(data) {
    logger.debug("getPrimaryId", data);
    const pkSk = this._getPrimaryKeyValues(data);
    logger.debug("getPrimaryId", pkSk);

    let primaryId;
    if (this.primaryKey.pk === 'modelPrefix') {
      primaryId = pkSk.sk;
    } else if (this.primaryKey.sk === 'modelPrefix') {
      primaryId = pkSk.pk;
    } else {
      primaryId = pkSk.pk + GID_SEPARATOR + pkSk.sk;
    }

    
    return primaryId;
  }

  getPrimaryId() {
    return this.constructor.getPrimaryId(this._data);
  }

  static parsePrimaryId(primaryId) {
      if (!primaryId) {
        throw new Error('Primary ID is required to parse');
      }
  
      if (primaryId.indexOf(GID_SEPARATOR) !== -1) {
        const [pk, sk] = primaryId.split(GID_SEPARATOR);
        return {pk, sk};
      } else {
        if (this.primaryKey.pk === 'modelPrefix') {
          return { pk: this.modelPrefix, sk: primaryId };
        } else if (this.primaryKey.sk === 'modelPrefix') {
          return { pk: primaryId, sk: this.modelPrefix };
        } else {
          throw new Error(`Invalid primary ID: ${primaryId}`);
        }
      }
  }

  // Get only changed fields - convert from Dynamo to JS format
  getChanges() {
    const changes = {};
    logger.debug('_changes Set contains:', Array.from(this._changes));
    for (const field of this._changes) {
        const fieldDef = this.constructor._getField(field);
        logger.debug('Field definition for', field, ':', {
            type: fieldDef.constructor.name,
            field: fieldDef
        });
        const dyValue = this._data[field];
        logger.debug('Converting value:', {
            field,
            dyValue,
            fromDyExists: typeof fieldDef.fromDy === 'function'
        });
        changes[field] = fieldDef.fromDy(dyValue);
    }
    return changes;
  }

  // Check if there are any changes
  hasChanges() {
    return this._changes.size > 0;
  }

  // Reset tracking after successful save
  _resetChangeTracking() {
    this._originalData = { ...this._data };
    this._changes.clear();
  }

  // Instance method to save only changes
  async save(options = {}) {
    if (!this.hasChanges()) {
      return this; // No changes to save
    }

    const changes = this.getChanges();
    logger.debug("save() - changes", changes);
    const updatedObj = await this.constructor.update(
      this.getPrimaryId(), 
      changes, 
      { instanceObj: this, ...options });
    
    // Update this instance with the new values
    Object.entries(this.constructor.fields).forEach(([fieldName, field]) => {
      if (updatedObj[fieldName] !== undefined) {
        this[fieldName] = updatedObj[fieldName];
      }
    });
    
    // Copy any system fields
    SYSTEM_FIELDS.forEach(key => {
      if (updatedObj._data[key] !== undefined) {
        this._data[key] = updatedObj._data[key];
      }
    });
    
    // Reset change tracking after successful save
    this._resetChangeTracking();
    
    return this;
  }

  async getOrLoadRelatedField(fieldName, loaderContext = null) {
    if (this._relatedObjects[fieldName]) {
      return this._relatedObjects[fieldName];
    }
    
    const field = this.constructor.fields[fieldName];
    if (!field || !field.modelName) {
      throw new Error(`Field ${fieldName} is not a valid relation field`);
    }
    
    const value = this[fieldName];
    if (!value) return null;
    
    const ModelClass = this.constructor.manager.getModel(field.modelName);
    this._relatedObjects[fieldName] = await ModelClass.find(value, { loaderContext });
    return this._relatedObjects[fieldName];
  }

  async loadRelatedData(fieldNames = null, loaderContext = null) {
    const promises = [];
    
    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      if (fieldNames && !fieldNames.includes(fieldName)) {
        continue;
      }
      
      if (field instanceof RelatedFieldClass && this[fieldName]) {
        promises.push(
          this._loadRelatedField(fieldName, field, loaderContext)
            .then(instance => {
              this._relatedObjects[fieldName] = instance;
            })
        );
      }
    }

    await Promise.all(promises);
    return this;
  }

  async _loadRelatedField(fieldName, field, loaderContext = null) {
    const value = this[fieldName];
    if (!value) return null;
    
    const ModelClass = this.constructor.manager.getModel(field.modelName);
    
    if (value instanceof ModelClass) {
      return value;
    }

    // Load the instance and track its capacity
    const relatedInstance = await ModelClass.find(value, { loaderContext });
    
    return relatedInstance;
  }

  getRelated(fieldName) {
    const field = this.constructor.fields[fieldName];
    if (!(field instanceof RelatedFieldClass)) {
      throw new Error(`Field ${fieldName} is not a RelatedField`);
    }
    return this._relatedObjects[fieldName];
  }

  static async findByUniqueConstraint(constraintName, value, loaderContext = null) {
    const constraint = this.uniqueConstraints[constraintName];
    if (!constraint) {
      throw new Error(`Unknown unique constraint '${constraintName}' in ${this.name}`);
    }

    if (!value) {
      throw new Error(`${constraint.field} value is required`);
    }
  
    const key = this._formatUniqueConstraintKey(
      constraint.constraintId,
      this.modelPrefix,
      constraint.field,
      value
    );
  
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: {
        _pk: key,
        _sk: UNIQUE_CONSTRAINT_KEY
      },
      ReturnConsumedCapacity: 'TOTAL'
    });
  
    if (!result.Item) {
      return new ObjectNotFound(result.ConsumedCapacity);
    }
  
    const item = await this.find(result.Item.relatedId, { loaderContext });
  
    if (item) {
      item.addConsumedCapacity(result.ConsumedCapacity);
    }
  
    return item;
  }

  exists() {
    return true;
  }

  setConsumedCapacity(capacity, type = 'read', fromContext = false) {
    this.clearConsumedCapacity();
    this.addConsumedCapacity(capacity, type, fromContext);
  }
  
  addConsumedCapacity(capacity, type = 'read', fromContext = false) {
    if (type !== 'read' && type !== 'write' && type !== 'total') {
      throw new Error(`Invalid consumed capacity type: ${type}`);
    }

    if (!capacity) {
      return;
    }

    if (Array.isArray(capacity)) {
      capacity.forEach(item => this.addConsumedCapacity(item, type, fromContext));
    } else {
      if (capacity.consumedCapacity) {
        this._consumedCapacity.push({
          consumedCapacity: capacity.consumedCapacity,
          fromContext: capacity.fromContext || fromContext,
          type: capacity.type || type
        });
      } else {
        this._consumedCapacity.push({
          consumedCapacity: capacity,
          fromContext: fromContext,
          type: type
        });
      }
    }
  }
  
  getNumericConsumedCapacity(type, includeRelated = false) {
    if (type !== 'read' && type !== 'write' && type !== 'total') {
      throw new Error(`Invalid consumed capacitytype: ${type}`);
    }

    let consumedCapacity = this._consumedCapacity;
    if (!consumedCapacity) {
      consumedCapacity = [];
    }

    let total = consumedCapacity.reduce((sum, capacity) => {
      if (!capacity.fromContext && (capacity.type === type || type === 'total')) {
        return sum + (capacity.consumedCapacity?.CapacityUnits || 0);
      }
      return sum;
    }, 0);

    if (includeRelated) {
      // Sum up capacity from any loaded related objects
      for (const relatedObj of Object.values(this._relatedObjects)) {
        if (relatedObj) {
          const relatedCapacity = relatedObj.getNumericConsumedCapacity(type, true);
          total += relatedCapacity;
        }
      }
    }

    return total;
  }
  
  getConsumedCapacity() {
    return this._consumedCapacity;
  }

  clearConsumedCapacity() {
    this._consumedCapacity = [];
  }
}

module.exports = {
  BaseModel,
  PrimaryKeyConfig: (pk, sk) => new PrimaryKeyConfig(pk, sk),
  IndexConfig: (pk, sk, indexId) => new IndexConfig(pk, sk, indexId),
  UniqueConstraintConfig: (field, constraintId) => new UniqueConstraintConfig(field, constraintId),
  BATCH_REQUEST_TIMEOUT,
  BATCH_REQUESTS
};


