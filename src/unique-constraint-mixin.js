const { defaultLogger: logger } = require('./utils/logger');
const { UNIQUE_CONSTRAINT_KEY } = require('./constants');

const UniqueConstraintMethods = {
  async validateUniqueConstraints(data, currentId = null) {
    logger.debug('validateUniqueConstraints called on', this.name, {
      modelTestId: this._testId,
      managerTestId: this.manager.getTestId(),
      instanceKey: this._testId || 'default'
    });

    if (!this.uniqueConstraints) {
      return;
    }

    const docClient = this.manager.documentClient;
    const tableName = this.manager.tableName;

    for (const [name, constraint] of Object.entries(this.uniqueConstraints)) {
      const value = data[constraint.field];
      if (!value) continue;

      try {
        const key = UniqueConstraintMethods.formatUniqueConstraintKey.call(
          this,
          constraint.constraintId,
          this.modelPrefix,
          constraint.field,
          value
        );

        logger.debug('Checking unique constraint:', {
          key,
          field: constraint.field,
          value,
          testId: this.manager.getTestId(),
          managerTestId: this.manager.getTestId()
        });

        const result = await docClient.get({
          TableName: tableName,
          Key: {
            _pk: key,
            _sk: UNIQUE_CONSTRAINT_KEY
          }
        });
        
        if (result.Item) {
          logger.debug('Found existing constraint:', result.Item);
          if (!currentId || result.Item.relatedId !== currentId) {
            throw new Error(`${constraint.field} must be unique`);
          }
        }
      } catch (innerError) {
        if (innerError.message.includes('must be unique')) {
          throw innerError;
        }
        console.error('Error checking unique constraint:', innerError);
        throw new Error(`Failed to validate ${constraint.field} uniqueness`);
      }
    }
  },

  async _createUniqueConstraint(field, value, relatedId, constraintId) {
    const testId = this.manager.getTestId();
    const key = UniqueConstraintMethods.formatUniqueConstraintKey.call(
      this,
      constraintId,
      this.modelPrefix,
      field,
      value
    );

    let item = {
      _pk: key,
      _sk: UNIQUE_CONSTRAINT_KEY,
      uniqueValue: key,
      relatedId: relatedId,
      relatedModel: this.name,
    };

    if (testId) {
      item._gsi_test_id = testId;
    }

    return {
      Put: {
        TableName: this.table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(#pk) OR (relatedId = :relatedId AND relatedModel = :modelName)',
        ExpressionAttributeNames: {
          '#pk': '_pk'
        },
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': this.name
        }
      }
    };
  },

  async _removeUniqueConstraint(field, value, relatedId, constraintId) {
    return {
      Delete: {
        TableName: this.table,
        Key: {
          _pk: UniqueConstraintMethods.formatUniqueConstraintKey.call(
            this,
            constraintId,
            this.modelPrefix,
            field,
            value
          ),
          _sk: UNIQUE_CONSTRAINT_KEY
        },
        ConditionExpression: 'relatedId = :relatedId AND relatedModel = :modelName',
        ExpressionAttributeValues: {
          ':relatedId': relatedId,
          ':modelName': this.name
        }
      }
    };
  }
};

// Define the static method separately
UniqueConstraintMethods.formatUniqueConstraintKey = function(constraintId, modelPrefix, field, value) {
  const testId = this.manager.getTestId();
  const baseKey = `${UNIQUE_CONSTRAINT_KEY}#${constraintId}#${modelPrefix}#${field}:${value}`;
  return testId ? `[${testId}]#${baseKey}` : baseKey;
};

module.exports = UniqueConstraintMethods; 