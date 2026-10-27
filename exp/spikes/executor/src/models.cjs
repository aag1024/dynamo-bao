// Mirrors of the js-bao-wss models on the paths under test, transcribed from
// js-bao-wss/src/models/*.js (generated from its models.yaml) on 2026-10-27.
// Same modelPrefix, fields, keys, indexes and unique constraints, so the item
// shapes, key formats and write patterns (TransactWrite for unique
// constraints, iteration keys on iterable models) match the product's.
//
// Field *names* are kept even where the spike never reads them, because item
// size is part of what is measured. Reverse-query helpers the product
// generates (queryPermissions, queryConnections, ...) are not mirrored; the
// replicas call queryByIndex directly, which is what those helpers do.
//
// If js-bao-wss's models.yaml changes for one of these, re-transcribe.

const {
  BaoModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
} = require("dynamo-bao/src/model.js");
const {
  GSI_INDEX_ID1,
  GSI_INDEX_ID2,
  UNIQUE_CONSTRAINT_ID1,
} = require("dynamo-bao/src/constants.js");
const {
  UlidField,
  StringField,
  StringSetField,
  BooleanField,
  IntegerField,
  CounterField,
  DateTimeField,
  CreateDateField,
  ModifiedDateField,
  RelatedField,
  TtlField,
} = require("dynamo-bao/src/fields.js");

// Stand-ins for models the mirrored ones point at through RelatedField but the
// spike never loads. Minimal on purpose; RelatedField only needs the name.
class User extends BaoModel {
  static modelPrefix = "u";
  static fields = {
    userId: UlidField({ autoAssign: true, required: true }),
    email: StringField({ required: true }),
    name: StringField(),
    provider: StringField({ required: true }),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };
  static primaryKey = PrimaryKeyConfig("userId");
}

class AdminUser extends BaoModel {
  static modelPrefix = "au";
  static fields = {
    adminId: UlidField({ autoAssign: true, required: true }),
    email: StringField({ required: true }),
  };
  static primaryKey = PrimaryKeyConfig("adminId");
}

// --- js-bao-wss/src/models/document.js --------------------------------------
class Document extends BaoModel {
  static modelPrefix = "d";
  static iterable = true;
  static iterationBuckets = 10;

  static fields = {
    documentId: UlidField({ autoAssign: true, required: true }),
    appId: RelatedField("App", { required: true }),
    title: StringField(),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
    createdBy: RelatedField("User", { required: true }),
    tags: StringSetField({ maxStringLength: 48, maxMemberCount: 10 }),
    thumbnailBlobId: StringField(),
    metadata: StringField(),
    tenantScopedDO: BooleanField({ default: false }),
    documentFormat: IntegerField(),
    linkAccess: StringField(),
    linkAccessUpdatedBy: RelatedField("User", { required: false }),
    linkAccessUpdatedAt: DateTimeField(),
  };

  static primaryKey = PrimaryKeyConfig("documentId", "modelPrefix");

  static indexes = {
    documentsByCreator: IndexConfig("createdBy", "modifiedAt", GSI_INDEX_ID1),
  };
}

// --- js-bao-wss/src/models/document-permission.js ---------------------------
class DocumentPermission extends BaoModel {
  static modelPrefix = "dp";

  static fields = {
    documentId: RelatedField("Document", { required: true }),
    userId: RelatedField("User", { required: true }),
    permission: StringField({ required: true }),
    grantedAt: CreateDateField(),
    grantedBy: RelatedField("User", { required: true }),
  };

  static primaryKey = PrimaryKeyConfig("documentId", "userId");

  static indexes = {
    permissionsForDocument: this.primaryKey,
    permissionsForUser: IndexConfig("userId", "grantedAt", GSI_INDEX_ID1),
  };
}

// --- js-bao-wss/src/models/document-group-permission.js ---------------------
class DocumentGroupPermission extends BaoModel {
  static modelPrefix = "dgp";

  static fields = {
    documentId: RelatedField("Document", { required: true }),
    groupComposite: StringField({ required: true }),
    groupType: StringField({ required: true }),
    groupId: StringField({ required: true }),
    appGroupComposite: StringField({ required: true }),
    permission: StringField({ required: true }),
    grantedAt: CreateDateField(),
    grantedBy: RelatedField("User", { required: true }),
    sourceCollectionIds: StringSetField(),
    directGrant: BooleanField({ default: true }),
    directPermission: StringField(),
    revision: IntegerField(),
  };

