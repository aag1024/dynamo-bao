// src/model.js

const { ulid } = require('ulid');

// Constants for GSI indexes
const GSI_INDEX_ID1 = 'gsi1';
const GSI_INDEX_ID2 = 'gsi2';
const GSI_INDEX_ID3 = 'gsi3';

// Constants for unique constraints
const UNIQUE_CONSTRAINT_ID1 = '_uc1';
const UNIQUE_CONSTRAINT_ID2 = '_uc2';
const UNIQUE_CONSTRAINT_ID3 = '_uc3';

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

class PrimaryKeyConfig {
  constructor(pk, sk = 'model_id') {
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
  static prefix = null;  // This replaces model_id in the Python version
  static fields = {};
  static primaryKey = null;
  static indexes = [];
  static uniqueConstraints = [];

  static initTable(documentClient, tableName) {
    if (!this.table) {
      this.documentClient = documentClient;
      this.table = tableName;
      this.validateConfiguration();
    }
    return this.table;
  }

  static validateConfiguration() {
    if (!this.prefix) {
      throw new Error(`${this.name} must define a prefix`);
    }

    if (!this.primaryKey) {
      throw new Error(`${this.name} must define a primaryKey`);
    }

    // Validate that index IDs are valid
    const validIndexIds = [GSI_INDEX_ID1, GSI_INDEX_ID2, GSI_INDEX_ID3];
    this.indexes.forEach(index => {
      if (!validIndexIds.includes(index.indexId)) {
        throw new Error(`Invalid index ID ${index.indexId} in ${this.name}`);
      }
    });

    // Validate that constraint IDs are valid
    const validConstraintIds = [UNIQUE_CONSTRAINT_ID1, UNIQUE_CONSTRAINT_ID2, UNIQUE_CONSTRAINT_ID3];
    this.uniqueConstraints.forEach(constraint => {
      if (!validConstraintIds.includes(constraint.constraintId)) {
        throw new Error(`Invalid constraint ID ${constraint.constraintId} in ${this.name}`);
      }
    });
  }

  static encodeDateToSortableString(date) {
    // Convert date to ISO string and pad year to ensure proper sorting
    // Format: YYYY-MM-DDTHH:mm:ss.sssZ
    const isoString = (typeof date === 'number' ? new Date(date) : date).toISOString();
    return isoString;
  }

  static getIndexKeys(data, id) {
    return {
      gsi1pk: `${this.prefix}#gsi1#${data.external_platform || ''}`,
      gsi1sk: id,
      gsi2pk: `${this.prefix}#gsi2#${data.role || ''}`,
      gsi2sk: id,
      gsi3pk: `${this.prefix}#gsi3#${data.status || ''}`,
      gsi3sk: new Date(data.createdAt).toISOString()
    };
  }

  static getCapacityFromResponse(response) {
    if (!response) return [];
    const consumed = response.ConsumedCapacity;
    if (!consumed) return [];
    return Array.isArray(consumed) ? consumed : [consumed];
  }

  static createPrefixedKey(prefix, value, isGsi = false) {
    const separator = isGsi ? '#' : '##';
    return `${prefix}${separator}${value}`;
  }

  static getKeyForId(id) {
    return {
      pk: `${this.prefix}##${id}`,
      sk: this.prefix
    };
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
          pk: `_raft_uc##${constraintId}#${this.prefix}#${field}:${value}`,
          sk: '_raft_uc',
          uniqueValue: `${this.prefix}:${field}:${value}`,
          relatedId: relatedId,
          relatedModel: this.name
        },
        ConditionExpression: 'attribute_not_exists(pk) OR (relatedId = :relatedId AND relatedModel = :modelName)',
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
          pk: `_raft_uc##${constraintId}#${this.prefix}#${field}:${value}`,
          sk: '_raft_uc'
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
    const startTime = Date.now();
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: this.getKeyForId(id),
      ReturnConsumedCapacity: 'TOTAL'
    });
    const endTime = Date.now();
    
    return result.Item ? {
      ...result.Item,
      _response: {
        ConsumedCapacity: result.ConsumedCapacity,
        duration: endTime - startTime
      }
    } : null;
  }

  static async findAll() {
    const startTime = Date.now();
    // Find the first global secondary index that uses model_id as PK
    const globalIndex = this.indexes.find(index => index.pk === 'model_id');
    
    if (!globalIndex) {
      throw new Error(`${this.name} must define a global secondary index with model_id as PK to use findAll`);
    }

    const result = await this.documentClient.query({
      TableName: this.table,
      IndexName: globalIndex.getIndexName(),
      KeyConditionExpression: '#pk = :prefix',
      ExpressionAttributeNames: {
        '#pk': globalIndex.getPkFieldName()
      },
      ExpressionAttributeValues: {
        ':prefix': this.createPrefixedKey(this.prefix, this.prefix)
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

  static async queryByIndex(indexNumber, pkValue, options = {}) {
    const indexName = `gsi${indexNumber}`;
    const params = {
        TableName: this.table,
        IndexName: indexName,
        KeyConditionExpression: options.skValue 
            ? '#pk = :pkValue AND #sk >= :startDate' 
            : '#pk = :pkValue',
        ExpressionAttributeNames: {
            '#pk': `gsi${indexNumber}pk`,
            ...(options.skValue && { '#sk': `gsi${indexNumber}sk` })
        },
        ExpressionAttributeValues: {
            ':pkValue': `${this.prefix}#gsi${indexNumber}#${pkValue}`,
            ...(options.skValue && { ':startDate': options.skValue })
        },
        ScanIndexForward: true,
        ReturnConsumedCapacity: 'TOTAL'
    };

    console.log('Query params:', JSON.stringify(params, null, 2));

    const result = await this.documentClient.query(params);
    const endTime = Date.now();

    return {
        Items: result.Items,
        Count: result.Count,
        ScannedCount: result.ScannedCount,
        ConsumedCapacity: result.ConsumedCapacity,
        duration: endTime - Date.now()
    };
}

  static async create(data) {
    const itemToCreate = {
      ...data,
      id: data.id || ulid(),
      createdAt: Date.now()
    };

    const transactItems = [];

    // Add unique constraint operations
    for (const constraint of this.uniqueConstraints) {
      if (itemToCreate[constraint.field]) {
        const constraintOp = {
          Put: {
            TableName: this.table,
            Item: {
              pk: `_raft_uc##${constraint.constraintId}#${this.prefix}#${constraint.field}:${itemToCreate[constraint.field]}`,
              sk: '_raft_uc',
              uniqueValue: `${this.prefix}:${constraint.field}:${itemToCreate[constraint.field]}`,
              relatedId: itemToCreate.id,
              relatedModel: this.name
            },
            ConditionExpression: 'attribute_not_exists(#pk)',
            ExpressionAttributeNames: {
              '#pk': 'pk'
            }
          }
        };
        transactItems.push(constraintOp);
      }
    }

    // Add the main item creation
    const mainItem = {
      pk: `${this.prefix}##${itemToCreate.id}`,
      sk: this.prefix,
      // Add GSI keys
      gsi1pk: `${this.prefix}#gsi1#${itemToCreate.external_platform || ''}`,
      gsi1sk: itemToCreate.id,
      gsi2pk: `${this.prefix}#gsi2#${itemToCreate.role || ''}`,
      gsi2sk: itemToCreate.id,
      gsi3pk: `${this.prefix}#gsi3#${itemToCreate.status || ''}`,
      gsi3sk: new Date(itemToCreate.createdAt).toISOString(),
      // Add the rest of the item data
      ...itemToCreate
    };

    transactItems.push({
      Put: {
        TableName: this.table,
        Item: mainItem,
        ConditionExpression: 'attribute_not_exists(#pk)',
        ExpressionAttributeNames: {
          '#pk': 'pk'
        }
      }
    });

    console.log('Transaction items:', JSON.stringify(transactItems, null, 2));

    try {
      const response = await this.documentClient.transactWrite({
        TransactItems: transactItems,
        ReturnConsumedCapacity: 'TOTAL'
      });
      
      return {
        ...itemToCreate,
        _response: {
          ConsumedCapacity: response.ConsumedCapacity,
          duration: Date.now() - itemToCreate.createdAt
        }
      };
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
                  pk: `_raft_uc##${constraint.constraintId}#${this.prefix}#${constraint.field}:${itemToCreate[constraint.field]}`,
                  sk: '_raft_uc'
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
    const startTime = Date.now();
    const responses = [];
  
    // Track the find operation capacity
    const currentItem = await this.find(id);
    if (!currentItem) {
      throw new Error('Item not found');
    }
    responses.push(currentItem._response);
  
    let response;
    const uniqueFieldsBeingUpdated = this.uniqueConstraints
      .filter(constraint => 
        data[constraint.field] !== undefined && 
        data[constraint.field] !== currentItem[constraint.field]
      );
  
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
      Object.entries(data).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      // Add index updates if needed
      const indexKeys = this.getIndexKeys(data, id);
      Object.entries(indexKeys).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      // Add modifiedAt timestamp
      updateParts.push('#modifiedAt = :modifiedAt');
      expressionAttributeNames['#modifiedAt'] = 'modifiedAt';
      expressionAttributeValues[':modifiedAt'] = Date.now();
  
      transactItems.push({
        Update: {
          TableName: this.table,
          Key: this.getKeyForId(id),
          UpdateExpression: `SET ${updateParts.join(', ')}`,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ConditionExpression: 'attribute_exists(pk)'
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
      Object.entries(data).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      // Add index updates if needed
      const indexKeys = this.getIndexKeys(data, id);
      Object.entries(indexKeys).forEach(([key, value]) => {
        updateParts.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });

      // Add modifiedAt timestamp
      updateParts.push('#modifiedAt = :modifiedAt');
      expressionAttributeNames['#modifiedAt'] = 'modifiedAt';
      expressionAttributeValues[':modifiedAt'] = Date.now();

      response = await this.documentClient.update({
        TableName: this.table,
        Key: this.getKeyForId(id),
        UpdateExpression: `SET ${updateParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: 'attribute_exists(pk)',
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
          ConditionExpression: 'attribute_exists(pk)'
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
        ConditionExpression: 'attribute_exists(pk)',
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
}


module.exports = {
  BaseModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
  // Constants
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2,
  UNIQUE_CONSTRAINT_ID3,
};