// src/models/post.js
const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1,
  GSI_INDEX_ID2  // Added this import
} = require('../model');

class Post extends BaseModel {
  static prefix = 'p';
  
  static fields = {
    userId: 'string',
    title: 'string',
    content: 'string'
  };

  static primaryKey = new PrimaryKeyConfig('post_id');

  static indexes = [
    new IndexConfig('model_id', 'post_id', GSI_INDEX_ID1),
    new IndexConfig('userId', 'createdAt', GSI_INDEX_ID2)
  ];
}

module.exports = { Post };