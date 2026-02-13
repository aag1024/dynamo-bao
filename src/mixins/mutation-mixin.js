const {
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
} = require("../dynamodb-client");
const { defaultLogger: logger } = require("../utils/logger");
const { pluginManager } = require("../plugin-manager");
const { retryOperation } = require("../utils/retry-helper");
const assert = require("assert");
const { FilterExpressionBuilder } = require("../filter-expression");
const {
  ItemNotFoundError,
  ConditionalError,
  ValidationError,
} = require("../exceptions");

const MutationMethods = {
  /**
   *@memberof BaoModel
   * @description
   * Create a new item in the database.
   * @param {Object} jsUpdates - The data to create the item with.
   * @returns {Promise<Object>} Returns a promise that resolves to the created item.
   */
  async create(jsUpdates) {
    await pluginManager.executeHooks(this.name, "beforeSave", jsUpdates, {
      isNew: true,
    });
    const result = await this._saveItem(null, jsUpdates, { isNew: true });

    logger.debug("create() - result", result);
    await pluginManager.executeHooks(this.name, "afterSave", result, {
      isNew: true,
    });
    return result;
  },

  /**
   *@memberof BaoModel
   * @description
   * Update an existing item in the database.
   * @param {string} primaryId - The primary ID of the item to update.
   * @param {Object} jsUpdates - The data to update the item with.
   * @param {Object} [options] - Additional options for the update operation.
   * @param {Object} [options.condition] - Condition that must be met for the update to succeed.
   *   The condition supports the same operators as filter expressions:
   *   - Simple field comparisons: { fieldName: value } for exact matches
   *   - Comparison operators: { fieldName: { $eq: value, $ne: value, $gt: value, $gte: value, $lt: value, $lte: value } }
   *   - String operators: { fieldName: { $beginsWith: value, $contains: value } }
   *   - Existence check: { fieldName: { $exists: true|false } }
   *   - Logical operators: $and, $or, $not
   * @param {boolean} [options.forceReindex=false] - When true, repopulates all index attributes even if the source fields are unchanged.
   * @returns {Promise<Object>} Returns a promise that resolves to the updated item.
   * @throws {Error} "Item not found" if the item doesn't exist
   * @throws {Error} "Condition check failed" if the condition isn't satisfied
   */
  async update(primaryId, jsUpdates, options = {}) {
    const updateOptions = {
      isNew: false,
      ...options,
    };

    await pluginManager.executeHooks(
      this.name,
      "beforeSave",
      jsUpdates,
      updateOptions,
    );

    const result = await this._saveItem(primaryId, jsUpdates, updateOptions);

    logger.debug("update() - result", result);

    await pluginManager.executeHooks(
      this.name,
      "afterSave",
      result,
      updateOptions,
    );

    return result;
  },

  /**
   *@memberof BaoModel
   * @description
   * Delete an existing item in the database.
   * @param {string} primaryId - The primary ID of the item to delete.
   * @param {Object} [options] - Additional options for the delete operation.
   * @param {Object} [options.condition] - Condition that must be met for the delete to succeed.
   *   The condition supports the same operators as filter expressions:
   *   - Simple field comparisons: { fieldName: value } for exact matches
   *   - Comparison operators: { fieldName: { $eq: value, $ne: value, $gt: value, $gte: value, $lt: value, $lte: value } }
   *   - String operators: { fieldName: { $beginsWith: value, $contains: value } }
   *   - Existence check: { fieldName: { $exists: true|false } }
   *   - Logical operators: $and, $or, $not
   * @example
   * // Delete with simple condition
   * await Model.delete(id, {
   *   condition: { status: 'active' }
   * });
   *
   * // Delete with complex condition
   * await Model.delete(id, {
   *   condition: {
   *     $and: [
   *       { status: { $exists: true } },
   *       { age: { $gt: 21 } }
   *     ]
   *   }
   * });
   * @throws {Error} "Item not found" if the item doesn't exist
   * @throws {Error} "Delete condition not met" if the condition isn't satisfied
   * @returns {Promise<Object>} Returns a promise that resolves to the deleted item.
   */
  async delete(primaryId, options = {}) {
    await pluginManager.executeHooks(
      this.name,
      "beforeDelete",
      primaryId,
      options,
    );

    const item = await this.find(primaryId, { batchDelay: 0 });
    if (!item.exists()) {
      throw new ItemNotFoundError("Item not found", primaryId);
    }

    // Check if we need to clean up any unique constraints
    const uniqueConstraints = Object.values(this.uniqueConstraints || {});
    const hasConstraintsToClean = uniqueConstraints.some((constraint) => {
      const value = item[constraint.field];
      return value != null;
    });

    try {
      let response;

      if (hasConstraintsToClean) {
        // Transaction path - handle unique constraint cleanup
        const transactItems = [
          {
            Delete: {
              TableName: this.table,
              Key: {
                _pk: item._dyData._pk,
                _sk: item._dyData._sk,
              },
            },
          },
        ];

        // Add condition if specified
        if (options.condition) {
          const builder = new FilterExpressionBuilder();
          const filterExpression = builder.build(options.condition, this);

          if (filterExpression) {
            transactItems[0].Delete = {
              ...transactItems[0].Delete,
              ConditionExpression: filterExpression.FilterExpression,
              ExpressionAttributeNames:
                filterExpression.ExpressionAttributeNames,
              ExpressionAttributeValues:
                filterExpression.ExpressionAttributeValues,
            };
          }
        }

        // Add unique constraint cleanup operations
        for (const constraint of uniqueConstraints) {
          const value = item[constraint.field];
          if (value) {
            const constraintOp = await this._removeUniqueConstraint(
              constraint.field,
              value,
              item.getPrimaryId(),
              constraint.constraintId,
            );
            transactItems.push(constraintOp);
          }
        }

        response = await retryOperation(() =>
          this.documentClient.send(
            new TransactWriteCommand({
              TransactItems: transactItems,
              ReturnConsumedCapacity: "TOTAL",
            }),
          ),
        );
      } else {
        // Fast path - simple delete
        const deleteParams = {
          TableName: this.table,
          Key: {
            _pk: item._dyData._pk,
            _sk: item._dyData._sk,
          },
          ReturnValues: "ALL_OLD",
          ReturnConsumedCapacity: "TOTAL",
        };

        // Add condition if specified
        if (options.condition) {
          const builder = new FilterExpressionBuilder();
          const filterExpression = builder.build(options.condition, this);

          if (filterExpression) {
            deleteParams.ConditionExpression =
              filterExpression.FilterExpression;
            deleteParams.ExpressionAttributeNames =
              filterExpression.ExpressionAttributeNames;
            deleteParams.ExpressionAttributeValues =
              filterExpression.ExpressionAttributeValues;
          }
        }

        response = await retryOperation(() =>
          this.documentClient.send(new DeleteCommand(deleteParams)),
        );
      }

      await pluginManager.executeHooks(
        this.name,
        "afterDelete",
        primaryId,
        options,
      );

      // For transaction path, we already have the item
      // For fast path, we get it from the response
      const deletedItem = hasConstraintsToClean
        ? item
        : this._createFromDyItem(response.Attributes);
      deletedItem._setConsumedCapacity(
        response.ConsumedCapacity,
        "write",
        false,
      );

      return deletedItem;
    } catch (error) {
      if (
        error.name === "ConditionalCheckFailedException" ||
        (error.name === "TransactionCanceledException" &&
          error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed")
      ) {
        throw new ConditionalError(
          "Delete condition not met",
          "delete",
          options.condition,
        );
      }
      throw error;
    }
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
      _sk: skValue,
    });

    return primaryId;
  },

  /**
   *@memberof BaoModel
   * @private
   * @description
   * Save an item to the database.
   * @param {string} primaryId - The primary ID of the item to save.
   * @param {Object} jsUpdates - The data to save the item with.
   * @param {Object} [options] - Additional options for the save operation.
   * @param {boolean} [options.isNew=false] - Whether this is a new item being created. Internal use only.
   * @param {Object} [options.instanceObj=null] - Existing model instance, if any. Internal use only.
   * @returns {Promise<Object>} Returns a promise that resolves to the saved item.
   */
  async _saveItem(primaryId, jsUpdates, options = {}) {
    try {
      const {
        isNew = false,
        instanceObj = null,
        forceReindex = false,
      } = options;

      logger.debug("saveItem", primaryId, isNew, instanceObj);
      let consumedCapacity = [];

      let currentItem = instanceObj;
      if (isNew) {
        currentItem = null;
      } else if (!currentItem) {
        currentItem = await this.find(primaryId, { batchDelay: 0 });
        if (currentItem && currentItem.exists()) {
          consumedCapacity = [
            ...consumedCapacity,
            ...currentItem.getConsumedCapacity(),
          ];
        } else {
          throw new ItemNotFoundError("Item not found", primaryId);
        }
      }

      if (!isNew && !currentItem) {
        throw new ItemNotFoundError("Item not found", primaryId);
      }

      const transactItems = [];
      const dyUpdatesToSave = {};
      const indexComputationData = {};
      let hasUniqueConstraintChanges = false;

      logger.debug("jsUpdates", jsUpdates);

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
          const dyValue = field.toDy(jsUpdates[key]);
          dyUpdatesToSave[key] = dyValue;
          indexComputationData[key] = dyValue;
        } else {
          if (typeof field.updateBeforeSave === "function") {
            const newValue = field.updateBeforeSave(jsUpdates[key]);
            if (newValue !== jsUpdates[key]) {
              const dyValue = field.toDy(newValue);
              dyUpdatesToSave[key] = dyValue;
              indexComputationData[key] = dyValue;
            }
          }
        }
      }

      // Backfill from currentItem for GSI consistency
      if (!isNew && currentItem) {
        if (forceReindex) {
          // forceReindex: backfill all fields from current item
          Object.keys(this.fields).forEach((fieldName) => {
            const currentValue = currentItem._dyData[fieldName];
            if (
              currentValue !== undefined &&
              indexComputationData[fieldName] === undefined
            ) {
              indexComputationData[fieldName] = currentValue;
            }
          });
        } else {
          // Regular update: backfill GSI counterpart fields so indexes
          // stay consistent when only one field of a key pair is updated
          Object.entries(this.indexes).forEach(([, index]) => {
            const pkField = index.pk;
            const skField = index.sk;
            const pkInUpdate =
              pkField === "modelPrefix" ||
              indexComputationData[pkField] !== undefined;
            const skInUpdate =
              skField === "modelPrefix" ||
              indexComputationData[skField] !== undefined;

            if (pkInUpdate && !skInUpdate && skField !== "modelPrefix") {
              const currentValue = currentItem._dyData[skField];
              if (currentValue !== undefined) {
                indexComputationData[skField] = currentValue;
              }
            }
            if (skInUpdate && !pkInUpdate && pkField !== "modelPrefix") {
              const currentValue = currentItem._dyData[pkField];
              if (currentValue !== undefined) {
                indexComputationData[pkField] = currentValue;
              }
            }
          });
        }
      }

      if (isNew) {
        primaryId = this._createNewPrimaryId(jsUpdates);

        // validate required fields
        for (const [fieldName, field] of Object.entries(this.fields)) {
          if (
            field.required &&
            (jsUpdates[fieldName] === undefined ||
              jsUpdates[fieldName] === null)
          ) {
            throw new ValidationError(
              `Field is required: ${fieldName}`,
              fieldName,
              jsUpdates[fieldName],
            );
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
      await this._validateUniqueConstraints(
        jsUpdates,
        isNew ? null : primaryId,
      );

      // Handle unique constraints
      for (const constraint of Object.values(this.uniqueConstraints || {})) {
        const fieldName = constraint.field;
        const field = this._getField(fieldName);
        const dyNewValue = dyUpdatesToSave[fieldName];
        const dyCurrentValue = currentItem?._loadedDyData[fieldName];

        logger.debug("uniqueConstraint", field, dyCurrentValue, dyNewValue);

        if (dyNewValue !== undefined && dyNewValue !== dyCurrentValue) {
          hasUniqueConstraintChanges = true;

          // Remove old constraint if updating
          if (currentItem && dyCurrentValue) {
            transactItems.push(
              await this._removeUniqueConstraint(
                fieldName,
                dyCurrentValue,
                primaryId,
                constraint.constraintId,
              ),
            );
          }

          // Add new constraint unless value is null (clearing field removes constraint)
          if (dyNewValue !== null) {
            transactItems.push(
              await this._createUniqueConstraint(
                fieldName,
                dyNewValue,
                primaryId,
                constraint.constraintId,
              ),
            );
          }
        }
      }

      // Add GSI keys
      const indexSourceData = Object.keys(indexComputationData).length
        ? indexComputationData
        : dyUpdatesToSave;

      const indexKeys = this._getIndexKeys(indexSourceData, {
        isUpdate: !isNew,
      });
      logger.debug("indexKeys", indexKeys);
      Object.assign(dyUpdatesToSave, indexKeys);

      // Add iteration keys if model is iterable
      if (this.iterable) {
        const iterationKeys = this._getIterationKeys(
          primaryId,
          dyUpdatesToSave,
        );
        Object.assign(dyUpdatesToSave, iterationKeys);
      }

      // Build the update expression first
      const { updateExpression, names, values } = this._buildUpdateExpression(
        dyUpdatesToSave,
        currentItem,
      );

      // Create the base update params
      const updateParams = {
        TableName: this.table,
        Key: this._getDyKeyForPkSk(this._parsePrimaryId(primaryId)),
        UpdateExpression: updateExpression,
        ReturnValues: "ALL_NEW",
      };

      if (Object.keys(names).length > 0) {
        updateParams.ExpressionAttributeNames = {
          ...names,
        };
      }

      if (Object.keys(values).length > 0) {
        updateParams.ExpressionAttributeValues = {
          ...values,
        };
      }

      // Build the condition expression for the update/put
      const conditionExpressions = [];
      const conditionNames = {};
      const conditionValues = {};

      if (options.condition) {
        const builder = new FilterExpressionBuilder();
        const filterExpression = builder.build(options.condition, this);

        if (filterExpression) {
          updateParams.ConditionExpression = filterExpression.FilterExpression;
          updateParams.ExpressionAttributeNames = {
            ...updateParams.ExpressionAttributeNames,
            ...filterExpression.ExpressionAttributeNames,
          };
          updateParams.ExpressionAttributeValues = {
            ...updateParams.ExpressionAttributeValues,
            ...filterExpression.ExpressionAttributeValues,
          };
        }
      } else if (isNew) {
        // For new items, ensure they don't already exist
        updateParams.ConditionExpression = "attribute_not_exists(#pk)";
        updateParams.ExpressionAttributeNames = {
          ...updateParams.ExpressionAttributeNames,
          "#pk": "_pk",
        };
      }

      const dyKey = this._getDyKeyForPkSk(this._parsePrimaryId(primaryId));
      logger.debug("dyKey", dyKey);

      try {
        let response;

        if (hasUniqueConstraintChanges) {
          // Use transaction if we have unique constraint changes
          transactItems.push({
            Update: updateParams,
          });

          logger.debug("transactItems", JSON.stringify(transactItems, null, 2));

          response = await retryOperation(() =>
            this.documentClient.send(
              new TransactWriteCommand({
                TransactItems: transactItems,
                ReturnConsumedCapacity: "TOTAL",
              }),
            ),
          );

          logger.debug("transactItems response", response);
          logger.debug("primaryId to load", primaryId);

          // Fetch the item since transactWrite doesn't return values
          let savedItem = await this.find(primaryId, { batchDelay: 0 });

          // if the item doesn't exist, sleep for 200ms and try again
          if (!savedItem.exists()) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            savedItem = await this.find(primaryId, { batchDelay: 0 });
          }

          logger.debug("savedItem", savedItem);

          if (!savedItem.exists()) {
            throw new ConditionalError("Failed to fetch saved item", "update");
          }
          logger.debug("savedItem.getPrimaryId()", savedItem.getPrimaryId());

          // Set the consumed capacity from the transaction
          savedItem._addConsumedCapacity(
            response.ConsumedCapacity,
            "write",
            false,
          );
          savedItem._addConsumedCapacity(consumedCapacity, "read", false);

          return savedItem;
        } else {
          // Use simple update if no unique constraints are changing
          logger.debug("updateParams", JSON.stringify(updateParams, null, 2));

          try {
            response = await retryOperation(() =>
              this.documentClient.send(
                new UpdateCommand({
                  ...updateParams,
                  ReturnConsumedCapacity: "TOTAL",
                }),
              ),
            );
          } catch (error) {
            logger.error(`DynamoDB update failed for ${primaryId}:`, error);
            throw error;
          }

          const savedItem = this._createFromDyItem(response.Attributes);
          logger.debug("savedItem", savedItem);

          savedItem._setConsumedCapacity(
            response.ConsumedCapacity,
            "write",
            false,
          );
          savedItem._addConsumedCapacity(consumedCapacity, "read", false);

          if (!savedItem.exists()) {
            throw new ConditionalError("Failed to fetch saved item", "update");
          }

          return savedItem;
        }
      } catch (error) {
        logger.error("Error in _saveItem", error);
        if (error.name === "ConditionalCheckFailedException") {
          throw new ConditionalError("Condition check failed", "update", error);
        }

        if (error.name === "TransactionCanceledException") {
          // Check if it's due to conditional check failure
          if (
            error.CancellationReasons?.some(
              (reason) => reason.Code === "ConditionalCheckFailed",
            )
          ) {
            throw new ConditionalError(
              "Transaction cancelled due to condition check failure",
              "update",
              error,
            );
          }
          // For other transaction cancellation reasons, try to validate unique constraints
          // which will throw the appropriate ConditionalError if that's the issue
          await this._validateUniqueConstraints(
            jsUpdates,
            isNew ? null : primaryId,
          );
        }
        throw error;
      }
    } catch (error) {
      logger.error(`Error in _saveItem for ${primaryId}:`, error);
      throw error;
    }
  },

  _buildUpdateExpression(dyUpdatesToSave, currentItem = null) {
    const names = {};
    const values = {};
    const expressions = [];

    logger.debug("dyUpdatesToSave", dyUpdatesToSave);

    // Process all fields in the data
    for (const [fieldName, value] of Object.entries(dyUpdatesToSave)) {
      // Skip undefined values
      if (value === undefined) continue;

      const field = this._getField(fieldName);

      // Handle null values differently - use REMOVE instead of SET
      if (value === null) {
        expressions.push({
          type: "REMOVE",
          expression: `#${fieldName}`,
          attrNameKey: `#${fieldName}`,
          fieldName: fieldName,
          fieldValue: null,
        });
      } else {
        // For StringSetField, pass the original value for diffing
        const { StringSetFieldClass } = require("../fields");
        if (field instanceof StringSetFieldClass && currentItem) {
          const originalValue = currentItem._loadedDyData[fieldName];
          const updateExpression = field.getUpdateExpression(
            fieldName,
            value,
            originalValue,
          );

          // Handle ADD_DELETE operations (multiple operations for the same field)
          if (updateExpression && updateExpression.type === "ADD_DELETE") {
            expressions.push(...updateExpression.operations);
          } else if (updateExpression) {
            expressions.push(updateExpression);
          }
        } else {
          const updateExpression = field.getUpdateExpression(fieldName, value);
          if (updateExpression) {
            expressions.push(updateExpression);
          }
        }
      }
    }

    const parts = [];
    const setExpressions = [];
    const addExpressions = [];
    const removeExpressions = [];
    const deleteExpressions = [];

    expressions.forEach((expression) => {
      if (expression.type === "SET") {
        setExpressions.push(expression.expression);
      } else if (expression.type === "ADD") {
        addExpressions.push(expression.expression);
      } else if (expression.type === "REMOVE") {
        removeExpressions.push(expression.expression);
      } else if (expression.type === "DELETE") {
        deleteExpressions.push(expression.expression);
      }

      if (expression.attrNameKey) {
        names[expression.attrNameKey] = expression.fieldName;
      }

      if (expression.fieldValue !== null && expression.attrValueKey) {
        values[expression.attrValueKey] = expression.fieldValue;
      }
    });

    if (setExpressions.length > 0)
      parts.push(`SET ${setExpressions.join(", ")}`);
    if (addExpressions.length > 0)
      parts.push(`ADD ${addExpressions.join(", ")}`);
    if (removeExpressions.length > 0)
      parts.push(`REMOVE ${removeExpressions.join(", ")}`);
    if (deleteExpressions.length > 0)
      parts.push(`DELETE ${deleteExpressions.join(", ")}`);

    return {
      updateExpression: parts.join(" "),
      names,
      values,
    };
  },

  _getIndexKeys(data, { isUpdate = false } = {}) {
    const indexKeys = {};

    Object.entries(this.indexes).forEach(([indexName, index]) => {
      let pkValue, skValue;

      // Handle partition key
      if (index.pk === "modelPrefix") {
        pkValue = this.modelPrefix;
      } else {
        const pkField = this._getField(index.pk);
        pkValue = data[index.pk];
        if (pkValue !== undefined) {
          pkValue = pkField.toGsi(pkValue);
        }
      }

      // Handle sort key
      if (index.sk === "modelPrefix") {
        skValue = this.modelPrefix;
      } else {
        const skField = this._getField(index.sk);
        skValue = data[index.sk];
        if (skValue !== undefined) {
          skValue = skField.toGsi(skValue);
        }
      }

      // Detect partial GSI key updates that would cause index staleness
      if (isUpdate && index.indexId !== undefined) {
        const pkProvided =
          index.pk === "modelPrefix" || pkValue !== undefined;
        const skProvided =
          index.sk === "modelPrefix" || skValue !== undefined;
        if (pkProvided && !skProvided) {
          throw new Error(
            `Update includes GSI partition key "${index.pk}" for index "${indexName}" ` +
              `but is missing sort key "${index.sk}". Include both fields or use forceReindex.`,
          );
        }
        if (skProvided && !pkProvided) {
          throw new Error(
            `Update includes GSI sort key "${index.sk}" for index "${indexName}" ` +
              `but is missing partition key "${index.pk}". Include both fields or use forceReindex.`,
          );
        }
      }

      if (
        pkValue !== undefined &&
        skValue !== undefined &&
        index.indexId !== undefined
      ) {
        logger.debug("indexKeys", {
          pkValue,
          skValue,
          indexId: index.indexId,
        });
        const gsiPk = this._formatGsiKey(
          this.modelPrefix,
          index.indexId,
          pkValue,
        );
        indexKeys[`_${index.indexId}_pk`] = gsiPk;
        indexKeys[`_${index.indexId}_sk`] = skValue;
      }
    });

    return indexKeys;
  },
};

module.exports = MutationMethods;
