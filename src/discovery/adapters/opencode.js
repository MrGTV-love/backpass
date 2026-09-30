import fs from "node:fs";
import path from "node:path";

import { emptyInteractionSignals, interactionSignals } from "../../interaction.js";
import { SELF_SESSION_SENTINEL } from "../../sentinel.js";
import { home, listDirs, readJsonFile, statOrNull } from "./shared.js";
import { openReadOnly, safeJsonParse } from "./sqlite.js";

/**
 * opencode: ~/.local/share/opencode/opencode.db (sqlite), in one of two layouts.
 *
 * OpenCode 1.x keeps messages and their parts in two tables:
 *
 *   project(id, worktree)                  - one row per project root
 *   session(id, project_id, parent_id, directory, title, time_created, time_updated)
 *   message(id, session_id, data)          - data is JSON: {role, modelID, time, ...}
 *   part(id, message_id, session_id, data) - data is JSON: {type: text|tool|reasoning|...}
 *
 * OpenCode 2.x keeps a session's history as one typed row per message:
 *
 *   session_v2(id, project_id, parent_id, directory, title, time_created, time_updated)
 *   session_message(id, session_id, type, seq, time_created, time_updated, data)
 *
 * `session_v2.time_updated` does not move as messages arrive, so listing must also
 * consider message activity. Upgrading copies every 1.x session into `session_v2`
 * under the same id and leaves the 1.x tables behind, so a session found in both is
 * read from `session_v2`, where it continues. (1.x also creates an empty
 * `session_message` table ahead of that upgrade.) A store with neither session table
 * has drifted and is reported, never read as empty.
 *
 * Listing returns each session's directory, deleted worktrees included, for the
 * caller's shared association tiers. Older opencode versions used file storage under
 * `storage/`; that layout is handled as a fallback so long-lived machines still yield
 * transcripts.
 *
 * acpx drives opencode, so backpass's own analysis and synthesis calls land in this
 * store under the repo's cwd. There is no transcript file for `../self.js` to read, so
 * the listing reads the text of each session's first user message and the row is marked
 * `self` when it opens with the sentinel every backpass prompt starts with. Self
 * ancestry includes parents outside the listing cutoff, so delegated work cannot
 * re-enter the corpus when its backpass-originated parent ages out of the discovery
 * window. Unused probes, including 2.x sessions with only harness notices, are not listed.
 *
 * Besides the default store, a run reads each store named in the personal
 * `discovery.opencodeStores` (an OpenCode data directory or a database file) - a copy of
 * the store another OS's OpenCode app writes, say. That list lives in config rather than
 * in `XDG_DATA_HOME` or `OPENCODE_DB` because acpx passes backpass's environment to the
 * OpenCode it runs for analysis, which must keep its own store and login. Each row names
 * the database it came from, which is where it is read again. A store reached twice is
 * read once, and a session id already listed from an earlier store is skipped, so a
 * copied session never counts twice. A configured store that is missing or unreadable is
 * named and skipped; the default store's failure is the harness's, as before.
 */

export const name = "opencode";
export const sqliteBacked = true;

export function storeRoot() {
  return home(".local", "share", "opencode");
}

export function dbPath() {
  return path.join(storeRoot(), "opencode.db");
}

/**
 * The databases a run reads: the default store first, then each configured store. An
 * entry naming a file (or a `.db` path) is that database; any other entry is an OpenCode
 * data directory holding `opencode.db`.
 *
 * @param {{ discovery?: { opencodeStores?: string[] } } | null | undefined} config
 * @returns {string[]}
 */
