const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../../src/model");

const { StringField, CreateDateField, UlidField } = require("../../src/fields");

class Tag extends BaoModel {
  static modelPrefix = "t";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    tagId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig("tagId");
}

module.exports = { Tag };
