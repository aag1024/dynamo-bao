# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each version heading links to the tag that was published to npm. Entries before
0.4.0 were reconstructed from commit history after the fact and are brief.

## [Unreleased]

## [0.9.0] - 2026-10-28

### Security

- With tenancy enabled, an operation with no tenant in context now throws
  `ConfigurationError`. It used to fall back to the tenant that was current
  when `initModels()` ran, so a request that lost its tenant read and wrote
  that tenant's data.
- `setCurrentTenant()` inside `runWithBatchContext()` now sets the tenant for
  that context only. It used to set a process-wide tenant that concurrent
  requests picked up. Registered resolvers now take precedence over the
  process-wide tenant, `runWithTenant()` never sees it, and `clearTenant()`
  inside a context clears only that context's tenant.
- Each distinct tenant id no longer adds a cached `ModelManager` that is
  never freed. A caller sending random tenant ids could grow memory without
  limit.
- Tenant ids containing `]` or `#`, which could produce another tenant's
  keys, are rejected.
- A model with a field named like `n1` or `v1` could have that field's
  placeholder overwritten by a write `condition`, writing the value into the
  attribute the condition checked. Filter placeholders now use a reserved
  prefix.
- `update()` rejects changes to primary key fields, and composite key values
  can't contain the id separator `##__SK__##`. Either one could make an id
  address a different record.
- `VersionField` is always generated on save and `CreateDateField` is set
  only on create, so callers can't roll a version back to get around
  optimistic locking.
- An `update()` that re-sends an unchanged unique value is now conditioned
  on the stored value, so a concurrent change can't leave the value without
  its constraint row for another record to claim.
- Codegen emits YAML values as literals and requires model, field, index
  and constraint names to be JavaScript identifiers. Crafted YAML could
  inject code into generated models or write files outside the output
  directory.

### Added

- `allowedFilterFields` option on `queryByIndex()`, `iterateAll()` and
  `searchAll()` (`allowedFields` on `FilterExpressionBuilder#build`) to limit
  the fields a filter that comes from user input may reference.
- `TenantContext.setDefaultTenant()` sets the process-wide tenant
  explicitly, for scripts and tests.
- `bao-rebuild-search-text --tenant <id>` for tenancy-enabled tables.

### Changed

- **Breaking:** importing the library no longer loads `.env` from the
  working directory. Apps that relied on this should call
  `require("dotenv").config()` themselves. The CLI tools still load `.env`.
- **Breaking:** config lookup no longer loads generic `config.js`,
  `config.mjs` or `config.cjs` files, which could be an unrelated project's
  config. It now refuses with a message saying to rename the file to
  `dynamo-bao.config.js` or set `DYNAMO_BAO_CONFIG`.
- **Breaking:** `bao-update-table` and `bao-rebuild-search-text` ask before
  changing the table. Pass `--yes` in scripts and CI.
- **Breaking:** field validation is stricter. `StringField` rejects objects,
  arrays and booleans and now enforces `maxLength`. `IntegerField` rejects
  non-integers and `FloatField` rejects non-numbers. Date fields reject
  unparseable strings.
- `initModels()` no longer requires a tenant when tenancy is enabled.
- The `logging.level` passed to `initModels()` now takes effect
  (`DYNAMO_BAO_LOG_LEVEL` still wins).
- Transactional writes send a `ClientRequestToken`, and updates that use
  `ADD` (counters, set changes) are no longer retried, so a retry can't apply
  a write twice.

### Fixed

- `$not` over more than one condition negated only the first one.
- Filter keys such as `constructor` or `toString` were looked up through the
  prototype chain and either built an expression on a bogus attribute or
  threw a `TypeError`. Filters are also limited to 16 levels of nesting.
- `CreateDateField` stored an ISO string as-is instead of converting it to a
  timestamp.
- Model managers created for a tenant at runtime had no models, client or
  config, so related-model lookups under that tenant could fail.
- A unique-constraint lookup error was logged with `console.error`,
  bypassing the configured log level.

## [0.8.2] - 2026-10-27

### Fixed

