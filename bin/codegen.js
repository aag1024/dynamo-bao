#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { generateModelFiles } = require('./generators/model');
const { createLogger } = require('./utils/scriptLogger');
const FieldResolver = require('../src/fieldResolver');
const logger = createLogger('CodeGen');

function loadConfig(definitionsPath) {
  try {
    // First try environment variable
    if (process.env.DYNAMO_BAO_CONFIG) {
      return require(path.resolve(process.cwd(), process.env.DYNAMO_BAO_CONFIG));
    }
    
    // Then try config.js in the same directory as definitions
    const configPath = path.resolve(path.dirname(definitionsPath), 'config.js');
    return require(configPath);
  } catch (err) {
    logger.debug('No config file found, using defaults');
    return {};
  }
}

function loadModelDefinitions(definitionsPath, fieldResolver) {
  const models = {};

  if (fs.statSync(definitionsPath).isDirectory()) {
    // Load all .yaml files from directory
    const files = fs.readdirSync(definitionsPath)
      .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));

    logger.debug('Found YAML files:', files);

    files.forEach(file => {
      const filePath = path.join(definitionsPath, file);
      logger.debug(`Loading file: ${filePath}`);
      
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const definition = yaml.load(fileContents);
      
      logger.debug(`Loaded definition from ${file}:`, definition);
      
      // Merge models from this file
      if (definition && definition.models) {
        Object.assign(models, definition.models);
      } else {
        console.warn(`Warning: No models found in ${file}`);
      }
    });
  } else {
    // Load single file
    const fileContents = fs.readFileSync(definitionsPath, 'utf8');
    const definition = yaml.load(fileContents);
    if (definition && definition.models) {
      Object.assign(models, definition.models);
    }
  }

  logger.debug('Final merged models:', models);
  return { models, fieldResolver };
}

function main() {
  const args = process.argv.slice(2);
  
  // Set default paths
  let definitionsPath = path.resolve(process.cwd(), './models.yaml');
  let outputDir = path.resolve(process.cwd(), './models');
  
  // Override with command line arguments if provided
  if (args.length >= 1) {
    definitionsPath = path.resolve(process.cwd(), args[0]);
  }
  if (args.length >= 2) {
    outputDir = path.resolve(process.cwd(), args[1]);
  }
  
  try {
    const config = loadConfig(definitionsPath);
    
    // Built-in fields are in fields.js
    const builtInFieldsPath = path.resolve(__dirname, '../src/fields.js');
    
    const fieldResolver = new FieldResolver(
      builtInFieldsPath,
      config?.paths?.fieldsDir
    );
    
    const definitions = loadModelDefinitions(definitionsPath, fieldResolver);
    generateModelFiles(definitions.models, outputDir, definitions.fieldResolver);
  } catch (error) {
    console.error('Error generating models:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { loadModelDefinitions };
