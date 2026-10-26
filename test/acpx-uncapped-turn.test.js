import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A default-config model call gets no wall-clock budget from backpass: no `--timeout`
 * reaches acpx and no kill timer is armed, so a turn (or an effort `set`) that runs
 * far past the old 300s/900s/60s limits in fake time still completes. The fake acpx
 * logs every argv and holds the named step until the test writes its release file.
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-acpx-uncapped-"));
const log = path.join(fixtureDir, "calls.jsonl");
const fakeAcpx = path.join(fixtureDir, "acpx");
fs.writeFileSync(
  fakeAcpx,
  `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const hold = (name) => {
  const file = path.join(${JSON.stringify(fixtureDir)}, "release-" + name);
  while (!fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};
if (argv.includes("config") && argv.includes("show")) {
  process.stdout.write(JSON.stringify({ agents: {} }));
  process.exit(0);
}
const mode = process.env.FAKE_MODE;
const acpxTimeout = () => {
  process.stderr.write("[acpx] error: TIMEOUT Timed out after 900000ms\\n");
  process.exit(3);
};
if (argv.includes("set") && mode === "set-timeout") acpxTimeout();
if (argv.includes("set")) hold("set");
if (!argv.includes("--file")) process.exit(0);
if (mode === "prompt-timeout") acpxTimeout();
if (mode === "tool-error") {
  // acpx's JSON stream carries both directions: a client error reply to one tool
  // request (non-null id), then acpx's own terminal onError object (id null).
  const toolError = { jsonrpc: "2.0", id: 7, error: { code: -32002, message: "Resource not found: missing.md" } };
  const data = { acpxCode: "RUNTIME", detailCode: "AUTH_REQUIRED", details: "Sign in before sending a prompt" };
  const terminal = { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Request failed", data } };
  process.stdout.write(JSON.stringify(toolError) + "\\n" + JSON.stringify(terminal) + "\\n");
  process.exit(1);
}
hold("prompt");
const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } };
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update } }) + "\\n");
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { usage: { inputTokens: 3, outputTokens: 4 } } }) + "\\n");
`,
);
fs.chmodSync(fakeAcpx, 0o755);
process.env.BACKPASS_ACPX_BIN = fakeAcpx;
const { classifyAcpxFailure, execOneShot, sessionPrompt } = await import("../src/acpx.js");
const { reportError } = await import("../src/cli.js");

test.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

function calls() {
  return fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function until(pending, predicate) {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled && !calls().some(predicate)) await new Promise((resolve) => setImmediate(resolve));
}