- A conditional `update()` or `delete()` of a row that did not exist was
  reported as `ConditionalError` instead of `ItemNotFoundError` when another
  writer created the row right after the failed write. Since 0.8.0 the
  library read the row after a failed condition check to tell the two apart,
  and that read described a later state. Guarded writes now send
  `ReturnValuesOnConditionCheckFailure`, so the answer comes from the state
  DynamoDB evaluated the condition against. The follow-up read is gone, which
  makes the failure path one call cheaper. It remains only as a fallback for
  injected clients that do not surface the returned item.

### Changed

- The bundled DynamoDB client attaches `Item` to a
  `ConditionalCheckFailedException` when the request asked for
  `ReturnValuesOnConditionCheckFailure` (`null` when the row did not exist).

## [0.8.1] - 2026-10-27

### Fixed

- `update()` on a model with a GSI that uses `modelPrefix` as one half of its
  key threw "Update includes GSI partition key modelPrefix but is missing sort
  key" unless the update also carried the other half. 0.8.0 stopped
  pre-reading the row on plain updates, and the partial-key guard
  then treated the constant half as a newly provided key. The index is now
  skipped when the field half is not in the update, since its key cannot
  change. Plain field and counter updates on such models stay at one
  `UpdateItem`. Models with a `modelPrefix` primary key behave the same in
  `legacy` and `tenant-scoped` modes; `migrating` mode still reads first
  because it writes in place.

## [0.8.0] - 2026-10-27

Cuts DynamoDB round trips and per-item CPU in the core read and write paths.
No key formats, index keys or constraint rows change.

### Changed

- `find()` in a batch context now flushes on the next tick (`setImmediate`)
  instead of waiting for a 5 ms timer. Finds issued in the same tick still
  share one `BatchGetItem`. Pass `batchDelay: <ms>` to keep a timer window, or
  `batchDelay: 0` to send a single `GetItem` immediately.
- `update()` no longer reads the item before writing unless the update needs
  the current row: a touched GSI key, string set, unique constraint, searchable
  field, `forceReindex`, or a model in `migrating` key mode. Otherwise it sends
  one conditional `UpdateItem` guarded by `attribute_exists`, and a missing row
  raises `ItemNotFoundError` as before.
- `delete()` on a model without unique constraints is a single conditional
  `DeleteItem`. Models with unique constraints still read first so the
  constraint rows can be removed in the same transaction.
- Updates of unique-constraint fields that use plain `SET` no longer read the
  item back after the transaction. Only atomic `ADD`/`DELETE` updates do.
- `batchFind()` sends its 100-key chunks concurrently (up to 5 in flight) and
  returns the cached instance for ids already in the request cache.
- `iterateAll()` prefetches the next page while the current page is being
  hydrated, and accepts `concurrency` to walk several iteration buckets in
  parallel.
- Items loaded from DynamoDB skip constructor work they do not need: no system
  field copy, no initial values. Field getters and setters are defined once on
  the model prototype instead of on every instance.
- Debug logging no longer builds its arguments unless debug output is enabled.
  Several misdirected `logger.log` calls in the query and field code were fixed
  or removed. "Models initialized" is logged at debug level instead of info.
- Expected condition failures (`ConditionalCheckFailedException`, cancelled
  transactions) are logged at debug level. Only unexpected save errors are
  logged at error level, once.

### Fixed

- `find()` with an object primary id in a batch context could resolve to
  `ObjectNotFound`. Object and string forms of the same id now share one batch
  entry.
- `create()` with a `$and` condition produced a "redundant parentheses"
  `ValidationException`.

### Removed

- The `DEFAULT_BATCH_DELAY_MS` export. The default is no longer a delay.

### Internal

- A batch's `timer` property is now a cancel function rather than a timeout
  handle. Tests that cleared it with `clearTimeout` should call it instead.
- `Logger` gained `isLevelEnabled(level)` and `isDebugEnabled()`.

## [0.7.3] - 2026-10-27

### Changed

