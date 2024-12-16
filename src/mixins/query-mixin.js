const { defaultLogger: logger } = require('../utils/logger');
const { KeyConditionBuilder } = require('../key-condition');
const { FilterExpressionBuilder } = require('../filter-expression');
const { ObjectNotFound } = require('../object-not-found');
const { PrimaryKeyConfig } = require('../model-config');
const assert = require('assert');
const { retryOperation } = require('../utils/retry-helper');
const { QueryCommand } = require('@aws-sdk/lib-dynamodb');

const QueryMethods = {
  async queryByPrimaryKey(pkValue, skCondition = null, options = {}) {
    const params = this._getBaseQueryParams(
      '_pk',
      this._formatPrimaryKey(this.modelPrefix, pkValue),
      skCondition,
      options
    );

    const response = await retryOperation(() => 
      this.documentClient.send(new QueryCommand(params))
    );
    
    return this._processQueryResponse(response, options);
  },

  async getRelatedObjectsViaMap(indexName, pkValue, targetField, mapSkCondition=null, 
    limit=null, direction='ASC', startKey=null) {
      return await this.queryByIndex(indexName, pkValue, mapSkCondition, {
        loadRelated: true,
        relatedOnly: true,
        relatedFields: [targetField],
        limit,
        direction,
        startKey
      });
  },

  /**
   * @param {Object|null} skCondition - Optional sort key condition in the format: { fieldName: value } or { fieldName: { $operator: value } }
   *                                   Supported operators: $between, $beginsWith
   *                                   Example: { status: 'active' } or { createdAt: { $between: [date1, date2] } }
   * @param {Object} options - Additional query options
     * @param {number} options.limit - Maximum number of items to return (default: model.defaultQueryLimit)
     * @param {string} options.direction - Sort direction, 'ASC' or 'DESC' (default: 'ASC')
     * @param {Object} options.startKey - Exclusive start key for pagination
     * @param {boolean} options.countOnly - If true, returns only the count of matching items
     * @param {Object} options.filter - Additional filter conditions for the query
     * @param {boolean} options.returnWrapped - If false, returns raw DynamoDB items instead of model instances
     * @param {boolean} options.loadRelated - If true, loads related models for RelatedFields
     * @param {string[]} options.relatedFields - Array of field names to load related data for (used with loadRelated)
     * @param {boolean} options.relatedOnly - Used by mapping tables to return only target objects; 
     *                                        loadRelated and a single entry in relatedFields must be provided
     * 
     * @returns {Promise<Object>} Returns an object containing:
     *   - items: Array of model instances or raw items
     *   - count: Number of items returned
     *   - lastEvaluatedKey: Key for pagination (if more items exist)
     *   - consumedCapacity: DynamoDB response metadata including ConsumedCapacity
     * 
     * @throws {Error} If index name is not found in model
     * @throws {Error} If sort key condition references wrong field
     * 
     * @example
     * // Basic query
     * const results = await Model.queryByIndex('statusIndex', 'active');
     * 
     * // Query with sort key condition
     * const results = await Model.queryByIndex('dateIndex', 'user123', {
     *   createdAt: { $between: [startDate, endDate] }
     * });
     * 
     * // Query with pagination
     * const results = await Model.queryByIndex('statusIndex', 'active', null, {
     *   limit: 10,
     *   startKey: lastEvaluatedKey
     * });
     * 
     * // Query with related data
     * const results = await Model.queryByIndex('userIndex', userId, null, {
     *   loadRelated: true,
     *   relatedFields: ['organizationId']
     * });
  */
  async queryByIndex(indexName, pkValue, skCondition = null, options = {}) {
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
      formattedPk = this._formatPrimaryKey(this.modelPrefix, pkValue);
    } else {
      const pkField = this._getField(index.pk);
      const gsiValue = pkField.toGsi(pkValue);
      formattedPk = this._formatGsiKey(this.modelPrefix, index.indexId, gsiValue);
    }
  
    const params = this._getBaseQueryParams(
      index instanceof PrimaryKeyConfig ? '_pk' : `_${index.indexId}_pk`,
      formattedPk,
      skCondition ? { [index.sk]: skCondition[index.sk] } : null,
      { 
        ...options, 
        indexName,
        gsiIndexId: index.indexId,
        gsiSortKeyName: `_${index.indexId}_sk`
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

    const response = await retryOperation(() => 
      this.documentClient.send(new QueryCommand(params))
    );
  
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
    
    return this._processQueryResponse(response, { 
      ...options, 
      totalItems 
    });
  },

  _getBaseQueryParams(pkFieldName, pkValue, skCondition, options = {}) {
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
  },

  async _processQueryResponse(response, options = {}) {
    if (options.countOnly) {
      return {
        count: response.Count,
        consumedCapacity: response.ConsumedCapacity
      };
    }

    const {
      returnWrapped = true,
      loadRelated = false,
      relatedFields = null,
      relatedOnly = false,
    } = options;

    if (relatedOnly) {
      assert(relatedFields && relatedFields.length === 1, 'relatedOnly requires a single entry in relatedFields');
      assert(loadRelated, 'relatedOnly requires loadRelated to be true');
    }
  
    // Create model instances
    let items = returnWrapped ? response.Items.map(item => this.createFromDyItem(item)) : response.Items;
    const loaderContext = options.loaderContext || {};

    // Load related data if requested
    if (returnWrapped && loadRelated) {
      await Promise.all(items.map(item => item.loadRelatedData(relatedFields, loaderContext)));
      
      if (relatedOnly) {
        items = items.map(item => item.getRelated(relatedFields[0]));
      }
    }

    return {
      items,
      count: items.length,
      lastEvaluatedKey: response.LastEvaluatedKey,
      consumedCapacity: response.ConsumedCapacity,
    };
  }
};

module.exports = QueryMethods; 