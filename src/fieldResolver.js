const path = require('path');

class FieldResolver {
  constructor(builtInFieldsPath, customFieldsPath) {
    console.log('Loading built-in fields from:', builtInFieldsPath);
    this.builtInFields = require(builtInFieldsPath);
    console.log('Available built-in fields:', Object.keys(this.builtInFields));
    this.customFieldsPath = customFieldsPath;
    this.fieldDefinitionCache = new Map();

    // Pre-cache all built-in fields
    Object.entries(this.builtInFields).forEach(([name, definition]) => {
      this.fieldDefinitionCache.set(name, definition);
    });
  }

  getFieldDefinition(fieldType) {
    console.log('Looking for field type:', fieldType);
    
    if (this.fieldDefinitionCache.has(fieldType)) {
      console.log('Found in cache');
      return this.fieldDefinitionCache.get(fieldType);
    }

    // Try custom fields if available
    if (this.customFieldsPath) {
      try {
        console.log('Looking in custom fields:', this.customFieldsPath);
        const customFields = require(this.customFieldsPath);
        if (customFields[fieldType]) {
          console.log('Found in custom fields');
          const fieldDefinition = customFields[fieldType];
          this.fieldDefinitionCache.set(fieldType, fieldDefinition);
          return fieldDefinition;
        }
      } catch (err) {
        console.log('Error loading custom fields:', err.message);
      }
    }

    throw new Error(`Field type '${fieldType}' not found in built-in or custom fields`);
  }
}

module.exports = FieldResolver; 