- Raised the `js-yaml` minimum to `^4.3.2`, which fixes four quadratic-CPU
  advisories (GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj,
  GHSA-2883-xcg3-v3hh). It is the only runtime dependency that was flagged and
  is used only by `bao-codegen`. (#16)
- Applied `npm audit fix` to dev-only transitive dependencies. (#16)
- Switched the generated docs from `clean-jsdoc-theme` to `docdash` with a
  custom stylesheet, dark mode and no build-date footer. Source pages on
  GitHub Pages lost their `src_` prefix and test helpers no longer appear
  under "Global". (#17)

## [0.7.2] - 2026-10-27

### Fixed

- `update()` with an object primary id on an iterable model failed with
  "Type mismatch for Index Key" on `_iter_sk`. The id is now converted to its
  string form first, which also stops an object id from being stored as the
  owner on a unique-constraint row. (#15)
- Relative counter values such as `"+3"` on a counter used in an index key
  were written into the key as the literal string. Creates now write the
  number. Updates write loaded value plus delta, guarded by a condition on the
  loaded value; a concurrent change raises `ConditionalError`. Counters in no
  index keep the atomic `ADD`. (#15)
- `npm publish` warned about every `bin` entry. The leading `./` was removed
  and the repository URL normalised. (#15)

## [0.7.1] - 2026-10-27

### Changed

- `create()` on a model with unique constraints takes one DynamoDB call
  instead of three. The uniqueness read before the transaction is gone (the
  constraint `Put` already carries `attribute_not_exists`) and the new item is
  built in memory instead of read back. A duplicate create now costs the
  cancelled transaction plus one read to name the field. (#14)
- `find(id, { bypassCache: true })` always issues its own `GetItem` and never
  joins a batch. (#14)
- Capacity reported on update results no longer includes earlier operations'
  capacity, so `getBatchContextCapacity()` equals what DynamoDB returned. (#14)
- Explicit `keyMigration.modelPrefixPkMode` is required to enable key
  migration.

### Fixed

- Request-scoped loader cache: creates and updates store the written row and
  deletes remove it, so a `find` later in the same request no longer returns
  stale data. An update that changed a unique field used to return the
  pre-update row. (#14)
- Cache keys now include the model and tenant. `ModelB.find(id)` could return
  a `ModelA` row with the same id, and after a tenant switch inside one request
  the second tenant could get the first tenant's cached row. (#14)
- Batches are grouped per tenant. Parallel finds from two tenants in one batch
  window were resolved with the first caller's tenant keys. (#14)
- A `{ pk, sk }` object id and its string form share one cache entry. (#14)
- Models with a field named `pk` can be created. (#14)
- `save({ condition })` on a new instance combines the caller's condition with
  the does-not-exist guard instead of replacing it. (#14)
- `DateTimeField` accepts `null` to clear the field. (#14)

## [0.7.0] - 2026-06-04

### Added

- Opt-in tenant scoping for models whose primary key partition is the model
  prefix, with a safe expand, migrate, contract rollout controlled by
  `keyMigration.modelPrefixPkMode` (`legacy`, `migrating`, `tenant-scoped`).
  The default `legacy` mode is byte-identical to earlier behaviour. In
  `migrating` mode reads fall back to both historical key shapes, updates
  write in place guarded by `attribute_exists`, and legacy-fallback reads
  report their consumed capacity. (#13)
- `PutCommand` on the DynamoDB client, used by backfill relocation. (#13)

### Changed

- The batch resolver sums every `ConsumedCapacity` entry, fixing an undercount
  for multi-page batch reads over 100 items. (#13)
- Search iteration index capacity is accounted for.

## [0.6.1] - 2026-05-27

### Fixed

- Tenant key formatting for models with a model-prefix partition key. This
  change was effectively reverted by the migration path in 0.7.0: it scoped
  the key atomically with no migration, which stranded existing rows for
  by-id reads. Upgrade to 0.7.0 or later rather than to this version.

### Changed

- Tightened the `formidable` dev dependency range.

## [0.6.0] - 2026-05-08

### Added

- `_searchText` is a first-class filter target. Use `$contains`,
  `$beginsWith`, `$eq`, `$ne` or `$exists` on it in `query`, `queryByIndex`,
  `iterateAll({ filter })` and condition expressions; the value is normalised
  with the model's `searchConfig`. (#11)
- `SECURITY.md` documenting an audit finding in the docs theme's `showdown`
  dependency (not exploitable in this project's threat model). (#11)

### Fixed

- `minTermLength` applied only at write time. Short query terms were sent to
  DynamoDB verbatim and silently matched nothing. They are now dropped from
  the predicate, and an error is raised if every term is dropped. (#11)

## [0.5.0] - 2026-05-06

### Added

- Searchable iterable models. A declarative `searchable: { fields: [...] }`
  block in the model YAML populates a normalised `_searchText` attribute on
  every save, with `caseSensitive`, `minTermLength` and `dedupe` options.
  (#10)
- `Model.searchAll(terms, options)` and
  `Model.searchBucket(bucketNum, terms, options)` async generators, with
  `$and` (default) or `$or` term matching, and
  `Model.tokenizeSearchQuery(query)` that respects quoted phrases. (#10)
- A new `iter_search_index` GSI replaces the legacy `iter_index` for
  iteration and search. `bao-update-table` adds it to existing tables; the
  legacy index is left in place for manual removal. The
  `db.iterationIndexName` config override keeps iteration on the legacy index
  during a transition. (#10)
- `bao-rebuild-search-text <ModelName>` CLI for backfilling `_searchText`.
  (#10)
- Codegen validates `searchable.fields` against existing string fields. (#10)

## [0.4.2] - 2026-03-31

### Fixed

- Generated code imports `dynamo-bao` by bare package specifier instead of a
  relative path.

### Changed

- `bao-create-table` is documented.

## [0.4.1] - 2026-03-31

### Added

- `bao-create-table` command. The bin scripts were cleaned up alongside it.

### Fixed

- Flaky pagination tests caused by GSI eventual consistency.
- A `form-data` vulnerability in a dev dependency.

## [0.4.0] - 2026-02-16

### Added

- Support for five GSIs (`gsi4` and `gsi5`), previously three. The table
  creation script provisions them. (#8)
- `bao-update-table` command to add missing GSIs and enable TTL on an existing
  table. (#8)

### Changed

- Partial updates to one half of a GSI key pair backfill the other half from
  the stored item so the index does not go stale. If the counterpart was never
  stored, the update throws with guidance to include both fields or use
  `forceReindex`. (#8)
- `forceReindex` recomputes every GSI key from the current item and preserves
  the new values. (#8)
- Table creation enables TTL via `UpdateTimeToLive` after the table is active
  instead of inline. (#8)

## [0.3.9] - 2026-01-25

### Added

- `getBatchContextCapacity()` returns the total read and write capacity
  consumed by every operation inside the current `runWithBatchContext` scope,
  for per-request usage metering. (#7)

## [0.3.8] - 2025-12-17

### Fixed

- A `const` declaration error introduced in 0.3.7.

## [0.3.7] - 2025-12-17

### Fixed

- Unique constraints on a field whose value is `null`.

## [0.3.6] - 2025-12-17

### Changed

- More robust retries after a transactional write.

### Removed

- The `serverless` dependency.

## [0.3.5] - 2025-10-22

### Added

- `forceReindex` option on updates.

## [0.3.4] - 2025-07-26

### Changed

- The log level is read from `DYNAMO_BAO_LOG_LEVEL` rather than `LOG_LEVEL`.

## [0.3.3] - 2025-07-24

### Fixed

- A logging issue.

## [0.3.2] - 2025-07-16

### Changed

- Better syntax for string sets.

## [0.3.1] - 2025-07-15

### Added

- `StringSetField`.

### Fixed

- A pagination test.

## [0.3.0] - 2025-06-26

### Added

- `runWithBatchContext()` and request-scoped batching and caching of finds.

## [0.2.12] - 2025-06-25

### Added

- Isolated-context batch loading.

## [0.2.11] - 2025-06-23

### Fixed

- An import issue in the create-table script.

## [0.2.10] - 2025-06-17

### Added

- Composite keys on `delete`.

## [0.2.9] - 2025-06-17

### Added

- Basic ESM support.

## [0.2.8] - 2025-06-16

### Added

- Cloudflare Workers support.

## [0.2.7] - 2025-06-16

### Added

- CommonJS config files.

## [0.2.6] - 2025-06-16

### Fixed

- Codegen fixes.

## [0.2.5] - 2025-06-16

### Changed

- Model discovery no longer uses `fs.readdirSync`.

## [0.2.4] - 2025-06-16

### Fixed

- An error when the custom field directory does not exist.
- Added a multi-tenant test for indexes.

## [0.2.3] - 2025-06-12

### Changed

- Documentation for iteration.

## [0.2.2] - 2025-06-12

### Added

- Multi-tenancy.
- Basic iteration over all items of a model.

## [0.2.1] - 2025-06-10

### Fixed

- `chokidar` restored as a dependency for the watcher.

## [0.2.0] - 2025-06-10

### Changed

- The DynamoDB client is a custom implementation on `aws4fetch` instead of
  the AWS SDK. Dependencies were cleaned up accordingly.

## [0.1.8] - 2025-06-03

### Changed

- Version bump only.

## [0.1.7] - 2025-06-03

### Fixed

- `exists()`.

### Changed

- Library updates and more error types.

## [0.1.6] - 2025-01-30

### Added

- Conditional saves and deletes, including exists / does-not-exist
  conditions.

### Changed

- Optimised delete. Old save constraint options removed.

## [0.1.5] - 2025-01-29

### Fixed

- Primary key naming.

## [0.1.4] - 2025-01-29

### Changed

- Config standardisation and codegen updates.

## [0.1.3] - 2025-01-10

### Added

- Basic tutorials and the LICENSE file.

## [0.1.2] - 2025-01-08

### Changed

- Simplified config setup.

## [0.1.1] - 2024-12-20

### Changed

- Documentation updates.

## [0.1.0] - 2024-12-20

Initial release: single-table models with fields, GSIs, unique constraints,
related fields, counters, TTL, filters, pagination, batch loading, hooks,
YAML codegen and a table creation tool.

[Unreleased]: https://github.com/aag1024/dynamo-bao/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/aag1024/dynamo-bao/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/aag1024/dynamo-bao/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/aag1024/dynamo-bao/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/aag1024/dynamo-bao/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/aag1024/dynamo-bao/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/aag1024/dynamo-bao/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/aag1024/dynamo-bao/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/aag1024/dynamo-bao/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/aag1024/dynamo-bao/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/aag1024/dynamo-bao/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/aag1024/dynamo-bao/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/aag1024/dynamo-bao/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/aag1024/dynamo-bao/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/aag1024/dynamo-bao/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/aag1024/dynamo-bao/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/aag1024/dynamo-bao/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/aag1024/dynamo-bao/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/aag1024/dynamo-bao/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/aag1024/dynamo-bao/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/aag1024/dynamo-bao/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/aag1024/dynamo-bao/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/aag1024/dynamo-bao/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/aag1024/dynamo-bao/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/aag1024/dynamo-bao/compare/v0.2.12...v0.3.0
[0.2.12]: https://github.com/aag1024/dynamo-bao/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/aag1024/dynamo-bao/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/aag1024/dynamo-bao/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/aag1024/dynamo-bao/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/aag1024/dynamo-bao/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/aag1024/dynamo-bao/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/aag1024/dynamo-bao/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/aag1024/dynamo-bao/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/aag1024/dynamo-bao/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/aag1024/dynamo-bao/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/aag1024/dynamo-bao/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/aag1024/dynamo-bao/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aag1024/dynamo-bao/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/aag1024/dynamo-bao/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/aag1024/dynamo-bao/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/aag1024/dynamo-bao/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/aag1024/dynamo-bao/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/aag1024/dynamo-bao/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/aag1024/dynamo-bao/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/aag1024/dynamo-bao/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/aag1024/dynamo-bao/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/aag1024/dynamo-bao/releases/tag/v0.1.0
