const { StringFieldClass } = require('../../../src/fields');

class EmailField extends StringFieldClass {
  constructor(options = {}) {
    super(options);
    // Allow specifying allowed domains, default to accepting all domains
    this.allowedDomains = options.allowedDomains || [];
  }

  validate(value) {
    super.validate(value);
    
    if (!value) return true;

    if (!value.includes('@')) {
      throw new Error('Invalid email format');
    }

    // If allowedDomains is specified, check if the email domain is allowed
    if (this.allowedDomains.length > 0) {
      const domain = value.split('@')[1];
      if (!this.allowedDomains.includes(domain)) {
        throw new Error(`Email domain must be one of: ${this.allowedDomains.join(', ')}`);
      }
    }

    return true;
  }
}

// Create a factory function to match the pattern of other fields
const createEmailField = (options) => new EmailField(options);

// Export both the factory function and the class
module.exports = {
  EmailField: createEmailField,
  EmailFieldClass: EmailField
}; 