export function storeFiles(config) {
  const configured = (config?.discovery?.opencodeStores || []).map((entry) =>
    statOrNull(entry)?.isFile() || entry.endsWith(".db") ? entry : path.join(entry, "opencode.db"),
  );
  const seen = new Set();
  const out = [];
  for (const file of [dbPath(), ...configured]) {
    let identity = path.resolve(file);
    try {
      identity = fs.realpathSync(file);
    } catch {
      // A store that is not there yet is compared by its spelling.
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(file);
  }
  return out;
}

function tableHasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function hasTables(db, ...names) {
  const check = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  return names.every((name) => check.get(name) !== undefined);
}

/** Pick the first user message before its text, so attachment-only openings stay genuine. */
const V1_FIRST_USER_PART = `(SELECT pt.data
     FROM part pt
    WHERE pt.message_id = (
      SELECT m.id FROM message m
       WHERE m.session_id = s.id
         AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'user'
       ORDER BY m.time_created, m.id
       LIMIT 1)
      AND CASE WHEN json_valid(pt.data) THEN json_extract(pt.data, '$.type') END = 'text'
    ORDER BY pt.id
    LIMIT 1)`;

/** The text of a 2.x session's first user message, skipping malformed JSON. */
const V2_FIRST_USER_TEXT = `(SELECT CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.text') END
     FROM session_message m
    WHERE m.session_id = s.id AND m.type = 'user'
    ORDER BY m.seq
    LIMIT 1)`;

/**
 * Discovery queries each layout and store for sessions inside the cutoff, then reads
 * any missing ancestors for self detection. The caller applies shared association tiers.
 *
 * @param {{ cutoffMs?: number | null, config?: object, warn?: (message: string) => void }} [options]
 */
export async function discover({ cutoffMs = null, config = null, warn = () => {} } = {}) {
  const [primary, ...configured] = storeFiles(config);
  const listed = new Set();
  const out = [];
  const add = (rows) => {
    for (const row of rows) {
      if (listed.has(row.id)) continue;
      listed.add(row.id);
      out.push(row);
    }
  };

  add(await discoverStore(primary, cutoffMs, { legacyFallback: true }));
  for (const file of configured) {
    if (!fs.existsSync(file)) {
      warn(`configured store ${file} not found - skipped`);
      continue;
    }
    try {
      add(await discoverStore(file, cutoffMs));
    } catch (err) {
      warn(`configured store ${file} unreadable (${err.message}) - skipped`);
    }
  }
  return out;
}

async function discoverStore(file, cutoffMs, { legacyFallback = false } = {}) {
  const db = await openReadOnly(file);
  if (!db) return legacyFallback ? legacyDiscover({ cutoffMs }) : [];

  try {
    const v2 = hasTables(db, "session_v2", "session_message");
    const v1 = hasTables(db, "session");
    if (!v2 && !v1) throw new Error("no session or session_v2 table (unrecognised opencode store)");
    const list = (options) => [
      ...(v2 ? listV2(db, options) : []),
      ...(v1 ? listV1(db, { ...options, skipV2: v2 }) : []),
    ];
    const sessions = list({ cutoffMs });
    // Only ancestors of candidates need out-of-window reads. Visit each once,
    // including empty intermediates; missing parents and cycles terminate too.
    const visited = new Set(sessions.map((session) => session.id));
    for (const session of sessions) {
      if (!session.parentId || visited.has(session.parentId)) continue;
      visited.add(session.parentId);
      sessions.push(...list({ sessionId: session.parentId }));
    }
    const self = selfSessions(sessions);
    return sessions
      .filter((session) => session.recorded && (cutoffMs == null || session.mtimeMs >= cutoffMs))
      .map((session) => sessionRow(session, file, self.has(session.id)));
  } finally {
    db.close();
  }
}

/**
 * Every session one of backpass's own prompts opened, plus every session delegated from
 * one - a subagent's task prompt carries no sentinel - however deep, and whether or not
 * the parent is still inside the listing window.
 */
function selfSessions(sessions) {
  const children = new Map();
  const self = new Set();
  for (const session of sessions) {
    if (opensWithSentinel(session.firstUserText)) self.add(session.id);
    if (session.parentId) {
      if (!children.has(session.parentId)) children.set(session.parentId, []);
      children.get(session.parentId).push(session.id);
    }
  }
  // Set iteration visits new additions too; each descendant is propagated once,
  // including empty intermediates, and cycles terminate without recursive queries.
  for (const id of self) {
    for (const child of children.get(id) || []) self.add(child);
  }
  return self;
}

function opensWithSentinel(text) {
  return typeof text === "string" && text.startsWith(SELF_SESSION_SENTINEL);
}

function listV1(db, { skipV2, cutoffMs = null, sessionId = null }) {
  const parentSelect = tableHasColumn(db, "session", "parent_id") ? ", s.parent_id AS parent_id" : "";
  const firstUserSelect = hasTables(db, "message", "part") ? `, ${V1_FIRST_USER_PART} AS first_user_part` : "";
  // Unused probes have no messages; attachment conversations need not have user text.
  const recordedSelect = hasTables(db, "message") ? "EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)" : "1";
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.directory AS directory, s.title AS title,
              s.time_created AS time_created, s.time_updated AS time_updated,
              p.worktree AS worktree, ${recordedSelect} AS recorded${parentSelect}${firstUserSelect}
         FROM session s
         LEFT JOIN project p ON p.id = s.project_id
        WHERE ${skipV2 ? "s.id NOT IN (SELECT id FROM session_v2) AND" : ""}
          ${sessionId != null ? "s.id = ?" : cutoffMs != null ? "COALESCE(NULLIF(s.time_updated, 0), s.time_created, 0) >= ?" : "1"}`,
    )
    .all(...(sessionId != null ? [sessionId] : cutoffMs != null ? [cutoffMs] : []));
  return rows.map((row) => ({
    ...row,
    layout: "v1",
    parentId: row.parent_id || null,
    mtimeMs: Number(row.time_updated) || Number(row.time_created) || 0,
    firstUserText: safeJsonParse(row.first_user_part)?.text,
  }));
}

function listV2(db, { cutoffMs = null, sessionId = null }) {
  // Message timestamps, not just session timestamps, admit resumed sessions.
  // Find recent message activity once rather than taking a per-session MAX over
  // the entire history before deciding which sessions need metadata and text.
  const filter =
    sessionId != null
      ? "s.id = $sessionId"
      : cutoffMs != null
        ? `(s.time_updated >= $cutoff OR s.time_created >= $cutoff OR s.id IN
          (SELECT session_id FROM session_message WHERE time_updated >= $cutoff))`
        : "1";
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.directory AS directory, s.title AS title, s.parent_id AS parent_id,
              s.time_created AS time_created, s.time_updated AS time_updated,
              p.worktree AS worktree,
              EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = s.id
                      AND m.type IN ('user', 'assistant', 'shell', 'skill')) AS recorded,
              (SELECT MAX(m.time_updated) FROM session_message m WHERE m.session_id = s.id) AS message_time,
              ${V2_FIRST_USER_TEXT} AS first_user_text
         FROM session_v2 s
         LEFT JOIN project p ON p.id = s.project_id
        WHERE ${filter}`,
    )
    .all(...(sessionId != null ? [{ sessionId }] : cutoffMs != null ? [{ cutoff: cutoffMs }] : []));
  return rows.map((row) => ({
    ...row,
    layout: "v2",
    parentId: row.parent_id || null,
    mtimeMs: Math.max(Number(row.time_updated) || 0, Number(row.message_time) || 0) || Number(row.time_created) || 0,
    firstUserText: row.first_user_text,
  }));
}

