const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1
} = require('../model');
const { StringField, CreateDateField, ULIDField } = require('../fields');

class Tag extends BaseModel {
  static modelPrefix = 't';
  
  static fields = {
    tagId: ULIDField({ autoAssign: true }),
    name: StringField({ required: true }),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig('tagId');
}

module.exports = { Tag }; 