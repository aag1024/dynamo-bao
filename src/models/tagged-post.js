const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1
} = require('../model');
const { CreateDateField, RelatedField } = require('../fields');

class TaggedPost extends BaseModel {
  static modelPrefix = 'tp';
  
  static fields = {
    tagId: RelatedField('Tag', { required: true }),
    postId: RelatedField('Post', { required: true }),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig('tagId', 'postId');

  static indexes = {
    postsByTag: this.primaryKey,
    tagsByPost: IndexConfig('postId', 'tagId', GSI_INDEX_ID1)
  };
}

module.exports = { TaggedPost }; 