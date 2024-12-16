// Constants for GSI indexes
const GSI_INDEX_ID1 = "gsi1";
const GSI_INDEX_ID2 = "gsi2";
const GSI_INDEX_ID3 = "gsi3";

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
  "_gsi_test_id",
];

const UNIQUE_CONSTRAINT_KEY = "_raft_uc";

module.exports = {
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  GSI_INDEX_ID3,
  UNIQUE_CONSTRAINT_ID1,
  UNIQUE_CONSTRAINT_ID2,
  UNIQUE_CONSTRAINT_ID3,
  SYSTEM_FIELDS,
  UNIQUE_CONSTRAINT_KEY,
};
