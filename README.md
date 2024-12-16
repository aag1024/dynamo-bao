# DynamoDB Single Table Library

Simple library for working with DynamoDB using the single-table pattern.# raftjs

## Key Structure

1. Primary Keys (Base Table):

- Partition Key (`_pk`): `{model_id}##{value}`
- Sort Key (`_sk`): Raw value or model_id depending on context

2. Global Secondary Indexes (GSI):

- GSI1:
  - PK (`_gsi1_pk`): `{model_id}#{index_id}#{value}`
  - SK (`_gsi1_sk`): Raw value
- GSI2:
  - PK (`_gsi2_pk`): `{model_id}#{index_id}#{value}`
  - SK (`_gsi2_sk`): Raw value
- GSI3:
  - PK (`_gsi3_pk`): `{model_id}#{index_id}#{value}`
  - SK (`_gsi3_sk`): Raw value

3. Unique Constraints:

- Partition Key: `_raft_uc##{unique_constraint_id}#{model_id}#{field_values}`
- Sort Key: `_raft_uc`
- Example for a user email constraint: `_raft_uc##user:email:test@example.com`

Key points about the prefixing system:

- All GSI partition keys include the model_id to namespace the records
- Single hash (`#`) is used for primary andGSI key component separation
- Unique constraints have their own special prefix (`_raft_uc`) to separate them from regular records
- The index_id is embedded in the key name for GSIs (`_gsi1_pk`, `_gsi2_pk`, etc.)

Unique constraint IDs look like this:
UNIQUE_CONSTRAINT_ID1 = "\_uc1"
UNIQUE_CONSTRAINT_ID2 = "\_uc2"
UNIQUE_CONSTRAINT_ID3 = "\_uc3"
