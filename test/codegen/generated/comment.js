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



  static async findAll(options = {}) {
    return await this.scan(options);
  }

  static async findById(id) {
    return await this.get(id);
  }



  async getAuthor() {
    return await this.getOrLoadRelatedField('authorId');
  }

  async getPost() {
    return await this.getOrLoadRelatedField('postId');
  }
}

module.exports = { Comment };