function sessionRow(session, file, self) {
  return {
    key: `opencode:${session.id}`,
    id: session.id,
    path: file,
    cwd: session.directory,
    gitRoot: session.worktree || null,
    gitBranch: null,
    remotes: [],
    title: session.title || null,
    startedAt: Number(session.time_created) || null,
    mtimeMs: session.mtimeMs,
    bytes: 0,
    model: null,
    extra: { sessionId: session.id, layout: session.layout },
    interactionSignals: session.parentId
      ? interactionSignals({ parentId: session.parentId })
      : emptyInteractionSignals(),
    self,
  };
}

/** A session is read from the database discovery listed it in. */
export async function read(ref) {
  if (ref.extra?.legacy) return legacyRead();
  const file = ref.path || dbPath();
  const db = await openReadOnly(file);
  if (!db) throw new Error(`opencode store ${file} not found`);

  try {
    const sessionId = ref.extra?.sessionId || ref.id;
    return layoutOf(db, ref, sessionId) === "v2" ? readV2(db, sessionId) : readV1(db, sessionId);
  } finally {
    db.close();
  }
}

/** Discovery records the layout; a ref from before it did is looked up the same way. */
function layoutOf(db, ref, sessionId) {
  if (ref.extra?.layout) return ref.extra.layout;
  if (!hasTables(db, "session_v2", "session_message")) return "v1";
  return db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId) ? "v2" : "v1";
}

function readV1(db, sessionId) {
  const messages = db
    .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId);
  const parts = db
    .prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId);

  const partsByMessage = new Map();
  for (const part of parts) {
    if (!partsByMessage.has(part.message_id)) partsByMessage.set(part.message_id, []);
    partsByMessage.get(part.message_id).push(safeJsonParse(part.data));
  }

  const events = [];
  let model = null;

  for (const message of messages) {
    const data = safeJsonParse(message.data) || {};
    const role = data.role === "user" ? "user" : "assistant";
    model = model || data.modelID || data.model?.modelID || null;

    const texts = [];
    let hasFiles = false;
    for (const part of partsByMessage.get(message.id) || []) {
      if (!part) continue;
      if (part.type === "text" && part.text) {
        texts.push(part.text);
      } else if (part.type === "file") {
        hasFiles = true;
      } else if (part.type === "tool") {
        events.push({
          kind: "tool",
          name: part.tool || part.name,
          input: part.state?.input ?? part.input,
          result: part.state?.output ?? part.output,
          status: part.state?.status,
        });
      }
      // reasoning / step-start / step-finish / patch parts carry no loss signal.
    }
    if (role === "user" && hasFiles && !texts.join("\n").trim()) {
      texts.length = 0;
      texts.push("[Attachment-only user message]");
    }
    if (texts.length) events.push({ kind: "message", role, text: texts.join("\n") });
  }

  return { events, model };
}

