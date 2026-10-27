const {
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
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
const { computeSearchTextUpdate } = require("../utils/search-text");
const { SEARCH_TEXT_FIELD } = require("../constants");

/**
 * AND a guard onto an optional ConditionExpression. The existing expression
 * is parenthesized so a top-level OR in it can't swallow the guard, except
 * when it is already one parenthesized group: DynamoDB rejects redundant
 * parentheses, and the filter builder emits "$and"/"$or" groups that way.
 * @private
 */
function andCondition(existing, guard) {
  if (!existing) return guard;
  return `${isOneParenGroup(existing) ? existing : `(${existing})`} AND ${guard}`;
}

function isOneParenGroup(expr) {
  if (!expr.startsWith("(") || !expr.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    // The opening paren closed before the end: not a single group.
    if (depth === 0 && i < expr.length - 1) return false;
  }
  return true;
}

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

    // The row is read first only when the delete needs its contents: to
    // find unique-constraint values to clean up, or (mid key migration) to
    // learn which key shape the row actually lives at. Otherwise the key is
    // derived from the id and a single conditional DeleteItem does the work.
    const uniqueConstraints = Object.values(this.uniqueConstraints || {});
    const needsRead =
      uniqueConstraints.length > 0 || this._writesInPlaceWhileMigrating();

    let item = null;
    let key;
    if (needsRead) {
      item = await this.find(primaryId, { batchDelay: 0 });
      if (!item.exists()) {
        throw new ItemNotFoundError("Item not found", primaryId);
      }
      key = { _pk: item._dyData._pk, _sk: item._dyData._sk };
    } else {
      key = this._getDyKeyForPkSk(this._parsePrimaryId(primaryId));
    }

    // Check if we need to clean up any unique constraints
    const hasConstraintsToClean =
      item !== null &&
      uniqueConstraints.some((constraint) => {
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
              Key: key,
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
          Key: key,
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

        // Without a pre-read, the item's existence is checked by the delete
        // itself; a failure is mapped to ItemNotFoundError in the catch below.
        if (!item) {
          this._addExistsGuard(deleteParams);
        }

        response = await retryOperation(() =>
          this.documentClient.send(new DeleteCommand(deleteParams)),
        );
      }

      this._evictFromLoaderContext(primaryId);

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
        if (
          !item &&
          !(await this._existsAfterGuardFailure(primaryId, options))
        ) {
          throw new ItemNotFoundError("Item not found", primaryId);
        }
        throw new ConditionalError(
          "Delete condition not met",
          "delete",
          options.condition,
        );
      }
      throw error;
    }
  },

  /**
   * Whether an existing `pk === "modelPrefix"` row must be written at the
   * key it was loaded from rather than the canonical key (mid-migration).
   * Such writes need the row read first to learn that key.
   * @private
   */
  _writesInPlaceWhileMigrating() {
    return (
      this.primaryKey.pk === "modelPrefix" &&
      this._modelPrefixPkMode() === "migrating"
    );
  },

  /**
   * AND an `attribute_exists(_pk)` guard into a write's ConditionExpression.
   * Uses a "#__" placeholder so it can't clobber a field placeholder (user
   * field names can't start with "_"; filter placeholders are "#nN").
   * @private
   */
  _addExistsGuard(params) {
    params.ExpressionAttributeNames = {
      ...params.ExpressionAttributeNames,
      "#__existsPk": "_pk",
    };
    params.ConditionExpression = andCondition(
      params.ConditionExpression,
      "attribute_exists(#__existsPk)",
    );
  },

  /**
   * After a guarded write fails its condition check, decide whether the row
   * exists. With no caller condition the guard is the only thing that could
   * have failed, so no read is needed; otherwise one GetItem (cache
   * bypassed) tells a missing row apart from an unmet condition. Only the
   * failure path pays for this read.
   * @private
   */
  async _existsAfterGuardFailure(primaryId, options) {
    if (!options.condition) return false;
    const existing = await this.find(primaryId, {
      batchDelay: 0,
      bypassCache: true,
    });
    return existing.exists();
  },

  /**
   * @memberof BaoModel
   * @description
   * Relocate a single record's base-table row from a legacy `pk === "modelPrefix"`
   * key to the current canonical key. This is the per-record primitive used to
   * back-fill the `keyMigration.modelPrefixPkMode` migration.
   *
   * Must be called in "migrating" mode and under the row's tenant context (so
   * `getTenantId()` resolves the tenant the canonical `[tenant]#prefix` key is
   * built from). The row's full item is copied verbatim to the canonical key
   * (a conditional Put that won't clobber an existing canonical row), then the
   * legacy row is deleted. GSI entries and unique-constraint pointers are
   * unaffected (their keys never change; the pointer's relatedId is the
   * unchanged logical id), so only the base row moves.
   *
   * Idempotent and safe to re-run: a row already at the canonical key is left
   * alone; a stale legacy row left behind by an interrupted run is cleaned up.
   *
   * @param {string} primaryId - The record's logical primary id.
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false] - Inspect only; perform no writes.
   * @returns {Promise<{relocated: boolean, from: ?string, to: string, reason: (string|undefined)}>}
   */
  async relocateToCanonicalKey(primaryId, options = {}) {
    const { dryRun = false } = options;

    if (this.primaryKey.pk !== "modelPrefix") {
      throw new Error(
        `relocateToCanonicalKey is only valid for models whose primaryKey.pk is "modelPrefix" (got "${this.primaryKey.pk}" for ${this.name})`,
      );
    }
    if (this._modelPrefixPkMode() !== "migrating") {
      throw new Error(
        `relocateToCanonicalKey must be called in "migrating" mode (modelPrefixPkMode is "${this._modelPrefixPkMode()}")`,
      );
    }

    const pkSk = this._parsePrimaryId(primaryId);
    const canonicalKey = this._getDyKeyForPkSk(pkSk);
    const legacyKeys = this._legacyDyKeysForPkSk(pkSk);

    const get = (Key) =>
      this.documentClient
        .send(new GetCommand({ TableName: this.table, Key }))
        .then((r) => r.Item || null);

    // Already at the canonical key? Clean up any stale legacy duplicate, done.
    const canonicalItem = await get(canonicalKey);
    if (canonicalItem) {
      for (const legacyKey of legacyKeys) {
        const stale = await get(legacyKey);
        if (stale && !dryRun) {
          await this.documentClient.send(
            new DeleteCommand({ TableName: this.table, Key: legacyKey }),
          );
        }
      }
      return {
        relocated: false,
        from: null,
        to: canonicalKey._pk,
        reason: "already-canonical",
      };
    }

    // Find the row at a legacy key.
    let sourceItem = null;
    let sourceKey = null;
    for (const legacyKey of legacyKeys) {
      const item = await get(legacyKey);
      if (item) {
        sourceItem = item;
        sourceKey = legacyKey;
        break;
      }
    }

    if (!sourceItem) {
      return {
        relocated: false,
        from: null,
        to: canonicalKey._pk,
        reason: "not-found",
      };
    }
    if (dryRun) {
      return {
        relocated: true,
        from: sourceKey._pk,
        to: canonicalKey._pk,
        reason: "dry-run",
      };
    }

    // Put the full item at the canonical key (don't clobber a concurrently
    // created canonical row), then delete the legacy row. Put-before-delete so
    // the record is never absent.
    const newItem = {
      ...sourceItem,
      _pk: canonicalKey._pk,
      _sk: canonicalKey._sk,
    };
    try {
      await this.documentClient.send(
        new PutCommand({
          TableName: this.table,
          Item: newItem,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "_pk" },
        }),
      );
    } catch (error) {
      // A canonical row appeared concurrently — treat as already migrated and
      // fall through to delete the now-redundant legacy row.
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
    await this.documentClient.send(
      new DeleteCommand({ TableName: this.table, Key: sourceKey }),
    );

    return { relocated: true, from: sourceKey._pk, to: canonicalKey._pk };
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
    const { isNew = false, instanceObj = null, forceReindex = false } = options;

    // The id is used as a string below (iteration keys, the relatedId on
    // unique constraint rows), so accept an object id by normalizing it.
    if (!isNew) {
      primaryId = this._canonicalPrimaryId(primaryId);
    }

    logger.debug("saveItem", primaryId, isNew, instanceObj);
    let consumedCapacity = [];

    let currentItem = isNew ? null : instanceObj;

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

    // An update by id reads the current row only when the write depends on
    // it (see _updateNeedsCurrentItem). Otherwise the UpdateItem carries an
    // attribute_exists guard instead, so a missing row still surfaces as
    // ItemNotFoundError rather than being upserted as a partial row.
    let existsGuard = false;
    if (!isNew && !currentItem) {
      if (this._updateNeedsCurrentItem(dyUpdatesToSave, { forceReindex })) {
        currentItem = await this.find(primaryId, { batchDelay: 0 });
        if (!currentItem.exists()) {
          throw new ItemNotFoundError("Item not found", primaryId);
        }
        consumedCapacity = [
          ...consumedCapacity,
          ...currentItem.getConsumedCapacity(),
        ];
      } else {
        existsGuard = true;
      }
    }

    // A relative counter ("+3") is written with ADD, which DynamoDB applies
    // at write time, but an index key built from it needs the resulting
    // number. On a new item ADD just stores the delta, so write that. On an
    // existing item, a counter that's part of an index key is written as
    // the loaded value plus the delta, guarded on the loaded value, so a
    // concurrent change fails the update (ConditionalError) instead of
    // leaving the index key stale. Other counters keep the atomic ADD.
    const counterGuards = [];
    const { CounterFieldClass } = require("../fields");
    for (const [key, field] of Object.entries(this.fields)) {
      const dyValue = dyUpdatesToSave[key];
      if (
        !(field instanceof CounterFieldClass) ||
        typeof dyValue !== "string"
      ) {
        continue;
      }
      const delta = parseInt(dyValue, 10);
      let value;
      if (isNew) {
        value = delta;
      } else if (
        Object.values(this.indexes).some(
          (index) =>
            index.indexId !== undefined &&
            (index.pk === key || index.sk === key),
        )
      ) {
        const loadedValue = currentItem._loadedDyData[key];
        value = Number(loadedValue ?? 0) + delta;
        counterGuards.push({ fieldName: key, loadedValue });
      } else {
        continue;
      }
      dyUpdatesToSave[key] = value;
      indexComputationData[key] = value;
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
          // Nothing to backfill when one half is the modelPrefix constant:
          // if the field half is in the update both halves are known, and
          // if it is not, the index key does not change.
          if (pkField === "modelPrefix" || skField === "modelPrefix") {
            return;
          }
          const pkInUpdate = indexComputationData[pkField] !== undefined;
          const skInUpdate = indexComputationData[skField] !== undefined;

          if (pkInUpdate && !skInUpdate) {
            const currentValue = currentItem._dyData[skField];
            if (currentValue !== undefined) {
              indexComputationData[skField] = currentValue;
            }
          }
          if (skInUpdate && !pkInUpdate) {
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
          (jsUpdates[fieldName] === undefined || jsUpdates[fieldName] === null)
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

    // No pre-save uniqueness read: each constraint Put in the transaction
    // carries attribute_not_exists, and the catch block below runs
    // _validateUniqueConstraints to name the colliding field.

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
      const iterationKeys = this._getIterationKeys(primaryId, dyUpdatesToSave);
      Object.assign(dyUpdatesToSave, iterationKeys);
    }

    // Compute _searchText if the model is searchable. Returns undefined to
    // skip the write entirely, null to REMOVE, or a string to SET.
    if (this.searchable && this.searchConfig) {
      const searchTextValue = computeSearchTextUpdate({
        searchConfig: this.searchConfig,
        dyUpdatesToSave,
        currentItem,
        isNew,
        forceReindex,
      });
      if (searchTextValue !== undefined) {
        dyUpdatesToSave[SEARCH_TEXT_FIELD] = searchTextValue;
      }
    }

    // Build the update expression first
    const { updateExpression, names, values, hasAtomicOps } =
      this._buildUpdateExpression(dyUpdatesToSave, currentItem);

    // Key to write to. Normally the canonical key. But for an EXISTING
    // `pk === "modelPrefix"` row in "migrating" mode, write in place at the
    // row's current (possibly legacy) key so we update the full row rather
    // than create a partial duplicate at the canonical key. The backfill is
    // what relocates rows to the canonical key; deletes already target the
    // loaded key. New items always use the canonical key.
    let writeKey = this._getDyKeyForPkSk(this._parsePrimaryId(primaryId));
    let inPlaceMigratingUpdate = false;
    if (
      !isNew &&
      this.primaryKey.pk === "modelPrefix" &&
      this._modelPrefixPkMode() === "migrating" &&
      currentItem?._dyData?._pk
    ) {
      writeKey = {
        _pk: currentItem._dyData._pk,
        _sk: currentItem._dyData._sk,
      };
      inPlaceMigratingUpdate = true;
    }

    // Create the base update params
    const updateParams = {
      TableName: this.table,
      Key: writeKey,
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
    }

    if (isNew) {
      // For new items, ensure they don't already exist, ANDed with any
      // caller-supplied condition. _buildUpdateExpression maps each field
      // to "#<fieldName>"; user field names can't start with "_" and no
      // system field starts with "__", so a "#__" placeholder can't clobber
      // one.
      updateParams.ConditionExpression = andCondition(
        updateParams.ConditionExpression,
        "attribute_not_exists(#__newItemPk)",
      );
      updateParams.ExpressionAttributeNames = {
        ...updateParams.ExpressionAttributeNames,
        "#__newItemPk": "_pk",
      };
    }

    if (existsGuard) {
      this._addExistsGuard(updateParams);
    }

    if (inPlaceMigratingUpdate) {
      // Updating the row in place at its current (legacy) key. Guard with
      // attribute_exists so a concurrent backfill that relocated/deleted the
      // legacy row can't make this UpdateItem upsert a partial row — it fails
      // loudly (ConditionalError) instead, and the caller can retry, which
      // will then find and update the relocated canonical row. ANDed with any
      // caller-supplied condition.
      //
      // Use a "#__" placeholder so we never clobber a field placeholder
      // (see the new-item guard above).
      updateParams.ExpressionAttributeNames = {
        ...updateParams.ExpressionAttributeNames,
        "#__migExistsPk": "_pk",
      };
      updateParams.ConditionExpression = andCondition(
        updateParams.ConditionExpression,
        "attribute_exists(#__migExistsPk)",
      );
    }

    for (const { fieldName, loadedValue } of counterGuards) {
      const name = `#__counterGuard_${fieldName}`;
      const value = `:__counterGuard_${fieldName}`;
      updateParams.ExpressionAttributeNames = {
        ...updateParams.ExpressionAttributeNames,
        [name]: fieldName,
      };
      let guard = `attribute_not_exists(${name})`;
      if (loadedValue != null) {
        guard = `${name} = ${value}`;
        updateParams.ExpressionAttributeValues = {
          ...updateParams.ExpressionAttributeValues,
          [value]: loadedValue,
        };
      }
      updateParams.ConditionExpression = andCondition(
        updateParams.ConditionExpression,
        guard,
      );
    }

    const dyKey = writeKey;
    logger.debug("dyKey", dyKey);

    try {
      let response;

      if (hasUniqueConstraintChanges) {
        // Use transaction if we have unique constraint changes
        transactItems.push({
          Update: updateParams,
        });

        if (logger.isDebugEnabled()) {
          logger.debug("transactItems", JSON.stringify(transactItems, null, 2));
        }

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

        // transactWrite doesn't return values. When the expression is only
        // SET/REMOVE the written row is fully determined: a new item is its
        // key plus what we wrote, and an update is the row we loaded with
        // our writes applied, so build it locally and save a round trip.
        // Fields this write didn't touch reflect the row as loaded, which
        // is the same staleness a caller-held instance already has. Only
        // an ADD/DELETE (counter, set diff) needs a read-back, bypassing the
        // loader cache, which still holds the pre-update row.
        let savedItem;
        if (isNew || !hasAtomicOps) {
          const base = isNew
            ? {}
            : currentItem.isLoaded()
              ? currentItem._loadedDyData
              : currentItem._dyData;
          const storedItem = { ...base, ...dyKey };
          for (const [key, value] of Object.entries(dyUpdatesToSave)) {
            if (value === undefined) continue;
            if (value === null) {
              delete storedItem[key];
            } else {
              storedItem[key] = value;
            }
          }
          savedItem = this._createFromDyItem(storedItem);
        } else {
          const readOptions = { batchDelay: 0, bypassCache: true };
          savedItem = await this.find(primaryId, readOptions);

          // if the item doesn't exist, sleep for 200ms and try again
          if (!savedItem.exists()) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            savedItem = await this.find(primaryId, readOptions);
          }
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
        // The loaded row's capacity was counted in the request total when
        // it was consumed, so don't count it again.
        savedItem._addConsumedCapacity(consumedCapacity, "read", false, true);

        this._primeLoaderContext(primaryId, savedItem);
        return savedItem;
      } else {
        // Use simple update if no unique constraints are changing
        if (logger.isDebugEnabled()) {
          logger.debug("updateParams", JSON.stringify(updateParams, null, 2));
        }

        response = await retryOperation(() =>
          this.documentClient.send(
            new UpdateCommand({
              ...updateParams,
              ReturnConsumedCapacity: "TOTAL",
            }),
          ),
        );

        const savedItem = this._createFromDyItem(response.Attributes);
        logger.debug("savedItem", savedItem);

        savedItem._setConsumedCapacity(
          response.ConsumedCapacity,
          "write",
          false,
        );
        // The loaded row's capacity was counted in the request total when
        // it was consumed, so don't count it again.
        savedItem._addConsumedCapacity(consumedCapacity, "read", false, true);

        if (!savedItem.exists()) {
          throw new ConditionalError("Failed to fetch saved item", "update");
        }

        this._primeLoaderContext(primaryId, savedItem);
        return savedItem;
      }
    } catch (error) {
      // A failed condition (caller condition, duplicate key, missing row,
      // taken unique value) is an expected outcome that is mapped to a
      // typed error below, so it is only worth a debug line. Anything
      // else is logged once, here, and rethrown as-is.
      const isConditionFailure =
        error.name === "ConditionalCheckFailedException" ||
        (error.name === "TransactionCanceledException" &&
          error.CancellationReasons?.some(
            (reason) => reason.Code === "ConditionalCheckFailed",
          ));
      if (isConditionFailure) {
        logger.debug(`${this.name} save condition failed for`, primaryId);
      } else {
        logger.error(`${this.name} save failed for ${primaryId}:`, error);
      }

      if (error.name === "ConditionalCheckFailedException") {
        if (
          existsGuard &&
          !(await this._existsAfterGuardFailure(primaryId, options))
        ) {
          throw new ItemNotFoundError("Item not found", primaryId);
        }
        throw new ConditionalError("Condition check failed", "update", error);
      }

      if (error.name === "TransactionCanceledException") {
        // A taken unique value cancels the transaction; this read throws a
        // ConditionalError naming the field if that's the cause.
        await this._validateUniqueConstraints(
          jsUpdates,
          isNew ? null : primaryId,
        );

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
      }
      throw error;
    }
  },

  /**
   * Whether an update by id has to read the current row before writing.
   * The row is needed to backfill the other half of a GSI key pair, to
   * diff a StringSet, to guard an indexed counter, to compare a unique
   * constraint's old value, to rebuild _searchText from untouched source
   * fields, to reindex everything, or (mid key migration) to find the key
   * the row lives at. A write touching none of those is a plain SET/REMOVE
   * of the given attributes and can go straight to DynamoDB.
   * @private
   * @param {Object} dyUpdatesToSave - Attributes the write will touch
   * @param {{forceReindex: boolean}} options
   * @returns {boolean}
   */
  _updateNeedsCurrentItem(dyUpdatesToSave, { forceReindex = false } = {}) {
    if (forceReindex || this._writesInPlaceWhileMigrating()) {
      return true;
    }

    const { StringSetFieldClass } = require("../fields");
    const indexes = Object.values(this.indexes).filter(
      (index) => index.indexId !== undefined,
    );
    for (const fieldName of Object.keys(dyUpdatesToSave)) {
      if (
        indexes.some(
          (index) => index.pk === fieldName || index.sk === fieldName,
        )
      ) {
        return true;
      }
      if (this.fields[fieldName] instanceof StringSetFieldClass) {
        return true;
      }
    }

    for (const constraint of Object.values(this.uniqueConstraints || {})) {
      if (constraint.field in dyUpdatesToSave) return true;
    }

    if (this.searchable && this.searchConfig) {
      const searchFields = this.searchConfig.fields || [];
      if (searchFields.some((f) => f in dyUpdatesToSave)) return true;
    }

    return false;
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
      // ADD/DELETE are applied by DynamoDB against the stored value, so the
      // written row can't be predicted locally; SET/REMOVE can.
      hasAtomicOps: addExpressions.length > 0 || deleteExpressions.length > 0,
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

      // Detect partial GSI key updates that would cause index staleness.
      // A "modelPrefix" half is a constant, so an update that leaves the
      // other half alone leaves the index key unchanged: skip it rather
      // than treat the constant as a newly provided key.
      if (isUpdate && index.indexId !== undefined) {
        if (
          (index.pk === "modelPrefix" && skValue === undefined) ||
          (index.sk === "modelPrefix" && pkValue === undefined)
        ) {
          return;
        }
        const pkProvided = pkValue !== undefined;
        const skProvided = skValue !== undefined;
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
