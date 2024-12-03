const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1
} = require('../../src/model');

const { 
  StringField, 
  CreateDateField, 
  UlidField 
} = require('../../src/fields');

class Tag extends BaseModel {
  static modelPrefix = 't';
  
  static fields = {
    tagId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig('tagId');
}

module.exports = { Tag }; 