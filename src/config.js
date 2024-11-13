require('dotenv').config();

module.exports = {
  AWS_REGION: process.env.AWS_REGION || 'us-west-2',
  TABLE_NAME: process.env.TABLE_NAME || 'raftjs-dynamo-dev'
};