const { BaseModel } = require('../model');

class Post extends BaseModel {
  static prefix = 'post';
  static name = 'Post';
  static fields = {
    userId: 'string',
    title: 'string',
    content: 'string'
  };
}

module.exports = { Post };