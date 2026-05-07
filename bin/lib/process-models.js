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

  if (raw.caseSensitive !== undefined && typeof raw.caseSensitive !== "boolean") {
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
  }
  return models;
}

module.exports = { applyModelDefaults };
