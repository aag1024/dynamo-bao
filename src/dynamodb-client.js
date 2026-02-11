const { AwsClient } = require('aws4fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');

class DynamoDBClient {
  constructor(config = {}) {
    this.region = config.region || this._resolveRegion();
    this.endpoint = config.endpoint || `https://dynamodb.${this.region}.amazonaws.com`;
    this.credentials = config.credentials;
    
    // Don't create the aws client until we actually need it
    this.awsClient = null;
  }

  _resolveRegion() {
    // 1. Try environment variables
    if (process.env.AWS_REGION) return process.env.AWS_REGION;
    if (process.env.AWS_DEFAULT_REGION) return process.env.AWS_DEFAULT_REGION;

    // 2. Try AWS config file
    try {
      const profile = process.env.AWS_PROFILE || 'default';
      const configPath = path.join(os.homedir(), '.aws', 'config');
      
      if (fs.existsSync(configPath)) {
        const configFile = fs.readFileSync(configPath, 'utf8');
        const region = this._parseRegionFromConfigFile(configFile, profile);
        if (region) return region;
      }
    } catch (error) {
      // Ignore file reading errors
    }

    // 3. Default fallback
    return 'us-east-1';
  }

  _parseRegionFromConfigFile(content, profile) {
    const lines = content.split('\n');
    let inSection = false;
    let sectionName = '';

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
        continue;
      }

      const sectionMatch = trimmedLine.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        sectionName = sectionMatch[1];
        inSection = sectionName === profile || sectionName === `profile ${profile}`;
        continue;
      }

      if (inSection) {
        const keyValueMatch = trimmedLine.match(/^([^=]+)=(.*)$/);
        if (keyValueMatch) {
          const key = keyValueMatch[1].trim();
          const value = keyValueMatch[2].trim();
          
          if (key === 'region') {
            return value;
          }
        }
      }
    }

    return null;
  }

  _resolveCredentials() {
    // 1. Use explicitly provided credentials
    if (this.credentials && this.credentials.accessKeyId && this.credentials.secretAccessKey) {
      return this.credentials;
    }

    // 2. Try environment variables
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN
      };
    }

    // 3. Try AWS credentials file
    try {
      const profile = process.env.AWS_PROFILE || 'default';
      const credentialsPath = path.join(os.homedir(), '.aws', 'credentials');
      
      if (fs.existsSync(credentialsPath)) {
        const credentialsFile = fs.readFileSync(credentialsPath, 'utf8');
        const credentials = this._parseCredentialsFile(credentialsFile, profile);
        if (credentials) {
          return credentials;
        }
      }
    } catch (error) {
      // Ignore file reading errors and continue
    }

    // 4. Try AWS config file for credentials
    try {
      const profile = process.env.AWS_PROFILE || 'default';
      const configPath = path.join(os.homedir(), '.aws', 'config');
      
      if (fs.existsSync(configPath)) {
        const configFile = fs.readFileSync(configPath, 'utf8');
        const credentials = this._parseCredentialsFile(configFile, profile);
        if (credentials) {
          return credentials;
        }
      }
    } catch (error) {
      // Ignore file reading errors
    }

    return null;
  }

  _parseCredentialsFile(content, profile) {
    const lines = content.split('\n');
    let inSection = false;
    let sectionName = '';
    const credentials = {};

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
        continue;
      }

      // Check for section headers
      const sectionMatch = trimmedLine.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        sectionName = sectionMatch[1];
        inSection = sectionName === profile || sectionName === `profile ${profile}`;
        continue;
      }

      // Parse key-value pairs in the target section
      if (inSection) {
        const keyValueMatch = trimmedLine.match(/^([^=]+)=(.*)$/);
        if (keyValueMatch) {
          const key = keyValueMatch[1].trim();
          const value = keyValueMatch[2].trim();
          
          if (key === 'aws_access_key_id') {
            credentials.accessKeyId = value;
          } else if (key === 'aws_secret_access_key') {
            credentials.secretAccessKey = value;
          } else if (key === 'aws_session_token') {
            credentials.sessionToken = value;
          }
        }
      }
    }

    if (credentials.accessKeyId && credentials.secretAccessKey) {
      return credentials;
    }

    return null;
  }

  _ensureClient() {
    if (!this.awsClient) {
      const credentials = this._resolveCredentials();
      
      if (!credentials) {
        throw new Error('AWS credentials not found. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables, configure ~/.aws/credentials, or provide credentials in config.');
      }
      
      this.awsClient = new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        region: this.region
      });
    }
    return this.awsClient;
  }

  _getOperationName(commandName) {
    const operationMap = {
      'GetCommand': 'GetItem',
      'QueryCommand': 'Query',
      'UpdateCommand': 'UpdateItem',
      'DeleteCommand': 'DeleteItem',
      'BatchGetCommand': 'BatchGetItem',
      'TransactWriteCommand': 'TransactWriteItems',
      'CreateTableCommand': 'CreateTable',
      'ListTablesCommand': 'ListTables',
      'DescribeTableCommand': 'DescribeTable',
      'UpdateTimeToLiveCommand': 'UpdateTimeToLive'
    };
    
    return operationMap[commandName] || commandName.replace('Command', '');
  }

  async send(command) {
    const client = this._ensureClient();
    const commandName = command.constructor.name;
    const operation = this._getOperationName(commandName);
    const headers = {
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': `DynamoDB_20120810.${operation}`
    };

    const response = await client.fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(command.input)
    });

    if (!response.ok) {
      const errorBody = await response.json();
      const errorType = errorBody.__type || 'DynamoDBError';
      
      // Map DynamoDB error types to expected names
      let errorName = errorType;
      if (errorType.includes('#')) {
        errorName = errorType.split('#')[1];
      }
      
      const error = new Error(errorBody.message || errorBody.Message || errorType);
      error.name = errorName;
      error.statusCode = response.status;
      error.$metadata = { httpStatusCode: response.status };
      
      // Add specific properties based on error type
      if (errorName === 'TransactionCanceledException' && errorBody.CancellationReasons) {
        error.CancellationReasons = errorBody.CancellationReasons;
      }
      
      throw error;
    }

    return response.json();
  }
}

