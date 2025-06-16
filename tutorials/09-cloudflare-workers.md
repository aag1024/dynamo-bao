# Using dynamo-bao with Cloudflare Workers

dynamo-bao supports running in Cloudflare Workers environments where filesystem access is not available. This is achieved by importing models directly instead of relying on directory scanning. dynamo-bao uses `aws4fetch` for lightweight AWS API calls, making it perfect for edge environments.

## Key Differences in Cloudflare Workers

Cloudflare Workers have several limitations compared to Node.js environments:
- No filesystem access (`fs` module not available)
- No ability to dynamically scan directories for model files
- Models must be imported explicitly

However, you can still use **all the dynamo-bao features** including:
- Code generation from YAML definitions
- Generated manifest files for easy imports
- All model functionality (queries, mutations, relationships, etc.)

## Two Approaches for Cloudflare Workers

### Approach 1: Using Generated Models (Recommended)

The recommended approach is to use dynamo-bao's code generation during your build process, then import the generated manifest file.

#### Step 1: Create YAML Model Definitions

**models.yaml**
```yaml
models:
  User:
    modelPrefix: "u"
    fields:
      userId:
        type: UlidField
        autoAssign: true
      name:
        type: StringField
        required: true
      email:
        type: StringField
        required: true
      createdAt:
        type: CreateDateField
    primaryKey:
      partitionKey: userId

  Post:
    modelPrefix: "p"
    fields:
      postId:
        type: UlidField
        autoAssign: true
      userId:
        type: StringField
        required: true
      title:
        type: StringField
        required: true
      content:
        type: StringField
      createdAt:
        type: CreateDateField
    primaryKey:
      partitionKey: postId
    indexes:
      byUser:
        partitionKey: userId
        sortKey: createdAt
        indexId: 1
```

#### Step 2: Generate Models During Build

Run codegen to generate your models and manifest:

```bash
npx bao-codegen models.yaml ./models
```

This creates:
- `./models/user.js` - Generated User model
- `./models/post.js` - Generated Post model  
- `./.bao/models.js` - Generated manifest file

#### Step 3: Use Generated Manifest in Worker

**worker.js**
```javascript
import { initModels } from 'dynamo-bao';
import generatedModels from './.bao/models.js';

let models;

export default {
  async fetch(request, env) {
    if (!models) {
      models = initModels({
        models: generatedModels, // Use generated manifest
        aws: { 
          region: env.AWS_REGION,
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        },
        db: { 
          tableName: env.TABLE_NAME 
        }
      });
    }
    
    const { User, Post } = models.models;
    
    // Your API logic here
    const user = await User.create({
      name: 'John Doe',
      email: 'john@example.com'
    });
    
    return new Response(JSON.stringify(user));
  }
};
```

### Approach 2: Manual Model Definition

If you prefer not to use code generation, you can define models manually:

**models/user.js**
```javascript
const { BaoModel, PrimaryKeyConfig, fields } = require('dynamo-bao');
const { StringField, UlidField, CreateDateField } = fields;

class User extends BaoModel {
  static modelPrefix = "u";
  
  static fields = {
    userId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    createdAt: CreateDateField(),
  };
  
  static primaryKey = PrimaryKeyConfig("userId");
}

module.exports = { User };
```

**models/post.js**
```javascript
const { BaoModel, PrimaryKeyConfig, IndexConfig, fields } = require('dynamo-bao');
const { StringField, UlidField, CreateDateField } = fields;
const { GSI_INDEX_ID1 } = require('dynamo-bao').constants;

class Post extends BaoModel {
  static modelPrefix = "p";
  
  static fields = {
    postId: UlidField({ autoAssign: true }),
    userId: StringField({ required: true }),
    title: StringField({ required: true }),
    content: StringField(),
    createdAt: CreateDateField(),
  };
  
  static primaryKey = PrimaryKeyConfig("postId");
  
  static indexes = {
    byUser: IndexConfig("userId", "createdAt", GSI_INDEX_ID1),
  };
}

module.exports = { Post };
```

### 2. Initialize Models with Direct Imports

In your Cloudflare Worker, import the models directly and pass them to `initModels`:

**worker.js**
```javascript
import { initModels } from 'dynamo-bao';
import { User } from './models/user.js';
import { Post } from './models/post.js';

// Initialize models with direct imports
const models = initModels({
  models: { User, Post }, // Direct model imports
  aws: { 
    region: 'us-west-2' 
  },
  db: { 
    tableName: 'my-app-table' 
  }
});

export default {
  async fetch(request, env) {
    // Your worker logic here
    const { User, Post } = models.models;
    
    // Use models normally
    const user = await User.create({
      name: 'John Doe',
      email: 'john@example.com'
    });
    
    const post = await Post.create({
      userId: user.userId,
      title: 'My First Post',
      content: 'Hello, World!'
    });
    
    return new Response(JSON.stringify({ user, post }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
```

## Environment Variables

Configure your Cloudflare Worker with the necessary environment variables:

