const { BaseModel } = require('../model');

class User extends BaseModel {
  static prefix = 'user';
  static name = 'User';
  static fields = {
    email: 'string',
    name: 'string'
  };
  static uniqueFields = ['email'];
}

module.exports = { User };