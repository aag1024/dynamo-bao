const { ulid, decodeTime } = require('ulid');

class BaseField {
  constructor(options = {}) {
    this.options = options;
    this.required = options.required || false;
    this.defaultValue = options.defaultValue;
  }

  getInitialValue() {
    if (this.defaultValue) {
      return typeof this.defaultValue === 'function' 
        ? this.defaultValue() 
        : this.defaultValue;
    }
    return undefined;
  }

  validate(value) {
    if (this.required && (value === null || value === undefined)) {
      throw new Error('Field is required');
    }
    return true;
  }

  toDy(value) {
    return value;
  }

  fromDy(value) {
    return value;
  }

  toGsi(value) {
    return String(value);
  }

  fromGsi(value) {
    return this.fromDy(value);
  }

  getUpdateExpression(fieldName, value, context = {}) {
    if (value === undefined) return null;
    
    // Default implementation just sets the value
    context.expressionAttributeNames = context.expressionAttributeNames || {};
    context.expressionAttributeValues = context.expressionAttributeValues || {};
    
    const attributeName = `#${fieldName}`;
    const attributeValue = `:${fieldName}`;
    
    context.expressionAttributeNames[attributeName] = fieldName;
    context.expressionAttributeValues[attributeValue] = this.toDy(value);
    
    return {
      type: 'SET',
      expression: `${attributeName} = ${attributeValue}`
    };
  }
}

class StringField extends BaseField {
  // String fields are pass-through since DynamoDB handles them natively
}

