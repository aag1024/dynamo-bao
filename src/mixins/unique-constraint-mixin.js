const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { defaultLogger: logger } = require("../utils/logger");
const { UNIQUE_CONSTRAINT_KEY } = require("../constants");
const { ConditionalError } = require("../exceptions");

const UniqueConstraintMethods = {
  async _validateUniqueConstraints(data, currentId = null) {
    logger.debug("validateUniqueConstraints called on", this.name, {
      modelTestId: this._testId,
      managerTestId: this.manager.getTestId(),
      instanceKey: this._testId || "default",
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
        const key = this._formatUniqueConstraintKey.call(
          this,
          constraint.constraintId,
          this.modelPrefix,
          constraint.field,
          value,
        );

        logger.debug("Checking unique constraint:", {
          key,
          field: constraint.field,
          value,
          testId: this.manager.getTestId(),
          managerTestId: this.manager.getTestId(),
        });

        const result = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              _pk: key,
              _sk: UNIQUE_CONSTRAINT_KEY,
            },
          }),
        );

        if (result.Item) {
          logger.debug("Found existing constraint:", result.Item);
          if (!currentId || result.Item.relatedId !== currentId) {
            throw new ConditionalError(
              `${constraint.field} must be unique`,
              "unique_constraint",
              constraint.field,
            );
          }
        }
      } catch (innerError) {
        if (innerError instanceof ConditionalError) {
          throw innerError;
        }
        console.error("Error checking unique constraint:", innerError);
        throw new ConditionalError(
          `Failed to validate ${constraint.field} uniqueness`,
          "unique_constraint",
          constraint.field,
        );
      }
    }
  },

  async _createUniqueConstraint(field, value, relatedId, constraintId) {
    const testId = this.manager.getTestId();
    const key = this._formatUniqueConstraintKey.call(
      this,
      constraintId,
      this.modelPrefix,
      field,
      value,
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
        ConditionExpression:
          "attribute_not_exists(#pk) OR (relatedId = :relatedId AND relatedModel = :modelName)",
        ExpressionAttributeNames: {
          "#pk": "_pk",
        },
        ExpressionAttributeValues: {
          ":relatedId": relatedId,
          ":modelName": this.name,
        },
      },
    };
  },

  async _removeUniqueConstraint(field, value, relatedId, constraintId) {
    return {
      Delete: {
        TableName: this.table,
        Key: {
          _pk: this._formatUniqueConstraintKey.call(
            this,
            constraintId,
            this.modelPrefix,
            field,
            value,
          ),
          _sk: UNIQUE_CONSTRAINT_KEY,
        },
        ConditionExpression:
          "relatedId = :relatedId AND relatedModel = :modelName",
        ExpressionAttributeValues: {
          ":relatedId": relatedId,
          ":modelName": this.name,
        },
      },
    };
  },
};

module.exports = UniqueConstraintMethods;
