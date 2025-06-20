// src/models/comment.js
const { BaoModel, PrimaryKeyConfig } = require("../../src/model");

const {
  StringField,
  RelatedField,
  IntegerField,
  CreateDateField,
  UlidField,
} = require("../../src/fields");

class Comment extends BaoModel {
  static modelPrefix = "c";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    commentId: UlidField({ autoAssign: true }),
    authorId: RelatedField("User"),
    postId: RelatedField("Post"),
    text: StringField(),
    createdAt: CreateDateField(),
    numLikes: IntegerField({ defaultValue: 0 }),
  };

  static primaryKey = PrimaryKeyConfig("postId", "commentId");

  static indexes = {
    commentsForPost: this.primaryKey,
  };
}

module.exports = { Comment };
