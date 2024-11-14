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

class User extends BaseModel {
  static prefix = 'u';
  
  static fields = {
    name: 'string',
    email: 'string',
    external_id: 'string',
    external_platform: 'string',
    profile_image_url: 'string',
    role: 'string',
    status: 'string'
  };

  static primaryKey = new PrimaryKeyConfig('user_id');

  // Multiple GSIs for different access patterns
  static indexes = [
    // GSI1: Query users by platform
    new IndexConfig('external_platform', 'user_id', GSI_INDEX_ID1),
    // GSI2: Query users by role
    new IndexConfig('role', 'status', GSI_INDEX_ID2),
    // GSI3: Query users by status
    new IndexConfig('status', 'created_at', GSI_INDEX_ID3)
  ];

  static uniqueConstraints = [
    new UniqueConstraintConfig('email', UNIQUE_CONSTRAINT_ID1),
    new UniqueConstraintConfig('external_id', UNIQUE_CONSTRAINT_ID2)
  ];
}

module.exports = { User };