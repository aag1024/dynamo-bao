class BaseField {
  constructor(options = {}) {
    this.options = options;
    this.required = options.required || false;
    this.defaultValue = options.defaultValue;
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
    if (value !== undefined && !(value instanceof Date) && typeof value !== 'number') {
      throw new Error('DateTimeField value must be a Date object or timestamp number');
    }
  }

  toDy(value) {
    // Store as Unix timestamp (milliseconds)
    if (!value) return null;
    return value instanceof Date ? value.getTime() : value;
  }

  fromDy(value) {
    // Convert from Unix timestamp to Date object
    if (!value) return null;
    return new Date(value);
  }

  toGsi(value) {
    // Convert to sortable ISO string for GSI
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
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

module.exports = {
  StringField: (options) => new StringField(options),
  DateTimeField: (options) => new DateTimeField(options),
  IntegerField: (options) => new IntegerField(options),
  FloatField: (options) => new FloatField(options),
}; 