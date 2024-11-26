// src/model.js
const { RelatedFieldClass, StringField } = require('./fields');
const { ModelManager } = require('./model-manager');

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

  static setTestId(test_id) {
    this._test_id = test_id;
    const manager = ModelManager.getInstance(test_id);
    this.documentClient = manager.documentClient;
    this.table = manager.tableName;
  }

  static get manager() {
    return ModelManager.getInstance(this._test_id);
  }

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

    const pkValue = this.primaryKey.pk === 'modelPrefix' ? 
      this.modelPrefix : 
      data[this.primaryKey.pk];

    console.log('getPkValue', pkValue);

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
    return this.constructor.getPkValue(this.data);
  }

  getSkValue() {
    return this.constructor.getSkValue(this.data);
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
    console.log('find primaryId', {primaryId});
    const pkSk = this.parsePrimaryId(primaryId);
    const dyKey = this.getDyKeyForPkSk(pkSk);
    console.log('find key', {primaryId, dyKey});
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: dyKey,
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

  static async validateUniqueConstraints(data, currentId = null) {
    console.log('validateUniqueConstraints called on', this.name, {
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

        console.log('Checking unique constraint:', {
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
          console.log('Found existing constraint:', result.Item);
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
        const pkField = this.fields[index.pk];
        pkValue = data[index.pk];
        if (pkValue !== undefined) {
          pkValue = pkField.toGsi(pkValue);
        }
      }
      
      // Handle sort key
      if (index.sk === 'modelPrefix') {
        skValue = this.modelPrefix;
      } else {
        const skField = this.fields[index.sk];
        skValue = data[index.sk];
        if (skValue !== undefined) {
          skValue = skField.toGsi(skValue);
        }
      }
      
      if (pkValue !== undefined && skValue !== undefined && index.indexId !== undefined) {
        console.log('indexKeys', {
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

    console.log('queryByIndex', { indexName, pkValue });

    // Format the partition key
    let formattedPk;
    if (index instanceof PrimaryKeyConfig) {
      formattedPk = this.formatPrimaryKey(this.modelPrefix, pkValue);
    } else {
      formattedPk = this.formatGsiKey(this.modelPrefix, index.indexId || '', pkValue);
    }

    console.log('formattedPk', formattedPk);

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

    console.log('Query params:', JSON.stringify(params, null, 2));

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

  static async _saveItem(primaryId, jsUpdates, options = {}) {
    const { 
      isNew = false,
      instanceObj = null,
      constraints = {} 
    } = options;

    console.log('saveItem', primaryId);
    
    const currentItem = isNew ? null : instanceObj || await this.find(primaryId);
    
    if (!isNew && !currentItem) {
      throw new Error('Item not found');
    }

    // Validate unique constraints before attempting save
    await this.validateUniqueConstraints(jsUpdates, isNew ? null : primaryId);

    const transactItems = [];
    const dyUpdatesToSave = {};
    let hasUniqueConstraintChanges = false;
    
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
            dyUpdatesToSave[key] = newValue;
          }
        }
      }
    }

    if (jsUpdates.length === 0) {
      return currentItem;
    }

    // Handle unique constraints
    for (const constraint of Object.values(this.uniqueConstraints || {})) {
      const fieldName = constraint.field;
      const field = this.fields[fieldName];
      const dyNewValue = dyUpdatesToSave[fieldName];
      const dyCurrentValue = currentItem?._originalData[fieldName];

      console.log('uniqueConstraint', field, dyCurrentValue, dyNewValue);

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
      console.log("savedTestId", testId, currentItem);
      if (testId !== currentItem?._originalData._gsi_test_id) {
        dyUpdatesToSave._gsi_test_id = testId;
      }
    }

    // Add GSI keys
    const indexKeys = this.getIndexKeys(dyUpdatesToSave);
    console.log('indexKeys', indexKeys);
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

    console.log('field matchconstraints', constraints);

    // Handle field match constraints
    if (constraints.fieldMatches) {
      if (instanceObj === null) {
        throw new Error('Instance object is required to check field matches');
      }

      const matchFields = Array.isArray(constraints.fieldMatches) 
        ? constraints.fieldMatches 
        : [constraints.fieldMatches];

      matchFields.forEach((fieldName, index) => {
        if (!this.fields[fieldName]) {
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
    console.log('dyKey', dyKey);
    // Create the update params
    const updateParams = {
      TableName: this.table,
      Key: dyKey,
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: {
        ...names,
        ...conditionNames
      },
      ExpressionAttributeValues: {
        ...values,
        ...conditionValues
      },
      ReturnValues: 'ALL_NEW'
    };

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

        console.log('transactItems', JSON.stringify(transactItems, null, 2));

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
        console.log('updateParams', JSON.stringify(updateParams, null, 2));

        response = await this.documentClient.update(updateParams);
        const savedItem = this.fromDynamoDB(response.Attributes);
        savedItem._response = {
          ConsumedCapacity: response.ConsumedCapacity,
        };
        return savedItem;
      }
    } catch (error) {
      console.error('Save error:', error);
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
        throw new Error('Condition check failed');
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

    return await this._saveItem(primaryId, processedData, { isNew: true });
  }

  static async update(primaryId, data, options = {}) {
    return this._saveItem(primaryId, data, { 
      ...options,
      isNew: false
     });
  }

  static _buildUpdateExpression(dyUpdatesToSave) {
    const names = {};
    const values = {};
    const expressions = [];

    console.log('dyUpdatesToSave', dyUpdatesToSave);

    // Process all fields in the data
    for (const [fieldName, value] of Object.entries(dyUpdatesToSave)) {
        // Skip undefined values
        if (value === undefined) continue;

        if (SYSTEM_FIELDS.includes(fieldName)) {
          expressions.push(StringField().getUpdateExpression(fieldName, value));
        } else {
          const field = this.fields[fieldName];
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
      values[expression.attrValueKey] = expression.fieldValue;
    });

    if (setExpressions.length > 0) parts.push(`SET ${setExpressions.join(', ')}`);
    if (addExpressions.length > 0) parts.push(`ADD ${addExpressions.join(', ')}`);
    if (removeExpressions.length > 0) parts.push(`REMOVE ${removeExpressions.join(', ')}`);
    
    return {
        updateExpression: parts.join(' '),
        names,
        values
    };
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
            _pk: item.data._pk,
            _sk: item.data._sk
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
    this.data = {};
    SYSTEM_FIELDS.forEach(key => {
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
            
            const Model = this.constructor.manager.getModel(field.modelName);
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

  // Returns the pk and sk values for a given object. These are encoded to work with
  // dynamo string keys. No test prefix or model prefix is applied.
  static getPrimaryKeyValues(data) {
    if (!data) {
      throw new Error('Data object is required for getPrimaryKeyValues call');
    }

    const pkField = this.fields[this.primaryKey.pk];
    const skField = this.fields[this.primaryKey.sk];

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

    console.log("getPrimaryKeyValues", key);

    return key;
  }

  static getPrimaryId(data) {
    console.log("getPrimaryId", data);
    const pkSk = this.getPrimaryKeyValues(data);
    console.log("getPrimaryId", pkSk);

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
    return this.constructor.getPrimaryId(this.data);
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
  async save(options = {}) {
    if (!this.hasChanges()) {
      return this; // No changes to save
    }

    const changes = this.getChanges();
    console.log("save() - changes", changes);
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
      if (updatedObj.data[key] !== undefined) {
        this.data[key] = updatedObj.data[key];
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
    const ModelClass = this.constructor.manager.getModel(field.modelName);
    
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

