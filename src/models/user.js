// src/models/user.js
const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2
} = require('../model');
const { StringField, CreateDateField, ModifiedDateField, ULIDField } = require('../fields');

class User extends BaseModel {
  static modelPrefix = 'u';
  
  static fields = {
    userId: ULIDField({ autoAssign: true }),
    name: StringField({ required: true }),
    email: StringField({ 
      required: true,
      pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    }),
    external_id: StringField({ required: true }),
    external_platform: StringField({ required: true }),
    profile_image_url: StringField(),
    role: StringField({ 
      required: true,
      defaultValue: 'user'
    }),
    status: StringField({ 
      required: true,
      defaultValue: 'active'
    }),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField()
  };

  static primaryKey = PrimaryKeyConfig('userId');

  static indexes = [
    IndexConfig('external_platform', 'userId', GSI_INDEX_ID1),
    IndexConfig('role', 'status', GSI_INDEX_ID2),
    IndexConfig('status', 'createdAt', GSI_INDEX_ID3)
  ];

  static uniqueConstraints = [
    UniqueConstraintConfig('email', UNIQUE_CONSTRAINT_ID1),
    UniqueConstraintConfig('external_id', UNIQUE_CONSTRAINT_ID2)
  ];
}

module.exports = { User };