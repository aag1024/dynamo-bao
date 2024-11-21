// src/models/comment.js
const { 
    BaseModel, 
    PrimaryKeyConfig,
    IndexConfig,
    GSI_INDEX_ID1,
  } = require('../model');
  const { StringField, RelatedField, CreateDateField } = require('../fields');
  
  class CommentLike extends BaseModel {
    static modelPrefix = 'cl';
    
    static fields = {
      authorId: RelatedField('User'),
      commentId: RelatedField('Comment'),
      likeType: StringField(),
      createdAt: CreateDateField(),
    };
  
    static primaryKey = PrimaryKeyConfig('commentId', 'authorId');

    static indexes = {
        commentLikesByUser: IndexConfig('authorId', 'createdAt', GSI_INDEX_ID1),
    }
  }
  
  module.exports = { CommentLike };