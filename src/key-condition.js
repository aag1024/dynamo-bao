class KeyConditionBuilder {
  constructor() {
    this.names = {};
    this.values = {};
    this.nameCount = 0;
    this.valueCount = 0;
    
    // Define operator mappings
    this.operatorMap = {
      '$gt': '>',
      '$gte': '>=',
      '$lt': '<',
      '$lte': '<='
    };
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

  buildSimpleCondition(fieldName, value) {
    const nameKey = this.generateName(fieldName);
    const valueKey = this.generateValue(value);
    return {
      condition: `${nameKey} = ${valueKey}`,
      names: this.names,
      values: this.values
    };
  }

  buildBeginsWithCondition(fieldName, value) {
    const nameKey = this.generateName(fieldName);
    const valueKey = this.generateValue(value);
    return {
      condition: `begins_with(${nameKey}, ${valueKey})`,
      names: this.names,
      values: this.values
    };
  }

  buildComparisonCondition(fieldName, operator, value) {
    const nameKey = this.generateName(fieldName);
    const valueKey = this.generateValue(value);
    const operators = {
      '$gt': '>',
      '$gte': '>=',
      '$lt': '<',
      '$lte': '<='
    };
    return {
      condition: `${nameKey} ${operators[operator]} ${valueKey}`,
      names: this.names,
      values: this.values
    };
  }

  buildKeyCondition(model, indexName, condition, gsiSortKeyName) {
    // Validate the condition format
    if (!condition || typeof condition !== 'object') {
      throw new Error('Invalid condition format');
    }

    const [[fieldName, fieldCondition]] = Object.entries(condition);

    // Validate that this field is the sort key for the index
    const index = model.indexes[indexName];
    if (!index || index.sk !== fieldName) {
      throw new Error(`Field "${fieldName}" is not the sort key for index "${indexName}"`);
    }

    // Get the field definition to use its toGsi method
    const field = model._getField(fieldName);
    const nameKey = '#sk';
    const names = { '#sk': gsiSortKeyName };

    // Handle operator object
    if (typeof fieldCondition === 'object' && fieldCondition !== null) {
      const operator = Object.keys(fieldCondition)[0];
      const value = fieldCondition[operator];

      // Validate operator before processing
      const validOperators = ['$eq', '$beginsWith', '$between', '$gt', '$gte', '$lt', '$lte'];
      if (!validOperators.includes(operator)) {
        throw new Error(`Unsupported sort key operator: ${operator}`);
      }

      switch (operator) {
        case '$between':
          if (!Array.isArray(value) || value.length !== 2) {
            throw new Error('$between requires an array with exactly 2 elements');
          }
          return {
            condition: `${nameKey} BETWEEN :sortKeyStart AND :sortKeyEnd`,
            names,
            values: { 
              ':sortKeyStart': field.toGsi(value[0]), 
              ':sortKeyEnd': field.toGsi(value[1]) 
            }
          };

        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          return {
            condition: `${nameKey} ${this.operatorMap[operator]} :sortKeyValue`,
            names,
            values: { ':sortKeyValue': field.toGsi(value) }
          };

        case '$beginsWith':
          return {
            condition: `begins_with(${nameKey}, :sortKeyValue)`,
            names,
            values: { ':sortKeyValue': field.toGsi(value) }
          };

        default:
          throw new Error(`Unsupported sort key operator: ${operator}`);
      }
    }

    // Handle simple value case (treated as equality)
    if (fieldCondition === undefined) {
      throw new Error('Sort key condition value cannot be undefined');
    }

    return {
      condition: `${nameKey} = :sortKeyValue`,
      names,
      values: { ':sortKeyValue': field.toGsi(fieldCondition) }
    };
  }
}

module.exports = { KeyConditionBuilder }; 