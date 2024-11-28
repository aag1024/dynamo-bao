class KeyConditionBuilder {
  constructor() {
    this.names = {};
    this.values = {};
    this.nameCount = 0;
    this.valueCount = 0;
  }

  generateName(fieldName) {
    const key = `#n${++this.nameCount}`;
    this.names[key] = fieldName;
    return key;
  }

  generateValue(value) {
    const key = `:v${++this.valueCount}`;
    this.values[key] = value;
    return key;
  }

  validateSortKeyField(model, indexName, fieldName) {
    const index = model.indexes[indexName];
    if (!index) {
      throw new Error(`Index "${indexName}" not found in ${model.name}`);
    }

    if (index.sk === 'modelPrefix') {
      throw new Error(`Cannot query by sort key on index "${indexName}" as it uses modelPrefix`);
    }

    const skField = index.sk;
    if (skField !== fieldName) {
      throw new Error(
        `Field "${fieldName}" is not the sort key for index "${indexName}". ` +
        `Expected "${skField}"`
      );
    }
  }

  buildSortKeyExpression(skField, condition) {
    if (condition === null || condition === undefined) {
      return null;
    }

    const nameKey = this.generateName(skField);

    // Handle simple value case (treated as equality)
    if (typeof condition !== 'object') {
      const valueKey = this.generateValue(condition);
      return {
        condition: `${nameKey} = ${valueKey}`,
        names: this.names,
        values: this.values
      };
    }

    // Handle operator object
    const operator = Object.keys(condition)[0];
    const value = condition[operator];

    switch (operator) {
      case '$eq':
        const valueKey = this.generateValue(value);
        return {
          condition: `${nameKey} = ${valueKey}`,
          names: this.names,
          values: this.values
        };

      case '$beginsWith':
        return {
          condition: `begins_with(${nameKey}, ${this.generateValue(value)})`,
          names: this.names,
          values: this.values
        };

      case '$between':
        if (!Array.isArray(value) || value.length !== 2) {
          throw new Error('$between requires an array with exactly 2 elements');
        }
        return {
          condition: `${nameKey} BETWEEN ${this.generateValue(value[0])} AND ${this.generateValue(value[1])}`,
          names: this.names,
          values: this.values
        };

      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        const operators = {
          '$gt': '>',
          '$gte': '>=',
          '$lt': '<',
          '$lte': '<='
        };
        return {
          condition: `${nameKey} ${operators[operator]} ${this.generateValue(value)}`,
          names: this.names,
          values: this.values
        };

      default:
        throw new Error(`Unsupported sort key operator: ${operator}`);
    }
  }

  buildBetweenCondition(fieldName, values) {
    return {
      condition: `#${fieldName} BETWEEN :${fieldName}_start AND :${fieldName}_end`,
      names: {
        [`#${fieldName}`]: fieldName
      },
      values: {
        [`:${fieldName}_start`]: values[0],
        [`:${fieldName}_end`]: values[1]
      }
    };
  }

  buildKeyCondition(model, indexName, condition, gsiSortKeyName) {
    // Validate the condition format
    if (!condition || typeof condition !== 'object') {
      throw new Error('Invalid condition format');
    }

    const [[fieldName, fieldCondition]] = Object.entries(condition);

    // Validate that this field is the sort key for the index
    this.validateSortKeyField(model, indexName, fieldName);

    // Build the condition using the GSI sort key name for DynamoDB
    const actualFieldName = gsiSortKeyName || fieldName;
    
    // Handle operator object
    if (typeof fieldCondition === 'object') {
      const operator = Object.keys(fieldCondition)[0];
      const value = fieldCondition[operator];

      switch (operator) {
        case '$eq':
          return this.buildSimpleCondition(actualFieldName, value);

        case '$beginsWith':
          return this.buildBeginsWithCondition(actualFieldName, value);

        case '$between':
          if (!Array.isArray(value) || value.length !== 2) {
            throw new Error('$between requires an array with exactly 2 elements');
          }
          return this.buildBetweenCondition(actualFieldName, value);

        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          return this.buildComparisonCondition(actualFieldName, operator, value);

        default:
          throw new Error(`Unsupported sort key operator: ${operator}`);
      }
    }

    // Handle simple value case (treated as equality)
    return this.buildSimpleCondition(actualFieldName, fieldCondition);
  }
}

module.exports = { KeyConditionBuilder }; 