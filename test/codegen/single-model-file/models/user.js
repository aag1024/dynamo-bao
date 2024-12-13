// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  BaseModel, 
  UNIQUE_CONSTRAINT_ID1,
  PrimaryKeyConfig,
  UniqueConstraintConfig
} = require('dynamo-bao');

const { 
    UlidField,
    StringField,
    CreateDateField,
    ModifiedDateField
} = require('dynamo-bao').fields;

const { Post } = require('./post');

class User extends BaseModel {
  static modelPrefix = 'u';
  
  static fields = {
    userId: UlidField({ required: true, autoAssign: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    profilePictureUrl: StringField(),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };

  static primaryKey = PrimaryKeyConfig('userId', 'modelPrefix');


  static uniqueConstraints = {
    uniqueEmail: UniqueConstraintConfig('email', UNIQUE_CONSTRAINT_ID1),
  };

  async cgQueryPosts(skCondition = null, options = {}) {
    const results = await Post.queryByIndex(
      'postsForUser',
      this._getPkValue(),
      skCondition,
      options
    );

    return results;
  }

  static async cgFindByEmail(value) {
    return await this.findByUniqueConstraint('uniqueEmail', value);
  }

}

module.exports = { User };
