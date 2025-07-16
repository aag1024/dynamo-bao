/**
 * @namespace BaoFields
 * @description
 * This module contains the built-in fields for Bao.
 */
const { ulid, decodeTime } = require("ulid");
const { defaultLogger: logger } = require("./utils/logger");
const { ValidationError } = require("./exceptions");

/**
 * @class BaoBaseField
 * @memberof BaoFields
 * @description
 * Base class for all fields. Do not instantiate this class directly.
 */
class BaoBaseField {
  constructor(options = {}) {
    this.options = options;
    this.required = options.required || false;
    this.defaultValue = options.defaultValue;
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Get the initial JS value for the field.
   * @returns {any} The initial value for the field.
   */
  getInitialValue() {
    if (this.defaultValue) {
      return typeof this.defaultValue === "function"
        ? this.defaultValue()
        : this.defaultValue;
    }
    return undefined;
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Validate the JS field value.
   * @param {any} value - The value to validate.
   * @returns {boolean} True if the value is valid, otherwise false.
   */
  validate(value) {
    if (this.required && (value === null || value === undefined)) {
      throw new ValidationError("Field is required", null, value);
    }
    return true;
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Convert the field value from the JS representation to DynamoDB representation.
   * @param {any} value - The value to convert.
   * @returns {any} The converted value.
   */
  toDy(value) {
    return value;
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Convert the field value from the DynamoDB representation to the JS representation.
   * @param {any} value - The value to convert.
   * @returns {any} The converted value.
   */
  fromDy(value) {
    return value;
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Convert the field value from the JS representation the index format used by DynamoDB.
   * This must be a string representation of the value. Pay special attention to
   * how this value sorts since it will be used for sort keys.
   * @param {any} value - The value to convert.
   * @returns {any} The converted value.
   */
  toGsi(value) {
    return String(value);
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Convert the field value from the index format used by DynamoDB to the JS representation.
   * @param {any} value - The value to convert.
   * @returns {any} The converted value.
   */
  fromGsi(value) {
    return this.fromDy(value);
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Get the DynamoDB update expression for the field. You usually don't need to override this.
   * By default, it will return a SET expression, unless the value is null. If the value is null,
   * it will remove the attribute from the item .
   *
   * @param {string} fieldName - The name of the field.
   * @param {any} value - The value to update.
   * @returns {Object} The update expression.
   */
  getUpdateExpression(fieldName, value) {
    if (value === undefined) return null;

    const attributeName = `#${fieldName}`;
    const attributeValue = `:${fieldName}`;

    if (value === null) {
      return {
        type: "REMOVE",
        expression: `${attributeName}`,
        attrNameKey: attributeName,
        attrValueKey: attributeValue,
        fieldName: fieldName,
        fieldValue: null,
      };
    }

    return {
      type: "SET",
      expression: `${attributeName} = ${attributeValue}`,
      attrNameKey: attributeName,
      attrValueKey: attributeValue,
      fieldName: fieldName,
      fieldValue: value,
    };
  }

  /**
   * @memberof BaoFields.BaoBaseField
   * @description
   * Update the field value before saving. An example of where you might override this
   * is a modified date field that you want to update to the current date/time before
   * saving.
   * @param {any} value - The value to update.
   * @param {BaoModel} currentObject - The current model instance.
   * @returns {any} The updated value.
   */
  updateBeforeSave(value, currentObject) {
    // Default implementation does nothing
    return value;
  }
}

/**
 * @class StringField
 * @memberof BaoFields
 * @description
 * A field that stores a string value.
 */
class StringField extends BaoBaseField {
  validate(value) {
    if (this.required && !value) {
      throw new ValidationError("Field is required", null, value);
    }
    if (value && this.maxLength && value.length > this.maxLength) {
      throw new ValidationError(
        `Value exceeds maximum length of ${this.maxLength}`,
        null,
        value,
      );
    }
    return true;
  }
}

/**
 * @class DateTimeField
 * @memberof BaoFields
 * @description
 * A field that stores a date/time value.
 */
class DateTimeField extends BaoBaseField {
  validate(value) {
    if (this.required && value === undefined) {
      throw new ValidationError("Field is required", null, value);
    }
    if (
      value !== undefined &&
      !(value instanceof Date) &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      throw new ValidationError(
        "DateTimeField value must be a Date object, timestamp number, or ISO string",
        null,
        value,
      );
    }
  }

  toDy(value) {
    if (!value) return null;

    try {
      // Convert any input to timestamp
      if (value instanceof Date) {
        return value.getTime();
      }
      if (typeof value === "string") {
        return new Date(value).getTime();
      }
      if (typeof value === "number") {
        return value;
      }
      return null;
    } catch (error) {
      console.warn("Error converting date value:", error);
      return null;
    }
  }

  fromDy(value) {
    if (!value) return null;
    try {
      return new Date(Number(value));
    } catch (error) {
      console.warn("Error parsing date value:", error);
      return null;
    }
  }

  toGsi(value) {
    if (!value) return "0";
    try {
      // Convert to timestamp string with padding for correct sorting
      const timestamp = this.toDy(value);
      if (!timestamp) return "0";
      const result = timestamp.toString().padStart(20, "0");
      // logger.log('Converting to GSI:', { value, timestamp, result });
      return result;
    } catch (error) {
      console.warn("Error converting date for GSI:", error);
      return "0";
    }
  }
}

/**
 * @class IntegerField
 * @memberof BaoFields
 * @description
 * A field that stores an integer value.
 */
class IntegerField extends BaoBaseField {
  getInitialValue() {
    return this.options.defaultValue !== undefined
      ? this.options.defaultValue
      : null;
  }

  toDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    return Number(value);
  }

  fromDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    return parseInt(value, 10);
  }

  toGsi(value) {
    // Pad with zeros for proper string sorting
    return value != null ? value.toString().padStart(20, "0") : "";
  }
}

/**
 * @class FloatField
 * @memberof BaoFields
 * @description
 * A field that stores a floating point number value.
 */
class FloatField extends BaoBaseField {
  getInitialValue() {
    return this.options.defaultValue !== undefined
      ? this.options.defaultValue
      : null;
  }

  toDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    const num = Number(value);
    if (this.options.precision !== undefined && !isNaN(num)) {
      return Number(num.toFixed(this.options.precision));
    }
    return num;
  }

  fromDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    return parseFloat(value);
  }

  toGsi(value) {
    // Scientific notation with padding for consistent sorting
    return value != null ? value.toExponential(20) : "";
  }
}

/**
 * @class CreateDateField
 * @memberof BaoFields
 * @description
 * A field that stores a date/time value based on when the object was created.
 */
class CreateDateField extends DateTimeField {
  constructor(options = {}) {
    super({
      ...options,
      required: true,
    });
  }

  getInitialValue() {
    return new Date();
  }

  toDy(value) {
    if (!value) {
      return Date.now();
    }
    return value instanceof Date ? value.getTime() : value;
  }
}

/**
 * @class ModifiedDateField
 * @memberof BaoFields
 * @description
 * A field that stores a date/time value based on when the object was last modified.
 */
class ModifiedDateField extends DateTimeField {
  constructor(options = {}) {
    super({
      ...options,
      required: true,
    });
  }

  getInitialValue() {
    return new Date();
  }

  toDy(value) {
    return Date.now();
  }

  updateBeforeSave(value, currentObject) {
    // Always update modified date before save
    return Date.now();
  }
}

/**
 * @class UlidField
 * @memberof BaoFields
 * @description
 * A field that stores a {@link https://github.com/ulid/spec ULID} value.
 */
class UlidField extends BaoBaseField {
  constructor(options = {}) {
    super({
      ...options,
      required: true,
    });
    this.autoAssign = options.autoAssign || false;
  }

  getInitialValue() {
    if (this.autoAssign) {
      return ulid();
    }
    return super.getInitialValue();
  }

  validate(value) {
    if (!value && !this.autoAssign) {
      throw new ValidationError("ULID is required", null, value);
    }

    if (value) {
      // Check if it's a valid ULID format
      // ULIDs are 26 characters, uppercase alphanumeric
      if (!/^[0-9A-Z]{26}$/.test(value)) {
        throw new ValidationError("Invalid ULID format", null, value);
      }

      try {
        // Attempt to decode the timestamp to verify it's valid
        decodeTime(value);
      } catch (error) {
        throw new ValidationError(
          "Invalid ULID: could not decode timestamp",
          null,
          value,
        );
      }
    }
    return true;
  }

  // toDy now only handles conversion, not generation
  toDy(value) {
    return value;
  }

  toGsi(value) {
    return value || "";
  }
}

/**
 * @class RelatedField
 * @memberof BaoFields
 * @description
 * A field that points to another object in the database. This field makes
 * it easy to load related objects.
 */
class RelatedField extends BaoBaseField {
  constructor(modelName, options = {}) {
    super(options);
    this.modelName = modelName;
  }

  validate(value) {
    if (this.required && !value) {
      throw new ValidationError("Field is required", null, value);
    }
    // Allow both string IDs and model instances
    if (
      value &&
      typeof value !== "string" &&
      (!value.getPrimaryId || typeof value.getPrimaryId !== "function")
    ) {
      throw new ValidationError(
        "Related field value must be a string ID or model instance",
        null,
        value,
      );
    }
    return true;
  }

  toDy(value) {
    if (!value) return null;
    // If we're given a model instance, get its ID
    if (typeof value === "object" && value.getPrimaryId) {
      return value.getPrimaryId();
    }
    return value;
  }

  fromDy(value) {
    return value;
  }

  toGsi(value) {
    return this.toDy(value) || "";
  }
}

/**
 * @class CounterField
 * @memberof BaoFields
 * @description
 * A field that stores an integer value that can be incremented or decremented atomically.
 */
class CounterField extends BaoBaseField {
  constructor(options = {}) {
    super(options);
    this.defaultValue = options.defaultValue || 0;
  }

  validate(value) {
    super.validate(value);
    if (value !== undefined) {
      // Accept increment/decrement operations (e.g., '+1', '-5')
      if (typeof value === "string" && /^[+-]\d+$/.test(value)) {
        return true;
      }
      // Accept regular integer values
      if (!Number.isInteger(value)) {
        throw new ValidationError(
          "CounterField value must be an integer",
          null,
          value,
        );
      }
    }
    return true;
  }

  getInitialValue() {
    return this.defaultValue;
  }

  toDy(value) {
    if (
      typeof value === "string" &&
      (value.startsWith("+") || value.startsWith("-"))
    ) {
      return value;
    }
    return super.toDy(value);
  }

  fromDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    return parseInt(value, 10);
  }

  getUpdateExpression(fieldName, value) {
    if (value === undefined) return null;

    const attributeName = `#${fieldName}`;
    const attributeValue = `:${fieldName}`;

    let expObj = {
      attrNameKey: attributeName,
      attrValueKey: attributeValue,
      type: "SET",
      expression: `${attributeName} = ${attributeValue}`,
      fieldName: fieldName,
      fieldValue: value,
    };

    logger.log("CounterField - getUpdateExpression", fieldName, value);

    if (value === null) {
      expObj = {
        ...expObj,
        type: "REMOVE",
        expression: `${attributeName}`,
        fieldValue: null,
      };
    }

    // If the value is relative (has + or - prefix), use ADD
    if (
      typeof value === "string" &&
      (value.startsWith("+") || value.startsWith("-"))
    ) {
      const numericValue = parseInt(value, 10);

      // Return just the expression part without the ADD keyword
      expObj = {
        ...expObj,
        type: "ADD",
        expression: `${attributeName} ${attributeValue}`,
        fieldValue: numericValue,
      };
    }

    return expObj;
  }

  toGsi(value) {
    return value != null ? value.toString().padStart(20, "0") : "";
  }
}

/**
 * @class BinaryField
 * @memberof BaoFields
 * @description
 * A field that stores a binary value.
 */
class BinaryField extends BaoBaseField {
  getInitialValue() {
    if (this.defaultValue) {
      return typeof this.defaultValue === "function"
        ? this.defaultValue()
        : this.defaultValue;
    }
    return null;
  }

  validate(value) {
    super.validate(value);
    if (
      value !== undefined &&
      value !== null &&
      !(value instanceof Buffer) &&
      !(value instanceof Uint8Array)
    ) {
      throw new ValidationError(
        "BinaryField value must be a Buffer or Uint8Array",
        null,
        value,
      );
    }
    return true;
  }

  toDy(value) {
    if (!value) return null;

    return value;
  }

  fromDy(value) {
    if (!value) return null;
    return value;
  }

  toGsi(value) {
    throw new ValidationError(
      "BinaryField does not support GSI conversion",
      null,
      value,
    );
  }
}

/**
 * @class VersionField
 * @memberof BaoFields
 * @description
 * A field that stores a ULID value that is used to track the version of the object.
 * You can use this field to implement optimistic locking by using the version field
 * as a condition in your update operation.
 */
class VersionField extends BaoBaseField {
  constructor(options = {}) {
    super({
      ...options,
      required: true,
    });
    this.defaultValue = options.defaultValue || ulid;
  }

  validate(value) {
    super.validate(value);
    if (value !== undefined) {
      // Verify it's a valid ULID string
      if (typeof value !== "string" || value.length !== 26) {
        throw new ValidationError(
          "VersionField value must be a valid ULID",
          null,
          value,
        );
      }
    }
    return true;
  }

  getInitialValue() {
    return typeof this.defaultValue === "function"
      ? this.defaultValue()
      : this.defaultValue;
  }

  updateBeforeSave(value) {
    return ulid();
  }

  fromDy(value) {
    return value || this.getInitialValue();
  }

  toDy(value) {
    return value || this.getInitialValue();
  }
}

/**
 * @class BooleanField
 * @memberof BaoFields
 * @description
 * A field that stores a boolean value.
 */
class BooleanField extends BaoBaseField {
  validate(value) {
    super.validate(value);
    if (value !== undefined && value !== null && typeof value !== "boolean") {
      throw new ValidationError(
        "BooleanField value must be a boolean",
        null,
        value,
      );
    }
    return true;
  }

  getInitialValue() {
    return this.defaultValue !== undefined ? this.defaultValue : null;
  }

  toDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    return Boolean(value);
  }

  fromDy(value) {
    if (value === undefined || value === null) {
      return this.getInitialValue();
    }
    return Boolean(value);
  }

  toGsi(value) {
    if (value === undefined || value === null) {
      return "";
    }
    // Convert to '0' or '1' for consistent string sorting
    return value ? "1" : "0";
  }
}

/**
 * @class TtlField
 * @memberof BaoFields
 * @description
 * A field that stores a Unix timestamp in seconds that indicates when the object should be deleted.
 * DynamoDB will automatically delete the item at the specified time. This
 * field must be named "ttl" for DynamoDB to automatically delete the item.
 */
class TtlField extends DateTimeField {
  validate(value) {
    if (value === null || value === undefined) {
      return true; // Allow null/undefined for field removal
    }
    super.validate(value); // Use parent validation for dates
  }