class DynamoDBDocumentClient {
  constructor(client, config = {}) {
    this.client = client;
    this.marshallOptions = config.marshallOptions || {};
    this.unmarshallOptions = config.unmarshallOptions || {};
  }

  static from(client, config = {}) {
    return new DynamoDBDocumentClient(client, config);
  }

  async send(command) {
    const marshalledCommand = this.marshallCommand(command);
    const response = await this.client.send(marshalledCommand);
    return this.unmarshallResponse(response, command);
  }

  marshallCommand(command) {
    const commandName = command.constructor.name;
    const input = { ...command.input };

    switch (commandName) {
      case 'GetCommand':
        const marshalledKey = {};
        Object.keys(input.Key).forEach(key => {
          marshalledKey[key] = marshall(input.Key[key]);
        });
        input.Key = marshalledKey;
        break;
      
      case 'QueryCommand':
        if (input.ExpressionAttributeValues) {
          const marshalledValues = {};
          Object.keys(input.ExpressionAttributeValues).forEach(key => {
            marshalledValues[key] = marshall(input.ExpressionAttributeValues[key]);
          });
          input.ExpressionAttributeValues = marshalledValues;
        }
        if (input.ExclusiveStartKey) {
          const marshalledStartKey = {};
          Object.keys(input.ExclusiveStartKey).forEach(key => {
            marshalledStartKey[key] = marshall(input.ExclusiveStartKey[key]);
          });
          input.ExclusiveStartKey = marshalledStartKey;
        }
        break;
      
      case 'UpdateCommand':
        const updateKey = {};
        Object.keys(input.Key).forEach(key => {
          updateKey[key] = marshall(input.Key[key]);
        });
        input.Key = updateKey;
        if (input.ExpressionAttributeValues) {
          const marshalledValues = {};
          Object.keys(input.ExpressionAttributeValues).forEach(key => {
            marshalledValues[key] = marshall(input.ExpressionAttributeValues[key]);
          });
          input.ExpressionAttributeValues = marshalledValues;
        }
        break;
      
      case 'DeleteCommand':
        const deleteKey = {};
        Object.keys(input.Key).forEach(key => {
          deleteKey[key] = marshall(input.Key[key]);
        });
        input.Key = deleteKey;
        if (input.ExpressionAttributeValues) {
          const marshalledValues = {};
          Object.keys(input.ExpressionAttributeValues).forEach(key => {
            marshalledValues[key] = marshall(input.ExpressionAttributeValues[key]);
          });
          input.ExpressionAttributeValues = marshalledValues;
        }
        break;
      
      case 'BatchGetCommand':
        if (input.RequestItems) {
          Object.keys(input.RequestItems).forEach(tableName => {
            const tableRequest = input.RequestItems[tableName];
            if (tableRequest.Keys) {
              tableRequest.Keys = tableRequest.Keys.map(key => {
                const marshalledKey = {};
                Object.keys(key).forEach(keyField => {
                  marshalledKey[keyField] = marshall(key[keyField]);
                });
                return marshalledKey;
              });
            }
          });
        }
        break;
      
      case 'TransactWriteCommand':
        if (input.TransactItems) {
          input.TransactItems = input.TransactItems.map(item => {
            const newItem = { ...item };
            if (item.Put) {
              const marshalledItem = {};
              Object.keys(item.Put.Item).forEach(key => {
                marshalledItem[key] = marshall(item.Put.Item[key]);
              });
              newItem.Put = {
                ...item.Put,
                Item: marshalledItem
              };
              if (item.Put.ExpressionAttributeValues) {
                const marshalledValues = {};
                Object.keys(item.Put.ExpressionAttributeValues).forEach(key => {
                  marshalledValues[key] = marshall(item.Put.ExpressionAttributeValues[key]);
                });
                newItem.Put.ExpressionAttributeValues = marshalledValues;
              }
            }
            if (item.Update) {
              const updateKey = {};
              Object.keys(item.Update.Key).forEach(key => {
                updateKey[key] = marshall(item.Update.Key[key]);
              });
              newItem.Update = {
                ...item.Update,
                Key: updateKey
              };
              if (item.Update.ExpressionAttributeValues) {
                const marshalledValues = {};
                Object.keys(item.Update.ExpressionAttributeValues).forEach(key => {
                  marshalledValues[key] = marshall(item.Update.ExpressionAttributeValues[key]);
                });
                newItem.Update.ExpressionAttributeValues = marshalledValues;
              }
            }
            if (item.Delete) {
              const deleteKey = {};
              Object.keys(item.Delete.Key).forEach(key => {
                deleteKey[key] = marshall(item.Delete.Key[key]);
              });
              newItem.Delete = {
                ...item.Delete,
                Key: deleteKey
              };
              if (item.Delete.ExpressionAttributeValues) {
                const marshalledValues = {};
                Object.keys(item.Delete.ExpressionAttributeValues).forEach(key => {
                  marshalledValues[key] = marshall(item.Delete.ExpressionAttributeValues[key]);
                });
                newItem.Delete.ExpressionAttributeValues = marshalledValues;
              }
            }
            return newItem;
          });
        }
        break;
    }

    return {
      constructor: { name: commandName },
      input
    };
  }

