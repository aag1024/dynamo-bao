// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨  
// DO NOT EDIT: Generated by model-codegen 
// 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 🧨 
const { 
  BaoModel,
  PrimaryKeyConfig
} = require('dynamo-bao');


const { 
    UlidField,
    StringField
} = require('dynamo-bao').fields;


const { EmailField } = require('../custom-fields/email-field');



class UserWithEmail extends BaoModel {
  static modelPrefix = 'u';
  
  static fields = {
    userId: UlidField({ required: true, autoAssign: true }),
    email: EmailField({ required: true, allowedDomains: ["company.com","subsidiary.com"] }),
    name: StringField(),
  };

  static primaryKey = PrimaryKeyConfig('userId', 'modelPrefix');





}

module.exports = { UserWithEmail };