  toDy(value) {
    logger.log("TTL toDy", value);
    if (value === undefined) return undefined; // Skip field
    if (value === null) return null; // Remove field

    // Convert any valid date input to Unix timestamp in seconds
    let date;
    if (value instanceof Date) {
      date = value;
    } else {
      date = new Date(value);
      if (isNaN(date.getTime())) {
        throw new ValidationError(
          "Invalid date value provided for TTL field",
          null,
          value,
        );
      }
    }

    const timestamp = Math.floor(date.getTime() / 1000);
    return timestamp;
  }

  fromDy(value) {
    logger.log("TTL fromDy", value);
    if (value === undefined || value === null) {
      return null; // Convert both undefined and null to null
    }
    return new Date(value * 1000);
  }
}

/**
 * @class StringSetField
 * @memberof BaoFields
 * @description
 * A field that stores a set of string values. Behind the scenes this is backed by a DynamoDB string set.
 * This field cannot be indexed but can be used in filter expressions.
 *
 * Supports direct mutation operations that automatically track changes:
 * - `add(value)` - Add a string to the set
 * - `delete(value)` - Remove a string from the set
 * - `clear()` - Remove all strings from the set
 *
 * @example
 * // Creating with initial values
 * const doc = new MyModel({
 *   tags: new Set(["javascript", "web", "tutorial"])
 * });
 *
 * // Direct mutations (recommended - changes are auto-tracked)
 * doc.tags.add("advanced");        // Add a tag
 * doc.tags.delete("tutorial");     // Remove a tag
 * doc.tags.clear();                // Clear all tags
 * await doc.save();                // Changes are saved automatically
 *
 * // Alternative: Replace entire set
 * doc.tags = new Set(["new", "tags"]);
 * await doc.save();
 *
 * // Filter expressions
 * const results = await MyModel.scan({
 *   filter: {
 *     tags: { $contains: "javascript" },    // Contains specific value
 *     tags: { $size: { $gt: 2 } }          // Set size greater than 2
 *   }
 * });
 */
class StringSetField extends BaoBaseField {
  constructor(options = {}) {
    super(options);
    this.maxStringLength = options.maxStringLength;
    this.maxMemberCount = options.maxMemberCount;
  }

