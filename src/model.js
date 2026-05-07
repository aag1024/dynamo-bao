/**
 * @description
 * This module contains the core functionality for models in Bao.
 */

const {
  RelatedFieldClass,
  StringField,
  StringSetFieldClass,
} = require("./fields");
const { ModelManager } = require("./model-manager");
const { defaultLogger: logger } = require("./utils/logger");
const { ObjectNotFound } = require("./object-not-found");
const ValidationMethods = require("./mixins/validation-mixin");
const UniqueConstraintMethods = require("./mixins/unique-constraint-mixin");
const QueryMethods = require("./mixins/query-mixin");
const MutationMethods = require("./mixins/mutation-mixin");
const {
  BatchLoadingMethods,
  BATCH_REQUESTS,
  BATCH_REQUEST_TIMEOUT,
  _accumulateCapacityToContext,
} = require("./mixins/batch-loading-mixin");

const {
  PrimaryKeyConfig: PrimaryKeyConfigClass,
  IndexConfig: IndexConfigClass,
  UniqueConstraintConfig: UniqueConstraintConfigClass,
} = require("./model-config");

const GID_SEPARATOR = "##__SK__##";
const {
  UNIQUE_CONSTRAINT_KEY,
  SYSTEM_FIELDS,
  ITERATION_INDEX_NAME,
  SEARCH_INDEX_NAME,
  ITERATION_PK_FIELD,
  ITERATION_SK_FIELD,
  SEARCH_TEXT_FIELD,
} = require("./constants");
const {
  ConfigurationError,
  ValidationError,
  QueryError,
  DataFormatError,
} = require("./exceptions");

/**
 * @description
 * Base model that implements core functionality for all models. Do not instantiate
 * this class directly, instead use a subclass, usually that has been generated
 * by the code generator.
 */
class BaoModel {
  static _tenantId = null;
  static _testId = null; // Backward compatibility
  static table = null;
  static documentClient = null;

  // These should be overridden by child classes
  static modelPrefix = null;
  static fields = {};
  static primaryKey = null;
  static indexes = {};
  static uniqueConstraints = {};
  static iterable = false;
  static iterationBuckets = 100;
  static searchable = false;
  static searchConfig = null;

  static defaultQueryLimit = 100;

  static {
    // Initialize methods
    Object.assign(BaoModel, ValidationMethods);
    Object.assign(BaoModel, UniqueConstraintMethods);
    Object.assign(BaoModel, QueryMethods);
    Object.assign(BaoModel, MutationMethods);
    Object.assign(BaoModel, BatchLoadingMethods);
  }

  /**
   * @description
   * ONLY use this for testing. It allows tests to run in isolation and
   * prevent data from being shared between tests/tests to run in parallel.
   * However, it should not be used outside of this context. For examples,
   * showing how to use this, see the tests.
   *
   * @deprecated Use TenantContext.setCurrentTenant() with the new multi-tenancy
   * system for both testing and production tenant isolation. See tutorial 08-multi-tenancy.
   * @param {string} testId - The ID of the test.
   */
  static setTestId(testId) {
    this._tenantId = testId;
    this._testId = testId; // Backward compatibility
    const manager = ModelManager.getInstance(testId);
    this.documentClient = manager.documentClient;
    this.table = manager.tableName;
  }

  static get manager() {
    const { TenantContext } = require("./tenant-context");
    const tenantId = TenantContext.getCurrentTenant();
    return ModelManager.getInstance(tenantId || this._tenantId);
  }

  static _getField(fieldName) {
    let fieldDef;
    if (SYSTEM_FIELDS.includes(fieldName) || fieldName === "modelPrefix") {
      fieldDef = StringField();
    } else {
      fieldDef = this.fields[fieldName];
    }

    if (!fieldDef) {
      throw new ConfigurationError(
        `Field ${fieldName} not found in ${this.name} fields`,
        this.name,
      );
    }

    return fieldDef;
  }

  static _getPkValue(data) {
    if (!data) {
      throw new ValidationError(
        "Data object is required for static _getPkValue call",
      );
    }

    const pkValue =
      this.primaryKey.pk === "modelPrefix"
        ? this.modelPrefix
        : data[this.primaryKey.pk];

    logger.debug("_getPkValue", pkValue);

    return pkValue;
  }

  static _getSkValue(data) {
    if (!data) {
      throw new ValidationError(
        "Data object is required for static _getSkValue call",
      );
    }

    if (this.primaryKey.sk === "modelPrefix") {
      return this.modelPrefix;
    }
    return data[this.primaryKey.sk];
  }

  _getPkValue() {
    return this.constructor._getPkValue(this._dyData);
  }

  _getSkValue() {
    return this.constructor._getSkValue(this._dyData);
  }

  static _formatGsiKey(modelPrefix, indexId, value) {
    const tenantId = this.manager.getTenantId();
    const baseKey = `${modelPrefix}#${indexId}#${value}`;
    return tenantId ? `[${tenantId}]#${baseKey}` : baseKey;
  }

  static _formatPrimaryKey(modelPrefix, value) {
    const tenantId = this.manager.getTenantId();
    const baseKey = `${modelPrefix}#${value}`;
    return tenantId ? `[${tenantId}]#${baseKey}` : baseKey;
  }

  static _formatUniqueConstraintKey(constraintId, modelPrefix, field, value) {
    const tenantId = this.manager.getTenantId();
    const baseKey = `${UNIQUE_CONSTRAINT_KEY}#${constraintId}#${modelPrefix}#${field}:${value}`;
    return tenantId ? `[${tenantId}]#${baseKey}` : baseKey;
  }

  static _getDyKeyForPkSk(pkSk) {
    if (this.primaryKey.sk === "modelPrefix") {
      return {
        _pk: this._formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: this.modelPrefix,
      };
    } else if (this.primaryKey.pk === "modelPrefix") {
      return {
        _pk: this.modelPrefix,
        _sk: pkSk.sk,
      };
    } else {
      return {
        _pk: this._formatPrimaryKey(this.modelPrefix, pkSk.pk),
        _sk: pkSk.sk,
      };
    }
  }

