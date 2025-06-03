/**
 * @fileoverview
 * Custom exception classes for dynamo-bao library.
 * These provide more specific error types than generic Error objects.
 */

/**
 * Base class for all dynamo-bao exceptions
 */
class BaoError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when model configuration is invalid
 * Examples: missing modelPrefix, invalid field names, invalid index configurations
 */
class ConfigurationError extends BaoError {
  constructor(message, modelName = null) {
    super(message);
    this.modelName = modelName;
  }
}

/**
 * Thrown when field validation fails
 * Examples: required field missing, invalid ULID format, type validation failures
 */
class ValidationError extends BaoError {
  constructor(message, fieldName = null, value = null) {
    super(message);
    this.fieldName = fieldName;
    this.value = value;
  }
}

/**
 * Thrown when query construction or execution fails
 * Examples: invalid operators, field not found, index not found, malformed conditions
 */
class QueryError extends BaoError {
  constructor(message, indexName = null, fieldName = null) {
    super(message);
    this.indexName = indexName;
    this.fieldName = fieldName;
  }
}

/**
 * Thrown when a database item is not found
 * This is distinct from the existing ObjectNotFound class which is a result wrapper
 */
class ItemNotFoundError extends BaoError {
  constructor(message = "Item not found", primaryId = null) {
    super(message);
    this.primaryId = primaryId;
  }
}

/**
 * Thrown when DynamoDB operations fail due to conditions
 * Examples: conditional check failures, unique constraint violations
 */
class ConditionalError extends BaoError {
  constructor(message, operation = null, condition = null) {
    super(message);
    this.operation = operation;
    this.condition = condition;
  }
}

/**
 * Thrown when data parsing or conversion fails
 * Examples: invalid primary ID format, JSON parsing errors, type conversion failures
 */
class DataFormatError extends BaoError {
  constructor(message, data = null, expectedFormat = null) {
    super(message);
    this.data = data;
    this.expectedFormat = expectedFormat;
  }
}

module.exports = {
  BaoError,
  ConfigurationError,
  ValidationError,
  QueryError,
  ItemNotFoundError,
  ConditionalError,
  DataFormatError,
};
