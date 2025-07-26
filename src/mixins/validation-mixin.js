const { defaultLogger: logger } = require("../utils/logger");
const { TtlFieldClass, StringSetFieldClass } = require("../fields");
const { PrimaryKeyConfig } = require("../model-config");
const { ConfigurationError } = require("../exceptions");
const {
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2,
  UNIQUE_CONSTRAINT_ID3,
} = require("../constants");

const ValidationMethods = {
  /**
   *
   * @function _validateConfiguration
   *@memberof BaoModel
   * @private
   * @throws {Error} If modelPrefix is not defined
   * @throws {Error} If primaryKey is not defined
   * @throws {Error} If TTL field is incorrectly named
   * @throws {Error} If field names start with underscore
   * @throws {Error} If index names start with underscore
   * @throws {Error} If index IDs are invalid
   * @throws {Error} If constraint IDs are invalid
   *
   * @example
   * const model = new DynamoModel();
   * model._validateConfiguration();
   *
   * @description
   * Validates the model configuration. This is called by the code generator
   * and should not need to be called directly.
   *
   * Performs the following validations:
   * - Ensures modelPrefix is defined
   * - Ensures primaryKey is defined
   * - Validates TTL field naming
   * - Ensures primary key fields are marked as required
   * - Validates field naming conventions
   * - Validates index configurations
   * - Validates unique constraints
   */
  _validateConfiguration() {
    if (!this.modelPrefix) {
      throw new ConfigurationError(
        `${this.name} must define a modelPrefix`,
        this.name,
      );
    }

    if (!this.primaryKey) {
      throw new ConfigurationError(
        `${this.name} must define a primaryKey`,
        this.name,
      );
    }

    // Update to use TtlFieldClass instead of TtlField
    Object.entries(this.fields).forEach(([fieldName, field]) => {
      if (field instanceof TtlFieldClass && fieldName !== "ttl") {
        throw new ConfigurationError(
          `TtlField must be named 'ttl', found '${fieldName}' in ${this.name}`,
          this.name,
        );
      }
    });

    // Ensure primary key fields are required
    const pkField = this._getField(this.primaryKey.pk);
    if (!pkField.required) {
      logger.warn(
        `Warning: Primary key field '${this.primaryKey.pk}' in ${this.name} was not explicitly marked as required. Marking as required automatically.`,
      );
      pkField.required = true;
    }

    const skField = this._getField(this.primaryKey.sk);
    if (!skField.required && this.primaryKey.sk !== "modelPrefix") {
      logger.warn(
        `Warning: Sort key field '${this.primaryKey.sk}' in ${this.name} was not explicitly marked as required. Marking as required automatically.`,
      );
      skField.required = true;
    }

    // Validate field names don't start with underscore
    Object.keys(this.fields).forEach((fieldName) => {
      if (fieldName.startsWith("_")) {
        throw new ConfigurationError(
          `Field name '${fieldName}' in ${this.name} cannot start with underscore`,
          this.name,
        );
      }
    });

    const validIndexIds = [
      GSI_INDEX_ID1,
      GSI_INDEX_ID2,
      GSI_INDEX_ID3,
      undefined,
    ]; // undefined for PK-based indexes

    // Validate index names and referenced fields
    Object.entries(this.indexes).forEach(([indexName, index]) => {
      // Check if index name starts with underscore
      if (indexName.startsWith("_")) {
        throw new ConfigurationError(
          `Index name '${indexName}' in ${this.name} cannot start with underscore`,
          this.name,
        );
      }

      // Check if referenced fields start with underscore
      if (index.pk !== "modelPrefix" && index.pk.startsWith("_")) {
        throw new ConfigurationError(
          `Index '${indexName}' references invalid field '${index.pk}' (cannot start with underscore)`,
          this.name,
        );
      }
      if (index.sk !== "modelPrefix" && index.sk.startsWith("_")) {
        throw new ConfigurationError(
          `Index '${indexName}' references invalid field '${index.sk}' (cannot start with underscore)`,
          this.name,
        );
      }

      // Check if this index matches the primary key configuration
      const isPrimaryKeyIndex =
        index instanceof PrimaryKeyConfig &&
        index.pk === this.primaryKey.pk &&
        index.sk === this.primaryKey.sk;

      if (!validIndexIds.includes(index.indexId) && !isPrimaryKeyIndex) {
        throw new ConfigurationError(
          `Invalid index ID ${index.indexId} in ${this.name}`,
          this.name,
        );
      }

      // These will throw errors if the fields don't exist
      const idxPkField = this._getField(index.pk);
      const idxSkField = this._getField(index.sk);

      // StringSetField cannot be indexed
      if (idxPkField instanceof StringSetFieldClass) {
        throw new ConfigurationError(
          `StringSetField '${index.pk}' cannot be used as partition key in index '${indexName}' in ${this.name}`,
          this.name,
        );
      }
      if (idxSkField instanceof StringSetFieldClass) {
        throw new ConfigurationError(
          `StringSetField '${index.sk}' cannot be used as sort key in index '${indexName}' in ${this.name}`,
          this.name,
        );
      }
    });

    // Validate iteration configuration
    if (this.hasOwnProperty("iterable")) {
      if (typeof this.iterable !== "boolean") {
        throw new ConfigurationError(
          `iterable must be a boolean in ${this.name}`,
          this.name,
        );
      }

      if (this.iterable) {
        if (!this.hasOwnProperty("iterationBuckets")) {
          this.iterationBuckets = 100; // Set default
        } else {
          if (
            !Number.isInteger(this.iterationBuckets) ||
            this.iterationBuckets < 1 ||
            this.iterationBuckets > 1000
          ) {
            throw new ConfigurationError(
              `iterationBuckets must be an integer between 1 and 1000 in ${this.name}`,
              this.name,
            );
          }
        }
      }
    } else {
      this.iterable = false;
    }

    // Validate unique constraints
    const validConstraintIds = [
      UNIQUE_CONSTRAINT_ID1,
      UNIQUE_CONSTRAINT_ID2,
      UNIQUE_CONSTRAINT_ID3,
    ];

    Object.values(this.uniqueConstraints || {}).forEach((constraint) => {
      if (!validConstraintIds.includes(constraint.constraintId)) {
        throw new ConfigurationError(
          `Invalid constraint ID ${constraint.constraintId} in ${this.name}`,
          this.name,
        );
      }

      if (!this._getField(constraint.field)) {
        throw new ConfigurationError(
          `Unique constraint field '${constraint.field}' not found in ${this.name} fields`,
          this.name,
        );
      }
    });
  },
};

module.exports = ValidationMethods;
