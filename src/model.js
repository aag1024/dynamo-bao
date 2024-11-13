const { ulid } = require('ulid');

class BaseModel {
  static table = null;
  static documentClient = null;

  static initTable(documentClient, tableName) {
    if (!this.table) {
      this.documentClient = documentClient;
      this.table = tableName;
    }
    return this.table;
  }

  static getCapacityFromResponse(response) {
    if (!response) return [];
    
    const consumed = response.ConsumedCapacity;
    if (!consumed) return [];
  
    if (Array.isArray(consumed)) {
      return consumed;
    }
  
    return [consumed];
  }

  static createPrefixedKey(prefix, value) {
    return `${prefix}##${value}`;
  }

  static getKeyForId(id) {
    return {
      pk: this.createPrefixedKey(this.prefix, id),
      sk: this.prefix
    };
  }

  static accumulateCapacity(responses) {
    const allCapacity = responses
      .filter(r => r && r.ConsumedCapacity)
      .flatMap(r => Array.isArray(r.ConsumedCapacity) ? r.ConsumedCapacity : [r.ConsumedCapacity]);
      
    return allCapacity.length ? allCapacity : null;
  }

  static async find(id) {
    const startTime = Date.now();
    const result = await this.documentClient.get({
      TableName: this.table,
      Key: this.getKeyForId(id),
      ReturnConsumedCapacity: 'TOTAL'
    });
    const endTime = Date.now();
    
    return {
      ...result.Item,
      _response: {
        ConsumedCapacity: result.ConsumedCapacity,
        duration: endTime - startTime
      }
    };
  }