  unmarshallResponse(response, command) {
    const commandName = command.constructor.name;
    const result = { ...response };

    switch (commandName) {
      case 'GetCommand':
        if (result.Item) {
          const unmarshalledItem = {};
          Object.keys(result.Item).forEach(key => {
            unmarshalledItem[key] = unmarshall(result.Item[key]);
          });
          result.Item = unmarshalledItem;
        }
        break;
      
      case 'QueryCommand':
        if (result.Items) {
          result.Items = result.Items.map(item => {
            const unmarshalledItem = {};
            Object.keys(item).forEach(key => {
              unmarshalledItem[key] = unmarshall(item[key]);
            });
            return unmarshalledItem;
          });
        }
        if (result.LastEvaluatedKey) {
          const unmarshalledKey = {};
          Object.keys(result.LastEvaluatedKey).forEach(key => {
            unmarshalledKey[key] = unmarshall(result.LastEvaluatedKey[key]);
          });
          result.LastEvaluatedKey = unmarshalledKey;
        }
        break;
      
      case 'UpdateCommand':
        if (result.Attributes) {
          const unmarshalledAttributes = {};
          Object.keys(result.Attributes).forEach(key => {
            unmarshalledAttributes[key] = unmarshall(result.Attributes[key]);
          });
          result.Attributes = unmarshalledAttributes;
        }
        break;
      
      case 'DeleteCommand':
        if (result.Attributes) {
          const unmarshalledAttributes = {};
          Object.keys(result.Attributes).forEach(key => {
            unmarshalledAttributes[key] = unmarshall(result.Attributes[key]);
          });
          result.Attributes = unmarshalledAttributes;
        }
        break;
      
      case 'BatchGetCommand':
        if (result.Responses) {
          Object.keys(result.Responses).forEach(tableName => {
            result.Responses[tableName] = result.Responses[tableName].map(item => {
              const unmarshalledItem = {};
              Object.keys(item).forEach(key => {
                unmarshalledItem[key] = unmarshall(item[key]);
              });
              return unmarshalledItem;
            });
          });
        }
        if (result.UnprocessedKeys) {
          Object.keys(result.UnprocessedKeys).forEach(tableName => {
            const tableRequest = result.UnprocessedKeys[tableName];
            if (tableRequest.Keys) {
              tableRequest.Keys = tableRequest.Keys.map(key => {
                const unmarshalledKey = {};
                Object.keys(key).forEach(keyField => {
                  unmarshalledKey[keyField] = unmarshall(key[keyField]);
                });
                return unmarshalledKey;
              });
            }
          });
        }
        break;
    }

    return result;
  }
}

