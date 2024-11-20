// src/index.js
const { 
    BaseModel,
    PrimaryKeyConfig,
    IndexConfig,
    UniqueConstraintConfig,
    GSI_INDEX_ID1,
    GSI_INDEX_ID2,
    GSI_INDEX_ID3,
    GSI_INDEX_ID4,
    UNIQUE_CONSTRAINT_ID1,
    UNIQUE_CONSTRAINT_ID2,
    UNIQUE_CONSTRAINT_ID3,
    UNIQUE_CONSTRAINT_ID4,
  } = require('./model');
  const { User } = require('./models/user');
  const { Post } = require('./models/post');
  const { Tag } = require('./models/tag');
  const { TaggedPost } = require('./models/tagged-post');
  
  module.exports = {
    BaseModel,
    User,
    Post,
    PrimaryKeyConfig,
    IndexConfig,
    UniqueConstraintConfig,
    GSI_INDEX_ID1,
    GSI_INDEX_ID2,
    GSI_INDEX_ID3,
    GSI_INDEX_ID4,
    UNIQUE_CONSTRAINT_ID1,
    UNIQUE_CONSTRAINT_ID2,
    UNIQUE_CONSTRAINT_ID3,
    UNIQUE_CONSTRAINT_ID4,
    Tag,
    TaggedPost,
  };