class FilterExpressionBuilder {
    constructor() {
      this.names = {};
      this.values = {};
      this.nameCount = 0;
      this.valueCount = 0;
    }
  
    // Generate unique name placeholder
    generateName(fieldName) {
      const key = `#n${++this.nameCount}`;
      this.names[key] = fieldName;
      return key;
    }
  
    // Generate unique value placeholder
    generateValue(value) {
      const key = `:v${++this.valueCount}`;
      this.values[key] = value;
      return key;
    }
  
    // Simplified value conversion - let the field handle it
    convertValue(value, model, fieldName) {
      const field = model.fields[fieldName];
      return field.toDy(value);
    }
  
    // Build expression for a single comparison
    buildComparison(fieldName, operator, value, model) {
      const nameKey = this.generateName(fieldName);
      const convertedValue = this.convertValue(value, model, fieldName);
  
      switch (operator) {
        case '$eq':
          const valueKey = this.generateValue(convertedValue);
          return `${nameKey} = ${valueKey}`;
        case '$ne':
          return `${nameKey} <> ${this.generateValue(convertedValue)}`;
        case '$gt':
          return `${nameKey} > ${this.generateValue(convertedValue)}`;
        case '$gte':
          return `${nameKey} >= ${this.generateValue(convertedValue)}`;
        case '$lt':
          return `${nameKey} < ${this.generateValue(convertedValue)}`;
        case '$lte':
          return `${nameKey} <= ${this.generateValue(convertedValue)}`;
        case '$contains':
          return `contains(${nameKey}, ${this.generateValue(convertedValue)})`;
        case '$beginsWith':
          return `begins_with(${nameKey}, ${this.generateValue(convertedValue)})`;
        case '$in':
          if (!Array.isArray(convertedValue)) {
            throw new Error('$in operator requires an array value');
          }
          const valueKeys = convertedValue.map(v => this.generateValue(v));
          return `${nameKey} IN (${valueKeys.join(', ')})`;
        default:
          throw new Error(`Unsupported operator: ${operator}`);
      }
    }
  
    // Build expression for a field
    buildFieldExpression(fieldName, condition, model) {
      if (condition === null) {
        const nameKey = this.generateName(fieldName);
        return `attribute_not_exists(${nameKey})`;
      }
  
      if (typeof condition !== 'object' || condition instanceof Date) {
        return this.buildComparison(fieldName, '$eq', condition, model);
      }
  
      const operators = Object.keys(condition);
      if (operators.length === 0) {
        throw new Error(`Empty condition object for field: ${fieldName}`);
      }
  
      const expressions = operators.map(operator => {
        return this.buildComparison(fieldName, operator, condition[operator], model);
      });
  
      return expressions.join(' AND ');
    }
  
    // Build expression for logical operators
    buildLogicalExpression(operator, conditions, model) {
      if (!Array.isArray(conditions)) {
        throw new Error(`${operator} requires an array of conditions`);
      }
  
      const expressions = conditions.map(condition => {
        return this.buildFilterExpression(condition, model);
      });
  
      const joinOperator = operator === '$and' ? ' AND ' : ' OR ';
      return `(${expressions.join(joinOperator)})`;
    }
  
    // Main entry point for building filter expression
    buildFilterExpression(filter, model) {
      if (!filter || Object.keys(filter).length === 0) {
        return null;
      }
  
      const expressions = [];
  
      for (const [key, value] of Object.entries(filter)) {
        if (key === '$and' || key === '$or') {
          expressions.push(this.buildLogicalExpression(key, value, model));
        } else if (key === '$not') {
          const innerExpr = this.buildFilterExpression(value, model);
          expressions.push(`NOT ${innerExpr}`);
        } else {
          expressions.push(this.buildFieldExpression(key, value, model));
        }
      }
  
      return expressions.join(' AND ');
    }
  
    // Build the complete filter expression with names and values
    build(filter, model) {
      // Validate field names against model
      this.validateFields(filter, model);
  
      const filterExpression = this.buildFilterExpression(filter, model);
      
      if (!filterExpression) {
        return null;
      }
  
      return {
        FilterExpression: filterExpression,
        ExpressionAttributeNames: this.names,
        ExpressionAttributeValues: this.values
      };
    }
  
    // Validate fields against model definition
    validateFields(filter, model) {
      const validateObject = (obj) => {
        for (const [key, value] of Object.entries(obj)) {
          // Skip logical operators
          if (['$and', '$or', '$not'].includes(key)) {
            if (Array.isArray(value)) {
              value.forEach(validateObject);
            } else {
              validateObject(value);
            }
            continue;
          }
  
          // Validate field exists in model
          if (!model.fields[key]) {
            throw new Error(`Unknown field in filter: ${key}`);
          }
  
          // Recursively validate nested conditions
          if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
            const operators = Object.keys(value);
            operators.forEach(op => {
              if (!['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$contains', '$beginsWith'].includes(op)) {
                throw new Error(`Invalid operator ${op} for field ${key}`);
              }
            });
          }
        }
      };
  
      validateObject(filter);
    }
  }
  
  module.exports = { FilterExpressionBuilder };