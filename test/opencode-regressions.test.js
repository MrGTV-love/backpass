import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as opencode from "../src/discovery/adapters/opencode.js";
import { readTranscript } from "../src/discovery/index.js";
import { distill } from "../src/distill.js";
import { SELF_SESSION_SENTINEL } from "../src/sentinel.js";
import { readOpencodeFixture, withOpencodeHome, writeOpencodeStore } from "./helpers/opencode.js";

for (const layout of ["v1", "v2"]) {
  for (const configured of [false, true]) {
    test(`${layout} ${configured ? "configured" : "default"} store disappearing after discovery rejects transcript reading`, async () => {
      await withOpencodeHome(
        (dbFile, home) =>
          writeOpencodeStore(
            configured ? path.join(home, "copy.db") : dbFile,
            readOpencodeFixture(`opencode-${layout}-store.json`),
          ),
        async (dbFile, home) => {
          const config = { discovery: { opencodeStores: configured ? [path.join(home, "copy.db")] : [] } };
          const [row] = await opencode.discover({ config });
          assert.ok((await readTranscript({ ...row, harness: "opencode" })).events.length);
          fs.rmSync(row.path);
          await assert.rejects(readTranscript({ ...row, harness: "opencode" }), (error) => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(row.path), error.message);
            return true;
          });
          assert.equal(fs.existsSync(row.path), false, "reading must not recreate the missing store");
        },
      );
    });
  }

  test(`${layout} attachment-only user messages survive reading and distillation`, async () => {
    const fixture = readOpencodeFixture(`opencode-${layout}-store.json`);
    const file = { type: "file", mime: "image/png", filename: "failure.png", url: "data:image/png;base64,AAAA" };
    const sessionId = fixture.rows[layout === "v1" ? "session" : "session_v2"][0].id;
    if (layout === "v1") {
      const user = fixture.rows.message.find((row) => row.session_id === sessionId && row.data.role === "user");
      const part = fixture.rows.part.find((row) => row.message_id === user.id);
      part.data = file;
    } else {
      const user = fixture.rows.session_message.find((row) => row.session_id === sessionId && row.type === "user");
      user.data.text = "";
      user.data.files = [file];
    }
    await withOpencodeHome(
      (dbFile) => writeOpencodeStore(dbFile, fixture),
      async () => {
        const row = (await opencode.discover()).find((row) => row.id === sessionId);
        assert.equal(row.self, false);
        const { events } = await readTranscript({ ...row, harness: "opencode" });
        assert.deepEqual(events[0], { kind: "message", role: "user", text: "[Attachment-only user message]" });
        assert.equal(distill(events, {}).stats.userTurns, layout === "v1" ? 1 : 2);
      },
    );
  });
}

test("2.x bookkeeping-only sessions are excluded, but every primary activity type is recorded", async () => {
  const fixture = readOpencodeFixture("opencode-v2-store.json");
  const types = ["synthetic", "system", "compaction", "idle", "location-switched", "agent-switched", "model-switched"];
  const active = {
    user: { text: "Hello" },
    assistant: { content: [{ type: "text", text: "Hello" }] },
    shell: { command: "pwd", output: { output: "/repo/demo" }, status: "exited", exit: 0 },
    skill: { name: "release" },
  };
  for (const type of [...types, ...Object.keys(active)]) {
    fixture.rows.session_v2.push({ ...fixture.rows.session_v2[0], id: type });
    fixture.rows.session_message.push({
      ...fixture.rows.session_message[0],
      id: `msg_${type}`,
      session_id: type,
      type,
      data: active[type] || { text: "Harness notice" },
    });
  }
  await withOpencodeHome(
    (dbFile) => writeOpencodeStore(dbFile, fixture),
    async () => {
      const rows = await opencode.discover();
      for (const type of types)
        assert.equal(
          rows.some((row) => row.id === type),
          false,
          type,
        );
      for (const type of Object.keys(active)) {
        const row = rows.find((row) => row.id === type);
        assert.ok(row, type);
        assert.equal((await opencode.read(row)).events.length, 1, type);
      }
    },
  );
});

