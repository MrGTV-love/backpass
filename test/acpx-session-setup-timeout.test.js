import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-acpx-setup-timeout-"));
const promptFile = path.join(fixtureDir, "prompt.md");
const logFile = path.join(fixtureDir, "calls.jsonl");
const fakeAcpx = path.join(fixtureDir, "acpx");
fs.writeFileSync(promptFile, "analyze this\n");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const operation = args.includes("config") ? "config"
  : args.includes("sessions") ? (args.includes("new") ? "new" : "close")
  : args.includes("set-mode") ? "set-mode"
  : args.includes("set") ? "set" : "prompt";
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(operation) + "\\n");
if (operation === "config") process.stdout.write('{"agents":{}}');
if (operation === process.env.FAKE_SETUP_OPERATION && process.env.FAKE_SETUP_EXIT !== "0") {
  process.stderr.write("[acpx] error: TIMEOUT CLAUDE_ACP_SESSION_CREATE_TIMEOUT adapter startup timed out\\n");
  process.exit(Number(process.env.FAKE_SETUP_EXIT));
}
if (operation === "prompt") process.stdout.write("done");
`,
  { mode: 0o755 },
);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;
const { AcpxError, openSession, sessionPrompt } = await import("../src/acpx.js");
const { AgentResolver } = await import("../src/agents.js");
const { UserError } = await import("../src/logger.js");

test.after(() => {
  delete process.env.FAKE_SETUP_OPERATION;
  delete process.env.FAKE_SETUP_EXIT;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

for (const [agent, operation] of [
  ["codex", "set"],
  ["claude", "set"],
  ["opencode", "set"],
  ["codex", "set-mode"],
]) {
  for (const code of [0, 1, 3]) {
    test(`${agent} ${operation} exit ${code} preserves pinned setup semantics and closes the session`, async () => {
      process.env.FAKE_SETUP_OPERATION = operation;
      process.env.FAKE_SETUP_EXIT = String(code);
      fs.writeFileSync(logFile, "");
      const effort = operation === "set" ? "medium" : null;
      const resolver = new AgentResolver({ analysis: { agent, effort } });
      let attempts = 0;
      const call = () =>
        resolver.withFallthrough("analysis", async (pick) => {
          attempts += 1;
          const options = { agent: pick.agent, effort, sessionName: "setup-timeout", cwd: fixtureDir };
          if (operation === "set") return sessionPrompt({ ...options, promptFile });
          const session = await openSession({ ...options, writeAccess: true });
          try {
            return await session.prompt({ promptFile });
          } finally {
            await session.close();
          }
        });
      if (code === 0) {
        assert.equal((await call()).text, "done");
      } else {
        await assert.rejects(call, (err) => {
          if (code === 3) {
            assert.ok(err instanceof AcpxError, String(err));
            assert.equal(err.timedOut, true);
            assert.equal(err.code, 3);
            assert.match(err.message, /: timed out$/);
            assert.match(err.stderr, /CLAUDE_ACP_SESSION_CREATE_TIMEOUT/);
          } else {
            assert.ok(err instanceof UserError, String(err));
            assert.match(err.message, /pinned analysis agent .* failed unexpectedly/);
          }
          return true;
        });
      }
      assert.equal(attempts, 1);
      assert.equal((await resolver.resolve("analysis")).agent, agent);
      const calls = fs
        .readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(calls, ["config", "new", operation, ...(code === 0 ? ["prompt"] : []), "close"]);
    });
  }
}