  validate(value) {
    super.validate(value);

    if (value === null || value === undefined) {
      return true; // Allow null/undefined
    }

    // Accept both Set and Array, but prefer Set
    let setToValidate;
    if (value instanceof Set) {
      setToValidate = value;
    } else if (Array.isArray(value)) {
      setToValidate = new Set(value);
    } else {
      throw new ValidationError(
        "StringSetField value must be a Set or Array",
        null,
        value,
      );
    }

    // Validate member count
    if (this.maxMemberCount && setToValidate.size > this.maxMemberCount) {
      throw new ValidationError(
        `StringSet exceeds maximum member count of ${this.maxMemberCount}`,
        null,
        value,
      );
    }

    // Validate each string in the set
    for (const item of setToValidate) {
      if (typeof item !== "string") {
        throw new ValidationError(
          "StringSetField can only contain string values",
          null,
          value,
        );
      }

      if (this.maxStringLength && item.length > this.maxStringLength) {
        throw new ValidationError(
          `String in set exceeds maximum length of ${this.maxStringLength}`,
          null,
          value,
        );
      }
    }

    return true;
  }

  getInitialValue() {
    return new Set();
  }

  toDy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;

    // Handle filter values (strings, numbers, objects) - pass through as-is
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      (typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Set))
    ) {
      return value;
    }

    // Convert Set or Array to array for DynamoDB
    let arrayValue;
    if (value instanceof Set) {
      arrayValue = Array.from(value);
    } else if (Array.isArray(value)) {
      arrayValue = [...new Set(value)]; // Remove duplicates
    } else {
      throw new ValidationError(
        "StringSetField value must be a Set or Array",
        null,
        value,
      );
    }

    // Empty sets are stored as null in DynamoDB
    if (arrayValue.length === 0) {
      return null;
    }

    return arrayValue;
  }

  fromDy(value, modelInstance = null, fieldName = null) {
    const baseSet = this._createBaseSet(value);

    // If no model context, return plain Set (for non-property usage)
    if (!modelInstance || !fieldName) {
      return baseSet;
    }

    // Return proxied Set that tracks changes
    return this._createTrackedSet(baseSet, modelInstance, fieldName);
  }

  /**
   * @private
   * @description
   * Creates a plain Set from DynamoDB data without any tracking.
   * @param {any} value - The value from DynamoDB (array, null, or undefined)
   * @returns {Set} A plain Set object
   */
  _createBaseSet(value) {
    if (value === undefined || value === null) {
      return new Set(); // Return empty Set for missing or null values
    }

    if (Array.isArray(value)) {
      return new Set(value);
    }

    return new Set();
  }

  /**
   * @private
   * @description
   * Creates a proxied Set that automatically tracks mutations and updates the model's underlying data.
   * The proxy intercepts add(), delete(), and clear() operations to mark the field as dirty
   * and update the model's _dyData immediately.
   * @param {Set} baseSet - The base Set to proxy
   * @param {BaoModel} modelInstance - The model instance that owns this field
   * @param {string} fieldName - The name of the field in the model
   * @returns {Proxy} A proxied Set that tracks changes
   */
  _createTrackedSet(baseSet, modelInstance, fieldName) {
    return new Proxy(baseSet, {
      get(target, prop) {
        const original = target[prop];

        // Handle functions/methods
        if (typeof original === "function") {
          // For mutating methods, track changes and update underlying data
          if (["add", "delete", "clear"].includes(prop)) {
            return function (...args) {
              const result = original.apply(target, args);
              // Mark field as dirty in existing change tracking
              modelInstance._changes.add(fieldName);
              // Update the underlying _dyData with the mutated set
              const field = modelInstance.constructor._getField(fieldName);
              modelInstance._dyData[fieldName] = field.toDy(target);
              return result;
            };
          }

          // For all other methods, bind them properly to maintain context
          return original.bind(target);
        }

        // For non-function properties, return as-is
        return original;
      },
    });
  }

  toGsi(value) {
    throw new ValidationError(
      "StringSetField does not support GSI conversion (sets cannot be indexed)",
      null,
      value,
    );
  }

  getUpdateExpression(fieldName, value, originalValue) {
    if (value === undefined) return null;

    const attributeName = `#${fieldName}`;
    const valueAttributeKey = `:${fieldName}`;

    // Handle null case (remove entire field)
    if (value === null) {
      return {
        type: "REMOVE",
        expression: `${attributeName}`,
        attrNameKey: attributeName,
        attrValueKey: null,
        fieldName: fieldName,
        fieldValue: null,
      };
    }

    // Convert values to Arrays for DynamoDB (value is already in DynamoDB format from toDy)
    const newArray = Array.isArray(value) ? value : [value];
    const oldArray =
      originalValue && Array.isArray(originalValue) ? originalValue : [];

    // If no original value or original was empty, use SET
    if (!originalValue || oldArray.length === 0) {
      return {
        type: "SET",
        expression: `${attributeName} = ${valueAttributeKey}`,
        attrNameKey: attributeName,
        attrValueKey: valueAttributeKey,
        fieldName: fieldName,
        fieldValue: newArray,
      };
    }

    // Convert to Sets for efficient comparison
    const newSet = new Set(newArray);
    const oldSet = new Set(oldArray);

    // Find items to add and delete
    const toAdd = newArray.filter((item) => !oldSet.has(item));
    const toDelete = oldArray.filter((item) => !newSet.has(item));

    // If no changes, return null
    if (toAdd.length === 0 && toDelete.length === 0) {
      return null;
    }

    // Handle mixed ADD and DELETE operations
    // For mixed operations, we use SET which replaces the entire set
    if (toAdd.length > 0 && toDelete.length > 0) {
      return {
        type: "SET",
        expression: `${attributeName} = ${valueAttributeKey}`,
        attrNameKey: attributeName,
        attrValueKey: valueAttributeKey,
        fieldName: fieldName,
        fieldValue: newArray,
      };
    }

    // If only additions, use ADD
    if (toAdd.length > 0 && toDelete.length === 0) {
      return {
        type: "ADD",
        expression: `${attributeName} ${valueAttributeKey}`,
        attrNameKey: attributeName,
        attrValueKey: valueAttributeKey,
        fieldName: fieldName,
        fieldValue: toAdd,
      };
    }

    // If only deletions, use DELETE
    if (toDelete.length > 0 && toAdd.length === 0) {
      return {
        type: "DELETE",
        expression: `${attributeName} ${valueAttributeKey}`,
        attrNameKey: attributeName,
        attrValueKey: valueAttributeKey,
        fieldName: fieldName,
        fieldValue: toDelete,
      };
    }

    // This shouldn't happen, but fallback to SET for safety
    return {
      type: "SET",
      expression: `${attributeName} = ${valueAttributeKey}`,
      attrNameKey: attributeName,
      attrValueKey: valueAttributeKey,
      fieldName: fieldName,
      fieldValue: newArray,
    };
  }
}

