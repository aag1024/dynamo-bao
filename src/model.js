/**
 * @description
 * This module contains the core functionality for models in Bao.
 */

const { RelatedFieldClass, StringField } = require("./fields");
const { ModelManager } = require("./model-manager");
const { defaultLogger: logger } = require("./utils/logger");
const { ObjectNotFound } = require("./object-not-found");
const ValidationMethods = require("./mixins/validation-mixin");
const UniqueConstraintMethods = require("./mixins/unique-constraint-mixin");
const QueryMethods = require("./mixins/query-mixin");
const MutationMethods = require("./mixins/mutation-mixin");
const {
  BatchLoadingMethods,
  BATCH_REQUESTS,
  BATCH_REQUEST_TIMEOUT,
} = require("./mixins/batch-loading-mixin");

const {
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("./model-config");

const GID_SEPARATOR = "##__SK__##";
const { UNIQUE_CONSTRAINT_KEY, SYSTEM_FIELDS } = require("./constants");

/**
 * @description
 * Base model that implements core functionality for all models. Do not instantiate
 * this class directly, instead use a subclass, usually that has been generated
 * by the code generator.
 */
class BaoModel {
  static _testId = null;
  static table = null;
  static documentClient = null;

  // These should be overridden by child classes
  static modelPrefix = null;
  static fields = {};
  static primaryKey = null;
  static indexes = {};
  static uniqueConstraints = {};

  static defaultQueryLimit = 100;

  static {
    // Initialize methods
    Object.assign(BaoModel, ValidationMethods);
    Object.assign(BaoModel, UniqueConstraintMethods);
    Object.assign(BaoModel, QueryMethods);
    Object.assign(BaoModel, MutationMethods);
    Object.assign(BaoModel, BatchLoadingMethods);
  }

  /**
   * @description
   * ONLY use this for testing. It allows tests to run in isolation and
   * prevent data from being shared between tests/tests to run in parallel.
   * However, it should not be used outside of this context. For examples,
   * showing how to use this, see the tests.
   * @param {string} testId - The ID of the test.
   */
  static setTestId(testId) {
    this._testId = testId;
    const manager = ModelManager.getInstance(testId);
    this.documentClient = manager.documentClient;
    this.table = manager.tableName;
  }

  static get manager() {
    return ModelManager.getInstance(this._testId);
  }

  static _getField(fieldName) {
    let fieldDef;
    if (SYSTEM_FIELDS.includes(fieldName) || fieldName === "modelPrefix") {
      fieldDef = StringField();
    } else {
      fieldDef = this.fields[fieldName];
    }

    if (!fieldDef) {
      throw new Error(`Field ${fieldName} not found in ${this.name} fields`);
    }

    return fieldDef;
  }

  static _getPkValue(data) {
    if (!data) {
      throw new Error("Data object is required for static _getPkValue call");
    }

    const pkValue =
      this.primaryKey.pk === "modelPrefix"
        ? this.modelPrefix
        : data[this.primaryKey.pk];

    logger.debug("_getPkValue", pkValue);

    return pkValue;
  }

  static _getSkValue(data) {
    if (!data) {
      throw new Error("Data object is required for static _getSkValue call");
    }

    if (this.primaryKey.sk === "modelPrefix") {
      return this.modelPrefix;
    }
    return data[this.primaryKey.sk];
  }

  _getPkValue() {
    return this.constructor._getPkValue(this._dyData);
  }

  _getSkValue() {
    return this.constructor._getSkValue(this._dyData);
  }

  static _formatGsiKey(modelPrefix, indexId, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${modelPrefix}#${indexId}#${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static _formatPrimaryKey(modelPrefix, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${modelPrefix}#${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static _formatUniqueConstraintKey(constraintId, modelPrefix, field, value) {
    const testId = this.manager.getTestId();
    const baseKey = `${UNIQUE_CONSTRAINT_KEY}#${constraintId}#${modelPrefix}#${field}:${value}`;
    return testId ? `[${testId}]#${baseKey}` : baseKey;
  }

  static _getDyKeyForPkSk(pkSk) {
    if (this.primaryKey.sk === "modelPrefix") {
      return {
        _pk: this._formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: this.modelPrefix,
      };
    } else if (this.primaryKey.pk === "modelPrefix") {
      return {
        _pk: this.modelPrefix,
        _sk: pkSk.sk,
      };
    } else {
      return {
        _pk: this._formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: pkSk.sk,
      };
    }
  }

  /**
   * @description
   * Create a new model instance.
   * @param {Object} [jsData] - The initial data for the model.
   */
  constructor(jsData = {}) {
    this._dyData = {};
    SYSTEM_FIELDS.forEach((key) => {
      if (jsData[key] !== undefined) {
        this._dyData[key] = jsData[key];
      }
    });

    this._loadedDyData = {};
    this._changes = new Set();
    this._relatedObjects = {};
    this._consumedCapacity = [];

    // Initialize fields with data
    Object.entries(this.constructor.fields).forEach(([fieldName, field]) => {
      // Convert initial value to DynamoDB format
      let value =
        jsData[fieldName] === undefined
          ? field.getInitialValue()
          : jsData[fieldName];
      this._dyData[fieldName] = field.toDy(value);

      // Define property getter/setter that always works with _dyData
      Object.defineProperty(this, fieldName, {
        get: () => field.fromDy(this._dyData[fieldName]),
        set: (newValue) => {
          const oldDyValue = this._dyData[fieldName];
          const newDyValue = field.toDy(newValue);
          if (newDyValue !== oldDyValue) {
            this._dyData[fieldName] = newDyValue;
            this._changes.add(fieldName);
            if (field instanceof RelatedFieldClass) {
              delete this._relatedObjects[fieldName];
            }
          }
        },
      });
    });
  }

  static _createFromDyItem(dyItem) {
    const newObj = new this();
    newObj._dyData = dyItem;
    newObj._resetChangeTracking();

    logger.debug("_createFromDyItem", dyItem, newObj);
    logger.debug("_createFromDyItem.name", newObj.name);
    return newObj;
  }

  /**
   * @description
   * Clear the related cache for a given field.
   * @param {string} fieldName - The name of the field to clear.
   */
  clearRelatedCache(fieldName) {
    delete this._relatedObjects[fieldName];
  }

  // Returns the pk and sk values for a given object. These are encoded to work with
  // dynamo string keys. No test prefix or model prefix is applied.
  static _getPrimaryKeyValues(data) {
    if (!data) {
      throw new Error("Data object is required for _getPrimaryKeyValues call");
    }

    const pkField = this._getField(this.primaryKey.pk);
    const skField = this._getField(this.primaryKey.sk);

    if (skField === undefined && this.primaryKey.sk !== "modelPrefix") {
      throw new Error(`SK field is required for getPkSk call`);
    }

    if (pkField === undefined && this.primaryKey.pk !== "modelPrefix") {
      throw new Error(`PK field is required for getPkSk call`);
    }

    // If the field is set, use the GSI value, otherwise use the raw value
    const pkValue = pkField
      ? pkField.toGsi(this._getPkValue(data))
      : this._getPkValue(data);
    const skValue = skField
      ? skField.toGsi(this._getSkValue(data))
      : this._getSkValue(data);

    if (
      pkValue === undefined ||
      skValue === undefined ||
      pkValue === null ||
      skValue === null
    ) {
      throw new Error(`PK and SK must be defined to get a PkSk`);
    }

    let key = {
      pk: pkValue,
      sk: skValue,
    };

    logger.debug("_getPrimaryKeyValues", key);

    return key;
  }

  /**
   * @description
   * Static version of {@link BaoModel#getPrimaryId}.
   * @param {Object} data - The data object to get the primary ID for.
   * @returns {string} The primary ID.
   */
  static getPrimaryId(data) {
    logger.debug("getPrimaryId", data);
    const pkSk = this._getPrimaryKeyValues(data);
    logger.debug("getPrimaryId", pkSk);

    let primaryId;
    if (this.primaryKey.pk === "modelPrefix") {
      primaryId = pkSk.sk;
    } else if (this.primaryKey.sk === "modelPrefix") {
      primaryId = pkSk.pk;
    } else {
      primaryId = pkSk.pk + GID_SEPARATOR + pkSk.sk;
    }

    return primaryId;
  }

  /**
   * @description
   * Get the primary ID for a given object. This is a string that uniquely
   * identifies the object in the database. When using {@link BaoModel.find},
   * this is the id to use. Do not make assumptions about how this id
   * is formatted since it will depend on the model key structure.
   * @returns {string} The primary ID.
   */
  getPrimaryId() {
    return this.constructor.getPrimaryId(this._dyData);
  }

  static _parsePrimaryId(primaryId) {
    if (!primaryId) {
      throw new Error("Primary ID is required to parse");
    }

    if (primaryId.indexOf(GID_SEPARATOR) !== -1) {
      const [pk, sk] = primaryId.split(GID_SEPARATOR);
      return { pk, sk };
    } else {
      if (this.primaryKey.pk === "modelPrefix") {
        return { pk: this.modelPrefix, sk: primaryId };
      } else if (this.primaryKey.sk === "modelPrefix") {
        return { pk: primaryId, sk: this.modelPrefix };
      } else {
        throw new Error(`Invalid primary ID: ${primaryId}`);
      }
    }
  }

  // Get all data - convert from Dynamo to JS format
  _getAllData() {
    const allData = {};
    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      allData[fieldName] = field.fromDy(this._dyData[fieldName]);
    }
    return allData;
  }

  // Get only changed fields - convert from Dynamo to JS format
  _getChanges() {
    const changes = {};
    logger.debug("_changes Set contains:", Array.from(this._changes));
    for (const field of this._changes) {
      const fieldDef = this.constructor._getField(field);
      logger.debug("Field definition for", field, ":", {
        type: fieldDef.constructor.name,
        field: fieldDef,
      });
      const dyValue = this._dyData[field];
      logger.debug("Converting value:", {
        field,
        dyValue,
        fromDyExists: typeof fieldDef.fromDy === "function",
      });
      changes[field] = fieldDef.fromDy(dyValue);
    }
    return changes;
  }

  /**
   * @description
   * Returns true if any fields have been modified since the object was last
   * loaded from the database.
   * @returns {boolean} True if there are changes, false otherwise.
   */
  hasChanges() {
    return this._changes.size > 0;
  }

  /**
   * @description
   * Returns true if the object has been loaded from the database.
   * @returns {boolean} True if the object has been loaded, false otherwise.
   */
  isLoaded() {
    return Object.keys(this._loadedDyData).length > 0;
  }

  // Reset tracking after successful save
  _resetChangeTracking() {
    this._loadedDyData = { ...this._dyData };
    this._changes.clear();
  }

  /**
   * @description
   * Save the current object to the database. This operation will diff the current
   * state of the object with the state that has been loaded from dynamo to
   * determine which changes need to be saved.
   *
   * @param {Object} [options] - Additional options for the save operation.
   * @param {Object} [options.constraints={}] - Constraints to validate. Options are:
   * @param {boolean} [options.constraints.mustExist=false] - Whether the item must exist.
   * @param {boolean} [options.constraints.mustNotExist=false] - Whether the item must not exist.
   * @param {string[]} [options.constraints.fieldMatches=[]] - An array of field names that must match
   * the current item's loaded state. This is often used for optimistic locking in conjunction
   * with a {@link BaoFields.VersionField} field.
   * @returns {Promise<Object>} Returns a promise that resolves to the updated item.
   */
  async save(options = {}) {
    if (!this.hasChanges() && this.isLoaded()) {
      logger.debug("save() - no changes to save");
      return this; // No changes to save
    }

    let changes = null;
    if (!this.isLoaded()) {
      options.isNew = true;
      changes = this._getAllData();
    } else {
      changes = this._getChanges();
    }

    logger.debug("save() - changes", changes);
    const updatedObj = await this.constructor.update(
      this.getPrimaryId(),
      changes,
      { instanceObj: this, ...options },
    );

    logger.debug("save() - updatedObj", updatedObj);
    this._dyData = updatedObj._dyData;
    logger.debug("save() - this", this);

    // Reset change tracking after successful save
    this._resetChangeTracking();

    return this;
  }

  /**
   * @description
   * Get or load a related field. If the field is already loaded, it will be
   * returned without reloading. Otherwise, it will be loaded from the database
   * and returned.
   * @param {string} fieldName - The name of the field to get or load.
   * @param {Object} [loaderContext] - Cache context for storing and retrieving items across requests.
   * @returns {Promise<Object>} Returns a promise that resolves to the loaded item.
   */
  async getOrLoadRelatedField(fieldName, loaderContext = null) {
    if (this._relatedObjects[fieldName]) {
      return this._relatedObjects[fieldName];
    }

    const field = this.constructor.fields[fieldName];
    if (!field || !field.modelName) {
      throw new Error(`Field ${fieldName} is not a valid relation field`);
    }

    const value = this[fieldName];
    if (!value) return null;

    const ModelClass = this.constructor.manager.getModel(field.modelName);
    this._relatedObjects[fieldName] = await ModelClass.find(value, {
      loaderContext,
    });
    return this._relatedObjects[fieldName];
  }

  /**
   * @description
   * Load objects for RelatedField's on the current model instance.
   * @param {string[]} [fieldNames] - The names of the fields to load. If not provided, all related fields will be loaded.
   * @param {Object} [loaderContext] - Cache context for storing and retrieving items across requests.
   * @returns {Promise<Object>} Returns a promise that resolves to the loaded items and their consumed capacity
   */
  async loadRelatedData(fieldNames = null, loaderContext = null) {
    const promises = [];

    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      if (fieldNames && !fieldNames.includes(fieldName)) {
        continue;
      }

      if (field instanceof RelatedFieldClass && this[fieldName]) {
        promises.push(
          this._loadRelatedField(fieldName, field, loaderContext).then(
            (instance) => {
              this._relatedObjects[fieldName] = instance;
            },
          ),
        );
      }
    }

    await Promise.all(promises);
    return this;
  }

  async _loadRelatedField(fieldName, field, loaderContext = null) {
    const value = this[fieldName];
    if (!value) return null;

    const ModelClass = this.constructor.manager.getModel(field.modelName);

    if (value instanceof ModelClass) {
      return value;
    }

    // Load the instance and track its capacity
    const relatedInstance = await ModelClass.find(value, { loaderContext });

    return relatedInstance;
  }

  /**
   * @description
   * Get a related field. If the field is not loaded, it will return null.
   * @param {string} fieldName - The name of the field to get.
   * @returns {Object} The related field.
   */
  getRelated(fieldName) {
    const field = this.constructor.fields[fieldName];
    if (!(field instanceof RelatedFieldClass)) {
      throw new Error(`Field ${fieldName} is not a RelatedField`);
    }
    return this._relatedObjects[fieldName];
  }

  /**
   * @description
   * Find an object by a unique constraint. Any unique constraint can also be used
   * to find an object.
   * @param {string} constraintName - The name of the unique constraint to use.
   * @param {string} value - The value of the unique constraint.
   * @param {Object} [loaderContext] - Cache context for storing and retrieving items across requests.
   * @returns {Promise<Object>} Returns a promise that resolves to the found item.
   */
  static async findByUniqueConstraint(
    constraintName,
    value,
    loaderContext = null,
  ) {
    const constraint = this.uniqueConstraints[constraintName];
    if (!constraint) {
      throw new Error(
        `Unknown unique constraint '${constraintName}' in ${this.name}`,
      );
    }

    if (!value) {
      throw new Error(`${constraint.field} value is required`);
    }

    const key = this._formatUniqueConstraintKey(
      constraint.constraintId,
      this.modelPrefix,
      constraint.field,
      value,
    );

    const result = await this.documentClient.get({
      TableName: this.table,
      Key: {
        _pk: key,
        _sk: UNIQUE_CONSTRAINT_KEY,
      },
      ReturnConsumedCapacity: "TOTAL",
    });

    if (!result.Item) {
      return new ObjectNotFound(result.ConsumedCapacity);
    }

    const item = await this.find(result.Item.relatedId, { loaderContext });

    if (item) {
      item._addConsumedCapacity(result.ConsumedCapacity);
    }

    return item;
  }

  /**
   * @description
   * Returns true if the object exists. This is particularly useful when checking
   * if an object has been found, since ObjectNotFound will be returned
   * rather than null if an object is not found (so capacity information
   * will also be returned).
   * @returns {boolean} True if the object exists, false otherwise.
   */
  exists() {
    return true;
  }

  _setConsumedCapacity(capacity, type = "read", fromContext = false) {
    this.clearConsumedCapacity();
    this._addConsumedCapacity(capacity, type, fromContext);
  }

  _addConsumedCapacity(capacity, type = "read", fromContext = false) {
    if (type !== "read" && type !== "write" && type !== "total") {
      throw new Error(`Invalid consumed capacity type: ${type}`);
    }

    if (!capacity) {
      return;
    }

    if (Array.isArray(capacity)) {
      capacity.forEach((item) =>
        this._addConsumedCapacity(item, type, fromContext),
      );
    } else {
      if (capacity.consumedCapacity) {
        this._consumedCapacity.push({
          consumedCapacity: capacity.consumedCapacity,
          fromContext: capacity.fromContext || fromContext,
          type: capacity.type || type,
        });
      } else {
        this._consumedCapacity.push({
          consumedCapacity: capacity,
          fromContext: fromContext,
          type: type,
        });
      }
    }
  }

  /**
   * Get the number of RCU/WCU consumed by a model instance. Additional capacity
   * is added every time a new operation (finding, saving, loading related data)
   * is performed on the instance. You can reset the consumed capacity by calling
   * {@link BaoModel#clearConsumedCapacity}.
   * @param {string} type - Either "read", "write", or "total".
   * @param {boolean} [includeRelated=false] - Whether to include capacity from related objects.
   * @returns {number} The numeric consumed capacity.
   */
  getNumericConsumedCapacity(type, includeRelated = false) {
    if (type !== "read" && type !== "write" && type !== "total") {
      throw new Error(`Invalid consumed capacitytype: ${type}`);
    }

    let consumedCapacity = this._consumedCapacity;
    if (!consumedCapacity) {
      consumedCapacity = [];
    }

    let total = consumedCapacity.reduce((sum, capacity) => {
      if (
        !capacity.fromContext &&
        (capacity.type === type || type === "total")
      ) {
        return sum + (capacity.consumedCapacity?.CapacityUnits || 0);
      }
      return sum;
    }, 0);

    if (includeRelated) {
      // Sum up capacity from any loaded related objects
      for (const relatedObj of Object.values(this._relatedObjects)) {
        if (relatedObj) {
          const relatedCapacity = relatedObj.getNumericConsumedCapacity(
            type,
            true,
          );
          total += relatedCapacity;
        }
      }
    }

    return total;
  }

  /**
   * @description
   * Get the consumed capacity for the current model instance. Every entry
   * in this array will represent a separate operation.
   * @returns {Object[]} The consumed capacity.
   */
  getConsumedCapacity() {
    return this._consumedCapacity;
  }

  /**
   * @description
   * Clear the consumed capacity for the current model instance.
   */
  clearConsumedCapacity() {
    this._consumedCapacity = [];
  }
}

module.exports = {
  BaoModel,
  PrimaryKeyConfig: (pk, sk) => new PrimaryKeyConfig(pk, sk),
  IndexConfig: (pk, sk, indexId) => new IndexConfig(pk, sk, indexId),
  UniqueConstraintConfig: (field, constraintId) =>
    new UniqueConstraintConfig(field, constraintId),
  BATCH_REQUEST_TIMEOUT,
  BATCH_REQUESTS,
};
