// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨
// DO NOT EDIT: Generated by model-codegen
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨
const { BaseModel, PrimaryKeyConfig, IndexConfig } = require("dynamo-bao");

const { GSI_INDEX_ID1, GSI_INDEX_ID2 } = require("dynamo-bao").constants;

const { RelatedField, CreateDateField } = require("dynamo-bao").fields;

class TaggedPost extends BaseModel {
  static modelPrefix = "tp";

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

  async cgGetTag() {
    return await this.getOrLoadRelatedField("tagId");
  }

  async cgGetPost() {
    return await this.getOrLoadRelatedField("postId");
  }
}

module.exports = { TaggedPost };
