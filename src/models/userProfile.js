// src/models/userProfile.js
const { 
    BaseModel, 
    PrimaryKeyConfig,
  } = require('../model');
  const { StringField, RelatedField } = require('../fields');
  
  class UserProfile extends BaseModel {
    static modelPrefix = 'up';
    
    static fields = {
      userId: RelatedField({ modelName: 'User' }),
      name: StringField({ required: true }),
      profile_image_url: StringField(),
    };
  
    static primaryKey = PrimaryKeyConfig('userId');
  }
  
  module.exports = { UserProfile };