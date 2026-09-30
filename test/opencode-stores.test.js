import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as opencode from "../src/discovery/adapters/opencode.js";
import { loadConfig } from "../src/config.js";
import { discoverTranscripts } from "../src/discovery/index.js";
import { setLoggerSink, UserError } from "../src/logger.js";
import { readOpencodeFixture, withOpencodeHome, writeOpencodeStore } from "./helpers/opencode.js";

/**
 * `discovery.opencodeStores`: more OpenCode stores to read beside the default one, named
 * in personal config (never the environment, which the OpenCode backpass runs for
 * analysis inherits). Each store's sessions are read from that store; a store reached
 * twice, or a session copied into two stores, is read once.
 */

const V1 = readOpencodeFixture("opencode-v1-store.json");
const V2 = readOpencodeFixture("opencode-v2-store.json");
const V1_SESSION = "ses_f16e2d036ffeZd4lFcWRZCBMYV";
const V2_PARENT = "ses_f17ca477affeM7vJpYuwLTunDK";

function withConfigHome(globalConfig, fn) {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-stores-xdg-"));
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    if (globalConfig) {
      fs.mkdirSync(path.join(configHome, "backpass"), { recursive: true });
      fs.writeFileSync(path.join(configHome, "backpass", "config.json"), JSON.stringify(globalConfig));
    }
    process.env.XDG_CONFIG_HOME = configHome;
    return fn();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(configHome, { recursive: true, force: true });
  }
}

function tempRepo(t, repoConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-stores-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (repoConfig) fs.writeFileSync(path.join(root, ".backpassrc.json"), JSON.stringify(repoConfig));
  return fs.realpathSync(root);
}

async function captureWarnings(fn) {
  const lines = [];
  setLoggerSink((line) => lines.push(line));
  try {
    return { result: await fn(), lines };
  } finally {
    setLoggerSink(null);
  }
}

