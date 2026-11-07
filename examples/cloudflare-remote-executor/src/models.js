import { initModels, BaoModel, PrimaryKeyConfig, fields } from "dynamo-bao";

const { UlidField, StringField, StringSetField, CreateDateField } = fields;

export class Note extends BaoModel {
  static modelPrefix = "exnote";
  static iterable = true;
  static iterationBuckets = 1;
  static fields = {
    noteId: UlidField({ autoAssign: true }),
    text: StringField({ required: true }),
    tags: StringSetField(),
    createdAt: CreateDateField(),
  };
  static primaryKey = PrimaryKeyConfig("noteId");
}

let manager = null;

/** The models for this deployment, built once per isolate from env. */
export function getModels(env) {
  if (!manager) {
    manager = initModels({
      models: { Note },
      aws: {
        region: env.AWS_REGION,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          sessionToken: env.AWS_SESSION_TOKEN,
        },
      },
      db: { tableName: env.TABLE_NAME },
      tenancy: { enabled: true },
    });
  }
  return { Note: manager.getModel("Note") };
}
