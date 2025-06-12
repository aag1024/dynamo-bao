// src/models/commentLike.js
const { BaoModel, PrimaryKeyConfig, IndexConfig } = require("../../src/model");

const { GSI_INDEX_ID1 } = require("../../src/constants");

const { StringField, RelatedField, UlidField } = require("../../src/fields");

class CommentLike extends BaoModel {
  static modelPrefix = "cl";
  static iterable = true;
  static iterationBuckets = 1;

  static fields = {
    commentLikeId: UlidField({ autoAssign: true }),
    authorId: RelatedField("User"),
    commentId: RelatedField("Comment"),
    likeType: StringField(),
  };

  static primaryKey = PrimaryKeyConfig("commentId", "authorId");

  static indexes = {
    commentLikesForComment: this.primaryKey,
    commentLikesByUser: IndexConfig("authorId", "commentLikeId", GSI_INDEX_ID1),
  };
}

module.exports = { CommentLike };
