import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const vars = Object.fromEntries(
    readFileSync(join(here, "..", ".dev.vars"), "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
  const sub = vars.SPIKE_WORKERS_SUBDOMAIN;
  if (!sub) throw new Error("SPIKE_WORKERS_SUBDOMAIN missing from .dev.vars");
  return {
    token: readFileSync(join(here, "..", ".spike-token"), "utf8").trim(),
    edge: `https://spike-edge.${sub}.workers.dev`,
    edgeUse1: `https://spike-edge-use1.${sub}.workers.dev`,
    data: `https://spike-data.${sub}.workers.dev`,
  };
}

export async function api(base, token, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (attempt >= 5 || res.status < 500) throw new Error(`${path} ${res.status}: ${text}`);
    await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
  }
}
