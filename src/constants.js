// Constants for GSI indexes
const GSI_INDEX_ID1 = "gsi1";
const GSI_INDEX_ID2 = "gsi2";
const GSI_INDEX_ID3 = "gsi3";
const GSI_INDEX_ID4 = "gsi4";
const GSI_INDEX_ID5 = "gsi5";

// Constants for iteration index
const ITERATION_INDEX_NAME = "iter_index";
const ITERATION_PK_FIELD = "_iter_pk";
const ITERATION_SK_FIELD = "_iter_sk";

// Constants for unique constraints
const UNIQUE_CONSTRAINT_ID1 = "_uc1";
const UNIQUE_CONSTRAINT_ID2 = "_uc2";
const UNIQUE_CONSTRAINT_ID3 = "_uc3";

// Constants for system fields
const SYSTEM_FIELDS = [
  "_pk",
  "_sk",
  "_gsi1_pk",
  "_gsi1_sk",
  "_gsi2_pk",
  "_gsi2_sk",
  "_gsi3_pk",
  "_gsi3_sk",
  "_gsi4_pk",
  "_gsi4_sk",
  "_gsi5_pk",
  "_gsi5_sk",
  "_iter_pk",
  "_iter_sk",
];

const UNIQUE_CONSTRAINT_KEY = "_raft_uc";

module.exports = {
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  GSI_INDEX_ID4,
  GSI_INDEX_ID5,
  ITERATION_INDEX_NAME,
  ITERATION_PK_FIELD,
  ITERATION_SK_FIELD,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2,
  UNIQUE_CONSTRAINT_ID3,
  SYSTEM_FIELDS,
  UNIQUE_CONSTRAINT_KEY,
};
