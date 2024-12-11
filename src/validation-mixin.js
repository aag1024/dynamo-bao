const { defaultLogger: logger } = require('./utils/logger');
const { TtlFieldClass } = require('./fields');
const { PrimaryKeyConfig } = require('./model-config');
const {
    GSI_INDEX_ID1,
    GSI_INDEX_ID2,
    GSI_INDEX_ID3,
    UNIQUE_CONSTRAINT_ID1,
    UNIQUE_CONSTRAINT_ID2,
    UNIQUE_CONSTRAINT_ID3
} = require('./constants');

const ValidationMethods = {
  validateConfiguration() {
    if (!this.modelPrefix) {
      throw new Error(`${this.name} must define a modelPrefix`);
    }

    if (!this.primaryKey) {
      throw new Error(`${this.name} must define a primaryKey`);
    }

    // Update to use TtlFieldClass instead of TtlField
    Object.entries(this.fields).forEach(([fieldName, field]) => {
      if (field instanceof TtlFieldClass && fieldName !== 'ttl') {
        throw new Error(`TtlField must be named 'ttl', found '${fieldName}' in ${this.name}`);
      }
    });

    // Ensure primary key fields are required
    const pkField = this.getField(this.primaryKey.pk);
    if (!pkField.required) {
      logger.warn(`Warning: Primary key field '${this.primaryKey.pk}' in ${this.name} was not explicitly marked as required. Marking as required automatically.`);
      pkField.required = true;
    }
    
    const skField = this.getField(this.primaryKey.sk);
    if (!skField.required) {
      logger.warn(`Warning: Sort key field '${this.primaryKey.sk}' in ${this.name} was not explicitly marked as required. Marking as required automatically.`);
      skField.required = true;
    }

    // Validate field names don't start with underscore
    Object.keys(this.fields).forEach(fieldName => {
      if (fieldName.startsWith('_')) {
        throw new Error(`Field name '${fieldName}' in ${this.name} cannot start with underscore`);
      }
    });

    const validIndexIds = [
        GSI_INDEX_ID1, 
        GSI_INDEX_ID2, 
        GSI_INDEX_ID3, 
        undefined]; // undefined for PK-based indexes
    
    // Validate index names and referenced fields
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      // Check if index name starts with underscore
      if (indexName.startsWith('_')) {
        throw new Error(`Index name '${indexName}' in ${this.name} cannot start with underscore`);
      }

      // Check if referenced fields start with underscore
      if (index.pk !== 'modelPrefix' && index.pk.startsWith('_')) {
        throw new Error(`Index '${indexName}' references invalid field '${index.pk}' (cannot start with underscore)`);
      }
      if (index.sk !== 'modelPrefix' && index.sk.startsWith('_')) {
        throw new Error(`Index '${indexName}' references invalid field '${index.sk}' (cannot start with underscore)`);
      }

      // Check if this index matches the primary key configuration
      const isPrimaryKeyIndex = (
        index instanceof PrimaryKeyConfig &&
        index.pk === this.primaryKey.pk &&
        index.sk === this.primaryKey.sk
      );

      if (!validIndexIds.includes(index.indexId) && !isPrimaryKeyIndex) {
        throw new Error(`Invalid index ID ${index.indexId} in ${this.name}`);
      }

      // These will throw errors if the fields don't exist
      const idxPkField = this.getField(index.pk);
      const idxSkField = this.getField(index.sk);
    });

    // Validate unique constraints
    const validConstraintIds = [
        UNIQUE_CONSTRAINT_ID1, 
        UNIQUE_CONSTRAINT_ID2, 
        UNIQUE_CONSTRAINT_ID3
    ];

    Object.values(this.uniqueConstraints || {}).forEach(constraint => {
      if (!validConstraintIds.includes(constraint.constraintId)) {
        throw new Error(`Invalid constraint ID ${constraint.constraintId} in ${this.name}`);
      }
      
      if (!this.getField(constraint.field)) {
        throw new Error(
          `Unique constraint field '${constraint.field}' not found in ${this.name} fields`
        );
      }
    });
  }
};

module.exports = ValidationMethods; 