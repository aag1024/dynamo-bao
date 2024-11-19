// test/unique.test.js
const { User } = require('../src');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocument } = require('@aws-sdk/lib-dynamodb');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
require('dotenv').config();

let docClient;

beforeAll(async () => {
  const client = new DynamoDBClient({ region: process.env.AWS_REGION });
  docClient = DynamoDBDocument.from(client);
  User.initTable(docClient, process.env.TABLE_NAME);
});

beforeEach(async () => {
  await cleanupTestData(docClient, process.env.TABLE_NAME);
  await verifyCleanup(docClient, process.env.TABLE_NAME);
});

afterEach(async () => {
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
    expect(user).toMatchObject(userData);
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
    const user1Data = {
      name: 'Test User 1',
      email: 'test1@example.com'
    };
    await User.create(user1Data);

    const user2Data = {
      name: 'Test User 2',
      email: 'test2@example.com'
    };
    const user2 = await User.create(user2Data);
    expect(user2).toMatchObject(user2Data);
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