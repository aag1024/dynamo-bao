// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig
} = require('dynamo-bao');

const { 
    UlidField,
    RelatedField,
    StringField,
    CreateDateField,
    IntegerField
} = require('dynamo-bao').fields;



class Comment extends BaseModel {
  static modelPrefix = 'c';
  
  static fields = {
    commentId: UlidField({ required: true, autoAssign: true }),
    authorId: RelatedField('User', { required: false }),
    postId: RelatedField('Post', { required: false }),
    text: StringField(),
    createdAt: CreateDateField(),
    numLikes: IntegerField(),
  };

  static primaryKey = PrimaryKeyConfig('postId', 'commentId');

  static indexes = {
    commentsForPost: this.primaryKey,
  };




  async cgGetAuthor() {
    return await this.getOrLoadRelatedField('authorId');
  }

  async cgGetPost() {
    return await this.getOrLoadRelatedField('postId');
  }
}

module.exports = { Comment };
