const dynamoBao = require('../src');
const testConfig = require('./config');
const User = dynamoBao.models.User;

const { ulid } = require('ulid');
const { defaultLogger: logger } = require('../src/utils/logger');

let testId;

beforeAll(async () => {
  // Initialize models
  const manager = dynamoBao.initModels({
    ...testConfig,
  });
});

beforeEach(async () => {

});

afterEach(async () => {

});

describe('Basic test of Non-test environment', () => {
  test('should create a user successfully', async () => {
    const userData = {
      name: 'Test User 1',
      email: `${ulid()}@example.com`,
      externalId: ulid(),
      externalPlatform: ulid()
    };

    logger.log('Creating user with data:', userData);
    let user;

    try {
      user = await User.create(userData);
      logger.log('Created user:', user);
      
      // Compare only the input fields that we explicitly provided
      expect(user.name).toBe(userData.name);
      expect(user.email).toBe(userData.email);
      expect(user.externalId).toBe(userData.externalId);
      expect(user.externalPlatform).toBe(userData.externalPlatform);
      
      // Verify date fields are Date instances
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.modifiedAt).toBeInstanceOf(Date);
      
      // Verify other auto-generated fields
      expect(user.userId).toBeDefined();
      expect(user.role).toBe('user');
      expect(user.status).toBe('active');
    } catch (error) {
      console.error('Transaction error details:', error);
      console.error('Cancellation reasons:', error.CancellationReasons);
      throw error;
    } finally {
      await User.delete(user.userId);
    }
  });


});
