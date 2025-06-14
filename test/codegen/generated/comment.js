// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  BaoModel,
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






class Comment extends BaoModel {
  static modelPrefix = 'c';
  static iterable = true;
  static iterationBuckets = 1;
  
  static fields = {
    commentId: UlidField({ autoAssign: true, required: true }),
    authorId: RelatedField('User', { required: false }),
    postId: RelatedField('Post', { required: false }),
    text: StringField(),
    createdAt: CreateDateField(),
    numLikes: IntegerField({ defaultValue: 0 }),
  };

  static primaryKey = PrimaryKeyConfig('postId', 'commentId');

  static indexes = {
    commentsForPost: this.primaryKey,
  };




  async getAuthor() {
    return await this.getOrLoadRelatedField('authorId');
  }

  async getPost() {
    return await this.getOrLoadRelatedField('postId');
  }
}

module.exports = { Comment };
