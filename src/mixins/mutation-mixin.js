const { TransactWriteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { defaultLogger: logger } = require('../utils/logger');
const { pluginManager } = require('../plugin-manager');
const { retryOperation } = require('../utils/retry-helper');
const assert = require('assert');

const MutationMethods = {
  async create(jsUpdates) {    
    await pluginManager.executeHooks(this.name, 'beforeSave', jsUpdates, { isNew: true });
    const result = await this._saveItem(null, jsUpdates, { isNew: true });
    await pluginManager.executeHooks(this.name, 'afterSave', result, { isNew: true });
    return result;
  },

  async update(primaryId, jsUpdates, options = {}) {
    await pluginManager.executeHooks(this.name, 'beforeSave', jsUpdates, { ...options, isNew: false });
    
    const result = await this._saveItem(primaryId, jsUpdates, { 
      ...options,
      isNew: false
    });

    await pluginManager.executeHooks(this.name, 'afterSave', result, { ...options, isNew: false });
    
    return result;
  },

  async delete(primaryId, options = {}) {
    await pluginManager.executeHooks(this.name, 'beforeDelete', primaryId, options);

    const item = await this.find(primaryId, { batchDelay: 0 });
    if (!item) {
      throw new Error('Item not found');
    }

    const transactItems = [
      {
        Delete: {
          TableName: this.table,
          Key: {
            _pk: item._dyData._pk,
            _sk: item._dyData._sk
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

    const response = await retryOperation(() => 
      this.documentClient.send(new TransactWriteCommand({
        TransactItems: transactItems,
        ReturnConsumedCapacity: 'TOTAL'
      }))
    );

    await pluginManager.executeHooks(this.name, 'afterDelete', primaryId, options);

    // Return deleted item info with capacity information
    item.setConsumedCapacity(response.ConsumedCapacity, 'write', false);
    return item;
  },

  _createNewPrimaryId(jsUpdates) {
    // Now calculate primary key values using the processed data
    const pkValue = this._getPkValue(jsUpdates);
    const skValue = this._getSkValue(jsUpdates);
    
    // Format the primary key
    const pk = this._formatPrimaryKey(this.modelPrefix, pkValue);
    const primaryId = this.getPrimaryId({
      ...jsUpdates,
      _pk: pk,
      _sk: skValue
    });

    return primaryId;
  },

  async _saveItem(primaryId, jsUpdates, options = {}) {
    try {
      const { 
        isNew = false,
        instanceObj = null,
        constraints = {} 
      } = options;

      logger.debug('saveItem', primaryId, isNew, instanceObj);
      let consumedCapacity = [];
      
      let currentItem = instanceObj;
      if (isNew) {
        assert(primaryId === null || primaryId === undefined, 'primaryId should be null for new items');
        currentItem = null;
      } else if (!currentItem) {
        currentItem = await this.find(primaryId, { batchDelay: 0 });
        consumedCapacity = [...consumedCapacity, ...currentItem.getConsumedCapacity()];
      } 
      
      if (!isNew && !currentItem) {
        throw new Error('Item not found');
      }

      const transactItems = [];
      const dyUpdatesToSave = {};
      let hasUniqueConstraintChanges = false;

      logger.debug('jsUpdates', jsUpdates);
      
      // Generate Dynamo Updates to save
      for (const [key, field] of Object.entries(this.fields)) {
        if (isNew && jsUpdates[key] === undefined) {
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

      if (isNew) {
        primaryId = this._createNewPrimaryId(jsUpdates);

        // validate required fields
        for (const [fieldName, field] of Object.entries(this.fields)) {
          if (field.required && (jsUpdates[fieldName] === undefined || jsUpdates[fieldName] === null)) {
            throw new Error(`Field is required: ${fieldName} `);
          }
        }
      }

      Object.entries(jsUpdates).forEach(([fieldName, value]) => {
        const field = this._getField(fieldName);
        if (field) {
          field.validate(value, fieldName);
        }
      });

      // Validate unique constraints before attempting save
      await this._validateUniqueConstraints(jsUpdates, isNew ? null : primaryId);


      // Handle unique constraints
      for (const constraint of Object.values(this.uniqueConstraints || {})) {
        const fieldName = constraint.field;
        const field = this._getField(fieldName);
        const dyNewValue = dyUpdatesToSave[fieldName];
        const dyCurrentValue = currentItem?._loadedDyData[fieldName];

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

      // Add testId if we're in test mode
      const testId = this.manager.getTestId();
      if (testId) {
        logger.debug("savedTestId", testId, currentItem);
        if (testId !== currentItem?._loadedDyData._gsi_test_id) {
          dyUpdatesToSave._gsi_test_id = testId;
        }
      }

      // Add GSI keys
      const indexKeys = this._getIndexKeys(dyUpdatesToSave);
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
          if (!this._getField(fieldName)) {
            throw new Error(`Unknown field in fieldMatches constraint: ${fieldName}`);
          }

          const nameKey = `#match${index}`;
          const valueKey = `:match${index}`;
          
          conditionExpressions.push(`${nameKey} = ${valueKey}`);
          conditionNames[nameKey] = fieldName;
          conditionValues[valueKey] = currentItem ? 
            currentItem._loadedDyData[fieldName] : 
            undefined;
        });
      }

      // When building update expression, pass both old and new data
      const { updateExpression, names, values } = this._buildUpdateExpression(dyUpdatesToSave);

      const dyKey = this._getDyKeyForPkSk(this.parsePrimaryId(primaryId));
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

          response = await retryOperation(() => 
            this.documentClient.send(new TransactWriteCommand({
              TransactItems: transactItems,
              ReturnConsumedCapacity: 'TOTAL'
            }))
          );

          logger.debug('transactItems response', response);
          logger.debug('primaryId to load', primaryId);
          
          // Fetch the item since transactWrite doesn't return values
          const savedItem = await this.find(primaryId, { batchDelay: 0 });

          logger.debug('savedItem', savedItem);
          logger.debug('savedItem.name', savedItem.name);
          
          if (!savedItem.exists()) {
            throw new Error('Failed to fetch saved item');
          }
          
          // Set the consumed capacity from the transaction
          savedItem.addConsumedCapacity(response.ConsumedCapacity, "write", false);
          savedItem.addConsumedCapacity(consumedCapacity, "read", false);

          return savedItem;
        } else {
          // Use simple update if no unique constraints are changing
          logger.debug('updateParams', JSON.stringify(updateParams, null, 2));
          
          try {
            response = await retryOperation(() => 
              this.documentClient.send(new UpdateCommand({
                ...updateParams,
                ReturnConsumedCapacity: 'TOTAL'
              }))
            );
          } catch (error) {
            logger.error(`DynamoDB update failed for ${primaryId}:`, error);
            throw error;
          }

          const savedItem = this.createFromDyItem(response.Attributes);
          logger.debug('savedItem', savedItem);

          savedItem.setConsumedCapacity(response.ConsumedCapacity, 'write', false);
          savedItem.addConsumedCapacity(consumedCapacity, 'read', false);
          return savedItem;
        }
      } catch (error) {
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
          await this._validateUniqueConstraints(jsUpdates, isNew ? null : primaryId);
        }
        throw error;
      }
    } catch (error) {
      logger.error(`Error in _saveItem for ${primaryId}:`, error);
      throw error;
    }
  },

  _buildUpdateExpression(dyUpdatesToSave) {
    const names = {};
    const values = {};
    const expressions = [];

    logger.debug('dyUpdatesToSave', dyUpdatesToSave);

    // Process all fields in the data
    for (const [fieldName, value] of Object.entries(dyUpdatesToSave)) {
      // Skip undefined values
      if (value === undefined) continue;

      const field = this._getField(fieldName);
      
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

    return {
      updateExpression: parts.join(' '),
      names,
      values
    };
  },

  _getIndexKeys(data) {
    const indexKeys = {};
    
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      let pkValue, skValue;
      
      // Handle partition key
      if (index.pk === 'modelPrefix') {
        pkValue = this.modelPrefix;
      } else {
        const pkField = this._getField(index.pk);
        pkValue = data[index.pk];
        if (pkValue !== undefined) {
          pkValue = pkField.toGsi(pkValue);
        }
      }
      
      // Handle sort key
      if (index.sk === 'modelPrefix') {
        skValue = this.modelPrefix;
      } else {
        const skField = this._getField(index.sk);
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
        const gsiPk = this._formatGsiKey(this.modelPrefix, index.indexId, pkValue);
        indexKeys[`_${index.indexId}_pk`] = gsiPk;
        indexKeys[`_${index.indexId}_sk`] = skValue;
      }
    });
    
    return indexKeys;
  }
};

module.exports = MutationMethods; 