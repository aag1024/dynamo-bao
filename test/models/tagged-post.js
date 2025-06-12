const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../../src/model");

const { GSI_INDEX_ID1, GSI_INDEX_ID2 } = require("../../src/constants");

const { CreateDateField, RelatedField } = require("../../src/fields");

class TaggedPost extends BaoModel {
  static modelPrefix = "tp";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    tagId: RelatedField("Tag", { required: true }),
    postId: RelatedField("Post", { required: true }),
    createdAt: CreateDateField(),
  };

  static primaryKey = PrimaryKeyConfig("tagId", "postId");

  static indexes = {
    postsForTag: this.primaryKey,
    tagsForPost: IndexConfig("postId", "tagId", GSI_INDEX_ID1),
    recentPostsForTag: IndexConfig("tagId", "createdAt", GSI_INDEX_ID2),
  };
}

module.exports = { TaggedPost };