// Marshall JavaScript values to DynamoDB JSON
function marshall(obj) {
  if (obj === null) return { NULL: true };
  if (obj === undefined) return { NULL: true };
  
  const type = typeof obj;
  
  if (type === 'string') {
    if (obj === '') {
      throw new Error('Cannot marshall empty string - DynamoDB does not support empty string values');
    }
    return { S: obj };
  }
  if (type === 'number') return { N: String(obj) };
  if (type === 'boolean') return { BOOL: obj };
  
  if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    return { B: Buffer.from(obj).toString('base64') };
  }
  
  if (Array.isArray(obj)) {
    if (obj.length === 0) return { L: [] };
    
    const firstType = typeof obj[0];
    const isHomogeneous = obj.every(item => typeof item === firstType);
    
    if (isHomogeneous && firstType === 'string') {
      return { SS: obj };
    } else if (isHomogeneous && firstType === 'number') {
      return { NS: obj.map(String) };
    } else if (isHomogeneous && (obj[0] instanceof Uint8Array || Buffer.isBuffer(obj[0]))) {
      return { BS: obj.map(b => Buffer.from(b).toString('base64')) };
    } else {
      return { L: obj.map(marshall) };
    }
  }
  
  if (type === 'object') {
    const result = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key) && obj[key] !== undefined) {
        result[key] = marshall(obj[key]);
      }
    }
    return { M: result };
  }
  
  throw new Error(`Cannot marshall type: ${type}`);
}

// Unmarshall DynamoDB JSON to JavaScript values
function unmarshall(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const keys = Object.keys(obj);
  if (keys.length !== 1) return obj;
  
  const [type] = keys;
  const value = obj[type];
  
  switch (type) {
    case 'S': return value;
    case 'N': return Number(value);
    case 'BOOL': return value;
    case 'NULL': return null;
    case 'B': return Buffer.from(value, 'base64');
    case 'SS': return value;
    case 'NS': return value.map(Number);
    case 'BS': return value.map(v => Buffer.from(v, 'base64'));
    case 'L': return value.map(unmarshall);
    case 'M': {
      const result = {};
      for (const key in value) {
        result[key] = unmarshall(value[key]);
      }
      return result;
    }
    default: return obj;
  }
}

// Command classes that mimic AWS SDK structure
class GetCommand {
  constructor(input) {
    this.input = input;
  }
}

class QueryCommand {
  constructor(input) {
    this.input = input;
  }
}

class UpdateCommand {
  constructor(input) {
    this.input = input;
  }
}

class DeleteCommand {
  constructor(input) {
    this.input = input;
  }
}

class BatchGetCommand {
  constructor(input) {
    this.input = input;
  }
}

class TransactWriteCommand {
  constructor(input) {
    this.input = input;
  }
}

class CreateTableCommand {
  constructor(input) {
    this.input = input;
  }
}

class ListTablesCommand {
  constructor(input) {
    this.input = input;
  }
}

class DescribeTableCommand {
  constructor(input) {
    this.input = input;
  }
}

class UpdateTimeToLiveCommand {
  constructor(input) {
    this.input = input;
  }
}

module.exports = {
  DynamoDBClient,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchGetCommand,
  TransactWriteCommand,
  CreateTableCommand,
  ListTablesCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  marshall,
  unmarshall
};