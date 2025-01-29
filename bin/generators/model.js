const path = require("path");
const fs = require("fs");
const { createLogger } = require("../utils/scriptLogger");
const logger = createLogger("ModelGen");

const codeGenPrefix = ""; // "cg";

function generateModelClass(
  modelName,
  modelConfig,
  allModels,
  fieldResolver,
  outputDir,
) {
  if (!modelConfig || !modelConfig.fields) {
    throw new Error(
      `Invalid model configuration for ${modelName}: missing fields`,
    );
  }

  // Track which fields, constants, and models are actually used
  const usedFields = new Set();
  const customFields = new Set();
  const baseImports = new Set(["BaoModel"]);
  const constantImports = new Set();

  console.log("model config", modelConfig);

  // Generate fields and track used field types
  const fields = Object.entries(modelConfig.fields || {})
    .map(([fieldName, fieldConfig]) => {
      // Special handling for mapping table fields
      if (modelConfig.mapping && !fieldConfig.type) {
        // Default to RelatedField if not specified in mapping table
        fieldConfig = {
          type: "RelatedField",
          ...fieldConfig,
        };
      }

      // Verify the field exists before using it
      const fieldClass = fieldResolver.getFieldDefinition(fieldConfig.type);
      if (!fieldClass) {
        throw new Error(
          `Field type '${fieldConfig.type}' not found for ${modelName}.${fieldName}`,
        );
      }

      // Track if this is a built-in or custom field
      if (fieldResolver.isCustomField(fieldConfig.type)) {
        customFields.add(fieldConfig.type);
      } else {
        usedFields.add(fieldConfig.type);
      }

      if (fieldConfig.type === "RelatedField") {
        return `    ${fieldName}: ${fieldConfig.type}('${fieldConfig.model}', { required: ${!!fieldConfig.required} }),`;
      }

      // Build options object from all field config properties except 'type'
      const options = Object.entries(fieldConfig)
        .filter(([key]) => key !== "type")
        .map(([key, value]) => {
          // Handle different types of values
          if (typeof value === "string") return `${key}: '${value}'`;
          if (Array.isArray(value)) return `${key}: ${JSON.stringify(value)}`;
          return `${key}: ${value}`;
        });

      const optionsStr = options.length ? `{ ${options.join(", ")} }` : "";
      return `    ${fieldName}: ${fieldConfig.type}(${optionsStr}),`;
    })
    .join("\n");

  // Handle primary key configuration
  const partitionKey = modelConfig.primaryKey.partitionKey;
  const sortKey = modelConfig.primaryKey.sortKey || "modelPrefix";
  logger.debug(`Generating primary key for ${modelName}:`, {
    partitionKey,
    sortKey,
  });
  const primaryKeyConfig = `PrimaryKeyConfig('${partitionKey}', '${sortKey}')`;

  // Generate indexes and track used constants
  const indexes = modelConfig.indexes
    ? Object.entries(modelConfig.indexes)
        .map(([indexName, indexConfig]) => {
          if (indexConfig === "primaryKey") {
            return `    ${indexName}: this.primaryKey,`;
          }

          // Update logging
          logger.debug(`Generating index ${indexName}:`, indexConfig);

          const indexId = `GSI_INDEX_ID${indexConfig.indexId.slice(-1)}`;
          constantImports.add(indexId);
          return `    ${indexName}: IndexConfig('${indexConfig.partitionKey}', '${indexConfig.sortKey}', ${indexId}),`;
        })
        .join("\n")
    : "";

  // Generate unique constraints and track used constants
  const uniqueConstraints = modelConfig.uniqueConstraints
    ? Object.entries(modelConfig.uniqueConstraints)
        .map(([constraintName, constraintConfig]) => {
          const constraintId = `UNIQUE_CONSTRAINT_ID${constraintConfig.uniqueConstraintId.slice(-1)}`;
          constantImports.add(constraintId);
          return `    ${constraintName}: UniqueConstraintConfig('${constraintConfig.field}', ${constraintId}),`;
        })
        .join("\n")
    : "";

  // Always need these
  baseImports.add("PrimaryKeyConfig");
  if (indexes) baseImports.add("IndexConfig");
  if (uniqueConstraints) baseImports.add("UniqueConstraintConfig");

  // Generate query methods and get related models
  const { methods: queryMethods, relatedModels } = generateQueryMethods(
    modelName,
    modelConfig,
    allModels,
  );
  const uniqueConstraintMethods = generateUniqueConstraintMethods(modelConfig);
  const relatedFieldMethods = generateRelatedFieldMethods(modelConfig.fields);

  // Generate import statements
  const baseImportStr = Array.from(baseImports).join(",\n  ");
  const constantImportStr = Array.from(constantImports).join(",\n  ");
  const fieldImports = Array.from(usedFields).join(",\n    ");

  logger.debug("fieldResolver customFields", fieldResolver.customFieldsPath);

  // get relative path for fieldResolver.customFieldsPath from projectPath
  const relativePath = path.relative(outputDir, fieldResolver.customFieldsPath);
  logger.debug("relativePath", relativePath);

  // Generate custom field imports
  const customFieldImports = Array.from(customFields)
    .map((fieldType) => {
      // Remove 'Field' suffix before converting to kebab case
      const baseName = fieldType.replace(/Field$/, "");
      const kebabName = baseName
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase();
      return `const { ${fieldType} } = require('${relativePath}/${kebabName}-field');`;
    })
    .join("\n");

  const standardMethods = generateStandardModelMethods(modelConfig);

  // Generate the final code with separated imports
  return `// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  ${baseImportStr}
} = require('dynamo-bao');

${
  constantImports.size > 0
    ? `const {
  ${constantImportStr}
} = require('dynamo-bao').constants;

`
    : ""
}
${
  usedFields.size > 0
    ? `const { 
    ${fieldImports}
} = require('dynamo-bao').fields;

`
    : ""
}
${customFieldImports}

${Array.from(relatedModels)
  .map((model) => {
    const kebabName = model
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
    return `const { ${model} } = require('./${kebabName}');`;
  })
  .join("\n")}

class ${modelName} extends BaoModel {
  static modelPrefix = '${modelConfig.modelPrefix}';
  
  static fields = {
${fields}
  };

  static primaryKey = ${primaryKeyConfig};
${indexes ? `\n  static indexes = {\n${indexes}\n  };` : ""}
${uniqueConstraints ? `\n  static uniqueConstraints = {\n${uniqueConstraints}\n  };` : ""}
${queryMethods}
${standardMethods}
${uniqueConstraintMethods}
${relatedFieldMethods}
}

module.exports = { ${modelName} };
`;
}

