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
  static indexes = [];
  static uniqueConstraints = [];

  static initTable(documentClient, tableName) {
    if (!this.table) {
      this.documentClient = documentClient;
      this.table = tableName;
      this.validateConfiguration();
      
      // Register the model when initializing table
      ModelRegistry.getInstance().register(this);
    }
    return this.table;
  }

  static validateConfiguration() {
    if (!this.modelPrefix) {
      throw new Error(`${this.name} must define a modelPrefix`);
    }

    if (!this.primaryKey) {
      throw new Error(`${this.name} must define a primaryKey`);
    }

    // Validate primary key fields exist
    if (!this.fields[this.primaryKey.pk]) {
      throw new Error(`Primary key field '${this.primaryKey.pk}' not found in ${this.name} fields`);
    }
    if (this.primaryKey.sk !== 'modelPrefix' && !this.fields[this.primaryKey.sk]) {
      throw new Error(`Sort key field '${this.primaryKey.sk}' not found in ${this.name} fields`);
    }

    // Validate that index fields exist
    const validIndexIds = [GSI_INDEX_ID1, GSI_INDEX_ID2, GSI_INDEX_ID3];
    this.indexes.forEach(index => {
      if (!validIndexIds.includes(index.indexId)) {
        throw new Error(`Invalid index ID ${index.indexId} in ${this.name}`);
      }
      
      // Validate partition key exists
      if (index.pk !== 'modelPrefix' && !this.fields[index.pk]) {
        throw new Error(
          `Index ${index.indexId} partition key field '${index.pk}' not found in ${this.name} fields`
        );
      }
      
      // Validate sort key exists (unless it's 'modelPrefix')
      if (index.sk !== 'modelPrefix' && !this.fields[index.sk]) {
        throw new Error(
          `Index ${index.indexId} sort key field '${index.sk}' not found in ${this.name} fields`
        );
      }
    });

    // Validate that constraint fields exist
    const validConstraintIds = [UNIQUE_CONSTRAINT_ID1, UNIQUE_CONSTRAINT_ID2, UNIQUE_CONSTRAINT_ID3];
    this.uniqueConstraints?.forEach(constraint => {
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

  static encodeDateToSortableString(date) {
    // Convert date to ISO string and pad year to ensure proper sorting
    // Format: YYYY-MM-DDTHH:mm:ss.sssZ
    const isoString = (typeof date === 'number' ? new Date(date) : date).toISOString();
    return isoString;
  }

  static getIndexKeys(data) {
    const indexKeys = {};
    
    this.indexes.forEach(index => {
      const pkValue = data[index.pk];
      let skValue = data[index.sk];
      
      if (pkValue && skValue) {
        // Convert values using field definitions
        let pkField = this.fields[index.pk];
        let skField = this.fields[index.sk];
        
        if (pkField && skField) {
          const gsiPk = `${this.modelPrefix}#${index.indexId}#${pkField.toGsi(pkValue)}`;
          const gsiSk = skField.toGsi(skValue);
          
          console.log('Creating GSI key:', {
            index: index.indexId,
            pkField: index.pk,
            skField: index.sk,
            pkValue,
            skValue,
            gsiPk,
            gsiSk
          });
          
          indexKeys[`_${index.indexId}_pk`] = gsiPk;
          indexKeys[`_${index.indexId}_sk`] = gsiSk;
        }
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

  static getKeyForId(id) {
    if (this.primaryKey.sk === 'modelPrefix') {
      return {
        _pk: `${this.modelPrefix}#${id}`,
        _sk: this.modelPrefix
      };
    }

    throw new Error(`getKeyForId only works for primary objects with prefix as SK`);
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

  static async find(id) {
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: this.getKeyForId(id),
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

  static async queryByIndex(indexId, pkValue, options = {}) {
    const startTime = Date.now();
    const index = this.indexes.find(idx => idx.indexId === indexId);
    if (!index) {
      throw new Error(`Index ${indexId} not found`);
    }

    // Get the field definition for the index's partition key
    const pkField = this.fields[index.pk];
    if (!pkField) {
      throw new Error(`Field ${index.pk} not found for index ${indexId}`);
    }

    // Convert the value using the field's GSI conversion
    const convertedPkValue = pkField.toGsi(pkValue);
    
    const gsiKey = `${this.modelPrefix}#${indexId}#${convertedPkValue}`;
    console.log('Index configuration:', {
      indexId,
      pkField: index.pk,
      skField: index.sk,
      convertedPkValue,
      gsiKey
    });

    const params = {
      TableName: this.table,
      IndexName: indexId,
      KeyConditionExpression: '#pk = :pkValue',
      ExpressionAttributeNames: {
        '#pk': `_${indexId}_pk`
      },
      ExpressionAttributeValues: {
        ':pkValue': gsiKey
      },
      ScanIndexForward: true,
      ReturnConsumedCapacity: 'TOTAL',
      ...options
    };

    console.log('Query params:', JSON.stringify(params, null, 2));

    const result = await this.documentClient.query(params);
    console.log('Query result:', JSON.stringify(result, null, 2));
    
    // Convert response items using field definitions
    const convertedItems = result.Items.map(item => new this(item));

    return {
      items: convertedItems,
      count: result.Count,
      scannedCount: result.ScannedCount,
      lastEvaluatedKey: result.LastEvaluatedKey,
      consumedCapacity: result.ConsumedCapacity,
      duration: Date.now() - startTime,
    };
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
    for (const constraint of this.uniqueConstraints) {
      if (itemToCreate[constraint.field]) {
        const constraintOp = await this._createUniqueConstraint(
          constraint.field,
          itemToCreate[constraint.field],
          this.getGid(itemToCreate),
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
      if (error.name === 'TransactionCanceledException') {
        console.error('Transaction cancelled. Reasons:', error.CancellationReasons);
        // Check which constraint failed
        for (const constraint of this.uniqueConstraints) {
          if (itemToCreate[constraint.field]) {
            try {
              const result = await this.documentClient.get({
                TableName: this.table,
                Key: {
                  _pk: `_raft_uc#${constraint.constraintId}#${this.modelPrefix}#${constraint.field}:${itemToCreate[constraint.field]}`,
                  _sk: '_raft_uc'
                }
              });
              if (result.Item) {
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
  }

  static async update(id, data) {
    if (!Object.keys(data).length) return;

    // Convert input data using field definitions
    const convertedData = {};
    for (const [key, value] of Object.entries(data)) {
      const field = this.fields[key];
      if (field) {
        field.validate(value);
        convertedData[key] = field.toDy(value);
      }
    }

    const currentItem = await this.find(id);
    if (!currentItem) {
      throw new Error('Item not found');
    }

    // Check unique constraints
    const uniqueFieldsBeingUpdated = this.uniqueConstraints
      ?.filter(constraint => 
        data[constraint.field] !== undefined && 
        data[constraint.field] !== currentItem[constraint.field]
      ) || [];

    const startTime = Date.now();
    const responses = [];
  
    responses.push(currentItem._response);
  
    let response;
  
    if (uniqueFieldsBeingUpdated.length > 0) {
      const transactItems = [];
  
      // Handle unique constraints
      for (const constraint of uniqueFieldsBeingUpdated) {
        // Remove old constraint if it exists
        if (currentItem[constraint.field]) {
          transactItems.push(
            await this._removeUniqueConstraint(
              constraint.field,
              currentItem[constraint.field],
              id,
              constraint.constraintId
            )
          );
        }
        // Add new constraint if value provided
        if (data[constraint.field]) {
          transactItems.push(
            await this._createUniqueConstraint(
              constraint.field,
              data[constraint.field],
              id,
              constraint.constraintId
            )
          );
        }
      }
  
      // Build update expression for main item
      const updateParts = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};
      
      // Handle regular field updates
      Object.entries(convertedData).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      // Add index updates if needed
      const indexKeys = this.getIndexKeys(data);
      Object.entries(indexKeys).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });
  
      transactItems.push({
        Update: {
          TableName: this.table,
          Key: this.getKeyForId(id),
          UpdateExpression: `SET ${updateParts.join(', ')}`,
          ExpressionAttributeNames: {
            ...expressionAttributeNames,
            '#pk': '_pk'
          },
          ExpressionAttributeValues: expressionAttributeValues,
          ConditionExpression: 'attribute_exists(#pk)'
        }
      });
  
      try {
        response = await this.documentClient.transactWrite({
          TransactItems: transactItems,
          ReturnConsumedCapacity: 'TOTAL'
        });
        responses.push(response);
      } catch (error) {
        if (error.name === 'TransactionCanceledException') {
          const failedConstraint = uniqueFieldsBeingUpdated[0];
          throw new Error(`${failedConstraint.field} must be unique`);
        }
        throw error;
      }
    } else {
      // Build update expression for non-unique update
      const updateParts = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};
      
      // Handle regular field updates
      Object.entries(convertedData).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      // Add index updates if needed
      const indexKeys = this.getIndexKeys(data);
      Object.entries(indexKeys).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      response = await this.documentClient.update({
        TableName: this.table,
        Key: this.getKeyForId(id),
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeNames: {
          ...expressionAttributeNames,
          '#pk': '_pk'
        },
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: 'attribute_exists(#pk)',
        ReturnValues: 'ALL_NEW',
        ReturnConsumedCapacity: 'TOTAL'
      });
      responses.push(response);
    }
  
    const endTime = Date.now();
    const allCapacity = this.accumulateCapacity(responses);
  
    return {
      ...currentItem,
      ...data,
      modifiedAt: Date.now(),
      _response: {
        ConsumedCapacity: allCapacity,
        duration: endTime - startTime
      }
    };
  }

  static async delete(id) {
    const startTime = Date.now();
    const responses = [];
    
    // Get the current item first to handle constraints
    const currentItem = await this.find(id);
    if (!currentItem) {
      return null;
    }
    responses.push(currentItem._response);
  
    let response;
    const hasUniqueConstraints = this.uniqueConstraints.filter(
      constraint => currentItem[constraint.field] !== undefined
    ).length > 0;
  
    if (hasUniqueConstraints) {
      const transactItems = [];
  
      // Remove all unique constraints
      for (const constraint of this.uniqueConstraints) {
        if (currentItem[constraint.field]) {
          transactItems.push(
            await this._removeUniqueConstraint(
              constraint.field,
              currentItem[constraint.field],
              id,
              constraint.constraintId
            )
          );
        }
      }
  
      // Delete the main item
      transactItems.push({
        Delete: {
          TableName: this.table,
          Key: this.getKeyForId(id),
          ExpressionAttributeNames: {
            '#pk': '_pk'
          },
          ConditionExpression: 'attribute_exists(#pk)'
        }
      });
  
      try {
        response = await this.documentClient.transactWrite({
          TransactItems: transactItems,
          ReturnConsumedCapacity: 'TOTAL'
        });
        responses.push(response);
      } catch (error) {
        if (error.name === 'TransactionCanceledException') {
          throw new Error('Failed to delete item - transaction failed');
        }
        throw error;
      }
    } else {
      // Simple delete without constraints
      response = await this.documentClient.delete({
        TableName: this.table,
        Key: this.getKeyForId(id),
        ExpressionAttributeNames: {
          '#pk': '_pk'
        },  
        ConditionExpression: 'attribute_exists(#pk)',
        ReturnValues: 'ALL_OLD',
        ReturnConsumedCapacity: 'TOTAL'
      });
      responses.push(response);
    }
  
    const endTime = Date.now();
    const allCapacity = this.accumulateCapacity(responses);
  
    return {
      ...currentItem,
      _response: {
        ConsumedCapacity: allCapacity,
        duration: endTime - startTime
      }
    };
  }

  constructor(data = {}) {
    // Initialize data and changes tracking
    this.data = {};
    this._originalData = {};
    this._changes = new Set();
    this._relatedObjects = {};  // Store related objects here

    // Initialize fields with data
    Object.entries(this.constructor.fields).forEach(([fieldName, field]) => {
      // Set the data value
      if (data[fieldName] !== undefined) {
        this.data[fieldName] = field.fromDy(data[fieldName]);
      } else {
        this.data[fieldName] = field.getInitialValue();
      }

      // Define property getter/setter
      Object.defineProperty(this, fieldName, {
        get: () => this.data[fieldName],
        set: (value) => {
          if (value !== this.data[fieldName]) {
            this.data[fieldName] = value;
            this._changes.add(fieldName);
            // Clear cached related object when field value changes
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
            // Return cached object if it exists
            if (this._relatedObjects[fieldName]) {
              return this._relatedObjects[fieldName];
            }
            
            // Load and cache the related object
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

  // get id() {
  //   return this.data.id;
  // }

  getGid() {
    return this.constructor.getGid(this.data);
  }

  static getGid(data) {
    if (!data) {
      throw new Error('Data object is required for getGid call');
    }

    if (this.primaryKey.sk === 'modelPrefix') {
      return this.getPkValue(data);
    }

    if (this.primaryKey.pk === 'modelPrefix') {
      return this.getSkValue(data);
    }

    throw new Error(`getGid only works for primary objects with prefix as SK or PK`);
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
    await this.constructor.update(this.getGid(), changes);
    
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

  async loadRelatedData() {
    const promises = [];
    
    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      if (field instanceof RelatedFieldClass && this[fieldName]) {
        promises.push(
          field.load(this[fieldName])
            .then(instance => {
              field._loadedInstance = instance;
            })
        );
      }
    }

    await Promise.all(promises);
    return this;
  }

  getRelated(fieldName) {
    const field = this.constructor.fields[fieldName];
    if (!(field instanceof RelatedFieldClass)) {
      throw new Error(`Field ${fieldName} is not a RelatedField`);
    }
    return field.getInstance();
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

