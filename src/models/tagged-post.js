const { 
  BaseModel, 
  PrimaryKeyConfig,
  IndexConfig,
  GSI_INDEX_ID1,
  GSI_INDEX_ID2
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
    postsForTag: this.primaryKey,
    tagsForPost: IndexConfig('postId', 'tagId', GSI_INDEX_ID1),
    recentPostsForTag: IndexConfig('tagId', 'createdAt', GSI_INDEX_ID2)
  };
}

module.exports = { TaggedPost }; 