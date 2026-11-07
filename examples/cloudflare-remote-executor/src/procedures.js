// Procedures: named, versioned functions that run on the data worker. The
// descriptors are also what callers import; nothing executable crosses the
// wire, only "name@version" and JSON arguments.
import { defineProcedure, ProcedureRegistry, encodeValue } from "dynamo-bao/remote";
import { exceptions } from "dynamo-bao";

const { ConditionalError } = exceptions;

/**
 * Create a note with a caller-chosen id. The create is guarded (it fails if
 * the row exists), so a resend after `unknown` is safe: the replay class is
 * `conditional`, and a second attempt reports `created: false`.
 */
export const createNote = defineProcedure({
  name: "note.create",
  version: 1,
  scope: "app",
  replay: "conditional",
  args: { type: "object", required: ["noteId", "text"] },
  async run(ctx, { noteId, text, tags = [] }) {
    // Without a caller-chosen id the model would assign a fresh one on every
    // attempt, and a resend would create a second note instead of finding the first.
    if (typeof noteId !== "string" || noteId === "") {
      throw new TypeError("note.create needs a noteId chosen by the caller");
    }
    try {
      const note = await ctx.models.Note.create({ noteId, text, tags: new Set(tags) });
      ctx.logger.info("note created", { noteId });
      return { created: true, note: encodeValue(note) };
    } catch (e) {
      if (!(e instanceof ConditionalError)) throw e;
      const existing = await ctx.fresh(() => ctx.models.Note.find(noteId));
      return { created: false, note: encodeValue(existing) };
    }
  },
});

/** Read a note. Returns an encoded row for Note.fromRemote, or null. */
export const getNote = defineProcedure({
  name: "note.get",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, { noteId }) {
    const note = await ctx.models.Note.find(noteId);
    return note.exists() ? encodeValue(note) : null;
  },
});

/** Delete a note. Idempotent: deleting a missing note reports false. */
export const deleteNote = defineProcedure({
  name: "note.delete",
  version: 1,
  scope: "app",
  replay: "idempotent",
  async run(ctx, { noteId }) {
    const note = await ctx.models.Note.find(noteId);
    if (!note.exists()) return { deleted: false };
    await ctx.models.Note.delete(noteId);
    return { deleted: true, at: ctx.now() };
  },
});

export const procedures = new ProcedureRegistry([createNote, getNote, deleteNote]);
