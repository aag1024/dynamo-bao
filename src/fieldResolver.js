const path = require('path');
const fs = require('fs');

class FieldResolver {
  constructor(builtInFieldsPath, customFieldsPath) {
    this.builtInFields = require(builtInFieldsPath);
    this.customFieldsPath = customFieldsPath;
    this.fieldDefinitionCache = new Map();

    console.log('FieldResolver constructor:', {
      builtInFieldsPath,
      customFieldsPath,
    });

    // Pre-cache all built-in fields
    Object.entries(this.builtInFields).forEach(([name, definition]) => {
      this.fieldDefinitionCache.set(name, definition);
    });
  }

  getFieldDefinition(fieldType) {
    
    if (this.fieldDefinitionCache.has(fieldType)) {
      return this.fieldDefinitionCache.get(fieldType);
    }

    // Try custom fields if available
    if (this.customFieldsPath) {
    //  try {
        // Convert to kebab case for file name
        const baseName = fieldType.replace(/Field$/, '');
        const kebabName = baseName
          .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
          .toLowerCase();
        const fieldPath = path.join(this.customFieldsPath, `${kebabName}-field.js`);
        
        console.log('fieldPath', fieldPath);

        if (fs.existsSync(fieldPath)) {
          console.log('fieldPath exists');
          const customField = require(fieldPath);

          console.log('customField', customField);
          // Get the field from the exports using the original field type name
          const fieldDefinition = customField[fieldType];
          if (fieldDefinition) {
            this.fieldDefinitionCache.set(fieldType, fieldDefinition);
            return fieldDefinition;
          }
        }
    //   } catch (err) {
    //     console.error('Error loading custom field:', err);
    //   }
    }

    throw new Error(`Field type '${fieldType}' not found in built-in or custom fields`);
  }

  isCustomField(fieldType) {
    if (!this.customFieldsPath) return false;
    const baseName = fieldType.replace(/Field$/, '');
    const kebabName = baseName
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
    const fieldPath = path.join(this.customFieldsPath, `${kebabName}-field.js`);
    return fs.existsSync(fieldPath);
  }
}

module.exports = FieldResolver; 