for (const layout of ["v1", "v2"]) {
  test(`recent 2.x children retain old ${layout} self ancestry through an unused intermediate`, async () => {
    const fixture = readOpencodeFixture("opencode-v2-store.json");
    for (const rows of [fixture.rows.session_v2, fixture.rows.session_message]) {
      for (const row of rows) row.time_created = row.time_updated = 1;
    }
    const [, realChild, self, , unused, selfChild] = fixture.rows.session_v2;
    selfChild.parent_id = unused.id;
    unused.parent_id = self.id;
    // Only message activity advances; session metadata remains out of the window.
    for (const message of fixture.rows.session_message) {
      if ([realChild.id, selfChild.id].includes(message.session_id)) message.time_updated = 1000;
    }
    await withOpencodeHome(
      (dbFile) => {
        if (layout === "v1") {
          const v1 = readOpencodeFixture("opencode-v1-store.json");
          for (const session of v1.rows.session) {
            session.project_id = fixture.rows.project[0].id;
            session.time_created = session.time_updated = 1;
          }
          v1.rows.part[0].data.text = `${SELF_SESSION_SENTINEL}\nAnalyze this trace.`;
          unused.parent_id = v1.rows.session[0].id;
          writeOpencodeStore(dbFile, fixture);
          writeOpencodeStore(dbFile, v1, { skipTables: ["project", "session_message"] });
        } else {
          writeOpencodeStore(dbFile, fixture);
        }
      },
      async () => {
        const rows = await opencode.discover({ cutoffMs: 1000 });
        assert.deepEqual(rows.map((row) => row.id).sort(), [realChild.id, selfChild.id].sort());
        assert.equal(rows.find((row) => row.id === selfChild.id).self, true);
        assert.equal(rows.find((row) => row.id === realChild.id).self, false);
      },
    );
  });

  test(`${layout} bounded discovery does not materialize unrelated old sessions`, async (t) => {
    const fixture = readOpencodeFixture(`opencode-${layout}-store.json`);
    const sessions = fixture.rows[layout === "v1" ? "session" : "session_v2"];
    for (let i = 0; i < 50; i++) {
      const id = `old_${i}`;
      sessions.push({ ...sessions[0], id, time_created: 1, time_updated: 1 });
      if (layout === "v1") {
        fixture.rows.message.push({ ...fixture.rows.message[0], id: `msg_${id}`, session_id: id, time_created: 1 });
        fixture.rows.part.push({
          ...fixture.rows.part[0],
          id: `part_${id}`,
          session_id: id,
          message_id: `msg_${id}`,
          time_created: 1,
        });
      } else {
        const user = fixture.rows.session_message.find((row) => row.type === "user");
        fixture.rows.session_message.push({
          ...user,
          id: `msg_${id}`,
          session_id: id,
          time_created: 1,
          time_updated: 1,
        });
      }
    }
    await withOpencodeHome(
      (dbFile) => writeOpencodeStore(dbFile, fixture),
      async () => {
        // Observe actual database result rows, not SQL spelling or implementation source.
        const materialized = [];
        const prepare = DatabaseSync.prototype.prepare;
        t.mock.method(DatabaseSync.prototype, "prepare", function (...args) {
          const statement = prepare.apply(this, args);
          const all = statement.all;
          t.mock.method(statement, "all", function (...params) {
            const rows = all.apply(this, params);
            materialized.push(...rows);
            return rows;
          });
          return statement;
        });
        const rows = await opencode.discover({ cutoffMs: 1000 });
        assert.ok(rows.length);
        assert.equal(materialized.filter((row) => row.id?.startsWith("old_")).length, 0);
      },
    );
  });
}