  static primaryKey = PrimaryKeyConfig("documentId", "groupComposite");

  static indexes = {
    groupPermissionsForDocument: this.primaryKey,
    documentsByGroup: IndexConfig("appGroupComposite", "grantedAt", GSI_INDEX_ID1),
  };
}

// --- js-bao-wss/src/models/app-membership.js --------------------------------
class AppMembership extends BaoModel {
  static modelPrefix = "am";

  static fields = {
    appId: RelatedField("App", { required: true }),
    membershipKey: StringField({ required: true }),
    userId: RelatedField("User", { required: true }),
    groupType: StringField({ required: true }),
    groupId: StringField({ required: true }),
    groupComposite: StringField({ required: true }),
    addedAt: CreateDateField(),
    addedBy: RelatedField("User", { required: true }),
  };

  static primaryKey = PrimaryKeyConfig("appId", "membershipKey");

  static indexes = {
    membershipsForApp: this.primaryKey,
    membershipsForGroup: IndexConfig("groupComposite", "userId", GSI_INDEX_ID1),
  };
}

// --- js-bao-wss/src/models/connection-mapping.js ----------------------------
class ConnectionMapping extends BaoModel {
  static modelPrefix = "cm";

  static fields = {
    connectionId: StringField({ required: true }),
    userId: RelatedField("User", { required: true }),
    appId: RelatedField("App", { required: true }),
    documentId: RelatedField("Document", { required: true }),
    connectedAt: CreateDateField(),
    lastActivity: DateTimeField(),
    ttl: TtlField(),
  };

  static primaryKey = PrimaryKeyConfig("documentId", "connectionId");

  static indexes = {
    connectionsForDocument: this.primaryKey,
    connectionsForUser: IndexConfig("userId", "connectedAt", GSI_INDEX_ID1),
  };
}

// --- js-bao-wss/src/models/rate-limit-window.js -----------------------------
class RateLimitWindow extends BaoModel {
  static modelPrefix = "rlw";

  static fields = {
    limitKey: StringField({ required: true }),
    windowStart: StringField({ required: true }),
    appId: RelatedField("App", { required: true }),
    count: CounterField(),
    ttl: TtlField(),
  };

  static primaryKey = PrimaryKeyConfig("limitKey", "windowStart");

  static indexes = {
    windowsByKey: this.primaryKey,
  };
}

// --- js-bao-wss/src/models/server-function.js -------------------------------
// pk is the bare modelPrefix; under MODEL_PREFIX_PK_MODE=tenant-scoped it is
// `[appId]#sfn`, which is what makes functionKeyPerApp unique per app.
class ServerFunction extends BaoModel {
  static modelPrefix = "sfn";

  static fields = {
    functionId: UlidField({ autoAssign: true, required: true }),
    appId: RelatedField("App", { required: true }),
    functionKey: StringField({ required: true }),
    description: StringField(),
    status: StringField({ default: "active" }),
    activeConfigId: StringField(),
    activeConfigActivatedAt: DateTimeField(),
    activeConfigActivatedBy: StringField(),
    access: StringField(),
    inputSchema: StringField(),
    outputSchema: StringField(),
    deleteLockedAt: DateTimeField(),
    createdBy: RelatedField("AdminUser", { required: true }),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };

  static primaryKey = PrimaryKeyConfig("modelPrefix", "functionId");

  static indexes = {
    functionsByApp: IndexConfig("appId", "modifiedAt", GSI_INDEX_ID1),
  };

  static uniqueConstraints = {
    functionKeyPerApp: UniqueConstraintConfig("functionKey", UNIQUE_CONSTRAINT_ID1),
  };

  static async findByfunctionKeyPerApp(value) {
    return await this.findByUniqueConstraint("functionKeyPerApp", value);
  }
}

// --- js-bao-wss/src/models/server-function-config.js ------------------------
class ServerFunctionConfig extends BaoModel {
  static modelPrefix = "sfcfg";

