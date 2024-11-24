const { 
    initModels,
    User
  } = require('../src');

const { ulid } = require('ulid');
require('dotenv').config();

let testId;

beforeAll(async () => {
  // Initialize models
  initModels({
    region: process.env.AWS_REGION,
    tableName: process.env.TABLE_NAME
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
      external_id: ulid(),
      external_platform: ulid()
    };

    console.log('Creating user with data:', userData);
    let user;

    try {
      user = await User.create(userData);
      console.log('Created user:', user);
      
      // Compare only the input fields that we explicitly provided
      expect(user.name).toBe(userData.name);
      expect(user.email).toBe(userData.email);
      expect(user.external_id).toBe(userData.external_id);
      expect(user.external_platform).toBe(userData.external_platform);
      
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
