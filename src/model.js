// src/model.js
const { RelatedFieldClass, StringField, TtlFieldClass } = require('./fields');
const { ModelManager } = require('./model-manager');
const { FilterExpressionBuilder } = require('./filter-expression');
const { defaultLogger: logger } = require('./utils/logger');
const { KeyConditionBuilder } = require('./key-condition');

// Constants for GSI indexes
const GSI_INDEX_ID1 = 'gsi1';
const GSI_INDEX_ID2 = 'gsi2';
const GSI_INDEX_ID3 = 'gsi3';

// Constants for unique constraints
const UNIQUE_CONSTRAINT_ID1 = '_uc1';
const UNIQUE_CONSTRAINT_ID2 = '_uc2';
const UNIQUE_CONSTRAINT_ID3 = '_uc3';

const GID_SEPARATOR = "##__SK__##";
const UNIQUE_CONSTRAINT_KEY = "_raft_uc";

const SYSTEM_FIELDS = [
  '_pk', '_sk',
  '_gsi1_pk', '_gsi1_sk',
  '_gsi2_pk', '_gsi2_sk',
  '_gsi3_pk', '_gsi3_sk',
  '_gsi_test_id'
];

class PrimaryKeyConfig {
  constructor(pk, sk = 'modelPrefix') {
    this.pk = pk;
    this.sk = sk;
  }

  getPkFieldName() {
    return '_pk';
  }

  getSkFieldName() {
    return '_sk';
  }
}

class IndexConfig {
  constructor(pk, sk, indexId) {
    this.pk = pk;
    this.sk = sk;
    this.indexId = indexId;
  }

  getIndexName() {
    return this.indexId;
  }

  getPkFieldName() {
    return `_${this.indexId}_pk`;
  }

  getSkFieldName() {
    return `_${this.indexId}_sk`;
  }
}

class UniqueConstraintConfig {
  constructor(field, constraintId) {
    this.field = field;
    this.constraintId = constraintId;
  }
}

class BaseModel {
  static _test_id = null;
  static table = null;
  static documentClient = null;
  
  // These should be overridden by child classes
  static modelPrefix = null;
  static fields = {};
  static primaryKey = null;
  static indexes = {};
  static uniqueConstraints = {};

  static defaultQueryLimit = 100;

  static setTestId(test_id) {
    this._test_id = test_id;
    const manager = ModelManager.getInstance(test_id);
    this.documentClient = manager.documentClient;
    this.table = manager.tableName;
  }

  static get manager() {
    return ModelManager.getInstance(this._test_id);
  }

  static getField(fieldName) {
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

  static validateConfiguration() {
    if (!this.modelPrefix) {
      throw new Error(`${this.name} must define a modelPrefix`);
    }

    if (!this.primaryKey) {
      throw new Error(`${this.name} must define a primaryKey`);
    }

    // Update to use TtlFieldClass instead of TtlField
    Object.entries(this.fields).forEach(([fieldName, field]) => {
      if (field instanceof TtlFieldClass && fieldName !== 'ttl') {
        throw new Error(`TtlField must be named 'ttl', found '${fieldName}' in ${this.name}`);
      }
    });

    // Ensure primary key fields are required
    const pkField = this.getField(this.primaryKey.pk);
    if (!pkField.required) {
      logger.warn(`Warning: Primary key field '${this.primaryKey.pk}' in ${this.name} was not explicitly marked as required. Marking as required automatically.`);
      pkField.required = true;
    }
    
    const skField = this.getField(this.primaryKey.sk);
    if (!skField.required) {
      logger.warn(`Warning: Sort key field '${this.primaryKey.sk}' in ${this.name} was not explicitly marked as required. Marking as required automatically.`);
      skField.required = true;
    }

    // Validate field names don't start with underscore
    Object.keys(this.fields).forEach(fieldName => {
      if (fieldName.startsWith('_')) {
        throw new Error(`Field name '${fieldName}' in ${this.name} cannot start with underscore`);
      }
    });

    const validIndexIds = [GSI_INDEX_ID1, GSI_INDEX_ID2, GSI_INDEX_ID3, undefined]; // undefined for PK-based indexes
    
    // Validate index names and referenced fields
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      // Check if index name starts with underscore
      if (indexName.startsWith('_')) {
        throw new Error(`Index name '${indexName}' in ${this.name} cannot start with underscore`);
      }

      // Check if referenced fields start with underscore
      if (index.pk !== 'modelPrefix' && index.pk.startsWith('_')) {
        throw new Error(`Index '${indexName}' references invalid field '${index.pk}' (cannot start with underscore)`);
      }
      if (index.sk !== 'modelPrefix' && index.sk.startsWith('_')) {
        throw new Error(`Index '${indexName}' references invalid field '${index.sk}' (cannot start with underscore)`);
      }

      // Check if this index matches the primary key configuration
      const isPrimaryKeyIndex = (
        index instanceof PrimaryKeyConfig &&
        index.pk === this.primaryKey.pk &&
        index.sk === this.primaryKey.sk
      );

      if (!validIndexIds.includes(index.indexId) && !isPrimaryKeyIndex) {
        throw new Error(`Invalid index ID ${index.indexId} in ${this.name}`);
      }

      // These will throw errors if the fields don't exist
      const idxPkField = this.getField(index.pk);
      const idxSkField = this.getField(index.sk);
    });

