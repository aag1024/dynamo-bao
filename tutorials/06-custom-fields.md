Dynamo Bao allows you to create custom field types to extend its functionality. This tutorial will show you how to create and use custom fields, using an email field as an example.

## Creating a Custom Field

Custom fields are created by extending one of the base field classes provided by Dynamo Bao. Here's how to create an email field that validates email formats and restricts domains.

```javascript
const { StringFieldClass } = require("dynamo-bao").fields;

class EmailField extends StringFieldClass {
  constructor(options = {}) {
    super(options);
    this.allowedDomains = options.allowedDomains || [];
  }

  validate(value) {
    super.validate(value);

    if (!value) return true;

    if (!value.includes("@")) {
      throw new Error("Invalid email format");
    }

    if (this.allowedDomains.length > 0) {
      const domain = value.split("@")[1];
      if (!this.allowedDomains.includes(domain)) {
        throw new Error(
          `Email domain must be one of: ${this.allowedDomains.join(", ")}`,
        );
      }
    }

    return true;
  }
}

// Create a factory function
const createEmailField = (options) => new EmailField(options);

module.exports = {
  EmailField: createEmailField,
  EmailFieldClass: EmailField,
};
```

By default, put any custom field definition files in the `fields` directory in your project. You can also configure this using the `paths.fieldsDir` option in your `config.js` file.

```yaml
const path = require("path");

module.exports = {
  paths: {
    fieldsDir: path.resolve(__dirname, "./fields"),
  },
};
```

## Using Custom Fields in Your Model

Once you've created a custom field, you can use it in your model definitions. Here's an example using the EmailField:

```yaml
models:
  UserWithEmail:
    modelPrefix: "u"
    fields:
      userId:
        type: UlidField
        required: true
        autoAssign: true
      email:
        type: EmailField
        required: true
        allowedDomains: ["company.com", "subsidiary.com"]
      name:
        type: StringField
    primaryKey:
      partitionKey: userId
```

## Field Validation

Custom fields can implement their own validation logic. In our EmailField example:

1. It validates the basic email format (must contain '@')
2. It can restrict emails to specific domains
3. It inherits all validation from the base StringField

Here are some examples of how the validation works:

```javascript
// Valid usage - email with allowed domain
await UserWithEmail.create({
  name: "Test User",
  email: "test@company.com",
});

// Invalid - will throw "Invalid email format"
await UserWithEmail.create({
  name: "Invalid User",
  email: "not-an-email",
});

// Invalid - will throw domain error
await UserWithEmail.create({
  name: "Invalid User",
  email: "test@gmail.com",
});
```

## Best Practices

When creating custom fields:

1. **Extend the Appropriate Base Class**: Choose the most appropriate base field class (StringField, NumberField, etc.)
2. **Implement Validation**: Override the `validate()` method to add your custom validation logic
3. **Call Super**: Always call `super.validate()` first to maintain base validation
4. **Use Factory Functions**: Export a factory function to maintain consistency with built-in fields
5. **Document Options**: Clearly document any custom options your field accepts