test("config fixtures restore the environment and remove directories on success and failure", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    for (const value of [undefined, "", "/original/config"]) {
      for (const fail of [false, true]) {
        if (value === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = value;
        let configHome;
        const failure = new Error("fixture callback failed");
        const run = () =>
          withConfigHome({}, () => {
            configHome = process.env.XDG_CONFIG_HOME;
            assert.ok(fs.existsSync(path.join(configHome, "backpass", "config.json")));
            if (fail) throw failure;
            return "result";
          });
        if (fail) assert.throws(run, (error) => error === failure);
        else assert.equal(run(), "result");
        assert.equal(process.env.XDG_CONFIG_HOME, value);
        assert.equal(fs.existsSync(configHome), false);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("repository fixtures are removed after their owning test", async (t) => {
  let root;
  await t.test("fixture owner", (t) => {
    root = tempRepo(t, {});
    assert.ok(fs.existsSync(path.join(root, ".backpassrc.json")));
  });
  assert.equal(fs.existsSync(root), false);
});

test("opencodeStores is personal configuration: expanded, absolute, and refused in a repository file", (t) => {
  const home = os.homedir();
  withConfigHome({ discovery: { opencodeStores: ["~/snapshots/opencode", "/srv/opencode.db"] } }, () => {
    const config = loadConfig(tempRepo(t));
    assert.deepEqual(config.discovery.opencodeStores, [path.join(home, "snapshots", "opencode"), "/srv/opencode.db"]);
    assert.deepEqual(
      loadConfig(null, {}, { kind: "user" }).discovery.opencodeStores,
      [path.join(home, "snapshots", "opencode"), "/srv/opencode.db"],
      "user scope reads the same top-level list, so stores are named once",
    );
  });
  withConfigHome(null, () => {
    assert.deepEqual(loadConfig(tempRepo(t)).discovery.opencodeStores, []);
    assert.throws(
      () => loadConfig(tempRepo(t), { discovery: { opencodeStores: "~/snap" } }),
      /opencodeStores must be an array of paths/,
    );
    assert.throws(
      () => loadConfig(tempRepo(t), { discovery: { opencodeStores: ["snapshots/opencode"] } }),
      /opencodeStores entry "snapshots\/opencode" is not an absolute path/,
    );
    let refused = null;
    try {
      loadConfig(tempRepo(t, { discovery: { opencodeStores: ["/srv/opencode.db"] } }));
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof UserError, "a checked-in file may not point backpass at a transcript store");
    assert.match(refused.message, /\.backpassrc\.json sets discovery\.opencodeStores/);
    assert.match(refused.hint, /backpass[/\\]config\.json/);
  });
});

test("a configured store joins the default one, and each session is read from its own store", async () => {
  await withOpencodeHome(
    (dbFile, home) => {
      writeOpencodeStore(dbFile, V1);
      writeOpencodeStore(path.join(home, "desktop", "opencode.db"), V2);
    },
    async (dbFile, home) => {
      const configured = path.join(home, "desktop");
      const rows = await opencode.discover({ cutoffMs: null, config: { discovery: { opencodeStores: [configured] } } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      assert.equal(byId.get(V1_SESSION).path, dbFile);
      assert.equal(byId.get(V2_PARENT).path, path.join(configured, "opencode.db"), "a directory holds opencode.db");
      assert.equal(byId.get(V2_PARENT).cwd, "/repo/demo");

      const { events } = await opencode.read(byId.get(V2_PARENT));
      assert.equal(events[0].text, "Open a PR for the parser fix.", "read from the store it was listed in");

      const byFile = await opencode.discover({
        cutoffMs: null,
        config: { discovery: { opencodeStores: [path.join(configured, "opencode.db")] } },
      });
      assert.deepEqual(byFile.map((row) => row.id).sort(), rows.map((row) => row.id).sort(), "or name the file");
    },
  );
});

test("a store named twice, or a session copied into two stores, is read once", async () => {
  await withOpencodeHome(
    (dbFile, home) => {
      writeOpencodeStore(dbFile, V2);
      writeOpencodeStore(path.join(home, "copy", "opencode.db"), V2);
    },
    async (dbFile, home) => {
      const stores = [path.dirname(dbFile), dbFile, path.join(home, "copy")];
      assert.deepEqual(opencode.storeFiles({ discovery: { opencodeStores: stores } }), [
        dbFile,
        path.join(home, "copy", "opencode.db"),
      ]);
      const rows = await opencode.discover({ cutoffMs: null, config: { discovery: { opencodeStores: stores } } });
      const single = await opencode.discover({ cutoffMs: null });
      assert.deepEqual(
        rows.map((row) => row.id).sort(),
        single.map((row) => row.id).sort(),
        "one row per session, as if the store were read once",
      );
      assert.ok(
        rows.every((row) => row.path === dbFile),
        "the first store listing a session keeps it, so its identity is stable",
      );
    },
  );
});

test("a configured store that is missing or unreadable is named and skipped; the rest are read", async () => {
  await withOpencodeHome(
    (dbFile, home) => {
      writeOpencodeStore(dbFile, V1);
      const junk = path.join(home, "junk", "opencode.db");
      fs.mkdirSync(path.dirname(junk), { recursive: true });
      const db = new DatabaseSync(junk);
      db.exec("CREATE TABLE unrelated (id INTEGER)");
      db.close();
      writeOpencodeStore(path.join(home, "desktop", "opencode.db"), V2);
    },
    async (dbFile, home) => {
      const warnings = [];
      const rows = await opencode.discover({
        cutoffMs: null,
        config: {
          discovery: {
            opencodeStores: [path.join(home, "absent"), path.join(home, "junk"), path.join(home, "desktop")],
          },
        },
        warn: (message) => warnings.push(message),
      });
      assert.ok(rows.some((row) => row.id === V1_SESSION));
      assert.ok(rows.some((row) => row.id === V2_PARENT));
      assert.deepEqual(warnings, [
        `configured store ${path.join(home, "absent", "opencode.db")} not found - skipped`,
        `configured store ${path.join(home, "junk", "opencode.db")} unreadable (no session or session_v2 table (unrecognised opencode store)) - skipped`,
      ]);
    },
  );
});

test("discovery associates a configured store's sessions and names a missing store", async (t) => {
  const repoRoot = tempRepo(t);
  const shape = structuredClone(V2);
  for (const session of shape.rows.session_v2) session.directory = repoRoot;
  await withOpencodeHome(
    (dbFile, home) => writeOpencodeStore(path.join(home, "desktop", "opencode.db"), shape),
    async (dbFile, home) => {
      const config = withConfigHome(
        { discovery: { opencodeStores: [path.join(home, "desktop"), path.join(home, "absent")] } },
        () => loadConfig(repoRoot, { discovery: { harnesses: ["opencode"], since: "all" } }),
      );
      config.state = { root: path.join(repoRoot, ".backpass"), readScanCache: () => ({ version: 1, entries: {} }) };
      const repo = { name: path.basename(repoRoot), root: repoRoot, worktrees: [repoRoot], remotes: [] };
      const { result, lines } = await captureWarnings(() => discoverTranscripts({ repo, config }));
      assert.deepEqual(result.transcripts.map((transcript) => transcript.nativeId).sort(), [
        "ses_f0a1b2c3dffeResumedSession01",
        "ses_f17c42540ffeM0ZIydCm19byyr",
        V2_PARENT,
      ]);
      assert.equal(
        result.perHarness.opencode.self,
        2,
        "backpass's own session in that store, and the subagent it delegated to, are still dropped",
      );
      assert.ok(result.transcripts.every((transcript) => transcript.association.tier === 1));
      assert.ok(
        lines.some((line) =>
          line.includes(`opencode: configured store ${path.join(home, "absent", "opencode.db")} not found`),
        ),
        lines.join("\n"),
      );
    },
  );
});