    // Validate unique constraints
    const validConstraintIds = [UNIQUE_CONSTRAINT_ID1, UNIQUE_CONSTRAINT_ID2, UNIQUE_CONSTRAINT_ID3];
    Object.values(this.uniqueConstraints || {}).forEach(constraint => {
      if (!validConstraintIds.includes(constraint.constraintId)) {
        throw new Error(`Invalid constraint ID ${constraint.constraintId} in ${this.name}`);
      }
      
      if (!this.getField(constraint.field)) {
        throw new Error(
          `Unique constraint field '${constraint.field}' not found in ${this.name} fields`
        );
      }
    });
  }

  static registerRelatedIndexes() {
    // Find all indexes where the partition key is a RelatedField
    const relatedIndexes = Object.entries(this.indexes).filter(([_, index]) => {
      const pkField = this.getField(index.pk);
      return pkField instanceof RelatedFieldClass;
    });

    relatedIndexes.forEach(([indexName, index]) => {
      const sourceField = this.getField(index.pk);
      const SourceModel = this.manager.getModel(sourceField.modelName);
      const CurrentModel = this;

      // Generate method name from index name
      let methodName;
      if (indexName.includes('For')) {
        const [prefix] = indexName.split('For');
        methodName = `query${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
      } else {
        methodName = `query${indexName.charAt(0).toUpperCase()}${indexName.slice(1)}`;
      }

      // Add the query method to the source model with separate pagination params
      SourceModel.prototype[methodName] = async function(
        skCondition = null,
        options = {}
      ) {
        const results = await CurrentModel.queryByIndex(
          indexName,
          this.getPkValue(),
          skCondition,
          options
        );

        return results;
      };
    });
  }

  static registerUniqueConstraintLookups() {
    // Find all unique constraints
    Object.entries(this.uniqueConstraints || {}).forEach(([name, constraint]) => {
      // Convert uniqueXxx to findByXxx
      const methodName = 'findBy' + name.replace(/^unique/, '');
      
      // Add the static lookup method
      this[methodName] = async function(value) {
        if (!value) {
          throw new Error(`${constraint.field} value is required`);
        }

        // Get the unique constraint record
        const key = this.formatUniqueConstraintKey(
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
          return null;
        }

        // Get the actual item using the relatedId
        const item = await this.find(result.Item.relatedId);
        
        // If found, add the constraint lookup capacity to the response
        if (item) {
          item._response.ConsumedCapacity = this.accumulateCapacity([
            result,
            item._response
          ]);
        }

        return item;
      };
    });
  }

  static getPkValue(data) {
    if (!data) {
      throw new Error('Data object is required for static getPkValue call');
    }

    const pkValue = this.primaryKey.pk === 'modelPrefix' ? 
      this.modelPrefix : 
      data[this.primaryKey.pk];

    logger.debug('getPkValue', pkValue);

    return pkValue;
  }

  static getSkValue(data) {
    if (!data) {
      throw new Error('Data object is required for static getSkValue call');
    }
    
    if (this.primaryKey.sk === 'modelPrefix') {
      return this.modelPrefix;
    }
    return data[this.primaryKey.sk];
  }

  getPkValue() {
    return this.constructor.getPkValue(this._data);
  }

  getSkValue() {
    return this.constructor.getSkValue(this._data);
  }

  static getCapacityFromResponse(response) {
    if (!response) return [];
    const consumed = response.ConsumedCapacity;
    if (!consumed) return [];
    return Array.isArray(consumed) ? consumed : [consumed];
  }

  static createPrefixedKey(prefix, value) {
    return `${prefix}#${value}`;
  }

  static accumulateCapacity(responses) {
    const allCapacity = responses
      .filter(r => r && r.ConsumedCapacity)
      .flatMap(r => Array.isArray(r.ConsumedCapacity) ? 
        r.ConsumedCapacity : 
        [r.ConsumedCapacity]
      );
    return allCapacity.length ? allCapacity : null;
  }

  static async _createUniqueConstraint(field, value, relatedId, constraintId = UNIQUE_CONSTRAINT_ID1) {
    const testId = this.manager.getTestId();
    const key = this.formatUniqueConstraintKey(constraintId, this.modelPrefix, field, value);

    let item = {
      _pk: key,
      _sk: UNIQUE_CONSTRAINT_KEY,
      uniqueValue: key,
      relatedId: relatedId,
      relatedModel: this.name,
    };

    if (testId) {
      item._gsi_test_id = testId;
    }

    return {
      Put: {
        TableName: this.table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#pk) OR (relatedId = :relatedId AND relatedModel = :modelName)',
        ExpressionAttributeNames: {
          '#pk': '_pk'
        },
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': this.name
        }
      }
    };
  }

  static async _removeUniqueConstraint(field, value, relatedId, constraintId = UNIQUE_CONSTRAINT_ID1) {
    return {
      Delete: {
        TableName: this.table,
        Key: {
          _pk: this.formatUniqueConstraintKey(constraintId, this.modelPrefix, field, value),
          _sk: UNIQUE_CONSTRAINT_KEY
        },
        ConditionExpression: 'relatedId = :relatedId AND relatedModel = :modelName',
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': this.name
        }
      }
    };
  }

  static async find(primaryId) {
    logger.debug('find primaryId', {primaryId});
    const pkSk = this.parsePrimaryId(primaryId);
    const dyKey = this.getDyKeyForPkSk(pkSk);
    logger.debug('find key', {primaryId, dyKey});
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: dyKey,
      ReturnConsumedCapacity: 'TOTAL'
    });

    if (!result.Item) return null;

    // Create instance with the raw data and add response data
    const instance = new this(result.Item);
    instance._response = {
      ConsumedCapacity: result.ConsumedCapacity
    };
    return instance;
  }

  static async findAll() {
    const startTime = Date.now();
    // Find the first global secondary index that uses prefix as PK
    const globalIndex = this.indexes.find(index => index.pk === 'prefix');
    
    if (!globalIndex) {
      throw new Error(`${this.name} must define a global secondary index with prefix as PK to use findAll`);
    }

    const result = await this.documentClient.query({
      TableName: this.table,
      IndexName: globalIndex.getIndexName(),
      KeyConditionExpression: '#pk = :prefix',
      ExpressionAttributeNames: {
        '#pk': globalIndex.getPkFieldName()
      },
      ExpressionAttributeValues: {
        ':prefix': this.createPrefixedKey(this.modelPrefix, this.modelPrefix)
      },
      ReturnConsumedCapacity: 'TOTAL'
    });
    const endTime = Date.now();

    return {
      Items: result.Items,
      _response: {
        ConsumedCapacity: result.ConsumedCapacity,
        duration: endTime - startTime
      }
    };
  }

  static formatGsiKey(modelPrefix, indexId, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${modelPrefix}#${indexId}#${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static formatPrimaryKey(modelPrefix, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${modelPrefix}#${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static formatUniqueConstraintKey(constraintId, modelPrefix, field, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${UNIQUE_CONSTRAINT_KEY}#${constraintId}#${modelPrefix}#${field}:${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static getBaseQueryParams(pkFieldName, pkValue, skCondition, options = {}) {
    const keyBuilder = new KeyConditionBuilder();
    let keyConditionExpression = `#pk = :pk`;
    const expressionNames = { '#pk': pkFieldName };
    const expressionValues = { ':pk': pkValue };
  
    if (skCondition) {
      logger.log('Building key condition for:', {
        condition: skCondition,
        gsiSortKeyName: options.gsiIndexId ? `_${options.gsiIndexId}_sk` : '_sk'
      });
      
      const skExpr = keyBuilder.buildKeyCondition(
        this, 
        options.indexName || 'primary', 
        skCondition,
        options.gsiIndexId ? `_${options.gsiIndexId}_sk` : '_sk'
      );
      if (skExpr) {
        keyConditionExpression += ` AND ${skExpr.condition}`;
        Object.assign(expressionNames, skExpr.names);
        Object.assign(expressionValues, skExpr.values);
      }
    }
  
    const params = {
      TableName: this.table,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: options.direction !== 'DESC',
      ReturnConsumedCapacity: 'TOTAL',
      Limit: options.limit || this.defaultQueryLimit
    };
  
    // Add Select:COUNT for countOnly queries
    if (options.countOnly) {
      params.Select = 'COUNT';
    }

    // Add the IndexName if gsiIndexId is provided
    if (options.gsiIndexId) {
      params.IndexName = options.gsiIndexId;
    }
  
    if (options.startKey) {
      params.ExclusiveStartKey = options.startKey;
    }
  
    // Add filter expression if provided
    if (options.filter) {
      const filterBuilder = new FilterExpressionBuilder();
      const filterExpression = filterBuilder.build(options.filter, this);
  
      if (filterExpression) {
        params.FilterExpression = filterExpression.FilterExpression;
        Object.assign(
          params.ExpressionAttributeNames,
          filterExpression.ExpressionAttributeNames
        );
        Object.assign(
          params.ExpressionAttributeValues,
          filterExpression.ExpressionAttributeValues
        );
      }
    }
  
    return params;
  }

  static async processQueryResponse(response, options = {}) {
    if (options.countOnly) {
      return {
        count: response.Count,
        _response: {
          ConsumedCapacity: response.ConsumedCapacity
        }
      };
    }

    const {
      returnModel = true,
      loadRelated = false,
      relatedFields = null
    } = options;
  
    // Create model instances
    let items = returnModel ? response.Items.map(item => new this(item)) : response.Items;

    // Initialize response for each item
    items.forEach(item => {
      if (!item._response) {
        item._response = { ConsumedCapacity: [] };
      }
    });

    // Load related data if requested
    if (returnModel && loadRelated) {
      await Promise.all(items.map(item => item.loadRelatedData(relatedFields)));
      
      // Aggregate capacity from all items including their related data
      let allCapacities = [];
      
      // Add the original query capacity
      if (response.ConsumedCapacity) {
        allCapacities.push(response.ConsumedCapacity);
      }
      
      // Add capacity from each item's related data loads
      items.forEach(item => {
        if (item._response?.ConsumedCapacity) {
          allCapacities.push(...[].concat(item._response.ConsumedCapacity));
        }
      });

      // Update response with aggregated capacities
      response.ConsumedCapacity = allCapacities;
    }

    return {
      items,
      count: items.length,
      lastEvaluatedKey: response.LastEvaluatedKey,
      _response: {
        ConsumedCapacity: response.ConsumedCapacity || []
      }
    };
  }

  static async validateUniqueConstraints(data, currentId = null) {
    logger.debug('validateUniqueConstraints called on', this.name, {
      modelTestId: this._test_id,
      managerTestId: this.manager.getTestId(),
      instanceKey: this._test_id || 'default'
    });

    if (!this.uniqueConstraints) {
      return;
    }

    const docClient = this.manager.documentClient;
    const tableName = this.manager.tableName;

    for (const [name, constraint] of Object.entries(this.uniqueConstraints)) {
      const value = data[constraint.field];
      if (!value) continue;

      try {
        const key = this.formatUniqueConstraintKey(
          constraint.constraintId,
          this.modelPrefix,
          constraint.field,
          value
        );

        logger.debug('Checking unique constraint:', {
          key,
          field: constraint.field,
          value,
          testId: this.manager.getTestId(),
          managerTestId: this.manager.getTestId()
        });

        const result = await docClient.get({
          TableName: tableName,
          Key: {
            _pk: key,
            _sk: UNIQUE_CONSTRAINT_KEY
          }
        });
        
        if (result.Item) {
          logger.debug('Found existing constraint:', result.Item);
          if (!currentId || result.Item.relatedId !== currentId) {
            throw new Error(`${constraint.field} must be unique`);
          }
        }
      } catch (innerError) {
        if (innerError.message.includes('must be unique')) {
          throw innerError;
        }
        console.error('Error checking unique constraint:', innerError);
        throw new Error(`Failed to validate ${constraint.field} uniqueness`);
      }
    }
  }

  static getDyKeyForPkSk(pkSk) {
    if (this.primaryKey.sk === 'modelPrefix') {
      return {
        _pk: this.formatPrimaryKey(this.modelPrefix, pkSk.pk),
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
        _pk: this.formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: pkSk.sk
      };
    }
  }

  static getIndexKeys(data) {
    const indexKeys = {};
    
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      let pkValue, skValue;
      
      // Handle partition key
      if (index.pk === 'modelPrefix') {
        pkValue = this.modelPrefix;
      } else {
        const pkField = this.getField(index.pk);
        pkValue = data[index.pk];
        if (pkValue !== undefined) {
          pkValue = pkField.toGsi(pkValue);
        }
      }
      
      // Handle sort key
      if (index.sk === 'modelPrefix') {
        skValue = this.modelPrefix;
      } else {
        const skField = this.getField(index.sk);
        skValue = data[index.sk];
        if (skValue !== undefined) {
          skValue = skField.toGsi(skValue);
        }
      }
      
      if (pkValue !== undefined && skValue !== undefined && index.indexId !== undefined) {
        logger.debug('indexKeys', {
          pkValue,
          skValue,
          indexId: index.indexId
        });
        const gsiPk = this.formatGsiKey(this.modelPrefix, index.indexId, pkValue);
        indexKeys[`_${index.indexId}_pk`] = gsiPk;
        indexKeys[`_${index.indexId}_sk`] = skValue;
      }
    });
    
    return indexKeys;
  }

  static async queryByPrimaryKey(pkValue, skCondition = null, options = {}) {
    const params = this.getBaseQueryParams(
      '_pk',
      this.formatPrimaryKey(this.modelPrefix, pkValue),
      skCondition,
      options
    );

    const response = await this.documentClient.query(params);
    return this.processQueryResponse(response, options);
  }

  static async queryByIndex(indexName, pkValue, skCondition = null, options = {}) {
    const index = this.indexes[indexName];
    if (!index) {
      throw new Error(`Index "${indexName}" not found in ${this.name} model`);
    }


    // Validate sort key field if condition is provided
    if (skCondition) {
      const [[fieldName]] = Object.entries(skCondition);
      if (fieldName !== index.sk) {
        throw new Error(`Field "${fieldName}" is not the sort key for index "${indexName}"`);
      }
    }
  
    // Format the partition key using the field's toGsi method
    let formattedPk;
    if (index instanceof PrimaryKeyConfig) {
      formattedPk = this.formatPrimaryKey(this.modelPrefix, pkValue);
    } else {
      const pkField = this.getField(index.pk);
      const gsiValue = pkField.toGsi(pkValue);
      formattedPk = this.formatGsiKey(this.modelPrefix, index.indexId, gsiValue);
    }
  
    // Convert sort key condition values using the field's toGsi method
    let formattedSkCondition = null;
    if (skCondition) {
      const [[fieldName, condition]] = Object.entries(skCondition);
      const field = this.getField(index.sk);  // Use the index's sort key field
      
      // Convert the values in the condition using the field's toGsi method
      if (typeof condition === 'object' && condition.$between) {
        formattedSkCondition = {
          [fieldName]: {  // Keep the original field name for validation
            $between: condition.$between.map(value => field.toGsi(value))
          }
        };
      } else if (typeof condition === 'object' && condition.$beginsWith) {
        formattedSkCondition = {
          [fieldName]: {  // Keep the original field name for validation
            $beginsWith: field.toGsi(condition.$beginsWith)
          }
        };
      } else {
        formattedSkCondition = {
          [fieldName]: field.toGsi(condition)  // Keep the original field name for validation
        };
      }

    }
  
    const params = this.getBaseQueryParams(
      index instanceof PrimaryKeyConfig ? '_pk' : `_${index.indexId}_pk`,
      formattedPk,
      skCondition ? { [index.sk]: skCondition[index.sk] } : null,
      { 
        ...options, 
        indexName,
        gsiIndexId: index.indexId,
        gsiSortKeyName: `_${index.indexId}_sk`  // Pass the GSI sort key name
      }
    );
  
    // Add debug logging
    logger.log('DynamoDB Query Params:', {
      TableName: params.TableName,
      IndexName: params.IndexName,
      KeyConditionExpression: params.KeyConditionExpression,
      ExpressionAttributeNames: params.ExpressionAttributeNames,
      ExpressionAttributeValues: params.ExpressionAttributeValues
    });

    const response = await this.documentClient.query(params);
  
    // Add debug logging
    logger.log('DynamoDB Response:', {
      Count: response.Count,
      ScannedCount: response.ScannedCount,
      Items: response.Items?.map(item => ({
        name: item.name,
        category: item.category,
        status: item.status
      }))
    });
    
    let totalItems;
    if (options.countOnly) {
      totalItems = response.Count;
    } else if (options.startKey) {
      totalItems = (options.previousCount || 0) + response.Items.length;
    } else {
      totalItems = response.Items.length;
    }
    
    return this.processQueryResponse(response, { 
      ...options, 
      totalItems 
    });
  }

  static async _saveItem(primaryId, jsUpdates, options = {}) {
    const { 
      isNew = false,
      instanceObj = null,
      constraints = {} 
    } = options;

    logger.debug('saveItem', primaryId);
    
    const currentItem = isNew ? null : instanceObj || await this.find(primaryId);
    
    if (!isNew && !currentItem) {
      throw new Error('Item not found');
    }

    // Validate unique constraints before attempting save
    await this.validateUniqueConstraints(jsUpdates, isNew ? null : primaryId);

    const transactItems = [];
    const dyUpdatesToSave = {};
    let hasUniqueConstraintChanges = false;

    logger.debug('jsUpdates', jsUpdates);
    
    // Generate Dynamo Updates to save
    for (const [key, field] of Object.entries(this.fields)) {
      if (jsUpdates[key] === undefined && isNew) {
        // Only set initial values during creation
        const initialValue = field.getInitialValue();
        if (initialValue !== undefined) {
          jsUpdates[key] = initialValue;
        }
      }

      if (jsUpdates[key] !== undefined) {
        field.validate(jsUpdates[key]);
        dyUpdatesToSave[key] = field.toDy(jsUpdates[key]);
      } else {
        if (typeof field.updateBeforeSave === 'function') {
          const newValue = field.updateBeforeSave(jsUpdates[key]);
          if (newValue !== jsUpdates[key]) {
            dyUpdatesToSave[key] = field.toDy(newValue);
          }
        }
      }
    }

    logger.debug('dyUpdatesToSave', dyUpdatesToSave);

    if (jsUpdates.length === 0) {
      return currentItem;
    }

    // Handle unique constraints
    for (const constraint of Object.values(this.uniqueConstraints || {})) {
      const fieldName = constraint.field;
      const field = this.getField(fieldName);
      const dyNewValue = dyUpdatesToSave[fieldName];
      const dyCurrentValue = currentItem?._originalData[fieldName];

      logger.debug('uniqueConstraint', field, dyCurrentValue, dyNewValue);

      if (dyNewValue !== undefined && dyNewValue !== dyCurrentValue) {
        hasUniqueConstraintChanges = true;
        
        // Remove old constraint if updating
        if (currentItem && dyCurrentValue) {
          transactItems.push(
            await this._removeUniqueConstraint(
              fieldName,
              dyCurrentValue,
              primaryId,
              constraint.constraintId
            )
          );
        }
        
        // Add new constraint
        transactItems.push(
          await this._createUniqueConstraint(
            fieldName,
            dyNewValue,
            primaryId,
            constraint.constraintId
          )
        );
      }
    }

    // Add test_id if we're in test mode
    const testId = this.manager.getTestId();
    if (testId) {
      logger.debug("savedTestId", testId, currentItem);
      if (testId !== currentItem?._originalData._gsi_test_id) {
        dyUpdatesToSave._gsi_test_id = testId;
      }
    }

    // Add GSI keys
    const indexKeys = this.getIndexKeys(dyUpdatesToSave);
    logger.debug('indexKeys', indexKeys);
    Object.assign(dyUpdatesToSave, indexKeys);

    // Build the condition expression for the update/put
    const conditionExpressions = [];
    const conditionNames = {};
    const conditionValues = {};

    // Handle existence constraints
    if (constraints.mustExist) {
      conditionExpressions.push('attribute_exists(#pk)');
      conditionNames['#pk'] = '_pk';
    }
    if (constraints.mustNotExist) {
      conditionExpressions.push('attribute_not_exists(#pk)');
      conditionNames['#pk'] = '_pk';
    }

    logger.debug('field matchconstraints', constraints);

    // Handle field match constraints
    if (constraints.fieldMatches) {
      if (instanceObj === null) {
        throw new Error('Instance object is required to check field matches');
      }

      const matchFields = Array.isArray(constraints.fieldMatches) 
        ? constraints.fieldMatches 
        : [constraints.fieldMatches];

      matchFields.forEach((fieldName, index) => {
        if (!this.getField(fieldName)) {
          throw new Error(`Unknown field in fieldMatches constraint: ${fieldName}`);
        }

        const nameKey = `#match${index}`;
        const valueKey = `:match${index}`;
        
        conditionExpressions.push(`${nameKey} = ${valueKey}`);
        conditionNames[nameKey] = fieldName;
        conditionValues[valueKey] = currentItem ? 
          currentItem._originalData[fieldName] : 
          undefined;
      });
    }

    // When building update expression, pass both old and new data
    const { updateExpression, names, values } = this._buildUpdateExpression(dyUpdatesToSave);

    const dyKey = this.getDyKeyForPkSk(this.parsePrimaryId(primaryId));
    logger.debug('dyKey', dyKey);
    // Create the update params
    const updateParams = {
      TableName: this.table,
      Key: dyKey,
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: {
        ...names,
        ...conditionNames
      },
      ReturnValues: 'ALL_NEW'
    };

    if (Object.keys(values).length > 0) {
      updateParams.ExpressionAttributeValues = {...values, ...conditionValues};
    }

    // Add condition expression if we have any conditions
    if (conditionExpressions.length > 0) {
      updateParams.ConditionExpression = conditionExpressions.join(' AND ');
    } else if (isNew) {
      // Default condition for new items if no other conditions specified
      updateParams.ConditionExpression = 'attribute_not_exists(#pk)';
      updateParams.ExpressionAttributeNames['#pk'] = '_pk';
    }

    try {
      let response;
      
      if (hasUniqueConstraintChanges) {
        // Use transaction if we have unique constraint changes
        transactItems.push({
          Update: updateParams
        });

        logger.debug('transactItems', JSON.stringify(transactItems, null, 2));

        response = await this.documentClient.transactWrite({
          TransactItems: transactItems,
          ReturnConsumedCapacity: 'TOTAL'
        });
        
        // Fetch the item since transactWrite doesn't return values
        const savedItem = await this.find(primaryId);
        savedItem._response = {
          ConsumedCapacity: response.ConsumedCapacity,
        };

        return savedItem;
      } else {
        // Use simple update if no unique constraints are changing
        logger.debug('updateParams', JSON.stringify(updateParams, null, 2));

        response = await this.documentClient.update({
          ...updateParams,
          ReturnConsumedCapacity: 'TOTAL'
        });

        const savedItem = new this(response.Attributes);
        savedItem._response = {
          ConsumedCapacity: response.ConsumedCapacity,
        };

        return savedItem;
      }
    } catch (error) {
      // console.error('Save error:', error);
      if (error.name === 'ConditionalCheckFailedException') {
        if (constraints.mustExist) {
          throw new Error('Item must exist');
        }
        if (constraints.mustNotExist) {
          throw new Error('Item must not exist');
        }
        if (constraints.fieldMatches) {
          throw new Error('Field values have been modified');
        }
        throw new Error('Condition check failed', error);
      }

      if (error.name === 'TransactionCanceledException') {
        await this.validateUniqueConstraints(jsUpdates, isNew ? null : primaryId);
      }
      throw error;
    }
  }

  static async create(data) {
    // First process the data through _saveItem to handle auto-assigned fields
    const processedData = {};
    
    // Handle fields and their initial values
    for (const [key, field] of Object.entries(this.fields)) {
      if (data[key] !== undefined) {
        processedData[key] = data[key];
      } else {
        const initialValue = field.getInitialValue();
        if (initialValue !== undefined) {
          processedData[key] = initialValue;
        }
      }
    }

    Object.entries(this.fields).forEach(([fieldName, field]) => {
      field.validate(processedData[fieldName], fieldName);
    });

    // Now calculate primary key values using the processed data
    const pkValue = this.getPkValue(processedData);
    const skValue = this.getSkValue(processedData);
    
    // Format the primary key
    const pk = this.formatPrimaryKey(this.modelPrefix, pkValue);
    const primaryId = this.getPrimaryId({
      ...processedData,
      _pk: pk,
      _sk: skValue
    });

    const result = await this._saveItem(primaryId, processedData, { isNew: true });
    
    // Ensure response is initialized
    if (!result._response) {
      result._response = { ConsumedCapacity: [] };
    } else if (!Array.isArray(result._response.ConsumedCapacity)) {
      result._response.ConsumedCapacity = [result._response.ConsumedCapacity];
    }
    
    return result;
  }

  static async update(primaryId, data, options = {}) {
    Object.entries(data).forEach(([fieldName, value]) => {
      const field = this.getField(fieldName);
      if (field) {
        field.validate(value, fieldName);
      }
    });
    
    return this._saveItem(primaryId, data, { 
      ...options,
      isNew: false
     });
  }

  static _buildUpdateExpression(dyUpdatesToSave) {
    const names = {};
    const values = {};
    const expressions = [];

    logger.debug('dyUpdatesToSave', dyUpdatesToSave);

    // Process all fields in the data
    for (const [fieldName, value] of Object.entries(dyUpdatesToSave)) {
        // Skip undefined values
        if (value === undefined) continue;

        const field = this.getField(fieldName);
        
        // Handle null values differently - use REMOVE instead of SET
        if (value === null) {
            expressions.push({
                type: 'REMOVE',
                expression: `#${fieldName}`,
                attrNameKey: `#${fieldName}`,
                fieldName: fieldName,
                fieldValue: null
            });
        } else {
            expressions.push(field.getUpdateExpression(fieldName, value));
        }
    }

    const parts = [];
    const setExpressions = [];
    const addExpressions = [];
    const removeExpressions = [];

    expressions.forEach(expression => {
        if (expression.type === 'SET') {
            setExpressions.push(expression.expression);
        } else if (expression.type === 'ADD') {
            addExpressions.push(expression.expression);
        } else if (expression.type === 'REMOVE') {
            removeExpressions.push(expression.expression);
        }

        names[expression.attrNameKey] = expression.fieldName;

        if (expression.fieldValue !== null) {
            values[expression.attrValueKey] = expression.fieldValue;
        }
    });

    if (setExpressions.length > 0) parts.push(`SET ${setExpressions.join(', ')}`);
    if (addExpressions.length > 0) parts.push(`ADD ${addExpressions.join(', ')}`);
    if (removeExpressions.length > 0) parts.push(`REMOVE ${removeExpressions.join(', ')}`);

    const response = {
      updateExpression: parts.join(' '),
      names,
      values
    };

    logger.debug('response', response);

    return response;
  }

  static async delete(primaryId) {
    const item = await this.find(primaryId);
    if (!item) {
      throw new Error('Item not found');
    }

    const transactItems = [
      {
        Delete: {
          TableName: this.table,
          Key: {
            _pk: item._data._pk,
            _sk: item._data._sk
          }
        }
      }
    ];

    // Add unique constraint cleanup
    const uniqueConstraints = Object.values(this.uniqueConstraints || {});
    if (uniqueConstraints.length > 0) {
      for (const constraint of uniqueConstraints) {
        const value = item[constraint.field];
        if (value) {
          const constraintOp = await this._removeUniqueConstraint(
            constraint.field,
            value,
            item.getPrimaryId(),
            constraint.constraintId
          );
          transactItems.push(constraintOp);
        }
      }
    }

    const response = await this.documentClient.transactWrite({
      TransactItems: transactItems,
      ReturnConsumedCapacity: 'TOTAL'
    });

    // Return deleted item info with capacity information
    item._response = response;
    return item;
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

      // Add getter method for RelatedFields
      if (field instanceof RelatedFieldClass) {
        const baseName = fieldName.endsWith('Id') 
          ? fieldName.slice(0, -2) 
          : fieldName;
        
        const capitalizedName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        const getterName = `get${capitalizedName}`;
        
        if (!this[getterName]) {
          this[getterName] = async function() {
            if (this._relatedObjects[fieldName]) {
              return this._relatedObjects[fieldName];
            }
            
            const Model = this.constructor.manager.getModel(field.modelName);
            this._relatedObjects[fieldName] = await Model.find(this[fieldName]);
            return this._relatedObjects[fieldName];
          };
        }
      }
    });

    // Store original data for change tracking
    this._originalData = { ...this._data };
  }

  clearRelatedCache(fieldName) {
    delete this._relatedObjects[fieldName];
  }

  // Returns the pk and sk values for a given object. These are encoded to work with
  // dynamo string keys. No test prefix or model prefix is applied.
  static getPrimaryKeyValues(data) {
    if (!data) {
      throw new Error('Data object is required for getPrimaryKeyValues call');
    }

    const pkField = this.getField(this.primaryKey.pk);
    const skField = this.getField(this.primaryKey.sk);

    if (skField === undefined && this.primaryKey.sk !== 'modelPrefix') {
      throw new Error(`SK field is required for getPkSk call`);
    }

    if (pkField === undefined && this.primaryKey.pk !== 'modelPrefix') {
      throw new Error(`PK field is required for getPkSk call`);
    }

    // If the field is set, use the GSI value, otherwise use the raw value
    const pkValue = pkField ? pkField.toGsi(this.getPkValue(data)) : this.getPkValue(data);
    const skValue = skField ? skField.toGsi(this.getSkValue(data)) : this.getSkValue(data);

    if (pkValue === undefined || skValue === undefined || pkValue === null || skValue === null) {
      throw new Error(`PK and SK must be defined to get a PkSk`);
    }

    let key = {
      pk: pkValue,
      sk: skValue
    }

    logger.debug("getPrimaryKeyValues", key);

    return key;
  }

  static getPrimaryId(data) {
    logger.debug("getPrimaryId", data);
    const pkSk = this.getPrimaryKeyValues(data);
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
        const fieldDef = this.constructor.getField(field);
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

  // Helper to convert to plain object
  toJSON() {
    const obj = {};
    for (const [fieldName] of Object.entries(this.constructor.fields)) {
      obj[fieldName] = this[fieldName];
    }
    return obj;
  }

  async loadRelatedData(fieldNames = null) {
    // Initialize response if not exists
    if (!this._response) {
      this._response = { ConsumedCapacity: [] };
    } else if (!Array.isArray(this._response.ConsumedCapacity)) {
      this._response.ConsumedCapacity = [this._response.ConsumedCapacity];
    }

    const promises = [];
    
    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      if (fieldNames && !fieldNames.includes(fieldName)) {
        continue;
      }
      
      if (field instanceof RelatedFieldClass && this[fieldName]) {
        promises.push(
          this._loadRelatedField(fieldName, field)
            .then(instance => {
              this._relatedObjects[fieldName] = instance;
            })
        );
      }
    }

    await Promise.all(promises);
    return this;
  }

  async _loadRelatedField(fieldName, field) {
    const value = this[fieldName];
    if (!value) return null;
    
    const ModelClass = this.constructor.manager.getModel(field.modelName);
    
    if (value instanceof ModelClass) {
      return value;
    }
    
    // Load the instance and track its capacity
    const relatedInstance = await ModelClass.find(value);
    
    // Initialize response tracking if needed
    if (!this._response) {
      this._response = { ConsumedCapacity: [] };
    }
    
    // Convert existing capacity to array if it's a single object
    if (this._response.ConsumedCapacity && !Array.isArray(this._response.ConsumedCapacity)) {
      this._response.ConsumedCapacity = [this._response.ConsumedCapacity];
    }

    // Add capacity for this operation, whether it succeeded or failed
    const capacityEntry = {
      TableName: this.constructor.table,
      CapacityUnits: 1.0  // Standard read capacity for a get operation
    };

    // If we have a successful related instance lookup, use its capacity instead
    if (relatedInstance?._response?.ConsumedCapacity) {
      if (Array.isArray(relatedInstance._response.ConsumedCapacity)) {
        this._response.ConsumedCapacity.push(...relatedInstance._response.ConsumedCapacity);
      } else {
        this._response.ConsumedCapacity.push(relatedInstance._response.ConsumedCapacity);
      }
    } else {
      this._response.ConsumedCapacity.push(capacityEntry);
    }
    
    return relatedInstance;
  }

  getRelated(fieldName) {
    const field = this.constructor.fields[fieldName];
    if (!(field instanceof RelatedFieldClass)) {
      throw new Error(`Field ${fieldName} is not a RelatedField`);
    }
    return this._relatedObjects[fieldName];
  }

  static fromDynamoDB(item) {
    if (!item) return null;

    const data = {};
    for (const [fieldName, field] of Object.entries(this.fields)) {
      if (item[fieldName] !== undefined) {
        data[fieldName] = field.fromDy(item[fieldName]);
      }
    }
    return new this(data);
  }
}
module.exports = {
  BaseModel,
  PrimaryKeyConfig: (pk, sk) => new PrimaryKeyConfig(pk, sk),
  IndexConfig: (pk, sk, indexId) => new IndexConfig(pk, sk, indexId),
  UniqueConstraintConfig: (field, constraintId) => new UniqueConstraintConfig(field, constraintId),
  // Constants
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2,
  UNIQUE_CONSTRAINT_ID3,
};


