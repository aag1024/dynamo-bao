#!/usr/bin/env node

console.log(`
🧨🧨🧨
Are you sure you want to PERMANENTLY delete this table?

This will delete all the data in the table and cannot be undone.

If you want to do this, please use the following AWS cli command:

aws dynamodb delete-table --table-name {YOUR_TABLE_NAME}

If you don't know your table's name, look in config.js.
🧨🧨🧨
`);

process.exit(1);
