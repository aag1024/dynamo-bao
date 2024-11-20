const { ulid, decodeTime } = require('ulid');
const { ModelRegistry } = require('./model-registry');

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
    if (!value) return '';
    try {
      // Convert to timestamp first to ensure consistency
      const timestamp = this.toDy(value);
      if (!timestamp) return '';
      return new Date(timestamp).toISOString();
    } catch (error) {
      console.warn('Error converting date for GSI:', error);
      return '';
    }
  }
}

class IntegerField extends BaseField {
  toDy(value) {
    return Number(value);
  }

  fromDy(value) {
    return value != null ? parseInt(value, 10) : null;
  }

  toGsi(value) {
    // Pad with zeros for proper string sorting
    return value != null ? value.toString().padStart(20, '0') : '';
  }
}

class FloatField extends BaseField {
  toDy(value) {
    const num = Number(value);
    if (this.options.precision !== undefined && !isNaN(num)) {
      return Number(num.toFixed(this.options.precision));
    }
    return num;
  }

  fromDy(value) {
    return value != null ? parseFloat(value) : null;
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
    if (value && typeof value !== 'string' && (!value.getGid || typeof value.getGid !== 'function')) {
      throw new Error('Related field value must be a string ID or model instance');
    }
    return true;
  }

  toDy(value) {
    if (!value) return null;
    // If we're given a model instance, get its ID
    if (typeof value === 'object' && value.getGid) {
      return value.getGid();
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

// Factory functions for creating field instances
const createStringField = (options) => new StringField(options);
const createDateTimeField = (options) => new DateTimeField(options);
const createCreateDateField = (options) => new CreateDateField(options);
const createModifiedDateField = (options) => new ModifiedDateField(options);
const createULIDField = (options) => new ULIDField(options);
const createRelatedField = (modelName, options) => new RelatedField(modelName, options);

// Export both the factory functions and the classes
module.exports = {
  // Factory functions
  StringField: createStringField,
  DateTimeField: createDateTimeField,
  CreateDateField: createCreateDateField,
  ModifiedDateField: createModifiedDateField,
  ULIDField: createULIDField,
  RelatedField: createRelatedField,
  
  // Classes (for instanceof checks)
  StringFieldClass: StringField,
  DateTimeFieldClass: DateTimeField,
  CreateDateFieldClass: CreateDateField,
  ModifiedDateFieldClass: ModifiedDateField,
  ULIDFieldClass: ULIDField,
  RelatedFieldClass: RelatedField
}; 