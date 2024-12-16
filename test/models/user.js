// src/models/user.js
const {
  BaseModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("../../src/model");

const {
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2,
} = require("../../src/constants");

const {
  StringField,
  CreateDateField,
  ModifiedDateField,
  UlidField,
} = require("../../src/fields");

class User extends BaseModel {
  static modelPrefix = "u";

  static fields = {
    userId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    externalId: StringField(),
    externalPlatform: StringField(),
    profileImageUrl: StringField(),
    role: StringField({
      required: true,
      defaultValue: "user",
    }),
    status: StringField({
      required: true,
      defaultValue: "active",
    }),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };

  static primaryKey = PrimaryKeyConfig("userId");

  static indexes = {
    byPlatform: IndexConfig("externalPlatform", "userId", GSI_INDEX_ID1),
    byRole: IndexConfig("role", "status", GSI_INDEX_ID2),
    byStatus: IndexConfig("status", "createdAt", GSI_INDEX_ID3),
  };

  static uniqueConstraints = {
    uniqueEmail: UniqueConstraintConfig("email", UNIQUE_CONSTRAINT_ID1),
    uniqueExternalId: UniqueConstraintConfig(
      "externalId",
      UNIQUE_CONSTRAINT_ID2,
    ),
  };
}

module.exports = { User };