// Factory functions for creating field instances
const createStringField = (options) => new StringField(options);
const createDateTimeField = (options) => new DateTimeField(options);
const createCreateDateField = (options) => new CreateDateField(options);
const createModifiedDateField = (options) => new ModifiedDateField(options);
const createUlidField = (options) => new UlidField(options);
const createRelatedField = (modelName, options) =>
  new RelatedField(modelName, options);
const createIntegerField = (options) => new IntegerField(options);
const createFloatField = (options) => new FloatField(options);
const createCounterField = (options) => new CounterField(options);
const createBinaryField = (options) => new BinaryField(options);
const createVersionField = (options) => new VersionField(options);
const createBooleanField = (options) => new BooleanField(options);
const createTtlField = (options) => new TtlField(options);
const createStringSetField = (options) => new StringSetField(options);

// Export both the factory functions and the classes
module.exports = {
  // Factory functions
  StringField: createStringField,
  DateTimeField: createDateTimeField,
  CreateDateField: createCreateDateField,
  ModifiedDateField: createModifiedDateField,
  UlidField: createUlidField,
  RelatedField: createRelatedField,
  IntegerField: createIntegerField,
  FloatField: createFloatField,
  CounterField: createCounterField,
  BinaryField: createBinaryField,
  VersionField: createVersionField,
  BooleanField: createBooleanField,
  TtlField: createTtlField,
  StringSetField: createStringSetField,

  // Classes (for instanceof checks)
  StringFieldClass: StringField,
  DateTimeFieldClass: DateTimeField,
  CreateDateFieldClass: CreateDateField,
  ModifiedDateFieldClass: ModifiedDateField,
  UlidFieldClass: UlidField,
  RelatedFieldClass: RelatedField,
  IntegerFieldClass: IntegerField,
  FloatFieldClass: FloatField,
  CounterFieldClass: CounterField,
  BinaryFieldClass: BinaryField,
  VersionFieldClass: VersionField,
  BooleanFieldClass: BooleanField,
  TtlFieldClass: TtlField,
  StringSetFieldClass: StringSetField,
};
