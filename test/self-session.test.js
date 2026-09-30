import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

/**
 * backpass's own analysis/synthesis calls are filed by each harness under this repo's
 * cwd, so discovery would pick them up as tier-1 sessions. These tests drive real
 * discovery over a fake HOME holding the acpx-backed stores (pi, codex, claude, and
 * opencode's SQLite store), each with one genuine session and one session whose first
 * user message is an actual prompt backpass rendered, and assert only the genuine ones
 * come back.
 */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-self-home-"));
process.env.HOME = fakeHome;

const { discoverTranscripts } = await import("../src/discovery/index.js");
const { renderPrompt, SELF_SESSION_SENTINEL } = await import("../src/prompts.js");
const { isSelfSession } = await import("../src/discovery/self.js");
const { loadConfig } = await import("../src/config.js");
const { transcriptIdentity } = await import("../src/transcript.js");

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-self-repo-"));
const realRoot = fs.realpathSync(repoRoot);
const repo = { name: "demo", root: realRoot, worktrees: [realRoot], remotes: [] };

const analysisPrompt = renderPrompt("analysis", {
  MEMORY_PATH: "AGENTS.md",
  INSTRUCTION_INDEX: "1. Run pnpm check before pushing.",
  TRACE: "user: fix the flaky test\nagent: ran the suite",
});
const synthesisPrompt = renderPrompt("synthesis", { REPO_NAME: "demo", MEMORY_PATH: "AGENTS.md" });

function jsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function writePiSession(dir, id, firstUserText) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-08-20T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(
    file,
    jsonl([
      { type: "session", version: 3, id, timestamp: "2026-08-20T10:00:00.000Z", cwd: realRoot },
      { type: "model_change", id: "m1", parentId: null, provider: "openai-codex", modelId: "gpt-5.6-sol" },
      {
        type: "message",
        id: "e1",
        parentId: "m1",
        message: { role: "user", content: [{ type: "text", text: firstUserText }] },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
      },
    ]),
  );
  return file;
}

function writeCodexSession(dir, id, firstUserText) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-20T10-00-00-${id}.jsonl`);
  fs.writeFileSync(
    file,
    jsonl([
      {
        timestamp: "2026-08-20T10:00:00.000Z",
        type: "session_meta",
        payload: { session_id: id, cwd: realRoot, source: "exec", git: { branch: "main" } },
      },
      { timestamp: "2026-08-20T10:00:01.000Z", type: "turn_context", payload: { cwd: realRoot, model: "gpt-5.2" } },
      {
        timestamp: "2026-08-20T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>ignore me" }],
        },
      },
      {
        timestamp: "2026-08-20T10:00:03.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: firstUserText }] },
      },
      {
        timestamp: "2026-08-20T10:00:04.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "{}" }] },
      },
    ]),
  );
  return file;
}

function writeClaudeSession(dir, id, firstUserText) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    jsonl([
      { type: "mode", mode: "normal", sessionId: id },
      {
        parentUuid: null,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: firstUserText },
        uuid: "u1",
        timestamp: "2026-08-20T10:00:00.000Z",
        cwd: realRoot,
        gitBranch: "main",
        sessionId: id,
      },
      {
        parentUuid: "u1",
        isSidechain: false,
        type: "assistant",
        message: { model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "{}" }] },
        uuid: "a1",
        timestamp: "2026-08-20T10:00:05.000Z",
        cwd: realRoot,
        sessionId: id,
      },
    ]),
  );
  return file;
}

const piDir = path.join(fakeHome, ".pi", "agent", "sessions", `-${realRoot.replace(/\//g, "-")}--`);
const codexDir = path.join(fakeHome, ".codex", "sessions", "2026", "08", "20");
const claudeDir = path.join(fakeHome, ".claude", "projects", realRoot.replace(/[/.]/g, "-"));

/**
 * opencode keeps every session in one SQLite store. The self session has the shape an
 * `acpx opencode` call really records: a user message whose first text part is the
 * rendered prompt. The store is small enough that its file head holds every session's
 * text, so a genuine session must survive a self session sharing its database.
 */
function writeOpencodeStore(sessions) {
  const store = path.join(fakeHome, ".local", "share", "opencode");
  fs.mkdirSync(store, { recursive: true });
  const db = new DatabaseSync(path.join(store, "opencode.db"));
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("p1", realRoot);
  writeOpencodeSessions(db, sessions);
  db.close();
}

function writeOpencodeSessions(db, sessions) {
  for (const { id, firstUserText, parentId = null, at = Date.parse("2026-08-20T10:00:00.000Z") } of sessions) {
    db.prepare(
      "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, 'p1', ?, ?, ?, ?, ?)",
    ).run(id, parentId, realRoot, id, at, at);
    // An agent probe (`acpx opencode sessions new`) leaves a session with no messages at all.
    if (firstUserText === null) continue;
    const turns = [
      { role: "user", parts: [{ type: "text", text: firstUserText }] },
      { role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "{}" }] },
    ];
    turns.forEach((turn, index) => {
      const messageId = `msg_${id}_${index}`;
      db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
        messageId,
        id,
        at + index,
        JSON.stringify({ role: turn.role, time: { created: at + index } }),
      );
      turn.parts.forEach((part, partIndex) => {
        db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
          `prt_${id}_${index}_${partIndex}`,
          messageId,
          id,
          at + index,
          JSON.stringify(part),
        );
      });
    });
  }
}