function generateUniqueConstraintMethods(modelConfig) {
  if (!modelConfig.uniqueConstraints) return "";

  return Object.entries(modelConfig.uniqueConstraints)
    .map(([name, constraint]) => {
      const methodName = `${codeGenPrefix}findBy${name.replace(/^unique/, "")}`;
      return `
  static async ${methodName}(value) {
    return await this.findByUniqueConstraint('${name}', value);
  }`;
    })
    .join("\n");
}

function generateModelFiles(models, outputDir, fieldResolver) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  Object.entries(models).forEach(([modelName, modelConfig]) => {
    // Convert model name from PascalCase to kebab-case for the file name
    const fileName = modelName
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();

    const filePath = path.join(outputDir, `${fileName}.js`);

    // delete the file if it exists
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    const code = generateModelClass(
      modelName,
      modelConfig,
      models,
      fieldResolver,
      outputDir,
    );

    fs.writeFileSync(filePath, code);
    console.log(`Generated ${filePath}`);
  });
}

function generateQueryMethods(modelName, modelConfig, allModels) {
  let methods = "";
  const relatedModels = new Set();

  // First, generate methods for indexes that use modelPrefix (self-referential queries)
  if (modelConfig.indexes) {
    Object.entries(modelConfig.indexes).forEach(([indexName, index]) => {
      if (index !== "primaryKey" && index.partitionKey === "modelPrefix") {
        let methodName;
        if (indexName.includes("For")) {
          const [prefix] = indexName.split("For");
          methodName = `${codeGenPrefix}query${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
        } else {
          methodName = `${codeGenPrefix}query${indexName.charAt(0).toUpperCase()}${indexName.slice(1)}`;
        }

        methods += `
  static async ${methodName}(skCondition = null, options = {}) {
    const results = await this.queryByIndex(
      '${indexName}',
      this.modelPrefix,
      skCondition,
      options
    );

    return results;
  }`;
      }
    });
  }

  // Then generate methods for other models that have relations to this model
  Object.entries(allModels).forEach(([otherModelName, otherModel]) => {
    if (otherModel.indexes) {
      // First check if the primary key's partition key is a relation to our model
      const pkPartitionField =
        otherModel.fields[otherModel.primaryKey.partitionKey];
      if (
        pkPartitionField?.type === "RelatedField" &&
        pkPartitionField.model === modelName
      ) {
        // Simple check here

        relatedModels.add(otherModelName);

        // Use the primary key index name if it exists in indexes
        const primaryKeyIndexName =
          Object.entries(otherModel.indexes).find(
            ([_, index]) => index === "primaryKey",
          )?.[0] || "primaryKey";

        methods += `
  async ${codeGenPrefix}query${otherModelName}s(skCondition = null, options = {}) {
    const results = await ${otherModelName}.queryByIndex(
      '${primaryKeyIndexName}',
      this._getPkValue(),
      skCondition,
      options
    );

    return results;
  }`;
      }

      // Then check other indexes
      Object.entries(otherModel.indexes).forEach(([indexName, index]) => {
        if (index === "primaryKey") return;

        const pkField = otherModel.fields[index.partitionKey];

        if (pkField?.type === "RelatedField" && pkField.model === modelName) {
          // Simple check here

          relatedModels.add(otherModelName);

          let methodName;
          if (indexName.includes("For")) {
            const [prefix] = indexName.split("For");
            methodName = `${codeGenPrefix}query${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
          } else {
            methodName = `${codeGenPrefix}query${indexName.charAt(0).toUpperCase()}${indexName.slice(1)}`;
          }

          methods += `
  async ${methodName}(skCondition = null, options = {}) {
    const results = await ${otherModelName}.queryByIndex(
      '${indexName}',
      this._getPkValue(),
      skCondition,
      options
    );

    return results;
  }`;
        }
      });
    }
  });

  // Add mapping table helper methods
  Object.entries(allModels).forEach(([mapModelName, mapModel]) => {
    if (mapModel.indexes && mapModel.tableType === "mapping") {
      // Only for mapping tables
      Object.entries(mapModel.indexes).forEach(([indexName, index]) => {
        let pkField, targetField;

        if (index === "primaryKey") {
          pkField = mapModel.fields[mapModel.primaryKey.partitionKey];
          targetField = mapModel.fields[mapModel.primaryKey.sortKey];
        } else if (index.partitionKey && index.sortKey) {
          pkField = mapModel.fields[index.partitionKey];
          targetField = mapModel.fields[index.sortKey];
        }

        // Check if this is a mapping table relationship
        if (pkField?.type === "RelatedField" && pkField.model === modelName) {
          relatedModels.add(mapModelName);

          // Generate method name from index
          let methodName;
          if (indexName.includes("For")) {
            const [prefix] = indexName.split("For");
            methodName = `${codeGenPrefix}get${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
          } else {
            methodName = `${codeGenPrefix}get${indexName.charAt(0).toUpperCase()}${indexName.slice(1)}`;
          }

          // Find the "other" relation field that isn't the one we're querying with
          const relationFields = Object.entries(mapModel.fields).filter(
            ([_, field]) => field.type === "RelatedField",
          );

          const targetFieldName = relationFields.find(
            ([_, field]) => field.model !== modelName,
          )?.[0];

          methods += `
  async ${methodName}(mapSkCondition=null, limit=null, direction='ASC', startKey=null) {
    return await ${mapModelName}.getRelatedObjectsViaMap(
      "${indexName}",
      this._getPkValue(),
      "${targetFieldName}",
      mapSkCondition,
      limit,
      direction,
      startKey
    );
  }`;
        }
      });
    }
  });

  return { methods, relatedModels };
}

// New function to generate related field getter methods
function generateRelatedFieldMethods(fields) {
  if (!fields) return "";

  const methods = [];

  Object.entries(fields).forEach(([fieldName, fieldConfig]) => {
    if (fieldConfig.type === "RelatedField") {
      const baseName = fieldName.endsWith("Id")
        ? fieldName.slice(0, -2)
        : fieldName;

      const capitalizedName =
        baseName.charAt(0).toUpperCase() + baseName.slice(1);

      methods.push(`
  async ${codeGenPrefix}get${capitalizedName}() {
    return await this.getOrLoadRelatedField('${fieldName}');
  }`);
    }
  });

  return methods.join("\n");
}

function generateStandardModelMethods(modelConfig) {
  let methods = "";

  // Only add these methods if the model has standard fields
  if (Object.keys(modelConfig.fields || {}).length > 0) {
    methods += `
  static async findAll(options = {}) {
    return await this.scan(options);
  }

  static async findById(id) {
    return await this.get(id);
  }
`;
  }

  return methods;
}

module.exports = { generateModelFiles };
