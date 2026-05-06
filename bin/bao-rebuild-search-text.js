#!/usr/bin/env node

// Walks every row of a searchable model via iterateAll and re-saves with
// forceReindex: true so the save-time _searchText computation runs and the
// row's _searchText attribute is populated. Use after turning a model
// `searchable: true` on a model with existing data.

const resolve = require("./lib/resolve");
const { initModels, runWithBatchContext } = resolve("src/index.js");
const { initConfig } = resolve("src/config.js");

const modelName = process.argv[2];
if (!modelName) {
  console.error("Usage: bao-rebuild-search-text <ModelName>");
  process.exit(1);
}

(async () => {
  const config = await initConfig();
  const manager = initModels(config);
  let ModelClass;
  try {
    ModelClass = manager.getModel(modelName);
  } catch (err) {
    console.error(`Model "${modelName}" not found.`);
    process.exit(1);
  }

  if (!ModelClass.searchable || !ModelClass.searchConfig) {
    console.error(
      `Model "${modelName}" is not configured as searchable. Add a ` +
        `searchable: { fields: [...] } block in YAML and run codegen first.`,
    );
    process.exit(1);
  }
  if (!ModelClass.iterable) {
    console.error(
      `Model "${modelName}" is not iterable. Cannot bulk-rebuild via iterateAll.`,
    );
    process.exit(1);
  }

  console.log(`Rebuilding _searchText for ${modelName}...`);
  let total = 0;

  await runWithBatchContext(async () => {
    for await (const batch of ModelClass.iterateAll({ batchSize: 50 })) {
      for (const item of batch) {
        await item.save({ forceReindex: true });
        total++;
        if (total % 100 === 0) {
          console.log(`  rebuilt ${total} so far...`);
        }
      }
    }
  });

  console.log(`Done. Rebuilt _searchText on ${total} ${modelName} item(s).`);
})().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