writePiSession(piDir, "pi-real", "Add the changelog entry.");
writePiSession(piDir, "pi-self", analysisPrompt);
writeCodexSession(codexDir, "codex-real", "Fix the flaky test.");
writeCodexSession(codexDir, "codex-self", synthesisPrompt);
writeClaudeSession(claudeDir, "claude-real", "Open a PR for the parser fix.");
writeClaudeSession(claudeDir, "claude-self", analysisPrompt);
writeOpencodeStore([
  { id: "ses_opencode_real", firstUserText: "Why does the release job skip the tag?" },
  { id: "ses_opencode_self", firstUserText: synthesisPrompt },
  { id: "ses_opencode_probe", firstUserText: null },
]);
// A genuine session that merely *talks about* the sentinel is not a self-session.
writePiSession(piDir, "pi-mentions", `Why does backpass prepend ${SELF_SESSION_SENTINEL} to its prompts?`);

function configFor() {
  const config = loadConfig(realRoot, {
    discovery: { harnesses: ["pi", "codex", "claude", "opencode"], since: "all" },
  });
  const cache = { version: 1, entries: {} };
  config.state = { readScanCache: () => cache, writeScanCache: () => {} };
  return config;
}

test("every prompt backpass sends begins with the self-session sentinel", () => {
  assert.ok(analysisPrompt.startsWith(`${SELF_SESSION_SENTINEL}\n`));
  assert.ok(synthesisPrompt.startsWith(`${SELF_SESSION_SENTINEL}\n`));
});

test("discovery excludes backpass-originated sessions from every acpx-backed harness", async () => {
  const { transcripts, perHarness } = await discoverTranscripts({ repo, config: configFor() });

  const ids = transcripts.map((t) => t.nativeId).sort();
  assert.deepEqual(ids, ["claude-real", "codex-real", "pi-mentions", "pi-real", "ses_opencode_real"]);
  assert.equal(perHarness.pi.self, 1);
  assert.equal(perHarness.codex.self, 1);
  assert.equal(perHarness.claude.self, 1);
  assert.equal(perHarness.opencode.self, 1);
  assert.equal(perHarness.opencode.scanned, 2, "a probe's empty session is not listed at all");
  assert.equal(perHarness.pi.matched, 2);
  assert.equal(perHarness.codex.matched, 1);
  assert.equal(perHarness.claude.matched, 1);
  assert.equal(perHarness.opencode.matched, 1);
  for (const t of transcripts) {
    assert.equal(t.association.tier, 1);
    assert.equal(t.identity, transcriptIdentity(t));
  }
  assert.equal(new Set(transcripts.map((t) => t.identity)).size, transcripts.length);
});