  static _getIterationKeys(objectId, dyData) {
    if (!this.iterable) {
      return {};
    }

    const tenantId = this.manager.getTenantId();
    let iterPk;

    if (this.iterationBuckets === 1) {
      iterPk = tenantId
        ? `[${tenantId}]#${this.modelPrefix}#iter`
        : `${this.modelPrefix}#iter`;
    } else {
      const bucketNum = this._hashObjectId(objectId) % this.iterationBuckets;
      const bucket = bucketNum.toString().padStart(3, "0");
      iterPk = tenantId
        ? `[${tenantId}]#${this.modelPrefix}#iter#${bucket}`
        : `${this.modelPrefix}#iter#${bucket}`;
    }

    return {
      [ITERATION_PK_FIELD]: iterPk,
      [ITERATION_SK_FIELD]: objectId,
    };
  }

  static _hashObjectId(objectId) {
    let hash = 0;
    for (let i = 0; i < objectId.length; i++) {
      const char = objectId.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  static getIterationBuckets() {
    return this.iterable ? this.iterationBuckets : 1;
  }

  static async *iterateAll(options = {}) {
    if (!this.iterable) {
      throw new Error(`Model ${this.name} is not configured as iterable`);
    }

    const { batchSize = 100, filter = null } = options;

    if (this.iterationBuckets === 1) {
      yield* this._iterateSingleBucket(null, {
        batchSize,
        filter,
      });
    } else {
      for (let bucket = 0; bucket < this.iterationBuckets; bucket++) {
        yield* this._iterateSingleBucket(bucket, {
          batchSize,
          filter,
        });
      }
    }
  }

  static async *iterateBucket(bucketNum, options = {}) {
    if (!this.iterable) {
      throw new Error(`Model ${this.name} is not configured as iterable`);
    }

    if (bucketNum < 0 || bucketNum >= this.iterationBuckets) {
      throw new Error(
        `Invalid bucket number ${bucketNum}. Must be 0-${this.iterationBuckets - 1}`,
      );
    }

    yield* this._iterateSingleBucket(bucketNum, options);
  }

  static _assertSearchable() {
    if (!this.searchable || !this.searchConfig) {
      throw new Error(
        `Model ${this.name} is not configured as searchable. ` +
          `Add a searchable: { fields: [...] } block in YAML to enable search.`,
      );
    }
    if (!this.iterable) {
      throw new Error(
        `searchAll requires iterable: true. For non-iterable models, use ` +
          `query/queryByIndex with a filter on _searchText.`,
      );
    }
    const indexName = this.manager.getIterationIndexName();
    if (indexName !== SEARCH_INDEX_NAME) {
      throw new Error(
        `searchAll requires the '${SEARCH_INDEX_NAME}' GSI. Current config ` +
          `resolves the iteration index to '${indexName}'. To enable search:\n` +
          `  1) Run 'bao-update-table' to add ${SEARCH_INDEX_NAME} to the table.\n` +
          `  2) Set 'db.iterationIndexName: "${SEARCH_INDEX_NAME}"' in your config.\n` +
          `  3) (If the model already has data) run 'bao-rebuild-search-text <ModelName>'.`,
      );
    }
  }

  /**
   * @description
   * Search a `searchable: { fields: [...] }`-configured iterable model by
   * substring(s) of `_searchText`. Each term becomes one
   * `contains(_searchText, :term)` predicate. Multiple terms are combined
   * with `$and` (default) or `$or`. Each term is normalized with the same
   * rules used to build `_searchText` at write time, so user input matches
   * what's stored.
   *
   * Reads from the bucketed `iter_search_index` GSI. By default fans out
   * across every bucket in parallel; sequential mode is available via
   * `parallel: false`. Returns one page of results plus an opaque cursor
   * for resumption. To paginate, pass the cursor back on subsequent calls;
   * `cursor === null` indicates the search is exhausted.
   *
   * @param {string[]} terms - One or more substring terms. Empty/whitespace
   *   terms are dropped; throws if zero usable terms remain after
   *   normalization.
   * @param {Object} [options]
   * @param {('$and'|'$or')} [options.operator='$and'] - How multi-term queries
   *   are combined.
   * @param {number} [options.batchSize=100] - DynamoDB Query Limit per page.
   *   Each Query examines up to this many items before applying
   *   FilterExpression.
   * @param {number} [options.limit=100] - Maximum total items returned by
   *   this call. Pass `Infinity` to opt out (caller is responsible for
   *   ensuring the call doesn't exhaust capacity).
   * @param {number} [options.maxQueriesPerBucket=50] - Per-bucket cap on
   *   DynamoDB Query roundtrips per call. Bounds worst-case capacity for
   *   sparse-match searches. When hit, the call returns whatever it found
   *   plus a non-null cursor pointing at the next page.
   * @param {boolean} [options.parallel=true] - When true, all unexhausted
   *   buckets are queried concurrently in rounds; results are interleaved.
   *   When false, buckets are walked sequentially in order.
   * @param {string|null} [options.cursor=null] - Opaque cursor from a
   *   previous call. Pass to resume; omit (or pass `null`) for a fresh
   *   search. Cursor is invalidated if `terms`, `operator`, or the model's
   *   `searchConfig` change.
   * @param {Object} [options.filter] - Additional filter combined via AND
   *   with the search predicate. Must reference only attributes projected
   *   on `iter_search_index` (i.e., `_searchText` and the index/base keys).
   * @returns {Promise<{items: BaoModel[], cursor: string|null}>} `items` is
   *   never longer than `limit`. `cursor` is `null` when the search is
   *   fully exhausted; otherwise pass it back to get the next page.
   * @throws {Error} If the model is not `searchable`, not `iterable`, the
   *   resolved iteration index is not `iter_search_index`, `limit` is
   *   invalid, the cursor is malformed, or the cursor was generated for a
   *   different query.
   * @example
   * // First page
   * const { items, cursor } = await Post.searchAll(["alice"], { limit: 50 });
   * // "Load more"
   * const next = await Post.searchAll(["alice"], { limit: 50, cursor });
   * // Drain everything
   * let cur = null, all = [];
   * do {
   *   const page = await Post.searchAll(["alice"], { limit: 100, cursor: cur });
   *   all.push(...page.items);
   *   cur = page.cursor;
   * } while (cur);
   */
  static async searchAll(terms, options = {}) {
    this._assertSearchable();
    return this._searchPaged({
      terms,
      options,
      activeBucketIndices: Array.from(
        { length: this.iterationBuckets },
        (_, b) => b,
      ),
    });
  }

  /**
   * @description
   * Search a single iteration bucket. Same predicate semantics and return
   * shape as {@link BaoModel.searchAll}, but scoped to one bucket. Useful
   * for partitioned workers (each handles a subset of buckets).
   *
   * @param {number} bucketNum - Bucket index, in `[0, iterationBuckets)`.
   * @param {string[]} terms - Substring terms (see `searchAll`).
   * @param {Object} [options] - Same options as `searchAll` (cursor scoped
   *   to this bucket).
   * @returns {Promise<{items: BaoModel[], cursor: string|null}>}
   * @throws {Error} On invalid bucket number, non-searchable model, etc.
   */
  static async searchBucket(bucketNum, terms, options = {}) {
    this._assertSearchable();
    if (
      !Number.isInteger(bucketNum) ||
      bucketNum < 0 ||
      bucketNum >= this.iterationBuckets
    ) {
      throw new Error(
        `Invalid bucket number ${bucketNum}. Must be 0-${this.iterationBuckets - 1}`,
      );
    }
    return this._searchPaged({
      terms,
      options,
      activeBucketIndices: [bucketNum],
    });
  }

  /**
   * @private
   * Shared paged-search engine for searchAll and searchBucket. Honors the
   * `parallel`, `limit`, `maxQueriesPerBucket`, and `cursor` options;
   * returns `{ items, cursor }` with `cursor === null` on exhaustion.
   */
  static async _searchPaged({ terms, options, activeBucketIndices }) {
    const {
      buildSearchPredicate,
      validateLimit,
      predicateHash,
      encodeCursor,
      decodeCursor,
    } = require("./utils/search-text");

    const {
      operator = "$and",
      batchSize = 100,
      filter = null,
      limit = 100,
      maxQueriesPerBucket = 50,
      parallel = true,
      cursor: incomingCursor = null,
    } = options;

    validateLimit(limit);
    if (
      !Number.isInteger(maxQueriesPerBucket) ||
      maxQueriesPerBucket < 1
    ) {
      throw new Error(
        "maxQueriesPerBucket must be a positive integer.",
      );
    }

    const searchPredicate = buildSearchPredicate(terms, this.searchConfig, {
      operator,
    });
    const expectedHash = predicateHash(terms, operator, this.searchConfig);

    // Decode the cursor or initialize per-bucket state for a fresh call.
    // bucketCursors maps bucketIdx -> lek (or null for "start of bucket").
    // pendingItemKeys is the over-pull from a previous parallel round.
    let bucketCursors;
    let pendingItemKeys = [];
    if (incomingCursor) {
      const decoded = decodeCursor(incomingCursor);
      if (decoded.predicateHash !== expectedHash) {
        throw new Error(
          `Cursor was generated for a different query (terms/operator/searchConfig changed). Start a new search.`,
        );
      }
      if (decoded.modelPrefix !== this.modelPrefix) {
        throw new Error(
          `Cursor was generated for model "${decoded.modelPrefix}", not "${this.modelPrefix}".`,
        );
      }
      // Cursors are scoped to the bucket set used to generate them, so a
      // searchAll cursor can't be passed into searchBucket(N) (and vice
      // versa) without silently mixing items across scopes via
      // pendingItemKeys. Reject mismatch with a clear message.
      const decodedScope = (decoded.scope || []).slice().sort((a, b) => a - b);
      const expectedScope = activeBucketIndices.slice().sort((a, b) => a - b);
      const scopesMatch =
        decodedScope.length === expectedScope.length &&
        decodedScope.every((s, i) => s === expectedScope[i]);
      if (!scopesMatch) {
        throw new Error(
          `Cursor scope mismatch. Cursor was generated for buckets ` +
            `[${decodedScope.join(", ")}], but this call covers ` +
            `[${expectedScope.join(", ")}]. Resume the cursor with the same ` +
            `API call (searchAll or searchBucket) that produced it.`,
        );
      }
      bucketCursors = { ...decoded.bucketCursors };
      pendingItemKeys = decoded.pendingItemKeys || [];
    } else {
      bucketCursors = {};
      for (const b of activeBucketIndices) bucketCursors[b] = null;
    }

    const items = [];

    // Phase 1: drain pending items from a prior over-pull. Hydrate via
    // batchFind (current row state — deletions surface as missing items).
    // Preserve insertion order from the original pendingItemKeys list so
    // the user sees a deterministic page-to-page sequence.
    if (pendingItemKeys.length > 0) {
      const { items: found } = await this.batchFind(pendingItemKeys);
      for (const k of pendingItemKeys) {
        if (found[k]) items.push(found[k]);
      }
    }

    const queriesByBucket = {};
    for (const b of Object.keys(bucketCursors)) queriesByBucket[b] = 0;

    // Collapse the iterationBuckets===1 case: PK shape uses null bucketArg,
    // but we still index state by 0 internally for consistency.
    const bucketArg = (b) => (this.iterationBuckets === 1 ? null : b);

    const pullPage = async (bucketIdx) => {
      const lek = bucketCursors[bucketIdx];
      queriesByBucket[bucketIdx] = (queriesByBucket[bucketIdx] || 0) + 1;
      const page = await this._searchSingleBucketPage(bucketArg(bucketIdx), {
        batchSize,
        filter,
        searchPredicate,
        exclusiveStartKey: lek || null,
      });
      if (page.lek) bucketCursors[bucketIdx] = page.lek;
      else delete bucketCursors[bucketIdx]; // exhausted
      return page.items;
    };

    const eligibleBuckets = () =>
      Object.keys(bucketCursors)
        .map((b) => parseInt(b, 10))
        .filter((b) => (queriesByBucket[b] || 0) < maxQueriesPerBucket)
        .sort((a, b) => a - b);

    if (parallel) {
      while (items.length < limit && eligibleBuckets().length > 0) {
        const round = eligibleBuckets();
        const pages = await Promise.all(round.map(pullPage));
        for (const pageItems of pages) items.push(...pageItems);
      }
    } else {
      // Sequential: walk eligible buckets in order, pulling pages until
      // exhausted / per-bucket cap / global limit hit.
      for (const bucket of eligibleBuckets()) {
        while (
          bucketCursors[bucket] !== undefined &&
          (queriesByBucket[bucket] || 0) < maxQueriesPerBucket &&
          items.length < limit
        ) {
          const pageItems = await pullPage(bucket);
          items.push(...pageItems);
        }
        if (items.length >= limit) break;
      }
    }

    // Slice to limit; over-pull at the boundary gets stashed in the cursor
    // as pendingItemKeys for the next call to return first. Both modes can
    // over-pull: parallel mode by up to (active buckets - 1) × batchSize,
    // sequential mode by up to one batchSize (its loop guard is at the top
    // so the page that pushes us past `limit` is fully kept).
    let kept = items;
    let overflowKeys = [];
    if (items.length > limit) {
      kept = items.slice(0, limit);
      overflowKeys = items
        .slice(limit)
        .map((m) => m.getPrimaryId());
    }

    const bucketsRemaining = Object.keys(bucketCursors).length > 0;
    const hasMore = bucketsRemaining || overflowKeys.length > 0;
    const cursorOut = hasMore
      ? encodeCursor({
          bucketCursors,
          predicateHash: expectedHash,
          modelPrefix: this.modelPrefix,
          scope: activeBucketIndices,
          pendingItemKeys: overflowKeys,
        })
      : null;

    return { items: kept, cursor: cursorOut };
  }

  /**
   * @description
   * Split a free-form query string into an array of terms suitable for
   * passing to {@link BaoModel.searchAll}. Whitespace separates terms;
   * double-quoted phrases are kept together as a single term.
   *
   * @param {string} queryString - Raw user input.
   * @returns {string[]} Array of terms (possibly empty).
   * @example
   * Post.tokenizeSearchQuery('"hello world" foo');
   * // => ["hello world", "foo"]
   */
  static tokenizeSearchQuery(queryString) {
    const { tokenizeSearchQuery } = require("./utils/search-text");
    return tokenizeSearchQuery(queryString);
  }

  /**
   * @description
   * Normalize a single search term using the same rules the model used to
   * build `_searchText` at write time: lowercase (unless
   * `caseSensitive: true`), strip punctuation, collapse whitespace. Useful
   * when post-filtering hydrated rows in JS, or when manually constructing
   * a `_searchText` filter against a model that has no `searchConfig`.
   *
   * Idempotent — calling multiple times returns the same result.
   *
   * @param {string} term - Raw user input.
   * @returns {string} Normalized term.
   * @example
   * const term = Post.normalizeSearchTerm("Hello, World!"); // "hello world"
   * results.filter((p) => p._dyData._searchText?.includes(term));
   */
  static normalizeSearchTerm(term) {
    const { normalizeSearchTerm } = require("./utils/search-text");
    return normalizeSearchTerm(term, this.searchConfig || {});
  }

  // Attributes projected onto each iteration index, by index name. The base
  // table key (_pk/_sk) and the index key (_iter_pk/_iter_sk) are always
  // projected by DynamoDB. iter_search_index additionally INCLUDEs
  // _searchText. iter_index (legacy) is KEYS_ONLY.
  static _PROJECTED_ATTRS_BY_INDEX = {
    [SEARCH_INDEX_NAME]: new Set([
      "_pk",
      "_sk",
      ITERATION_PK_FIELD,
      ITERATION_SK_FIELD,
      SEARCH_TEXT_FIELD,
    ]),
    [ITERATION_INDEX_NAME]: new Set([
      "_pk",
      "_sk",
      ITERATION_PK_FIELD,
      ITERATION_SK_FIELD,
    ]),
  };

  static _assertFilterFitsIterIndex(indexName, expressionAttributeNames) {
    const projected = this._PROJECTED_ATTRS_BY_INDEX[indexName];
    if (!projected) return; // Unknown index — skip the preflight.
    const referenced = Object.values(expressionAttributeNames);
    const unprojected = referenced.filter((name) => !projected.has(name));
    if (unprojected.length === 0) return;
    const list = unprojected.join(", ");
    const example = unprojected[0];
    const projectedList = Array.from(projected).join(", ");
    throw new Error(
      `Filter on '${indexName}' references attribute(s) that aren't ` +
        `projected: [${list}]. The index projects: [${projectedList}]. ` +
        `DynamoDB can't filter on anything else at the index level — ` +
        `filter the hydrated batch in JS instead, e.g.:\n` +
        `  for await (const batch of Model.iterateAll()) {\n` +
        `    for (const item of batch) {\n` +
        `      if (item.${example} === ...) { /* keep */ }\n` +
        `    }\n` +
        `  }`,
    );
  }

  static _getIterationPk(bucketNum) {
    const tenantId = this.manager.getTenantId();
    if (this.iterationBuckets === 1) {
      return tenantId
        ? `[${tenantId}]#${this.modelPrefix}#iter`
        : `${this.modelPrefix}#iter`;
    }
    const bucket = bucketNum.toString().padStart(3, "0");
    return tenantId
      ? `[${tenantId}]#${this.modelPrefix}#iter#${bucket}`
      : `${this.modelPrefix}#iter#${bucket}`;
  }

  /**
   * @private
   * Single Query roundtrip against the iter_search_index for one bucket.
   * Returns hydrated items + lastEvaluatedKey. Used by the paged
   * searchAll/searchBucket implementation that needs explicit page-by-page
   * control (instead of the do/while loop in _iterateSingleBucket).
   *
   * @param {number|null} bucketNum - Bucket index, or `null` for single-bucket models.
   * @param {Object} options
   * @param {number} options.batchSize - DynamoDB Query Limit.
   * @param {Object} [options.filter] - User filter.
   * @param {Object} [options.searchPredicate] - Predicate from buildSearchPredicate.
   * @param {Object} [options.exclusiveStartKey] - DynamoDB LEK to resume from.
   * @returns {Promise<{items: BaoModel[], lek: Object|null}>}
   */
  static async _searchSingleBucketPage(bucketNum, options = {}) {
    const {
      batchSize = 100,
      filter = null,
      searchPredicate = null,
      exclusiveStartKey = null,
    } = options;
    const iterPk = this._getIterationPk(bucketNum);
    const indexName = this.manager.getIterationIndexName();

    const { QueryCommand } = require("./dynamodb-client");
    const params = {
      TableName: this.table,
      IndexName: indexName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": ITERATION_PK_FIELD },
      ExpressionAttributeValues: { ":pk": iterPk },
      Limit: batchSize,
      ReturnConsumedCapacity: "TOTAL",
    };
    if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;

    const filterParts = [];
    if (filter) {
      const { FilterExpressionBuilder } = require("./filter-expression");
      const filterBuilder = new FilterExpressionBuilder();
      const filterExpression = filterBuilder.build(filter, this);
      if (filterExpression) {
        this._assertFilterFitsIterIndex(
          indexName,
          filterExpression.ExpressionAttributeNames,
        );
        filterParts.push(filterExpression.FilterExpression);
        Object.assign(
          params.ExpressionAttributeNames,
          filterExpression.ExpressionAttributeNames,
        );
        Object.assign(
          params.ExpressionAttributeValues,
          filterExpression.ExpressionAttributeValues,
        );
      }
    }
    if (searchPredicate) {
      filterParts.push(searchPredicate.FilterExpression);
      Object.assign(
        params.ExpressionAttributeNames,
        searchPredicate.ExpressionAttributeNames,
      );
      Object.assign(
        params.ExpressionAttributeValues,
        searchPredicate.ExpressionAttributeValues,
      );
    }
    if (filterParts.length > 0) {
      params.FilterExpression = filterParts
        .map((p) => `(${p})`)
        .join(" AND ");
    }

    let response;
    try {
      response = await this.documentClient.send(new QueryCommand(params));
    } catch (error) {
      const message = error.message || "";
      const isMissingIndex =
        /does not have the specified index/i.test(message) ||
        message.includes(`specified index: ${indexName}`) ||
        (error.name === "ResourceNotFoundException" &&
          message.toLowerCase().includes("index"));
      if (isMissingIndex) {
        throw new Error(
          `Index '${indexName}' is missing on table '${this.table}'. ` +
            `Run 'bao-update-table' to add it.`,
        );
      }
      throw error;
    }

    let items = [];
    if (response.Items && response.Items.length > 0) {
      const objectIds = response.Items.map((item) => item[ITERATION_SK_FIELD]);
      const { items: found } = await this.batchFind(objectIds);
      items = Object.values(found);
    }
    return { items, lek: response.LastEvaluatedKey || null };
  }

  static async *_iterateSingleBucket(bucketNum, options = {}) {
    const { batchSize = 100, filter = null, searchPredicate = null } = options;
    const iterPk = this._getIterationPk(bucketNum);
    const indexName = this.manager.getIterationIndexName();

    let lastEvaluatedKey = null;

    do {
      const { QueryCommand } = require("./dynamodb-client");
      const params = {
        TableName: this.table,
        IndexName: indexName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": ITERATION_PK_FIELD },
        ExpressionAttributeValues: { ":pk": iterPk },
        Limit: batchSize,
        ReturnConsumedCapacity: "TOTAL",
      };

      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }

      const filterParts = [];
      if (filter) {
        const { FilterExpressionBuilder } = require("./filter-expression");
        const filterBuilder = new FilterExpressionBuilder();
        const filterExpression = filterBuilder.build(filter, this);
        if (filterExpression) {
          // Preflight: filter attributes must be in the GSI's projection.
          // Otherwise DynamoDB returns an opaque "does not project one or
          // more filter attributes" ValidationException; we surface a clearer
          // error before the round-trip.
          this._assertFilterFitsIterIndex(
            indexName,
            filterExpression.ExpressionAttributeNames,
          );
          filterParts.push(filterExpression.FilterExpression);
          Object.assign(
            params.ExpressionAttributeNames,
            filterExpression.ExpressionAttributeNames,
          );
          Object.assign(
            params.ExpressionAttributeValues,
            filterExpression.ExpressionAttributeValues,
          );
        }
      }
      if (searchPredicate) {
        filterParts.push(searchPredicate.FilterExpression);
        Object.assign(
          params.ExpressionAttributeNames,
          searchPredicate.ExpressionAttributeNames,
        );
        Object.assign(
          params.ExpressionAttributeValues,
          searchPredicate.ExpressionAttributeValues,
        );
      }
      if (filterParts.length > 0) {
        params.FilterExpression = filterParts.map((p) => `(${p})`).join(" AND ");
      }

      let response;
      try {
        response = await this.documentClient.send(new QueryCommand(params));
      } catch (error) {
        // DynamoDB reports a missing index as a ValidationException with a
        // message like "The table does not have the specified index: <name>".
        // We only translate when the message explicitly references an index
        // — translating raw ResourceNotFoundException would mask a missing
        // *table* with a "run bao-update-table" hint that wouldn't help.
        const message = error.message || "";
        const isMissingIndex =
          /does not have the specified index/i.test(message) ||
          message.includes(`specified index: ${indexName}`) ||
          (error.name === "ResourceNotFoundException" &&
            message.toLowerCase().includes("index"));
        if (isMissingIndex) {
          throw new Error(
            `Index '${indexName}' is missing on table '${this.table}'. ` +
              `Run 'bao-update-table' to add it.`,
          );
        }
        throw error;
      }

      if (response.Items && response.Items.length > 0) {
        const objectIds = response.Items.map(
          (item) => item[ITERATION_SK_FIELD],
        );

        const { items } = await this.batchFind(objectIds);
        const batch = Object.values(items);

        if (batch.length > 0) {
          yield batch;
        }
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  }

  /**
   * @description
   * Create a new model instance.
   * @param {Object} [jsData] - The initial data for the model.
   */
  constructor(jsData = {}) {
    this._dyData = {};
    SYSTEM_FIELDS.forEach((key) => {
      if (jsData[key] !== undefined) {
        this._dyData[key] = jsData[key];
      }
    });

    this._loadedDyData = {};
    this._changes = new Set();
    this._relatedObjects = {};
    this._consumedCapacity = [];

    // Initialize fields with data
    Object.entries(this.constructor.fields).forEach(([fieldName, field]) => {
      // Convert initial value to DynamoDB format
      let value =
        jsData[fieldName] === undefined
          ? field.getInitialValue()
          : jsData[fieldName];
      this._dyData[fieldName] = field.toDy(value);

      // Define property getter/setter that always works with _dyData
      Object.defineProperty(this, fieldName, {
        get: () => {
          // For StringSetField, pass model context to enable proxy
          if (field instanceof StringSetFieldClass) {
            return field.fromDy(this._dyData[fieldName], this, fieldName);
          }
          return field.fromDy(this._dyData[fieldName]);
        },
        set: (newValue) => {
          const oldDyValue = this._dyData[fieldName];
          const newDyValue = field.toDy(newValue);
          if (newDyValue !== oldDyValue) {
            this._dyData[fieldName] = newDyValue;
            this._changes.add(fieldName);
            if (field instanceof RelatedFieldClass) {
              delete this._relatedObjects[fieldName];
            }
          }
        },
      });
    });
  }

  static _createFromDyItem(dyItem) {
    const newObj = new this();
    newObj._dyData = dyItem;
    newObj._resetChangeTracking();

    logger.debug("_createFromDyItem", dyItem, newObj);
    logger.debug("_createFromDyItem.name", newObj.name);
    return newObj;
  }

  /**
   * @description
   * Clear the related cache for a given field.
   * @param {string} fieldName - The name of the field to clear.
   */
  clearRelatedCache(fieldName) {
    delete this._relatedObjects[fieldName];
  }

  // Returns the pk and sk values for a given object. These are encoded to work with
  // dynamo string keys. No test prefix or model prefix is applied.
  static _getPrimaryKeyValues(data) {
    if (!data) {
      throw new ValidationError(
        "Data object is required for _getPrimaryKeyValues call",
      );
    }

    const pkField = this._getField(this.primaryKey.pk);
    const pkValue = pkField
      ? pkField.toGsi(this._getPkValue(data))
      : this._getPkValue(data);

    if (pkValue === undefined || pkValue === null) {
      throw new ValidationError(`PK must be defined to get a PkSk`);
    }

    const key = { pk: pkValue };

    if (this.primaryKey.sk) {
      const skField = this._getField(this.primaryKey.sk);
      const skValue = skField
        ? skField.toGsi(this._getSkValue(data))
        : this._getSkValue(data);

      if (skValue === undefined || skValue === null) {
        throw new ValidationError(
          `SK must be defined for a composite primary key`,
        );
      }
      key.sk = skValue;
    }

    logger.debug("_getPrimaryKeyValues", key);
    return key;
  }

  /**
   * @description
   * Make a primary ID from a pk and sk.
   * @param {string} pk - The partition key.
   * @param {string} sk - The sort key.
   * @returns {string} The primary ID.
   */
  static makePrimaryId(pk, sk) {
    if (this.primaryKey.pk === "modelPrefix") {
      return sk;
    } else if (this.primaryKey.sk === "modelPrefix") {
      return pk;
    } else {
      return pk + GID_SEPARATOR + sk;
    }
  }

  /**
   * @description
   * Static version of {@link BaoModel#getPrimaryId}.
   * @param {Object} data - The data object to get the primary ID for.
   * @returns {string} The primary ID.
   */
  static getPrimaryId(data) {
    logger.debug("getPrimaryId", data);
    const pkSk = this._getPrimaryKeyValues(data);
    logger.debug("getPrimaryId", pkSk);

    let primaryId = this.makePrimaryId(pkSk.pk, pkSk.sk);
    return primaryId;
  }

  /**
   * @description
   * Get the primary ID for a given object. This is a string that uniquely
   * identifies the object in the database. When using {@link BaoModel.find},
   * this is the id to use. Do not make assumptions about how this id
   * is formatted since it will depend on the model key structure.
   * @returns {string} The primary ID.
   */
  getPrimaryId() {
    return this.constructor.getPrimaryId(this._dyData);
  }

  static _parsePrimaryId(primaryId) {
    if (typeof primaryId === "object" && primaryId !== null) {
      if (primaryId.pk !== undefined) {
        return primaryId;
      }
      return this._getPrimaryKeyValues(primaryId);
    }

    if (typeof primaryId !== "string") {
      throw new ValidationError(
        `primaryId must be a string or an object. Got ${typeof primaryId}`,
      );
    }

    if (primaryId.indexOf(GID_SEPARATOR) !== -1) {
      const [pk, sk] = primaryId.split(GID_SEPARATOR);
      return { pk, sk };
    } else {
      if (this.primaryKey.pk === "modelPrefix") {
        return { pk: this.modelPrefix, sk: primaryId };
      } else if (this.primaryKey.sk === "modelPrefix") {
        return { pk: primaryId, sk: this.modelPrefix };
      }
      return { pk: primaryId };
    }
  }

  // Get all data - convert from Dynamo to JS format
  _getAllData() {
    const allData = {};
    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      allData[fieldName] = field.fromDy(this._dyData[fieldName]);
    }
    return allData;
  }

  // Get only changed fields - convert from Dynamo to JS format
  _getChanges() {
    const changes = {};
    logger.debug("_changes Set contains:", Array.from(this._changes));
    for (const field of this._changes) {
      const fieldDef = this.constructor._getField(field);
      logger.debug("Field definition for", field, ":", {
        type: fieldDef.constructor.name,
        field: fieldDef,
      });
      const dyValue = this._dyData[field];
      logger.debug("Converting value:", {
        field,
        dyValue,
        fromDyExists: typeof fieldDef.fromDy === "function",
      });
      changes[field] = fieldDef.fromDy(dyValue);
    }
    return changes;
  }

  /**
   * @description
   * Returns true if any fields have been modified since the object was last
   * loaded from the database.
   * @returns {boolean} True if there are changes, false otherwise.
   */
  hasChanges() {
    return this._changes.size > 0;
  }

  /**
   * @description
   * Returns true if the object has been loaded from the database.
   * @returns {boolean} True if the object has been loaded, false otherwise.
   */
  isLoaded() {
    return Object.keys(this._loadedDyData).length > 0;
  }

  // Reset tracking after successful save
  _resetChangeTracking() {
    this._loadedDyData = { ...this._dyData };
    this._changes.clear();
  }

  /**
   * @description
   * Save the current object to the database. This operation will diff the current
   * state of the object with the state that has been loaded from dynamo to
   * determine which changes need to be saved.
   *
   * @param {Object} [options] - Additional options for the save operation.
   * @param {Object} [options.constraints={}] - Constraints to validate. Options are:
   * @param {boolean} [options.constraints.mustExist=false] - Whether the item must exist.
   * @param {boolean} [options.constraints.mustNotExist=false] - Whether the item must not exist.
   * @param {string[]} [options.constraints.fieldMatches=[]] - An array of field names that must match
   * the current item's loaded state. This is often used for optimistic locking in conjunction
   * with a {@link BaoFields.VersionField} field.
   * @param {boolean} [options.forceReindex=false] - When true, repopulates all index attributes even if no tracked changes exist.
   * @returns {Promise<Object>} Returns a promise that resolves to the updated item.
   */
  async save(options = {}) {
    const { forceReindex = false, ...otherOptions } = options;

    if (!forceReindex && !this.hasChanges() && this.isLoaded()) {
      logger.debug("save() - no changes to save");
      return this; // No changes to save
    }

    let changes = null;
    const updateOptions = { ...otherOptions, instanceObj: this };

    if (!this.isLoaded()) {
      updateOptions.isNew = true;
      changes = this._getAllData();
    } else if (forceReindex) {
      changes = this._getAllData();
    } else {
      changes = this._getChanges();
    }

    logger.debug("save() - changes", changes);
    const updatedObj = await this.constructor.update(
      this.getPrimaryId(),
      changes,
      { ...updateOptions, forceReindex },
    );

    logger.debug("save() - updatedObj", updatedObj);
    this._dyData = updatedObj._dyData;
    logger.debug("save() - this", this);

    // Reset change tracking after successful save
    this._resetChangeTracking();

    return this;
  }

  /**
   * @description
   * Get or load a related field. If the field is already loaded, it will be
   * returned without reloading. Otherwise, it will be loaded from the database
   * and returned.
   * @param {string} fieldName - The name of the field to get or load.
   * @param {Object} [loaderContext] - Cache context for storing and retrieving items across requests.
   * @returns {Promise<Object>} Returns a promise that resolves to the loaded item.
   */
  async getOrLoadRelatedField(fieldName) {
    if (this._relatedObjects[fieldName]) {
      return this._relatedObjects[fieldName];
    }

    const field = this.constructor.fields[fieldName];
    if (!field || !field.modelName) {
      throw new ConfigurationError(
        `Field ${fieldName} is not a valid relation field`,
        this.constructor.name,
      );
    }

    const value = this[fieldName];
    if (!value) return null;

    const ModelClass = this.constructor.manager.getModel(field.modelName);
    this._relatedObjects[fieldName] = await ModelClass.find(value);
    return this._relatedObjects[fieldName];
  }

  /**
   * @description
   * Load objects for RelatedField's on the current model instance.
   * @param {string[]} [fieldNames] - The names of the fields to load. If not provided, all related fields will be loaded.
   * @returns {Promise<Object>} Returns a promise that resolves to the loaded items and their consumed capacity
   */
  async loadRelatedData(fieldNames = null) {
    const promises = [];

    for (const [fieldName, field] of Object.entries(this.constructor.fields)) {
      if (fieldNames && !fieldNames.includes(fieldName)) {
        continue;
      }

      if (field instanceof RelatedFieldClass && this[fieldName]) {
        promises.push(
          this._loadRelatedField(fieldName, field).then((instance) => {
            this._relatedObjects[fieldName] = instance;
          }),
        );
      }
    }

    await Promise.all(promises);
    return this;
  }

  async _loadRelatedField(fieldName, field) {
    const value = this[fieldName];
    if (!value) return null;

    const ModelClass = this.constructor.manager.getModel(field.modelName);

    if (value instanceof ModelClass) {
      return value;
    }

    // Load the instance and track its capacity
    const relatedInstance = await ModelClass.find(value);

    return relatedInstance;
  }

  /**
   * @description
   * Get a related field. If the field is not loaded, it will return null.
   * @param {string} fieldName - The name of the field to get.
   * @returns {Object} The related field.
   */
  getRelated(fieldName) {
    const field = this.constructor.fields[fieldName];
    if (!(field instanceof RelatedFieldClass)) {
      throw new ConfigurationError(
        `Field ${fieldName} is not a RelatedField`,
        this.constructor.name,
      );
    }
    return this._relatedObjects[fieldName];
  }

  /**
   * @description
   * Find an object by a unique constraint. Any unique constraint can also be used
   * to find an object.
   * @param {string} constraintName - The name of the unique constraint to use.
   * @param {string} value - The value of the unique constraint.
   * @returns {Promise<Object>} Returns a promise that resolves to the found item.
   */
  static async findByUniqueConstraint(constraintName, value) {
    const constraint = this.uniqueConstraints[constraintName];
    if (!constraint) {
      throw new ConfigurationError(
        `Unknown unique constraint '${constraintName}' in ${this.name}`,
        this.name,
      );
    }

    if (!value) {
      throw new ValidationError(
        `${constraint.field} value is required`,
        constraint.field,
      );
    }

    const key = this._formatUniqueConstraintKey(
      constraint.constraintId,
      this.modelPrefix,
      constraint.field,
      value,
    );

    const { GetCommand } = require("./dynamodb-client");
    const result = await this.documentClient.send(
      new GetCommand({
        TableName: this.table,
        Key: {
          _pk: key,
          _sk: UNIQUE_CONSTRAINT_KEY,
        },
        ReturnConsumedCapacity: "TOTAL",
      }),
    );

    if (!result.Item) {
      return new ObjectNotFound(result.ConsumedCapacity);
    }

    const item = await this.find(result.Item.relatedId);

    if (item.exists()) {
      item._addConsumedCapacity(result.ConsumedCapacity, "read");
    }

    return item;
  }

  /**
   * @description
   * Returns true if the object exists. This is particularly useful when checking
   * if an object has been found, since ObjectNotFound will be returned
   * rather than null if an object is not found (so capacity information
   * will also be returned).
   * @returns {boolean} True if the object exists, false otherwise.
   */
  exists() {
    return true;
  }

  _setConsumedCapacity(capacity, type = "read", fromContext = false) {
    this.clearConsumedCapacity();
    this._addConsumedCapacity(capacity, type, fromContext);
  }

  _addConsumedCapacity(
    consumedCapacity,
    type,
    isRelated = false,
    skipContextAccumulation = false,
  ) {
    if (!["read", "write"].includes(type)) {
      throw new ValidationError(`Invalid consumed capacity type: ${type}`);
    }

    if (!consumedCapacity) {
      return;
    }

    if (Array.isArray(consumedCapacity)) {
      consumedCapacity.forEach((item) =>
        this._addConsumedCapacity(item, type, isRelated, skipContextAccumulation),
      );
    } else {
      if (consumedCapacity.consumedCapacity) {
        this._consumedCapacity.push({
          consumedCapacity: consumedCapacity.consumedCapacity,
          fromContext: consumedCapacity.fromContext || isRelated,
          type: consumedCapacity.type || type,
        });
        // Accumulate to batch context (only for non-related to avoid double counting)
        if (!isRelated && !consumedCapacity.fromContext && !skipContextAccumulation) {
          const units = consumedCapacity.consumedCapacity?.CapacityUnits || 0;
          _accumulateCapacityToContext(units, consumedCapacity.type || type);
        }
      } else {
        this._consumedCapacity.push({
          consumedCapacity: consumedCapacity,
          fromContext: isRelated,
          type: type,
        });
        // Accumulate to batch context (only for non-related to avoid double counting)
        if (!isRelated && !skipContextAccumulation) {
          const units = consumedCapacity?.CapacityUnits || 0;
          _accumulateCapacityToContext(units, type);
        }
      }
    }
  }

  /**
   * Get the number of RCU/WCU consumed by a model instance. Additional capacity
   * is added every time a new operation (finding, saving, loading related data)
   * is performed on the instance. You can reset the consumed capacity by calling
   * {@link BaoModel#clearConsumedCapacity}.
   * @param {string} type - Either "read", "write", or "total".
   * @param {boolean} [includeRelated=false] - Whether to include capacity from related objects.
   * @returns {number} The numeric consumed capacity.
   */
  getNumericConsumedCapacity(type, includeRelated = false) {
    if (!["read", "write", "total"].includes(type)) {
      throw new ValidationError(`Invalid consumed capacity type: ${type}`);
    }

    let consumedCapacity = this._consumedCapacity;
    if (!consumedCapacity) {
      consumedCapacity = [];
    }

    let total = consumedCapacity.reduce((sum, capacity) => {
      if (
        !capacity.fromContext &&
        (capacity.type === type || type === "total")
      ) {
        return sum + (capacity.consumedCapacity?.CapacityUnits || 0);
      }
      return sum;
    }, 0);

    if (includeRelated) {
      // Sum up capacity from any loaded related objects
      for (const relatedObj of Object.values(this._relatedObjects)) {
        if (relatedObj) {
          const relatedCapacity = relatedObj.getNumericConsumedCapacity(
            type,
            true,
          );
          total += relatedCapacity;
        }
      }
    }

    return total;
  }

  /**
   * @description
   * Get the consumed capacity for the current model instance. Every entry
   * in this array will represent a separate operation.
   * @returns {Object[]} The consumed capacity.
   */
  getConsumedCapacity() {
    return this._consumedCapacity;
  }

  /**
   * @description
   * Clear the consumed capacity for the current model instance.
   */
  clearConsumedCapacity() {
    this._consumedCapacity = [];
  }
}

// Factory functions to maintain compatibility
const PrimaryKeyConfig = (pk, sk) => new PrimaryKeyConfigClass(pk, sk);
const IndexConfig = (pk, sk, indexId) => new IndexConfigClass(pk, sk, indexId);
const UniqueConstraintConfig = (field, constraintId) =>
  new UniqueConstraintConfigClass(field, constraintId);

module.exports = {
  BaoModel,
  PrimaryKeyConfig,
  IndexConfig,
  UniqueConstraintConfig,
  BATCH_REQUEST_TIMEOUT,
  BATCH_REQUESTS,
};
