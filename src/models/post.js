// src/models/post.js
const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1,
  GSI_INDEX_ID2
} = require('../model');
const { StringField, CreateDateField } = require('../fields');

class Post extends BaseModel {
  static modelPrefix = 'p';
  
  static fields = {
    postId: StringField({ required: true }),
    userId: StringField({ required: true }),
    title: StringField({ required: true }),
    content: StringField({ required: true }),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig('postId');

  static indexes = [
    IndexConfig('modelPrefix', 'postId', GSI_INDEX_ID1),
    IndexConfig('userId', 'createdAt', GSI_INDEX_ID2)
  ];
}

module.exports = { Post };