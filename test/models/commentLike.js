// src/models/commentLike.js
const { 
    BaseModel, 
    PrimaryKeyConfig,
    IndexConfig,
    GSI_INDEX_ID1,
} = require('../../src/model');

const { 
  StringField, 
  RelatedField, 
  UlidField 
} = require('../../src/fields');
  
class CommentLike extends BaseModel {
  static modelPrefix = 'cl';
  
  static fields = {
    commentLikeId: UlidField({ autoAssign: true }),
    authorId: RelatedField('User'),
    commentId: RelatedField('Comment'),
    likeType: StringField(),
  };

  static primaryKey = PrimaryKeyConfig('commentId', 'authorId');

  static indexes = {
      commentLikesForComment: this.primaryKey,
      commentLikesByUser: IndexConfig('authorId', 'commentLikeId', GSI_INDEX_ID1),
  }
}

module.exports = { CommentLike };