/**
 * A 2.x session, message by message in `seq` order:
 *
 *   user        the prompt as sent
 *   assistant   text and tool calls in the order the model produced them; reasoning is
 *               dropped. A tool's result is its text content, or its error message.
 *   shell       a command the person ran from the prompt, as a `shell` tool call
 *   skill       a skill the person activated, as a `skill` call without its body
 *   synthetic   text the harness injected (instruction files, "continue" notices,
 *               background-job notifications) - never a user turn. The one kind that
 *               carries session signal is the completion of a background subagent or
 *               shell, which becomes the result of the call that started the job.
 *
 * `system` notices, `compaction` summaries (a model's summary of turns still stored
 * above them), `idle` markers and agent/model/location switches carry no loss signal.
 */
function readV2(db, sessionId) {
  const rows = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq").all(sessionId);
  const events = [];
  const backgroundJobs = new Map();
  let model = null;

  for (const row of rows) {
    const data = safeJsonParse(row.data);
    if (!data || typeof data !== "object") continue;
    switch (row.type) {
      case "user":
        if (typeof data.text === "string" && data.text.trim()) {
          events.push({ kind: "message", role: "user", text: data.text });
        } else if (Array.isArray(data.files) && data.files.length) {
          events.push({ kind: "message", role: "user", text: "[Attachment-only user message]" });
        }
        break;
      case "assistant": {
        model = model || data.model?.id || null;
        const texts = [];
        const flushText = () => {
          if (texts.length) events.push({ kind: "message", role: "assistant", text: texts.join("\n") });
          texts.length = 0;
        };
        for (const item of Array.isArray(data.content) ? data.content : []) {
          if (item?.type === "text" && typeof item.text === "string" && item.text) {
            texts.push(item.text);
          } else if (item?.type === "tool") {
            flushText();
            const call = toolEvent(item);
            events.push(call);
            const job = item.state?.metadata?.sessionID ?? item.state?.metadata?.shellID;
            if (typeof job === "string") backgroundJobs.set(job, call);
          }
        }
        flushText();
        break;
      }
      case "shell":
        events.push({
          kind: "tool",
          name: "shell",
          input: { command: data.command },
          result: data.output?.output,
          status: shellStatus(data),
        });
        break;
      case "skill":
        events.push({ kind: "tool", name: "skill", input: { name: data.name }, status: "completed" });
        break;
      case "synthetic": {
        const job = data.metadata?.childID ?? data.metadata?.shellID;
        const call = typeof job === "string" ? backgroundJobs.get(job) : null;
        if (call && typeof data.text === "string") {
          call.result = data.text;
          call.status = data.metadata?.state || call.status;
        }
        break;
      }
      default:
        break;
    }
  }

  return { events, model };
}

function toolEvent(item) {
  const state = item.state && typeof item.state === "object" ? item.state : {};
  const content = (Array.isArray(state.content) ? state.content : [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
  const error = state.status === "error" ? state.error?.message : undefined;
  const result = [error, content].filter(Boolean).join("\n");
  return { kind: "tool", name: item.name, input: state.input, result: result || undefined, status: state.status };
}

function shellStatus(shell) {
  if (shell.status !== "exited") return shell.status;
  return (shell.exit ?? 0) === 0 ? "completed" : "error";
}

/** Pre-sqlite opencode kept JSON files under storage/. Best-effort, never fatal. */
function legacyDiscover({ cutoffMs }) {
  const projectsDir = path.join(storeRoot(), "storage", "project");
  const out = [];
  for (const dir of listDirs(projectsDir)) {
    const meta = readJsonFile(path.join(dir, "project.json"));
    const stat = statOrNull(dir);
    if (!meta?.worktree || !stat) continue;
    if (cutoffMs && stat.mtimeMs < cutoffMs) continue;
    out.push({
      key: `opencode-legacy:${dir}`,
      id: path.basename(dir),
      path: dir,
      cwd: meta.worktree,
      gitRoot: null,
      gitBranch: null,
      remotes: [],
      title: null,
      startedAt: stat.birthtimeMs || stat.mtimeMs,
      mtimeMs: stat.mtimeMs,
      bytes: 0,
      model: null,
      extra: { legacy: true },
      interactionSignals: emptyInteractionSignals(),
      self: false,
    });
  }
  return out;
}

function legacyRead() {
  // The legacy layout stores messages per project in a shape that changed across
  // releases; rather than guess, report an empty trace so the run stays fail-soft.
  return { events: [], model: null };
}
