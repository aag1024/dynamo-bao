// src/model.js
const { ulid } = require('ulid');
const { StringField, DateTimeField, RelatedFieldClass, RelatedField } = require('./fields');
const { ModelRegistry } = require('./model-registry');

// Constants for GSI indexes
const GSI_INDEX_ID1 = 'gsi1';
const GSI_INDEX_ID2 = 'gsi2';
const GSI_INDEX_ID3 = 'gsi3';

// Constants for unique constraints
const UNIQUE_CONSTRAINT_ID1 = '_uc1';
const UNIQUE_CONSTRAINT_ID2 = '_uc2';
const UNIQUE_CONSTRAINT_ID3 = '_uc3';

const GID_SEPARATOR = "##__SK__##";

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
  static table = null;
  static documentClient = null;
  
  // These should be overridden by child classes
  static modelPrefix = null;
  static fields = {};
  static primaryKey = null;
  static indexes = {};
  static uniqueConstraints = {};

  static validateConfiguration() {
    if (!this.modelPrefix) {
      throw new Error(`${this.name} must define a modelPrefix`);
    }

    if (!this.primaryKey) {
      throw new Error(`${this.name} must define a primaryKey`);
    }

    const validIndexIds = [GSI_INDEX_ID1, GSI_INDEX_ID2, GSI_INDEX_ID3, undefined]; // undefined for PK-based indexes
    
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      // Check if this index matches the primary key configuration
      const isPrimaryKeyIndex = (
        index instanceof PrimaryKeyConfig &&
        index.pk === this.primaryKey.pk &&
        index.sk === this.primaryKey.sk
      );

      // Allow undefined indexId only for primary key based indexes
      if (!validIndexIds.includes(index.indexId) && !isPrimaryKeyIndex) {
        throw new Error(`Invalid index ID ${index.indexId} in ${this.name}`);
      }

      // Validate fields exist, accounting for modelPrefix
      if (index.pk !== 'modelPrefix' && !this.fields[index.pk]) {
        throw new Error(`Index ${indexName} references non-existent field ${index.pk}`);
      }
      if (index.sk !== 'modelPrefix' && !this.fields[index.sk]) {
        throw new Error(`Index ${indexName} references non-existent field ${index.sk}`);
      }
    });

    // Validate primary key fields exist
    if (this.primaryKey.pk !== 'modelPrefix' && !this.fields[this.primaryKey.pk]) {
      throw new Error(`Primary key field '${this.primaryKey.pk}' not found in ${this.name} fields`);
    }
    if (this.primaryKey.sk !== 'modelPrefix' && !this.fields[this.primaryKey.sk]) {
      throw new Error(`Sort key field '${this.primaryKey.sk}' not found in ${this.name} fields`);
    }

    // Validate unique constraints
    const validConstraintIds = [UNIQUE_CONSTRAINT_ID1, UNIQUE_CONSTRAINT_ID2, UNIQUE_CONSTRAINT_ID3];
    Object.values(this.uniqueConstraints || {}).forEach(constraint => {
      if (!validConstraintIds.includes(constraint.constraintId)) {
        throw new Error(`Invalid constraint ID ${constraint.constraintId} in ${this.name}`);
      }
      
      if (!this.fields[constraint.field]) {
        throw new Error(
          `Unique constraint field '${constraint.field}' not found in ${this.name} fields`
        );
      }
    });
  }

  static registerRelatedIndexes() {
    // Find all indexes where the partition key is a RelatedField
    const relatedIndexes = Object.entries(this.indexes).filter(([_, index]) => {
      const pkField = this.fields[index.pk];
      return pkField instanceof RelatedFieldClass;
    });

    relatedIndexes.forEach(([indexName, index]) => {
      const sourceField = this.fields[index.pk];
      const SourceModel = ModelRegistry.getInstance().get(sourceField.modelName);
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
        limit = null,
        startKey = null,
        direction = 'DESC',
        options = {}
      ) {
        // Convert the startKey back to the correct format if it exists
        const queryOptions = {
          ...options,
          limit,
          direction,
          startKey: startKey ? JSON.parse(JSON.stringify(startKey)) : null
        };

        const results = await CurrentModel.queryByIndex(
          indexName,
          this.getPkValue(),
          queryOptions
        );

        return results;
      };
    });
  }

  static getPkValue(data) {
    if (!data) {
      throw new Error('Data object is required for static getPkValue call');
    }

    if (this.primaryKey.pk === 'modelPrefix') {
      return this.modelPrefix;
    }

    return data[this.primaryKey.pk];
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
    return this.constructor.getPkValue(this.data);
  }

  getSkValue() {
    return this.constructor.getSkValue(this.data);
  }

  static getIndexKeys(data) {
    const indexKeys = {};
    
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      let pkValue, skValue;
      
      // Handle partition key
      if (index.pk === 'modelPrefix') {
        pkValue = this.modelPrefix;
      } else {
        const pkField = this.fields[index.pk];
        pkValue = pkField.toGsi(data[index.pk]);
      }
      
      // Handle sort key
      if (index.sk === 'modelPrefix') {
        skValue = this.modelPrefix;
      } else {
        const skField = this.fields[index.sk];
        skValue = skField.toGsi(data[index.sk]);
      }
      
      if (pkValue !== undefined && skValue !== undefined) {
        // Format the GSI keys
        const gsiPk = `${this.modelPrefix}#${index.indexId}#${pkValue}`;
        const gsiSk = skValue;
        
        indexKeys[`_${index.indexId}_pk`] = gsiPk;
        indexKeys[`_${index.indexId}_sk`] = gsiSk;
      }
    });
    
    return indexKeys;
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
      .flatMap(r => Array.isArray(r.ConsumedCapacity) ? r.ConsumedCapacity : [r.ConsumedCapacity]);
    return allCapacity.length ? allCapacity : null;
  }

  static async _createUniqueConstraint(field, value, relatedId, constraintId = UNIQUE_CONSTRAINT_ID1) {
    return {
      Put: {
        TableName: this.table,
        Item: {
          _pk: `_raft_uc#${constraintId}#${this.modelPrefix}#${field}:${value}`,
          _sk: '_raft_uc',
          uniqueValue: `${this.modelPrefix}:${field}:${value}`,
          relatedId: relatedId,
          relatedModel: this.name
        },
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
          _pk: `_raft_uc#${constraintId}#${this.modelPrefix}#${field}:${value}`,
          _sk: '_raft_uc'
        },
        ConditionExpression: 'relatedId = :relatedId AND relatedModel = :modelName',
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': this.name
        }
      }
    };
  }

  static async find(gid) {
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: this.getKeyForGlobalId(gid),
      ReturnConsumedCapacity: 'TOTAL'
    });

    if (!result.Item) return null;

    // Create instance with the raw data
    return new this(result.Item);
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
    return `${modelPrefix}#${indexId}#${value}`;
  }

  static formatPrimaryKey(modelPrefix, value) {
    return `${modelPrefix}#${value}`;
  }

  static formatUniqueConstraintKey(constraintId, modelPrefix, field, value) {
    return `_raft_uc#${constraintId}#${modelPrefix}#${field}:${value}`;
  }

  static getBaseQueryParams(pkFieldName, pkValue, options = {}) {
    const {
      limit,
      startKey,
      direction = 'DESC',
      indexName
    } = options;

    const params = {
      TableName: this.table,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: {
        '#pk': pkFieldName
      },
      ExpressionAttributeValues: {
        ':pk': pkValue
      },
      ScanIndexForward: direction === 'ASC',
      IndexName: indexName,
      ReturnConsumedCapacity: 'TOTAL'
    };

    if (limit) {
      params.Limit = limit;
    }

    if (startKey) {
      params.ExclusiveStartKey = startKey;
    }

    return params;
  }

  static async processQueryResponse(response, options = {}) {
    const {
      returnModel = true,
      loadRelated = false,
      relatedFields = null
    } = options;
  
    // Create model instances
    let items = returnModel ? response.Items.map(item => new this(item)) : response.Items;

    // Load related data if requested
    if (returnModel && loadRelated) {
      await Promise.all(items.map(item => item.loadRelatedData(relatedFields)));
    }

    return {
      items,
      count: items.length,
      lastEvaluatedKey: response.LastEvaluatedKey,
      _response: {
        ConsumedCapacity: response.ConsumedCapacity
      }
    };
  }

  static async validateUniqueConstraints(error, data, currentId = null) {
    if (error.name === 'TransactionCanceledException') {
      for (const constraint of Object.values(this.uniqueConstraints)) {
        if (data[constraint.field]) {
          try {
            const result = await this.documentClient.get({
              TableName: this.table,
              Key: {
                _pk: this.formatUniqueConstraintKey(
                  constraint.constraintId,
                  this.modelPrefix,
                  constraint.field,
                  data[constraint.field]
                ),
                _sk: '_raft_uc'
              }
            });
            
            if (result.Item && (!currentId || result.Item.relatedId !== currentId)) {
              throw new Error(`${constraint.field} must be unique`);
            }
          } catch (innerError) {
            if (innerError.message.includes('must be unique')) {
              throw innerError;
            }
          }
        }
      }
    }
    throw error;
  }

  static isModelPrefixGid(gid) {
    return gid.indexOf(GID_SEPARATOR) === -1;
  }

  static getKeyForGlobalId(gid) {
    if (this.isModelPrefixGid(gid)) {
      if (this.primaryKey.sk === 'modelPrefix') {
        return {
          _pk: this.formatPrimaryKey(this.modelPrefix, gid),
          _sk: this.modelPrefix
        };
      }
      else if (this.primaryKey.pk === 'modelPrefix') {
        return {
          _pk: this.modelPrefix,
          _sk: gid
        };
      } else {
        throw new Error(`Primary key must be modelPrefix to use a modelPrefix GID: ${gid}`);
      }
    } else {
      const id = this.parseGlobalId(gid);
      return {
        _pk: this.formatPrimaryKey(this.modelPrefix, id.pk),
        _sk: id.sk
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
        const pkField = this.fields[index.pk];
        pkValue = pkField.toGsi(data[index.pk]);
      }
      
      // Handle sort key
      if (index.sk === 'modelPrefix') {
        skValue = this.modelPrefix;
      } else {
        const skField = this.fields[index.sk];
        skValue = skField.toGsi(data[index.sk]);
      }
      
      if (pkValue !== undefined && skValue !== undefined) {
        const gsiPk = this.formatGsiKey(this.modelPrefix, index.indexId, pkValue);
        indexKeys[`_${index.indexId}_pk`] = gsiPk;
        indexKeys[`_${index.indexId}_sk`] = skValue;
      }
    });
    
    return indexKeys;
  }

  static async queryByPrimaryKey(pkValue, options = {}) {
    const params = this.getBaseQueryParams(
      '_pk',
      this.formatPrimaryKey(this.modelPrefix, pkValue),
      options
    );

    const response = await this.documentClient.query(params);
    return this.processQueryResponse(response, options);
  }

  static async queryByIndex(indexName, pkValue, options = {}) {
    const index = this.indexes[indexName];
    if (!index) {
      throw new Error(`Index "${indexName}" not found in ${this.name} model`);
    }

    // Format the partition key
    let formattedPk;
    if (index instanceof PrimaryKeyConfig) {
      formattedPk = this.formatPrimaryKey(this.modelPrefix, pkValue);
    } else {
      formattedPk = this.formatGsiKey(this.modelPrefix, index.indexId || '', pkValue);
    }

    const params = this.getBaseQueryParams(
      index instanceof PrimaryKeyConfig ? '_pk' : `_${index.indexId ? index.indexId + '_' : ''}pk`,
      formattedPk,
      { ...options, indexName: index instanceof PrimaryKeyConfig ? undefined : (index.indexId || undefined) }
    );

    // Add range key conditions if provided
    if (options.rangeKey && options.rangeValue !== undefined) {
      const skName = index instanceof PrimaryKeyConfig ? '_sk' : `_${index.indexId ? index.indexId + '_' : ''}sk`;
      params.ExpressionAttributeNames['#sk'] = skName;

      const formatRangeValue = (value) => {
        if (index.sk === 'modelPrefix' ? null : this.fields[index.sk] && this.fields[index.sk].toGsi) {
          return this.fields[index.sk].toGsi(value);
        }
        return value.toString();
      };

      if (options.rangeCondition === 'BETWEEN' && options.endRangeValue !== undefined) {
        params.KeyConditionExpression += ' AND #sk BETWEEN :rv AND :erv';
        params.ExpressionAttributeValues[':rv'] = formatRangeValue(options.rangeValue);
        params.ExpressionAttributeValues[':erv'] = formatRangeValue(options.endRangeValue);
      } else {
        params.KeyConditionExpression += ` AND #sk ${options.rangeCondition} :rv`;
        params.ExpressionAttributeValues[':rv'] = formatRangeValue(options.rangeValue);
      }
    }

    const response = await this.documentClient.query(params);
  
    // If this is a paginated query, track how many items we've seen
    const totalItems = options.startKey ? 
      (options.previousCount || 0) + response.Items.length :
      response.Items.length;
  
    return this.processQueryResponse(response, { 
      ...options, 
      totalItems 
    });
  }

  static async create(data) {
    const itemToCreate = {};
    
    // First pass: Handle initial values for undefined fields
    for (const [key, field] of Object.entries(this.fields)) {
      if (data[key] === undefined) {
        const initialValue = field.getInitialValue();
        if (initialValue !== undefined) {
          data[key] = initialValue;
        }
      }
    }

    // Second pass: Validate and convert to DynamoDB format
    for (const [key, field] of Object.entries(this.fields)) {
      if (data[key] !== undefined) {
        field.validate(data[key]);
        itemToCreate[key] = field.toDy(data[key]);
      }
    }

    const transactItems = [];

    // Add unique constraint operations
    for (const constraint of Object.values(this.uniqueConstraints)) {
      if (itemToCreate[constraint.field]) {
        const constraintOp = await this._createUniqueConstraint(
          constraint.field,
          itemToCreate[constraint.field],
          this.getGlobalId(itemToCreate),
          constraint.constraintId
        );
        transactItems.push(constraintOp);
      }
    }

    // Add the main item creation
    const mainItem = {
      _pk: `${this.modelPrefix}#${this.getPkValue(itemToCreate)}`,
      _sk: this.getSkValue(itemToCreate),
      // Add GSI keys from index configuration
      ...this.getIndexKeys(itemToCreate),
      // Add the rest of the item data
      ...itemToCreate
    };

    transactItems.push({
      Put: {
        TableName: this.table,
        Item: mainItem,
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: {
          '#pk': '_pk'
        }
      }
    });

    try {
      const response = await this.documentClient.transactWrite({
        TransactItems: transactItems,
        ReturnConsumedCapacity: 'TOTAL'
      });
      
      // Create a new instance with the created data and response
      const instance = new this(mainItem);
      instance._response = {
        ConsumedCapacity: response.ConsumedCapacity,
      };
      return instance;
      
    } catch (error) {
      await this.validateUniqueConstraints(error, data);
    }
  }

  static async update(id, data) {
    const currentItem = await this.find(id);
    if (!currentItem) {
      throw new Error('Item not found');
    }

    const transactItems = [];

    // Handle unique constraint updates
    for (const constraint of Object.values(this.uniqueConstraints)) {
      const field = constraint.field;
      if (data[field] !== undefined && data[field] !== currentItem[field]) {
        // Remove old constraint
        if (currentItem[field]) {
          transactItems.push(
            await this._removeUniqueConstraint(
              field,
              currentItem[field],
              id,
              constraint.constraintId
            )
          );
        }
        
        // Add new constraint
        transactItems.push(
          await this._createUniqueConstraint(
            field,
            data[field],
            id,
            constraint.constraintId
          )
        );
      }
    }

    // Initialize context for collecting expressions
    const context = {
      expressionAttributeNames: {},
      expressionAttributeValues: {}
    };
    
    const setParts = [];
    const addParts = [];
    
    // Handle regular fields
    for (const [fieldName, value] of Object.entries(data)) {
      const field = this.fields[fieldName];
      if (!field) continue;

      const updateExpr = field.getUpdateExpression(fieldName, value, context);
      
      if (updateExpr && updateExpr.expression) {
        if (updateExpr.type === 'ADD') {
          addParts.push(updateExpr.expression);
        } else if (updateExpr.type === 'SET') {
          setParts.push(updateExpr.expression);
        }
      }
    }
    
    // Build update expression parts
    const updateParts = [];
    if (setParts.length > 0) {
      updateParts.push(`SET ${setParts.join(', ')}`);
    }
    if (addParts.length > 0) {
      updateParts.push(`ADD ${addParts.join(', ')}`);
    }

    const updateExpression = updateParts.join(' ');

    // Clean up unused attribute names and values
    const usedNames = new Set();
    const usedValues = new Set();
    
    // Extract used names and values from all parts of the update expression
    updateExpression.split(/[\s,()]+/).forEach(part => {
      if (part.startsWith('#')) {
        usedNames.add(part);
      }
      if (part.startsWith(':')) {
        usedValues.add(part);
      }
    });

    // Filter out unused names and values
    const filteredNames = {};
    const filteredValues = {};
    
    for (const [key, value] of Object.entries(context.expressionAttributeNames)) {
      if (usedNames.has(key)) {
        filteredNames[key] = value;
      }
    }
    
    for (const [key, value] of Object.entries(context.expressionAttributeValues)) {
      // Include all values that start with the same prefix
      const prefix = key.split('_')[0]; // In case we have suffixed values
      if (usedValues.has(prefix)) {
        filteredValues[key] = value;
      }
    }

    // Use the filtered attributes in the update
    if (transactItems.length > 0) {
      transactItems.push({
        Update: {
          TableName: this.table,
          Key: this.getKeyForGlobalId(id),
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: Object.keys(filteredNames).length > 0 ? filteredNames : undefined,
          ExpressionAttributeValues: Object.keys(filteredValues).length > 0 ? filteredValues : undefined
        }
      });

      try {
        const response = await this.documentClient.transactWrite({
          TransactItems: transactItems,
          ReturnConsumedCapacity: 'TOTAL'
        });
        
        // Fetch the updated item since transactWrite doesn't return values
        const updatedItem = await this.find(id);
        updatedItem._response = {
          ConsumedCapacity: response.ConsumedCapacity,
        };
        return updatedItem;
        
      } catch (error) {
        await this.validateUniqueConstraints(error, data, id);
      }
    } else {
      const response = await this.documentClient.update({
        TableName: this.table,
        Key: this.getKeyForGlobalId(id),
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: Object.keys(filteredNames).length > 0 ? filteredNames : undefined,
        ExpressionAttributeValues: Object.keys(filteredValues).length > 0 ? filteredValues : undefined,
        ReturnValues: 'ALL_NEW'
      });

      return this.fromDynamoDB(response.Attributes);
    }
  }

  static async delete(id) {
    const item = await this.find(id);
    if (!item) {
      throw new Error('Item not found');
    }

    const transactItems = [
      {
        Delete: {
          TableName: this.table,
          Key: {
            _pk: item.data._pk,
            _sk: item.data._sk
          }
        }
      }
    ];

    // Add unique constraint cleanup
    const uniqueConstraints = Object.values(this.uniqueConstraints || {});
    if (uniqueConstraints.length > 0) {
      uniqueConstraints.forEach(constraint => {
        const value = item[constraint.field];
        if (value) {
          transactItems.push({
            Delete: {
              TableName: this.table,
              Key: {
                _pk: `_raft_uc#${constraint.constraintId}#${this.modelPrefix}#${constraint.field}:${value}`,
                _sk: '_raft_uc'
              }
            }
          });
        }
      });
    }

    const response = await this.documentClient.transactWrite({
      TransactItems: transactItems,
      ReturnConsumedCapacity: 'TOTAL'
    });

    // Return deleted item info with capacity information
    return {
      userId: id,
      _pk: item.data._pk,
      _sk: item.data._sk,
      _response: {
        ConsumedCapacity: response.ConsumedCapacity
      }
    };
  }

  constructor(data = {}) {
    // Initialize data object with all DynamoDB attributes
    this.data = {};
    
    // Copy all DynamoDB system attributes
    const systemKeys = [
      '_pk', '_sk',
      '_gsi1_pk', '_gsi1_sk',
      '_gsi2_pk', '_gsi2_sk',
      '_gsi3_pk', '_gsi3_sk'
    ];
    
    systemKeys.forEach(key => {
      if (data[key] !== undefined) {
        this.data[key] = data[key];
      }
    });

    this._originalData = {};
    this._changes = new Set();
    this._relatedObjects = {};

    // Initialize fields with data
    Object.entries(this.constructor.fields).forEach(([fieldName, field]) => {
      let value;
      if (data[fieldName] !== undefined) {
        value = field.fromDy(data[fieldName]);
      } else {
        value = field.getInitialValue();
      }
      
      // Store both raw and converted values
      this.data[fieldName] = data[fieldName];  // Raw DynamoDB value
      
      // Define property getter/setter for converted value
      Object.defineProperty(this, fieldName, {
        get: () => value,
        set: (newValue) => {
          if (newValue !== value) {
            value = newValue;
            this.data[fieldName] = field.toDy(newValue);  // Update raw value
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
            
            const Model = ModelRegistry.getInstance().get(field.modelName);
            this._relatedObjects[fieldName] = await Model.find(this[fieldName]);
            return this._relatedObjects[fieldName];
          };
        }
      }
    });

    // Store original data for change tracking
    this._originalData = { ...this.data };
  }

  clearRelatedCache(fieldName) {
    delete this._relatedObjects[fieldName];
  }

  getGlobalId() {
    return this.constructor.getGlobalId(this.data);
  }

  static parseGlobalId(gid) {
    if (!gid) {
      throw new Error('Global ID is required to parse');
    }

    if (gid.indexOf(GID_SEPARATOR) === -1) {
      return gid;
    }

    const [pk, sk] = gid.split(GID_SEPARATOR);
    return { pk, sk };
  }

  static getGlobalId(data) {
    if (!data) {
      throw new Error('Data object is required for getGlobalId call');
    }

    if (this.primaryKey.sk === 'modelPrefix') {
      const pkField = this.fields[this.primaryKey.pk];
      return pkField.toGsi(this.getPkValue(data));
    } else if (this.primaryKey.pk === 'modelPrefix') {
      const skField = this.fields[this.primaryKey.sk];
      return skField.toGsi(this.getSkValue(data));
    } else {
      const pkField = this.fields[this.primaryKey.pk];
      const skField = this.fields[this.primaryKey.sk];
  
      const pkValue = pkField.toGsi(this.getPkValue(data));
      const skValue = skField.toGsi(this.getSkValue(data));
  
      if (pkValue !== undefined && skValue !== undefined && 
        pkValue !== null && skValue !== null) {
        return pkValue + GID_SEPARATOR + skValue;
      }
    }
    
    throw new Error(`PK and SK must be defined to get a GID`);
  }

  // Get only changed fields
  getChanges() {
    const changes = {};
    for (const field of this._changes) {
      changes[field] = this.data[field];
    }
    return changes;
  }

  // Check if there are any changes
  hasChanges() {
    return this._changes.size > 0;
  }

  // Reset tracking after successful save
  _resetChangeTracking() {
    this._originalData = { ...this.data };
    this._changes.clear();
  }

  // Instance method to save only changes
  async save() {
    if (!this.hasChanges()) {
      return this; // No changes to save
    }

    const changes = this.getChanges();
    await this.constructor.update(this.getGlobalId(), changes);
    
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
    const promises = [];
    
    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      // Skip if fieldNames is provided and this field isn't in the list
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
    
    // Get the related model class from the registry
    const ModelClass = ModelRegistry.getInstance().get(field.modelName);
    
    // If we already have a model instance, return it
    if (value instanceof ModelClass) {
      return value;
    }
    
    // Otherwise, load the instance from the database
    return await ModelClass.find(value);
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

