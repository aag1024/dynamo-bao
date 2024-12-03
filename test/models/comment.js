// src/models/comment.js
const { 
    BaseModel, 
    PrimaryKeyConfig,
  } = require('../../src/model');
  
const { 
  StringField, 
  RelatedField, 
  IntegerField, 
  CreateDateField, 
  ULIDField 
} = require('../../src/fields');
  
class Comment extends BaseModel {
  static modelPrefix = 'c';
  
  static fields = {
    commentId: ULIDField({ autoAssign: true }),
    authorId: RelatedField('User'),
    postId: RelatedField('Post'),
    text: StringField(),
    createdAt: CreateDateField(),
    numLikes: IntegerField({ defaultValue: 0 }),
  };

  static primaryKey = PrimaryKeyConfig('postId', 'commentId');

  static indexes = {
      commentsForPost: this.primaryKey
  }
}

module.exports = { Comment };