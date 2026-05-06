# Security Policy

## Reporting a Vulnerability

If you find a security issue in dynamo-bao, please open a private GitHub
security advisory at
https://github.com/aag1024/dynamo-bao/security/advisories/new rather than
filing a public issue.

## Known `npm audit` Findings

The findings below are ones `npm audit` reports against the dev tree but
which do not affect users of the published `dynamo-bao` package. We
document them here rather than papering over them.

### `showdown` ReDoS — GHSA-rmmh-p597-ppvv (moderate)

- **Where it lives:** transitive dependency of `clean-jsdoc-theme`, our
  jsdoc theme. devDependency only.
- **Status upstream:** every published version of `showdown` is affected;
  there is no patched release (`first_patched_version: None` in the
  advisory).
- **Exploitability in this project:** the regex runs only when
  `npm run docs` parses markdown. The only markdown inputs are this
  project's own committed `README.md` and the `tutorials/` directory.
  There is no path for an attacker to supply malicious markdown to the
  docs builder.
- **Shipped to users:** no. `showdown` is a devDependency, not present
  in `dependencies` and not in the published tarball.
- **Why we're not "fixing" it:**
  - `clean-jsdoc-theme` versions before `4.1.10` don't depend on
    `showdown`, but they require `jsdoc@3` and we use `jsdoc@4`.
  - All `clean-jsdoc-theme` versions that support `jsdoc@4` (i.e.
    `>=4.2.0`) pull in `showdown`.
  - Switching jsdoc themes is the only mechanical fix and would change
    the look of generated docs without reducing the actual risk.

If you run `npm audit` and want it to exit clean for CI purposes, add
`GHSA-rmmh-p597-ppvv` to your allowlist (e.g., `audit-ci`'s `--allowlist`
flag, or a `.npmrc` `audit-level` adjustment).