class DateTimeField extends BaseField {
  validate(value) {
    if (this.required && value === undefined) {
      throw new Error('Field is required');
    }
    if (value !== undefined && !(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string') {
      throw new Error('DateTimeField value must be a Date object, timestamp number, or ISO string');
    }
  }

  toDy(value) {
    if (!value) return null;
    
    try {
      // Convert any input to timestamp
      if (value instanceof Date) {
        return value.getTime();
      }
      if (typeof value === 'string') {
        return new Date(value).getTime();
      }
      if (typeof value === 'number') {
        return value;
      }
      return null;
    } catch (error) {
      console.warn('Error converting date value:', error);
      return null;
    }
  }

  fromDy(value) {
    if (!value) return null;
    try {
      return new Date(Number(value));
    } catch (error) {
      console.warn('Error parsing date value:', error);
      return null;
    }
  }

  toGsi(value) {
    if (!value) return '0';
    try {
      // Convert to timestamp string with padding for correct sorting
      const timestamp = this.toDy(value);
      if (!timestamp) return '0';
      const result = timestamp.toString().padStart(20, '0');
      // console.log('Converting to GSI:', { value, timestamp, result });
      return result;
    } catch (error) {
      console.warn('Error converting date for GSI:', error);
      return '0';
    }
  }
}

class IntegerField extends BaseField {
  getInitialValue() {
    return this.options.defaultValue !== undefined ? this.options.defaultValue : null;
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
    return value != null ? value.toString().padStart(20, '0') : '';
  }
}

class FloatField extends BaseField {
  getInitialValue() {
    return this.options.defaultValue !== undefined ? this.options.defaultValue : null;
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
    return value != null ? value.toExponential(20) : '';
  }
}

class CreateDateField extends DateTimeField {
  constructor(options = {}) {
    super({
      ...options,
      required: true
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

class ModifiedDateField extends DateTimeField {
  constructor(options = {}) {
    super({
      ...options,
      required: true
    });
  }

  getInitialValue() {
    return new Date();
  }

  toDy(value) {
    return Date.now();
  }
}

class ULIDField extends BaseField {
  constructor(options = {}) {
    super({
      ...options,
      required: true
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
      throw new Error('ULID is required');
    }
    
    if (value) {
      // Check if it's a valid ULID format
      // ULIDs are 26 characters, uppercase alphanumeric
      if (!/^[0-9A-Z]{26}$/.test(value)) {
        throw new Error('Invalid ULID format');
      }

      try {
        // Attempt to decode the timestamp to verify it's valid
        decodeTime(value);
      } catch (error) {
        throw new Error('Invalid ULID: could not decode timestamp');
      }
    }
    return true;
  }

  // toDy now only handles conversion, not generation
  toDy(value) {
    return value;
  }

  toGsi(value) {
    return value || '';
  }
}

class RelatedField extends BaseField {
  constructor(modelName, options = {}) {
    super(options);
    this.modelName = modelName;
  }

  validate(value) {
    if (this.required && !value) {
      throw new Error('Field is required');
    }
    // Allow both string IDs and model instances
    if (value && typeof value !== 'string' && (!value.getPrimaryId || typeof value.getPrimaryId !== 'function')) {
      throw new Error('Related field value must be a string ID or model instance');
    }
    return true;
  }

  toDy(value) {
    if (!value) return null;
    // If we're given a model instance, get its ID
    if (typeof value === 'object' && value.getPrimaryId) {
      return value.getPrimaryId();
    }
    return value;
  }

  fromDy(value) {
    return value;
  }

  toGsi(value) {
    return this.toDy(value) || '';
  }
}

class CounterField extends BaseField {
  constructor(options = {}) {
    super(options);
    this.defaultValue = options.defaultValue || 0;
  }

  validate(value) {
    super.validate(value);
    if (value !== undefined) {
      // Accept increment/decrement operations (e.g., '+1', '-5')
      if (typeof value === 'string' && /^[+-]\d+$/.test(value)) {
        return true;
      }
      // Accept regular integer values
      if (!Number.isInteger(value)) {
        throw new Error('CounterField value must be an integer');
      }
    }
    return true;
  }

  getInitialValue() {
    return this.defaultValue;
  }

  toDy(value) {
    if (typeof value === 'string' && (value.startsWith('+') || value.startsWith('-'))) {
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

  getUpdateExpression(fieldName, value, context = {}) {
    if (value === undefined) {
      // For new items, use the default value
      value = this.getInitialValue();
    }

    context.expressionAttributeNames = context.expressionAttributeNames || {};
    context.expressionAttributeValues = context.expressionAttributeValues || {};

    const attributeName = `#${fieldName}`;
    const attributeValue = `:${fieldName}`;
    
    context.expressionAttributeNames[attributeName] = fieldName;
    
    // If the value is relative (has + or - prefix), use ADD
    if (typeof value === 'string' && (value.startsWith('+') || value.startsWith('-'))) {
      const numericValue = parseInt(value, 10);
      context.expressionAttributeValues[attributeValue] = numericValue;
      
      // Return just the expression part without the ADD keyword
      return {
        type: 'ADD',
        expression: `${attributeName} ${attributeValue}`
      };
    }
    
    // Return just the expression part without the SET keyword
    context.expressionAttributeValues[attributeValue] = this.toDy(value);
    return {
      type: 'SET',
      expression: `${attributeName} = ${attributeValue}`
    };
  }

  toGsi(value) {
    return value != null ? value.toString().padStart(20, '0') : '';
  }
}

class BinaryField extends BaseField {
  validate(value) {
    super.validate(value);
    if (value !== undefined && value !== null && !(value instanceof Buffer)) {
      throw new Error('BinaryField value must be a Buffer');
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
    throw new Error('BinaryField does not support GSI conversion');
  }
}

class VersionField extends ULIDField {
  constructor(options = {}) {
    super({
      ...options,
      required: true
    });
  }

  getInitialValue() {
    return ulid();
  }

  toDy(value) {
    // Always generate a new ULID when saving
    return ulid();
  }
}

// Factory functions for creating field instances
const createStringField = (options) => new StringField(options);
const createDateTimeField = (options) => new DateTimeField(options);
const createCreateDateField = (options) => new CreateDateField(options);
const createModifiedDateField = (options) => new ModifiedDateField(options);
const createULIDField = (options) => new ULIDField(options);
const createRelatedField = (modelName, options) => new RelatedField(modelName, options);
const createIntegerField = (options) => new IntegerField(options);
const createFloatField = (options) => new FloatField(options);
const createCounterField = (options) => new CounterField(options);
const createBinaryField = (options) => new BinaryField(options);
const createVersionField = (options) => new VersionField(options);

// Export both the factory functions and the classes
module.exports = {
  // Factory functions
  StringField: createStringField,
  DateTimeField: createDateTimeField,
  CreateDateField: createCreateDateField,
  ModifiedDateField: createModifiedDateField,
  ULIDField: createULIDField,
  RelatedField: createRelatedField,
  IntegerField: createIntegerField,
  FloatField: createFloatField,
  CounterField: createCounterField,
  BinaryField: createBinaryField,
  VersionField: createVersionField,
  
  // Classes (for instanceof checks)
  StringFieldClass: StringField,
  DateTimeFieldClass: DateTimeField,
  CreateDateFieldClass: CreateDateField,
  ModifiedDateFieldClass: ModifiedDateField,
  ULIDFieldClass: ULIDField,
  RelatedFieldClass: RelatedField,
  IntegerFieldClass: IntegerField,
  FloatFieldClass: FloatField,
  CounterFieldClass: CounterField,
  BinaryFieldClass: BinaryField,
  VersionFieldClass: VersionField
}; 