function reset(t) {
  fs.rmSync(log, { force: true });
  for (const name of ["set", "prompt"]) fs.rmSync(path.join(fixtureDir, `release-${name}`), { force: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const promptFile = path.join(fixtureDir, `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(promptFile, "analyze this\n");
  return promptFile;
}

const release = (name) => fs.writeFileSync(path.join(fixtureDir, `release-${name}`), "");

test("a default exec one-shot passes no --timeout and outlives the old 300s cap", async (t) => {
  const promptFile = reset(t);
  const pending = execOneShot({ agent: "codex", promptFile, cwd: fixtureDir });
  await until(pending, (argv) => argv.includes("--file"));
  t.mock.timers.tick(1_000_000);
  release("prompt");
  const result = await pending;
  assert.equal(result.text, "answer");
  const turn = calls().find((argv) => argv.includes("--file"));
  assert.ok(!turn.includes("--timeout"), turn.join(" "));
});

test("a default session prompt and its effort set get no cap, and setup steps are recorded", async (t) => {
  const promptFile = reset(t);
  const pending = sessionPrompt({
    agent: "codex",
    effort: "medium",
    sessionName: "backpass-uncapped",
    promptFile,
    cwd: fixtureDir,
  });
  // The effort set is the setup step behind 13 of 19 measured failures (old 60s cap).
  await until(pending, (argv) => argv.includes("set"));
  t.mock.timers.tick(1_000_000);
  release("set");
  await until(pending, (argv) => argv.includes("--file"));
  t.mock.timers.tick(1_000_000);
  release("prompt");
  const result = await pending;
  assert.equal(result.text, "answer");
  const turn = calls().find((argv) => argv.includes("--file"));
  assert.ok(!turn.includes("--timeout"), turn.join(" "));
  assert.ok(calls().some((argv) => argv.includes("sessions") && argv.includes("close")));

  const records = fs
    .readFileSync(`${promptFile}.activity.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const ended = records.filter((record) => record.type === "end").map((record) => record.step);
  assert.deepEqual(ended, ["config show", "sessions new", "set reasoning_effort", null]);
  assert.ok(records.every((record) => record.type !== "end" || record.stalled === false));
});

test("an explicit stall cap stops a silent turn and the error names stallTimeoutSeconds", async (t) => {
  const promptFile = reset(t);
  const pending = execOneShot({ agent: "codex", promptFile, cwd: fixtureDir, stallTimeoutSeconds: 60 });
  await until(pending, (argv) => argv.includes("--file"));
  t.mock.timers.tick(60_000);
  const err = await pending.then(
    () => assert.fail("a silent turn past the explicit stall cap completed"),
    (error) => error,
  );
  assert.equal(err.timedOut, true);
  const lines = [];
  t.mock.method(console, "error", (...args) => lines.push(args.join(" ")));
  assert.equal(reportError(err), 1);
  const output = lines.join("\n");
  assert.match(output, /no ACP activity/);
  assert.match(output, /stallTimeoutSeconds/);
  assert.doesNotMatch(output, /raise timeoutSeconds/);
});

function hint(t, err) {
  const lines = [];
  t.mock.method(console, "error", (...args) => lines.push(args.join(" ")));
  assert.equal(reportError(err), 1);
  return lines.join("\n");
}

function withMode(t, mode) {
  process.env.FAKE_MODE = mode;
  t.after(() => delete process.env.FAKE_MODE);
  return reset(t);
}

test("a tool request's error reply is not the call's diagnostic; acpx's terminal error is", async (t) => {
  const promptFile = withMode(t, "tool-error");
  const err = await execOneShot({ agent: "codex", promptFile, cwd: fixtureDir }).then(
    () => assert.fail("a failed exec resolved"),
    (error) => error,
  );
  assert.match(
    err.message,
    /exec failed \(exit 1\): \[acpx\] error: RUNTIME AUTH_REQUIRED Sign in before sending a prompt$/,
  );
  assert.doesNotMatch(err.stderr, /Resource not found/);
  assert.equal(classifyAcpxFailure(err), "unauthenticated");
});

test("acpx's own timeout on an uncapped turn or setup step never advises timeoutSeconds", async (t) => {
  /** @type {Array<[string, (promptFile: string) => Promise<unknown>]>} */
  const cases = [
    [
      "prompt-timeout",
      (promptFile) => sessionPrompt({ agent: "codex", sessionName: "bp-acpx-timeout", promptFile, cwd: fixtureDir }),
    ],
    ["prompt-timeout", (promptFile) => execOneShot({ agent: "codex", promptFile, cwd: fixtureDir })],
    [
      "set-timeout",
      (promptFile) =>
        sessionPrompt({ agent: "codex", effort: "medium", sessionName: "bp-set-timeout", promptFile, cwd: fixtureDir }),
    ],
  ];
  for (const [mode, call] of cases) {
    await t.test(mode, async (st) => {
      const err = await call(withMode(st, mode)).then(
        () => assert.fail("a timed-out call resolved"),
        (error) => error,
      );
      assert.equal(err.timedOut, true);
      const output = hint(st, err);
      assert.match(output, /acpx ended the call at its own timeout/);
      assert.doesNotMatch(output, /raise timeoutSeconds/);
    });
  }
});

test("acpx's timeout under an explicit timeoutSeconds still advises raising it", async (t) => {
  const promptFile = withMode(t, "prompt-timeout");
  const err = await execOneShot({ agent: "codex", promptFile, cwd: fixtureDir, timeoutSeconds: 300 }).then(
    () => assert.fail("a timed-out call resolved"),
    (error) => error,
  );
  assert.match(hint(t, err), /raise timeoutSeconds/);
});
