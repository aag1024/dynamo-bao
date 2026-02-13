const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../../src/model");

const { GSI_INDEX_ID1 } = require("../../src/constants");

const { StringField, UlidField } = require("../../src/fields");

class OptionalGsiModel extends BaoModel {
  static modelPrefix = "og";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    itemId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    // Both GSI key fields are optional with no defaults
    category: StringField(),
    subcategory: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("itemId");

  static indexes = {
    byCategory: IndexConfig("category", "subcategory", GSI_INDEX_ID1),
  };
}

module.exports = { OptionalGsiModel };
