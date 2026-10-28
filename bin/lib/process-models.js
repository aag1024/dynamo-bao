// Pure function for normalizing and validating parsed model definitions
// before they hit codegen. Keeps validation testable in isolation and
// produces clear, model-scoped error messages.

const SEARCHABLE_KNOWN_OPTIONS = new Set([
  "fields",
  "caseSensitive",
  "minTermLength",
  "dedupe",
]);

function applyIterableDefaults(modelDef) {
  // Default `iterable` to false. Iteration adds a per-row write to the
  // iter_search_index GSI on every save, doubling write cost — opt-in is
  // safer than opt-out. Mapping tables default to false either way.
  if (modelDef.iterable === undefined) {
    modelDef.iterable = false;
  }
  if (modelDef.iterationBuckets === undefined) {
    modelDef.iterationBuckets = modelDef.iterable ? 10 : 0;
  }
}

function validateSearchable(modelName, modelDef) {
  const raw = modelDef.searchable;

  if (raw === undefined || raw === false) {
    modelDef.searchable = false;
    return;
  }

  if (raw === true) {
    throw new Error(
      `Model "${modelName}": \`searchable: true\` is not supported. ` +
        `Provide an object with \`fields\` listing the StringField names to index, ` +
        `e.g. \`searchable: { fields: [title, body] }\`.`,
    );
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Model "${modelName}": \`searchable\` must be either a boolean or an object. Got ${typeof raw}.`,
    );
  }

  for (const key of Object.keys(raw)) {
    if (!SEARCHABLE_KNOWN_OPTIONS.has(key)) {
      throw new Error(
        `Model "${modelName}": \`searchable\` has unknown option "${key}". ` +
          `Known options: ${Array.from(SEARCHABLE_KNOWN_OPTIONS).join(", ")}.`,
      );
    }
  }

  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw new Error(
      `Model "${modelName}": \`searchable.fields\` must be a non-empty array of field names.`,
    );
  }

  for (const fieldName of raw.fields) {
    if (typeof fieldName !== "string") {
      throw new Error(
        `Model "${modelName}": \`searchable.fields\` entries must be strings. Got ${typeof fieldName}.`,
      );
    }
    const fieldDef = modelDef.fields && modelDef.fields[fieldName];
    if (!fieldDef) {
      throw new Error(
        `Model "${modelName}": \`searchable.fields\` references "${fieldName}" but that field is not defined on the model.`,
      );
    }
    if (fieldDef.type !== "StringField") {
      throw new Error(
        `Model "${modelName}": \`searchable.fields\` entry "${fieldName}" must be a StringField, got ${fieldDef.type}.`,
      );
    }
  }

  if (
    raw.caseSensitive !== undefined &&
    typeof raw.caseSensitive !== "boolean"
  ) {
    throw new Error(
      `Model "${modelName}": \`searchable.caseSensitive\` must be a boolean.`,
    );
  }

  if (raw.dedupe !== undefined && typeof raw.dedupe !== "boolean") {
    throw new Error(
      `Model "${modelName}": \`searchable.dedupe\` must be a boolean.`,
    );
  }

  if (raw.minTermLength !== undefined) {
    const n = raw.minTermLength;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new Error(
        `Model "${modelName}": \`searchable.minTermLength\` must be a positive integer.`,
      );
    }
  }

  modelDef.searchable = {
    fields: raw.fields.slice(),
    caseSensitive: raw.caseSensitive === true,
    minTermLength: raw.minTermLength === undefined ? 1 : raw.minTermLength,
    dedupe: raw.dedupe === true,
  };
}

function applyModelDefaults(models) {
  for (const [modelName, modelDef] of Object.entries(models)) {
    applyIterableDefaults(modelDef);
    validateSearchable(modelName, modelDef);
    // searchable on a non-iterable model is a supported combination
    // (partition-scoped _searchText filtering), but searchAll/searchBucket
    // require iteration buckets and will throw at runtime. Warn so users
    // who forgot to opt into iteration find out at codegen, not in prod.
    if (
      modelDef.searchable &&
      typeof modelDef.searchable === "object" &&
      !modelDef.iterable
    ) {
      console.warn(
        `[dynamo-bao] Model "${modelName}" has \`searchable\` configured but ` +
          `\`iterable\` is false. _searchText will populate and filter on it ` +
          `via the standard query API works, but searchAll/searchBucket will ` +
          `throw. Set \`iterable: true\` to enable cross-bucket parallel search.`,
      );
    }
  }
  return models;
}

// Names from model definitions become identifiers, string literals, file
// names and import paths in generated code, so they must be plain JavaScript
// identifiers. Anything else could inject code or write outside the output
// directory.
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function assertIdentifier(value, what) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${what} ${JSON.stringify(value)}: must be a JavaScript identifier`,
    );
  }
}

function assertIdSuffix(value, what) {
  if (typeof value !== "string" || !/\d$/.test(value)) {
    throw new Error(`Invalid ${what} ${JSON.stringify(value)}`);
  }
}

function validateModelNames(models) {
  for (const [modelName, modelDef] of Object.entries(models)) {
    assertIdentifier(modelName, "model name");
    const where = (what) => `${what} in model ${modelName}`;

    for (const [fieldName, fieldDef] of Object.entries(modelDef.fields || {})) {
      assertIdentifier(fieldName, where("field name"));
      if (fieldDef.type !== undefined) {
        assertIdentifier(fieldDef.type, where(`type of field ${fieldName}`));
      }
      if (fieldDef.model !== undefined) {
        assertIdentifier(fieldDef.model, where(`model of field ${fieldName}`));
      }
      for (const option of Object.keys(fieldDef)) {
        assertIdentifier(option, where(`option of field ${fieldName}`));
      }
    }

    const { partitionKey, sortKey } = modelDef.primaryKey || {};
    assertIdentifier(partitionKey, where("primary partition key"));
    if (sortKey !== undefined) {
      assertIdentifier(sortKey, where("primary sort key"));
    }

    for (const [indexName, index] of Object.entries(modelDef.indexes || {})) {
      assertIdentifier(indexName, where("index name"));
      if (index === "primaryKey") continue;
      assertIdentifier(
        index.partitionKey,
        where(`partition key of ${indexName}`),
      );
      assertIdentifier(index.sortKey, where(`sort key of ${indexName}`));
      assertIdSuffix(index.indexId, where(`indexId of ${indexName}`));
    }

    for (const [name, constraint] of Object.entries(
      modelDef.uniqueConstraints || {},
    )) {
      assertIdentifier(name, where("unique constraint name"));
      assertIdentifier(constraint.field, where(`field of ${name}`));
      assertIdSuffix(
        constraint.uniqueConstraintId,
        where(`uniqueConstraintId of ${name}`),
      );
    }
  }
}

module.exports = { applyModelDefaults, validateModelNames };