  static fields = {
    configId: UlidField({ autoAssign: true, required: true }),
    functionId: RelatedField("ServerFunction", { required: true }),
    appId: RelatedField("App", { required: true }),
    entry: StringField({ required: true }),
    bundleR2Key: StringField(),
    contentHash: StringField(),
    envelopeHash: StringField(),
    envelopeKey: StringField({ required: true }),
    manifest: StringField(),
    manifestR2Key: StringField(),
    limits: StringField(),
    capabilities: StringSetField({ maxStringLength: 200, maxMemberCount: 100 }),
    triggers: StringField(),
    status: StringField({ default: "active" }),
    createdBy: RelatedField("AdminUser", { required: true }),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };

  static primaryKey = PrimaryKeyConfig("modelPrefix", "configId");

  static indexes = {
    configsByFunction: IndexConfig("functionId", "createdAt", GSI_INDEX_ID1),
  };

  static uniqueConstraints = {
    envelopePerFunction: UniqueConstraintConfig("envelopeKey", UNIQUE_CONSTRAINT_ID1),
  };
}

// --- js-bao-wss/src/models/app.js (an admin model: global, no tenant) -------
// All fields kept so the App item is the product's size; most stay empty.
class App extends BaoModel {
  static modelPrefix = "a";
  static iterable = true;
  static iterationBuckets = 10;

  static fields = {
    appId: UlidField({ autoAssign: true, required: true }),
    name: StringField({ required: true }),
    mode: StringField({ required: true }),
    waitlistEnabled: BooleanField({ default: false }),
    waitlistNotifyAdmins: BooleanField({ default: true }),
    createdBy: RelatedField("AdminUser", { required: true }),
    createdByAdminId: StringField(),
    googleOAuthEnabled: BooleanField(),
    googleClientId: StringField(),
    googleClientSecret: StringField(),
    googleClients: StringField(),
    appleSignInEnabled: BooleanField(),
    appleAudiences: StringField(),
    allowedDomains: StringField(),
    redirectUris: StringField(),
    emailRedirectUris: StringField(),
    testAccountBaseEmails: StringField(),
    corsMode: StringField(),
    corsAllowedOrigins: StringField(),
    corsAllowCredentials: BooleanField(),
    corsAllowedMethods: StringField(),
    corsAllowedHeaders: StringField(),
    corsExposedHeaders: StringField(),
    corsMaxAge: StringField(),
    passkeyEnabled: BooleanField({ default: true }),
    passkeyRpId: StringField(),
    passkeyRpName: StringField(),
    passkeyRpConfig: StringField(),
    passkeyUserVerification: StringField(),
    emailSignInEnabled: BooleanField({ default: true }),
    magicLinkEnabled: BooleanField({ default: true }),
    otpEnabled: BooleanField({ default: true }),
    baseUrl: StringField(),
    memberInvitationsEnabled: BooleanField({ default: false }),
    memberInvitationLimit: IntegerField({ default: 5 }),
    largeDocumentWindowDays: IntegerField(),
    rootDocumentFormat: IntegerField(),
    protection: StringField(),
    protected: BooleanField({ default: false }),
    parentAppId: StringField(),
    childSlug: StringField(),
    parentSlugKey: StringField(),
    ownerAdminId: StringField(),
    branch: StringField(),
    idleDays: IntegerField(),
    expiresAt: DateTimeField(),
    warnedForExpiresAt: DateTimeField(),
    deletingAt: DateTimeField(),
    previewOrigins: StringField(),
    childPartition: StringField(),
    lastActivityAt: DateTimeField(),
    createdAt: CreateDateField(),
    modifiedAt: ModifiedDateField(),
  };

  static primaryKey = PrimaryKeyConfig("appId", "modelPrefix");

  static indexes = {
    childrenByParent: IndexConfig("parentAppId", "createdAt", GSI_INDEX_ID1),
    childrenByExpiry: IndexConfig("childPartition", "expiresAt", GSI_INDEX_ID2),
  };

  static uniqueConstraints = {
    slugPerParent: UniqueConstraintConfig("parentSlugKey", UNIQUE_CONSTRAINT_ID1),
  };
}

/** Tenant-scoped models, as js-bao-wss's getAppModels returns them. */
const appModels = {
  User,
  Document,
  DocumentPermission,
  DocumentGroupPermission,
  AppMembership,
  ConnectionMapping,
  RateLimitWindow,
  ServerFunction,
  ServerFunctionConfig,
};

/** Global models, as getAdminModels returns them. */
const adminModels = { AdminUser, App };

module.exports = { appModels, adminModels };
