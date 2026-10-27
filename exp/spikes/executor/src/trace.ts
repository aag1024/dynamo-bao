/**
 * Where this isolate is actually running. `request.cf.colo` names the colo the
 * request ENTERED at; under targeted placement the worker runs somewhere else,
 * and a DO runs wherever it was created. A subrequest to /cdn-cgi/trace leaves
 * from the colo the code runs in, so its `colo=` line is the honest answer.
 * Cached per isolate: an isolate does not move. (Copied from latency-lab.)
 */
let cached: Promise<string | null> | null = null;

export function traceColo(): Promise<string | null> {
  cached ??= fetch("https://cloudflare.com/cdn-cgi/trace")
    .then((r) => r.text())
    .then((t) => /^colo=(\w+)$/m.exec(t)?.[1] ?? null)
    .catch(() => {
      cached = null;
      return null;
    });
  return cached;
}