  static async findAll() {
    const startTime = Date.now();
    const result = await this.documentClient.query({
      TableName: this.table,
      IndexName: 'gsi1',
      KeyConditionExpression: '#pk = :prefix',
      ExpressionAttributeNames: {
        '#pk': 'gsi1pk'
      },
      ExpressionAttributeValues: {
        ':prefix': this.prefix
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

  static async _createUniqueConstraint(uniqueValue, relatedId, modelName) {
    return {
      Put: {
        TableName: this.table,
        Item: {
          pk: `_raft_uc##${uniqueValue}`,
          sk: '_raft_uc',
          uniqueValue,
          relatedId,
          relatedModel: modelName
        },
        ConditionExpression: 'attribute_not_exists(pk) OR (relatedId = :relatedId AND relatedModel = :modelName)',
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': modelName
        }
      }
    };
  }

  static async _removeUniqueConstraint(uniqueValue, relatedId, modelName) {
    return {
      Delete: {
        TableName: this.table,
        Key: {
          pk: `_raft_uc##${uniqueValue}`,
          sk: '_raft_uc'
        },
        ConditionExpression: 'relatedId = :relatedId AND relatedModel = :modelName',
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': modelName
        }
      }
    };
  }

  static async create(data) {
    const startTime = Date.now();
    const itemToCreate = {
      ...data,
      id: data.id || ulid(),
      createdAt: Date.now()
    };
  
    let response;
    const hasUniqueFields = this.uniqueFields && 
      this.uniqueFields.some(field => itemToCreate[field] !== undefined);
  
    if (hasUniqueFields) {
      const transactItems = [];
  
      // Add unique constraint operations
      for (const field of this.uniqueFields) {
        if (itemToCreate[field]) {
          transactItems.push({
            Put: {
              TableName: this.table,
              Item: {
                pk: `_raft_uc##${this.prefix}:${field}:${itemToCreate[field]}`,
                sk: '_raft_uc',
                uniqueValue: `${this.prefix}:${field}:${itemToCreate[field]}`,
                relatedId: itemToCreate.id,
                relatedModel: this.name
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            }
          });
        }
      }
  
      // Add the main item creation
      transactItems.push({
        Put: {
          TableName: this.table,
          Item: {
            pk: this.createPrefixedKey(this.prefix, itemToCreate.id),
            sk: this.prefix,
            gsi1pk: this.prefix,
            gsi1sk: itemToCreate.id,
            ...itemToCreate
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      });
  
      try {
        response = await this.documentClient.transactWrite({
          TransactItems: transactItems,
          ReturnConsumedCapacity: 'TOTAL'
        });
      } catch (error) {
        if (error.name === 'TransactionCanceledException') {
          throw new Error(`${this.uniqueFields[0]} must be unique`);
        }
        throw error;
      }
    } else {
      response = await this.documentClient.put({
        TableName: this.table,
        Item: {
          pk: this.createPrefixedKey(this.prefix, itemToCreate.id),
          sk: this.prefix,
          gsi1pk: this.prefix,
          gsi1sk: itemToCreate.id,
          ...itemToCreate
        },
        ConditionExpression: 'attribute_not_exists(pk)',
        ReturnConsumedCapacity: 'TOTAL'
      });
    }
  
    const endTime = Date.now();
  
    // Return the item and raw response
    return {
      ...itemToCreate,
      _response: response // Return the raw response directly
    };
  }

  static async update(id, data) {
    const startTime = Date.now();
    const responses = [];
  
    // Track the find operation capacity
    const currentItemResponse = await this.find(id);
    responses.push(currentItemResponse._response);
    const currentItem = currentItemResponse;
    
    if (!currentItem) {
      throw new Error('Item not found');
    }
  
    let response;
    const uniqueFieldsBeingUpdated = this.uniqueFields?.filter(
      field => data[field] !== undefined && data[field] !== currentItem[field]
    ) || [];
  
    if (uniqueFieldsBeingUpdated.length > 0) {
      const transactItems = [];
  
      // Handle unique constraints
      for (const field of uniqueFieldsBeingUpdated) {
        if (currentItem[field]) {
          transactItems.push({
            Delete: {
              TableName: this.table,
              Key: {
                pk: `_raft_uc##${this.prefix}:${field}:${currentItem[field]}`,
                sk: '_raft_uc'
              },
              ConditionExpression: 'relatedId = :relatedId AND relatedModel = :modelName',
              ExpressionAttributeValues: {
                ':relatedId': id,
                ':modelName': this.name
              }
            }
          });
        }
        if (data[field]) {
          transactItems.push({
            Put: {
              TableName: this.table,
              Item: {
                pk: `_raft_uc##${this.prefix}:${field}:${data[field]}`,
                sk: '_raft_uc',
                uniqueValue: `${this.prefix}:${field}:${data[field]}`,
                relatedId: id,
                relatedModel: this.name
              },
              ConditionExpression: 'attribute_not_exists(pk)'
            }
          });
        }
      }
  
      // Build update expression
      const updateExpression = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};
      
      Object.entries(data).forEach(([key, value]) => {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });
  
      transactItems.push({
        Update: {
          TableName: this.table,
          Key: this.getKeyForId(id),
          UpdateExpression: `SET ${updateExpression.join(', ')}`,
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
          throw new Error(`${uniqueFieldsBeingUpdated[0]} must be unique`);
        }
        throw error;
      }
    } else {
      // Build update expression
      const updateExpression = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};
      
      Object.entries(data).forEach(([key, value]) => {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      });
  
      response = await this.documentClient.update({
        TableName: this.table,
        Key: this.getKeyForId(id),
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
        ReturnConsumedCapacity: 'TOTAL'
      });
      responses.push(response);
    }
  
    const endTime = Date.now();
  
    // Accumulate all capacity from read and write operations
    const allCapacity = this.accumulateCapacity(responses);
  
    return {
      ...currentItem,
      ...data,
      _response: {
        ConsumedCapacity: allCapacity,
        duration: endTime - startTime
      }
    };
  }
  
  // Similarly update the delete method
  static async delete(id) {
    const startTime = Date.now();
    const responses = [];
    
    const currentItemResponse = await this.find(id);
    responses.push(currentItemResponse._response);
    const currentItem = currentItemResponse;
    
    if (!currentItem) return;
  
    let response;
    const hasUniqueConstraints = this.uniqueFields && 
      this.uniqueFields.some(field => currentItem[field] !== undefined);
  
    if (hasUniqueConstraints) {
      const transactItems = [];
  
      for (const field of this.uniqueFields) {
        if (currentItem[field]) {
          transactItems.push({
            Delete: {
              TableName: this.table,
              Key: {
                pk: `_raft_uc##${this.prefix}:${field}:${currentItem[field]}`,
                sk: '_raft_uc'
              },
              ConditionExpression: 'relatedId = :relatedId AND relatedModel = :modelName',
              ExpressionAttributeValues: {
                ':relatedId': id,
                ':modelName': this.name
              }
            }
          });
        }
      }
  
      transactItems.push({
        Delete: {
          TableName: this.table,
          Key: this.getKeyForId(id),
          ConditionExpression: 'attribute_exists(pk)'
        }
      });
  
      response = await this.documentClient.transactWrite({
        TransactItems: transactItems,
        ReturnConsumedCapacity: 'TOTAL'
      });
      responses.push(response);
    } else {
      response = await this.documentClient.delete({
        TableName: this.table,
        Key: this.getKeyForId(id),
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
module.exports = { BaseModel };