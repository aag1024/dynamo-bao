#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { generateModels } = require('./generators/model');

function loadModelDefinitions(definitionsPath) {
  const models = {};

  if (fs.statSync(definitionsPath).isDirectory()) {
    // Load all .yaml files from directory
    const files = fs.readdirSync(definitionsPath)
      .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));

    console.log('Found YAML files:', files);

    files.forEach(file => {
      const filePath = path.join(definitionsPath, file);
      console.log(`Loading file: ${filePath}`);
      
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const definition = yaml.load(fileContents);
      
      console.log(`Loaded definition from ${file}:`, definition);
      
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

  console.log('Final merged models:', models);
  return { models };
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: model-codegen <path-to-models> <output-directory>');
    console.error('  path-to-models can be a single .yaml file or a directory containing .yaml files');
    process.exit(1);
  }

  const definitionsPath = path.resolve(process.cwd(), args[0]);
  const outputDir = path.resolve(process.cwd(), args[1]);
  
  try {
    const definitions = loadModelDefinitions(definitionsPath);
    generateModels(definitions, outputDir);
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
