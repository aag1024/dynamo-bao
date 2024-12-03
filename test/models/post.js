// src/models/post.js
const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1,
  GSI_INDEX_ID2
} = require('../../src/model');

const { 
  StringField, 
  CreateDateField, 
  UlidField, 
  RelatedField, 
  VersionField 
} = require('../../src/fields');

class Post extends BaseModel {
  static modelPrefix = 'p';
  
  static fields = {
    postId: UlidField({ autoAssign: true }),
    userId: RelatedField('User', { required: true }),
    title: StringField({ required: true }),
    content: StringField({ required: true }),
    createdAt: CreateDateField(),
    version: VersionField(),
  };

  static primaryKey = PrimaryKeyConfig('postId');

  static indexes = {
    allPosts: IndexConfig('modelPrefix', 'postId', GSI_INDEX_ID1),
    postsForUser: IndexConfig('userId', 'createdAt', GSI_INDEX_ID2)
  };
}

module.exports = { Post };