// test/unique.test.js
const { 
  initModels, 
  ModelManager,
  User,
  Post,
  UNIQUE_CONSTRAINT_ID1 
} = require('../src');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
require('dotenv').config();

beforeAll(async () => {
  // Initialize models
  initModels({
    region: process.env.AWS_REGION,
    tableName: process.env.TABLE_NAME
  });

  const docClient = ModelManager.getInstance().documentClient;
  
  try {
    const tableInfo = await docClient.send(new DescribeTableCommand({
      TableName: process.env.TABLE_NAME
    }));
    console.log('Table exists:', tableInfo.Table.TableName);
    console.log('GSIs:', tableInfo.Table.GlobalSecondaryIndexes);
  } catch (error) {
    console.error('Failed to connect to DynamoDB:', error);
    throw error;
  }
});

beforeEach(async () => {
  const docClient = ModelManager.getInstance().documentClient;
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

afterEach(async () => {
  const docClient = ModelManager.getInstance().documentClient;
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

describe('User Unique Constraints', () => {
  test('should create user with unique email', async () => {
    const userData = {
      name: 'Test User 1',
      email: 'test1@example.com'
    };
    const user = await User.create(userData);
    expect(user.name).toBe(userData.name);
    expect(user.email).toBe(userData.email);
  });

  test('should prevent duplicate email creation', async () => {
    const userData = {
      name: 'Test User 1',
      email: 'test1@example.com'
    };
    await User.create(userData);

    await expect(async () => {
      await User.create({
        name: 'Test User 2',
        email: 'test1@example.com'
      });
    }).rejects.toThrow('email must be unique');
  });

  test('should allow creating user with different email', async () => {
    const user2Data = {
      name: 'Test User 2',
      email: 'test2@example.com',
      role: 'user',
      status: 'active',
      createdAt: new Date(),
      modifiedAt: new Date()
    };
    const user2 = await User.create(user2Data);
    
    // Only check the fields we care about
    expect(user2).toMatchObject({
      name: user2Data.name,
      email: user2Data.email,
      role: user2Data.role,
      status: user2Data.status
    });

    // Verify timestamps exist but don't check exact values
    expect(user2.createdAt).toBeInstanceOf(Date);
    expect(user2.modifiedAt).toBeInstanceOf(Date);
    
    // Verify ID was generated
    expect(user2.userId).toBeDefined();
  });

  test('should allow updating user with unique email', async () => {
    const user = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com',
      status: 'active',
    });

    const updatedUser = await User.update(user.userId, {
      email: 'test2@example.com',
      status: user.status,
      createdAt: user.createdAt
    });
    expect(updatedUser.email).toBe('test2@example.com');
  });

  test('should prevent updating user with existing email', async () => {
    const user1 = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com',
      status: 'active',
    });

    await User.create({
      name: 'Test User 2',
      email: 'test2@example.com',
      status: 'active',
    });

    await expect(async () => {
      await User.update(user1.userId, { 
        email: 'test2@example.com',
        status: user1.status,
        createdAt: user1.createdAt
      });
    }).rejects.toThrow('email must be unique');
  });

  test('should allow reusing email after user deletion', async () => {
    const user1 = await User.create({
      name: 'Test User 1',
      email: 'test1@example.com'
    });

    await User.delete(user1.userId);

    const user2 = await User.create({
      name: 'Test User 2',
      email: 'test1@example.com'
    });
    expect(user2.email).toBe('test1@example.com');
  });
});