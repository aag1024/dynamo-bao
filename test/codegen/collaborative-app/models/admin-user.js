// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  BaoModel,
  PrimaryKeyConfig,
  UniqueConstraintConfig
} = require('../../../../src/model.js');

const {
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2
} = require('../../../../src/constants.js');

const { 
    UlidField,
    StringField,
    CreateDateField,
    ModifiedDateField
} = require('../../../../src/fields.js');


const { AdminSession } = require('./admin-session.js');


class AdminUser extends BaoModel {
  static modelPrefix = 'admin';
  static iterable = true;
  static iterationBuckets = 10;
  
  static fields = {
    adminId: UlidField({ autoAssign: true, required: true }),
    email: StringField({ required: true }),
    name: StringField({ required: true }),
    avatarUrl: StringField(),
    provider: StringField({ required: true }),
    providerId: StringField({ required: true }),
    role: StringField({ required: true }),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };

  static primaryKey = PrimaryKeyConfig('adminId', 'modelPrefix');


  static uniqueConstraints = {
    uniqueAdminEmail: UniqueConstraintConfig('email', UNIQUE_CONSTRAINT_ID1),
    uniqueAdminProvider: UniqueConstraintConfig('providerId', UNIQUE_CONSTRAINT_ID2),
  };

  async querySessions(skCondition = null, options = {}) {
    const results = await AdminSession.queryByIndex(
      'sessionsForAdmin',
      this._getPkValue(),
      skCondition,
      options
    );

    return results;
  }

  static async findByAdminEmail(value) {
    return await this.findByUniqueConstraint('uniqueAdminEmail', value);
  }

  static async findByAdminProvider(value) {
    return await this.findByUniqueConstraint('uniqueAdminProvider', value);
  }

}

module.exports = { AdminUser };