test("the exclusion survives the scan cache (a cached descriptor is still checked)", async () => {
  const config = configFor();
  await discoverTranscripts({ repo, config });
  const second = await discoverTranscripts({ repo, config });
  assert.deepEqual(second.transcripts.map((t) => t.nativeId).sort(), [
    "claude-real",
    "codex-real",
    "pi-mentions",
    "pi-real",
    "ses_opencode_real",
  ]);
  assert.equal(second.perHarness.pi.cached, 3);
  assert.equal(second.perHarness.pi.self, 1);
});

test("OpenCode attachment openings followed by prompt quotes survive CLI scans and shipped probes", async (t) => {
  const { buildProbeProgram } = await import("../src/discovery/remote/bundle.js");
  const db = new DatabaseSync(path.join(fakeHome, ".local", "share", "opencode", "opencode.db"));
  const id = "ses_opencode_attachment";
  const reply = "The screenshot shows a missing release tag. Create the tag before publishing.";
  try {
    writeOpencodeSessions(db, [
      { id, firstUserText: "placeholder" },
      { id: `${id}_child`, parentId: id, firstUserText: "Inspect the release" },
    ]);
    const update = db.prepare("UPDATE part SET data = ? WHERE id = ?");
    update.run(
      JSON.stringify({
        type: "file",
        mime: "image/png",
        filename: "failure.png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      }),
      `prt_${id}_0_0`,
    );
    update.run(JSON.stringify({ type: "text", text: reply }), `prt_${id}_1_1`);
    // A later user turn quotes a backpass prompt; it is not the conversation's opening.
    const quotedPrompt = `${synthesisPrompt}\nWhy was this prompt sent?`;
    const at = Date.parse("2026-08-20T10:00:02.000Z");
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      `msg_${id}_2`,
      id,
      at,
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      `prt_${id}_2_0`,
      `msg_${id}_2`,
      id,
      at,
      JSON.stringify({ type: "text", text: quotedPrompt }),
    );
    const initialized = spawnSync("git", ["init", "-q", realRoot], { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);

    await t.test("CLI retains the conversation but not the empty probe or self session", () => {
      for (let scan = 0; scan < 2; scan++) {
        const result = spawnSync(
          process.execPath,
          [path.resolve("bin/backpass.js"), "scan", "--harness", "opencode", "--since", "all", "--strict", "--json"],
          { cwd: realRoot, encoding: "utf8", timeout: 30000 },
        );
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.transcripts.map((entry) => entry.nativeId).sort(), [
          id,
          `${id}_child`,
          "ses_opencode_real",
        ]);
        assert.equal(output.perHarness.opencode.scanned, 4);
        assert.equal(output.perHarness.opencode.self, 1);
      }
    });

    await t.test("shipped probe retains the conversation but not the empty probe or self session", () => {
      const result = spawnSync(process.execPath, ["-"], {
        cwd: realRoot,
        encoding: "utf8",
        timeout: 30000,
        input: buildProbeProgram({ op: "discover", harnesses: ["opencode"], cutoffMs: null }),
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.transcripts.map((entry) => entry.id).sort(), [id, `${id}_child`, "ses_opencode_real"]);
      assert.equal(output.harnesses.opencode.scanned, 4);
      assert.equal(output.harnesses.opencode.self, 1);
    });

    const { read } = await import("../src/discovery/adapters/opencode.js");
    assert.deepEqual((await read({ id })).events, [
      { kind: "message", role: "user", text: "[Attachment-only user message]" },
      { kind: "message", role: "assistant", text: reply },
      { kind: "message", role: "user", text: quotedPrompt },
    ]);
  } finally {
    for (const sessionId of [id, `${id}_child`]) {
      db.prepare("DELETE FROM part WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM message WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
    }
    db.close();
  }
});

test("malformed OpenCode rows do not suppress valid sessions locally or remotely", async (t) => {
  const { discover } = await import("../src/discovery/remote/probe.js");
  const db = new DatabaseSync(path.join(fakeHome, ".local", "share", "opencode", "opencode.db"));
  const at = Date.parse("2026-08-20T09:00:00.000Z");
  try {
    db.prepare(
      "INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("ses_other", "other", path.join(fakeHome, "other-repo"), "Other repository", at, at);
    for (const column of ["message", "part"]) {
      for (const sessionId of ["ses_opencode_real", "ses_opencode_self", "ses_other"]) {
        await t.test(`${column} corruption in ${sessionId}`, async () => {
          // Recorded but unreadable messages are not unused probes. Remote discovery
          // lists them; local association still excludes the unrelated repository.
          const remoteIds = sessionId === "ses_other" ? ["ses_opencode_real", "ses_other"] : ["ses_opencode_real"];
          const localIds = ["ses_opencode_real"];
          // A valid first user message with unreadable content cannot be replaced by
          // a later sentinel-bearing message when deciding whether the session is self.
          const selfCount = column === "part" && sessionId === "ses_opencode_self" ? 0 : 1;
          if (!selfCount) {
            remoteIds.push("ses_opencode_self");
            localIds.push("ses_opencode_self");
          }
          db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
            "msg_corrupt",
            sessionId,
            at,
            column === "message" ? "{broken" : JSON.stringify({ role: "user" }),
          );
          db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
            "prt_corrupt",
            "msg_corrupt",
            sessionId,
            at,
            column === "part" ? "{broken" : JSON.stringify({ type: "text", text: "Unreadable message" }),
          );
          try {
            const config = configFor();
            for (let scan = 0; scan < 2; scan++) {
              const local = await discoverTranscripts({ repo, config, harnesses: ["opencode"] });
              assert.equal(local.perHarness.opencode.error, null);
              assert.deepEqual(local.transcripts.map((entry) => entry.nativeId).sort(), localIds);
              assert.equal(local.perHarness.opencode.self, selfCount);
              assert.equal(local.perHarness.opencode.scanned, remoteIds.length + selfCount);
            }
            const remote = await discover({ harnesses: ["opencode"], cutoffMs: at });
            assert.equal(remote.harnesses.opencode.error, null);
            assert.deepEqual(remote.transcripts.map((entry) => entry.id).sort(), remoteIds);
            assert.equal(remote.harnesses.opencode.self, selfCount);
            assert.equal(remote.harnesses.opencode.scanned, remoteIds.length + selfCount);
          } finally {
            db.prepare("DELETE FROM part WHERE id = ?").run("prt_corrupt");
            db.prepare("DELETE FROM message WHERE id = ?").run("msg_corrupt");
          }
        });
      }
    }
  } finally {
    db.prepare("DELETE FROM session WHERE id = ?").run("ses_other");
    db.close();
  }
});

test("OpenCode self ancestry excludes descendants locally and remotely regardless of cutoff", async () => {
  const { discover } = await import("../src/discovery/remote/probe.js");
  const db = new DatabaseSync(path.join(fakeHome, ".local", "share", "opencode", "opencode.db"));
  const old = Date.parse("2026-08-19T10:00:00.000Z");
  const now = Date.parse("2026-08-21T00:00:00.000Z");
  const sessions = [
    { id: "self_grandchild", parentId: "self_child", firstUserText: "Inspect the parser" },
    { id: "self_child", parentId: "self_old", firstUserText: "Delegate an exploration" },
    { id: "self_via_empty", parentId: "self_empty", firstUserText: "Read the tests" },
    { id: "self_empty", parentId: "self_old", firstUserText: null },
    { id: "self_old", firstUserText: analysisPrompt, at: old },
    { id: "real_child", parentId: "real_old", firstUserText: "Check the release" },
    { id: "real_grandchild", parentId: "real_child", firstUserText: "Check the tag" },
    { id: "real_old", firstUserText: "Fix the release", at: old },
    { id: "self_under_real", parentId: "real_old", firstUserText: synthesisPrompt },
    { id: "self_nested", parentId: "self_under_real", firstUserText: "Read the configuration" },
    { id: "orphan", parentId: "missing", firstUserText: "Continue the task" },
    { id: "cycle_a", parentId: "cycle_b", firstUserText: "Check A" },
    { id: "cycle_b", parentId: "cycle_a", firstUserText: "Check B" },
  ];
  try {
    writeOpencodeSessions(db, sessions);
    for (const since of ["all", "1d"]) {
      const expected = ["cycle_a", "cycle_b", "orphan", "real_child", "real_grandchild", "ses_opencode_real"];
      if (since === "all") expected.push("real_old");
      expected.sort();
      const config = configFor();
      config.discovery.since = since;
      for (let scan = 0; scan < 2; scan++) {
        const local = await discoverTranscripts({ repo, config, now, harnesses: ["opencode"] });
        assert.equal(local.perHarness.opencode.error, null);
        assert.deepEqual(local.transcripts.map((entry) => entry.nativeId).sort(), expected);
        assert.equal(local.perHarness.opencode.self, since === "all" ? 7 : 6);
      }
      const remote = await discover({
        harnesses: ["opencode"],
        cutoffMs: since === "all" ? null : now - 24 * 60 * 60 * 1000,
      });
      assert.equal(remote.harnesses.opencode.error, null);
      assert.deepEqual(remote.transcripts.map((entry) => entry.id).sort(), expected);
      assert.equal(remote.harnesses.opencode.self, since === "all" ? 7 : 6);
    }
  } finally {
    for (const { id } of sessions) {
      db.prepare("DELETE FROM part WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM message WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM session WHERE id = ?").run(id);
    }
    db.close();
  }
});

test("OpenCode discovery does not reread shared ancestors for each child", async (t) => {
  const { discover } = await import("../src/discovery/adapters/opencode.js");
  const db = new DatabaseSync(path.join(fakeHome, ".local", "share", "opencode", "opencode.db"));
  const sessions = [
    { id: "shared_real", parentId: "ses_opencode_real", firstUserText: "Explore the release" },
    { id: "shared_self", parentId: "ses_opencode_self", firstUserText: "Explore the parser" },
  ];
  let reads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (...args) {
    const statement = prepare.apply(this, args);
    const all = statement.all;
    t.mock.method(statement, "all", function (...params) {
      reads++;
      return all.apply(this, params);
    });
    return statement;
  });
  try {
    writeOpencodeSessions(db, sessions);
    await discover({ cutoffMs: null });
    const initialReads = reads;
    const children = Array.from({ length: 32 }, (_, index) => ({
      id: `shared_child_${index}`,
      parentId: index % 2 ? "shared_self" : "shared_real",
      firstUserText: "Inspect the tests",
    }));
    sessions.push(...children);
    writeOpencodeSessions(db, children);
    reads = 0;
    const rows = await discover({ cutoffMs: null });
    assert.equal(reads, initialReads, "adding siblings must not add ancestor database reads");
    for (const child of children) {
      assert.equal(rows.find((row) => row.id === child.id)?.self, child.parentId === "shared_self");
    }
  } finally {
    for (const { id } of sessions) {
      db.prepare("DELETE FROM part WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM message WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM session WHERE id = ?").run(id);
    }
    t.mock.restoreAll();
    db.close();
  }
});

test("isSelfSession is fail-soft on a missing or directory path", () => {
  assert.equal(isSelfSession({ path: path.join(fakeHome, "nope.jsonl") }), false);
  assert.equal(isSelfSession({ path: fakeHome }), false);
  assert.equal(isSelfSession({ path: null }), false);
});
