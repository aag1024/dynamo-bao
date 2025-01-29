// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig
} = require('dynamo-bao');

const {
  UNIQUE_CONSTRAINT_ID1
} = require('dynamo-bao').constants;


const { 
    UlidField,
    StringField,
    CreateDateField,
    ModifiedDateField
} = require('dynamo-bao').fields;




const { Post } = require('./post');

class User extends BaoModel {
  static modelPrefix = 'u';
  
  static fields = {
    userId: UlidField({ autoAssign: true, required: true }),
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

  async queryPosts(skCondition = null, options = {}) {
    const results = await Post.queryByIndex(
      'postsForUser',
      this._getPkValue(),
      skCondition,
      options
    );

    return results;
  }

  static async findAll(options = {}) {
    return await this.scan(options);
  }

  static async findById(id) {
    return await this.get(id);
  }


  static async findByEmail(value) {
    return await this.findByUniqueConstraint('uniqueEmail', value);
  }

}

module.exports = { User };
