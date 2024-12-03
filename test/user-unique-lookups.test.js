const dynamoBao = require('../src');
const testConfig = require('./config');
const { cleanupTestData, verifyCleanup } = require('./utils/test-utils');
const { ulid } = require('ulid');

let User, testId;

describe('User Unique Constraint Lookups', () => {
  beforeEach(async () => {
    testId = ulid();
    
    const manager = dynamoBao.initModels({
      ...testConfig,
      testId: testId
    });

    await cleanupTestData(testId);
    await verifyCleanup(testId);

    User = manager.getModel('User');
  });

  afterEach(async () => {
    if (testId) {
      await cleanupTestData(testId);
      await verifyCleanup(testId);
    }
  });

  describe('Email Lookups', () => {
    test('should find user by email', async () => {
      const email = `test${Date.now()}@example.com`;
      const user = await User.create({
        name: 'Test User',
        email: email,
        role: 'user',
        status: 'active'
      });

      const foundUser = await User.findByEmail(email);
      expect(foundUser.userId).toBe(user.userId);
      expect(foundUser.email).toBe(email);
    });

    test('should return null for non-existent email', async () => {
      const foundUser = await User.findByEmail('nonexistent@example.com');
      expect(foundUser).toBeNull();
    });
  });

  describe('External ID Lookups', () => {
    test('should find user by external ID', async () => {
      const externalId = `ext${Date.now()}`;
      const user = await User.create({
        name: 'Test User',
        email: `test${Date.now()}@example.com`,
        externalId: externalId,
        externalPlatform: 'platform1',
        role: 'user',
        status: 'active'
      });

      const foundUser = await User.findByExternalId(externalId);
      expect(foundUser.userId).toBe(user.userId);
      expect(foundUser.externalId).toBe(externalId);
    });

    test('should return null for non-existent external ID', async () => {
      const foundUser = await User.findByExternalId('nonexistent-ext-id');
      expect(foundUser).toBeNull();
    });
  });

  describe('Error Handling', () => {
    test('should throw error for invalid email format', async () => {
      await expect(User.findByEmail('')).rejects.toThrow();
    });

    test('should throw error for null external ID', async () => {
      await expect(User.findByExternalId(null)).rejects.toThrow();
    });
  });
}); 