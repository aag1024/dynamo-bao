// Product constants and key derivations the replicas and the seed share.
// Transcribed from js-bao-wss on 2026-10-28 after the fidelity review.

/** wrangler.toml GLOBAL_ADMIN_APP_ID: admin models run under this tenant
 *  (`withAdminContext`), so the App row's key is `[global-admin-app]#a#<appId>`. */
export const ADMIN_TENANT = "global-admin-app";

/** server-functions/limits.ts PLATFORM_RATE_PER_MINUTE, the default per-function limit. */
export const PLATFORM_RATE_PER_MINUTE = 1200;

/** rate-limit.ts buildKey: name, then `${key}_${sha256(normalized value).slice(0,16)}`
 *  for each identifier in sorted key order. */
export async function buildLimitKey(name: string, id: Record<string, string>): Promise<string> {
  const parts = [name];
  for (const key of Object.keys(id).sort()) {
    const normalized = id[key].toLowerCase().trim().normalize("NFC");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    parts.push(`${key}_${hex.slice(0, 16)}`);
  }
  return parts.join("_");
}
