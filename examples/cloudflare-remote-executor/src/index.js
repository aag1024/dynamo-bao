import { remote } from "dynamo-bao/remote";
import { executor, DATA_ROUTE, SECRET_HEADER } from "./executor.js";
import { createNote, getNote } from "./procedures.js";
import { Note } from "./models.js";

/** The actor a caller builds from its own authority checks. */
export const systemActor = (appId) => ({
  kind: "system",
  appId,
  systemAuthority: true,
  preAuthenticated: false,
});

/** A caller: in a real app this runs in a Durable Object near the user. */
export function dataClient(env, appId) {
  return remote(env.DATA, {
    actor: systemActor(appId),
    headers: { [SECRET_HEADER]: env.DATA_BINDING_SECRET },
    retries: 1, // only ever resends idempotent and conditional calls
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The executor's route.
    if (url.pathname === DATA_ROUTE) return executor.fetch(request, env, ctx);

    // An example caller: POST /apps/:appId/notes {"noteId","text"}.
    const match = url.pathname.match(/^\/apps\/([^/]+)\/notes(?:\/([^/]+))?$/);
    if (match) {
      const [, appId, noteId] = match;
      const data = dataClient(env, appId);
      const r =
        request.method === "POST"
          ? await data.call(createNote, await request.json(), { tenant: appId })
          : await data.call(getNote, { noteId }, { tenant: appId });
      if ("unknown" in r) return Response.json({ error: "try again" }, { status: 503 });
      if ("error" in r) return Response.json({ error: r.error.name }, { status: 500 });
      const row = request.method === "POST" ? r.ok.note : r.ok;
      if (!row) return Response.json({ error: "not found" }, { status: 404 });
      const note = Note.fromRemote(row); // detached: read-only at the caller
      return Response.json({ noteId: note.noteId, text: note.text, tags: [...note.tags] });
    }

    return new Response("not found", { status: 404 });
  },
};
