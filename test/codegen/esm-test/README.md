# ESM Codegen Test

This directory contains test files and generated models for testing ESM (ECMAScript Modules) code generation in dynamo-bao.

## Files

- `config.mjs` - ESM configuration file with `moduleSystem: 'esm'`
- `models.yaml` - Model definitions for User, Post, and Comment
- `generated/` - Auto-generated ESM model files

## Generated Files

The generated model files use ESM syntax:
- `import { ... } from '...'` instead of `require()`
- `export { ModelName }` instead of `module.exports`
- `.js` extensions in import paths for ESM compatibility

## Running Codegen

To regenerate the models:

```bash
cd test/codegen/esm-test
DYNAMO_BAO_CONFIG=config.mjs node ../../../bin/codegen.js
```

## Testing

The ESM generation is tested in `/test/esm-generator.test.js` which verifies:
- Correct ESM import/export syntax
- Proper `.js` extensions for ESM compatibility
- Cross-module references work correctly
- No CommonJS syntax is present in generated files