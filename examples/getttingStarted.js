// require('dotenv').config();
// const { initModels } = require('../src');
const { User } = require('../src');

// // Initialize the model system with the models directory
// const manager = initModels({
//   region: 'us-west-2',
//   tableName: 'dynamo-bao-dev',
//   modelsDir: './examples/models'  // Specify the models directory
// });

async function main() {
  // const User = manager.getModel('User');

  try {
    // Look up by email (using unique constraint)
    const existingUser = await User.findByEmail('john.doe@example.com');
    if (existingUser) {
        console.log('Found existing user:', existingUser);
        await User.delete(existingUser.getPrimaryId());
        console.log('Deleted existing user:', existingUser);
    } else {
        console.log('No existing user found');
    }

    // Create a new user
    const user = await User.create({
      name: 'John Doe',
      email: 'john.doe@example.com',
      externalId: 'ext123',
      externalPlatform: 'platform1'
    });

    console.log('Created user:', user);

    // Look up the user by ID
    const foundById = await User.find(user.userId);
    console.log('Found by ID:', foundById);

    // Look up by email (using unique constraint)
    const foundByEmail = await User.findByEmail('john.doe@example.com');
    console.log('Found by email:', foundByEmail);

    // Query users by platform
    const platformUsers = await User.queryByIndex('byPlatform', 'platform1');
    console.log('Platform users:', platformUsers);

    // Delete the user
    await User.delete(user.getPrimaryId());
    console.log('Deleted user:', user);

  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(console.error);