```toml
# wrangler.toml
[env.production.vars]
AWS_REGION = "us-west-2"
TABLE_NAME = "my-production-table"

[env.staging.vars]
AWS_REGION = "us-west-2"
TABLE_NAME = "my-staging-table"
```

## AWS Authentication with aws4fetch

dynamo-bao uses `aws4fetch` instead of the AWS SDK, making it lightweight and perfect for Cloudflare Workers. Configure your AWS credentials:

```javascript
// You can also pass AWS configuration directly
const models = initModels({
  models: { User, Post },
  aws: {
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }
  },
  db: {
    tableName: env.TABLE_NAME
  }
});
```

## Complete Example

Here's a complete example of a Cloudflare Worker using dynamo-bao:

**package.json**
```json
{
  "name": "my-worker",
  "version": "1.0.0",
  "main": "worker.js",
  "dependencies": {
    "dynamo-bao": "^0.2.7"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

**wrangler.toml**
```toml
name = "my-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
AWS_REGION = "us-west-2"
TABLE_NAME = "my-table"

[env.production.vars]
TABLE_NAME = "my-production-table"
```

**models/user.js**
```javascript
const { BaoModel, PrimaryKeyConfig, fields } = require('dynamo-bao');
const { StringField, UlidField, CreateDateField } = fields;

class User extends BaoModel {
  static modelPrefix = "u";
  
  static fields = {
    userId: UlidField({ autoAssign: true }),
    name: StringField({ required: true }),
    email: StringField({ required: true }),
    createdAt: CreateDateField(),
  };
  
  static primaryKey = PrimaryKeyConfig("userId");
}

module.exports = { User };
```

**worker.js**
```javascript
import { initModels } from 'dynamo-bao';
import { User } from './models/user.js';

let models;

export default {
  async fetch(request, env) {
    // Initialize models once
    if (!models) {
      models = initModels({
        models: { User },
        aws: { 
          region: env.AWS_REGION,
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        },
        db: { 
          tableName: env.TABLE_NAME 
        }
      });
    }
    
    const { User } = models.models;
    const url = new URL(request.url);
    
    if (url.pathname === '/users' && request.method === 'POST') {
      const userData = await request.json();
      const user = await User.create(userData);
      return new Response(JSON.stringify(user), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (url.pathname.startsWith('/users/') && request.method === 'GET') {
      const userId = url.pathname.split('/')[2];
      const user = await User.findByPrimaryKey(userId);
      return new Response(JSON.stringify(user), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('Not Found', { status: 404 });
  }
};
```

## Build Process Integration

### Using Generated Models in CI/CD

Add model generation to your build pipeline:

**package.json**
```json
{
  "scripts": {
    "build": "bao-codegen models.yaml ./models && wrangler publish",
    "dev": "bao-codegen models.yaml ./models && wrangler dev",
    "generate-models": "bao-codegen models.yaml ./models"
  }
}
```

**GitHub Actions Example**
```yaml
name: Deploy Worker
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Generate models
        run: npm run generate-models
        
      - name: Deploy to Cloudflare Workers
        run: npx wrangler publish
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### Local Development

For local development, generate models first:

```bash
# Generate models from YAML
npm run generate-models

# Start local development
npx wrangler dev
```

## Deployment

Deploy your worker using Wrangler:

```bash
npm install -g wrangler
wrangler publish
```

## Error Handling

dynamo-bao provides helpful error messages when running in environments without filesystem access:

```javascript
// This will throw an error in Cloudflare Workers
const models = initModels({
  aws: { region: 'us-west-2' },
  db: { tableName: 'my-table' }
  // Missing models config - will fail
});
// Error: "Filesystem not available. Please provide models directly using the 'models' config option."
```

## Migration from Filesystem-based Setup

If you're migrating an existing dynamo-bao application to Cloudflare Workers:

1. **Export your models**: Make sure all model classes are properly exported from their files
2. **Import explicitly**: Replace directory scanning with explicit imports
3. **Update initialization**: Use the `models` config option instead of `paths.modelsDir`
4. **Test thoroughly**: Verify all functionality works in the Workers environment

### Before (Node.js with filesystem)
```javascript
const models = initModels({
  paths: {
    modelsDir: './models'
  },
  aws: { region: 'us-west-2' },
  db: { tableName: 'my-table' }
});
```

### After (Cloudflare Workers)
```javascript
import { User, Post, Comment } from './models/index.js';

const models = initModels({
  models: { User, Post, Comment },
  aws: { region: 'us-west-2' },
  db: { tableName: 'my-table' }
});
```

## Best Practices

1. **Initialize once**: Initialize models once and reuse the instance across requests
2. **Environment variables**: Use environment variables for configuration
3. **Error handling**: Implement proper error handling for DynamoDB operations
4. **Caching**: Consider implementing response caching for read-heavy operations
5. **Bundle size**: Only import the models you need to keep bundle size small

## Limitations

- Code generation must be run during build time (not at runtime in Workers)
- Directory watching and auto-reload features are not available in Workers environment
- File system operations like loading models from directories require pre-generation
- AWS credential resolution from `~/.aws/` files is not available (use environment variables or explicit credentials)