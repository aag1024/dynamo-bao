#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { run: runCodegen } = require("./codegen");
const { createLogger } = require("./utils/scriptLogger");
const config = require("../src/config");

const logger = createLogger("Watch");

function main() {
  const definitionsPath = config.paths.modelsDefinitionPath
    ? path.resolve(process.cwd(), config.paths.modelsDefinitionPath)
    : path.resolve(process.cwd(), "./models.yaml");

  const modelsDir = config.paths.modelsDir;

  // Initial generation
  logger.info("Performing initial model generation...");
  runCodegen();

  // Set up watcher with appropriate glob pattern
  const isDirectory = fs.statSync(definitionsPath).isDirectory();
  const definitionWatchPattern = isDirectory
    ? path.join(definitionsPath, "**/*.{yaml,yml}") // Watch all yaml files in directory
    : definitionsPath; // Watch single file directly

  const watchPatterns = [definitionWatchPattern];

  if (modelsDir && fs.existsSync(modelsDir)) {
    const modelsWatchPattern = path.join(modelsDir, "**/*.js");
    watchPatterns.push(modelsWatchPattern);
    logger.info(`Also watching for manual changes in: ${modelsDir}`);
  }

  const watcher = chokidar.watch(watchPatterns, {
    persistent: true,
    ignoreInitial: true,
  });

  logger.info(`Watching for changes in: ${watchPatterns.join(", ")}`);

  const debouncedGenerate = debounce(() => {
    logger.info("Change detected, running codegen...");
    runCodegen();
  }, 300);

  watcher
    .on("all", (event, filePath) => {
      logger.info(`File ${event}: ${filePath}. Regenerating...`);
      debouncedGenerate();
    })
    .on("error", (error) => logger.error(`Watcher error: ${error}`));
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

if (require.main === module) {
  main();
}
