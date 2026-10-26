import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { captureModelActivity } from "../src/model-activity.js";
import { clearProgressSink, setProgressSink } from "../src/progress.js";
import { initialState, reduceEvent } from "../src/tui/index.js";
import { renderFrame } from "../src/tui/render.js";
import { makeTheme } from "../src/tui/theme.js";

const event = (kind, text) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: { sessionUpdate: kind, content: { type: "text", text } },
    },
  }) + "\n";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-activity-"));
  t.after(() => {
    clearProgressSink();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  t.mock.method(performance, "now", () => Date.now());
  const promptFile = path.join(dir, "prompt.md");
  fs.writeFileSync(promptFile, "test");
  return { promptFile, agent: "codex" };
}

// A fake streaming acpx transport with the same stdout and cancellation interface.
function fakeAcpx(events, endMs) {
  return ({ signal, onStdout }) =>
    new Promise((resolve) => {
      const timers = events.map(([at, chunk]) => setTimeout(() => onStdout(Buffer.from(chunk)), at));
      const finish = (timedOut) => {
        timers.forEach(clearTimeout);
        resolve({ code: timedOut ? 130 : 0, stdout: "", stderr: "", timedOut });
      };
      timers.push(setTimeout(() => finish(false), endMs));
      signal.addEventListener("abort", () => finish(true), { once: true });
    });
}

for (const cap of [undefined, 400]) {
  test(`active call exceeds old 900s floor with stall cap ${cap ?? "off"}`, async (t) => {
    const options = fixture(t);
    const promise = captureModelActivity(
      fakeAcpx(
        [
          [300_000, event("agent_thought_chunk", "thinking")],
          [600_000, event("tool_call", "working")],
          [900_000, event("agent_message_chunk", "answer")],
        ],
        1_000_000,
      ),
      { ...options, stallTimeoutSeconds: cap },
    );
    t.mock.timers.tick(300_000);
    t.mock.timers.tick(300_000);
    t.mock.timers.tick(300_000);
    t.mock.timers.tick(100_000);
    const result = await promise;
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, "answer");
    const records = fs
      .readFileSync(`${options.promptFile}.activity.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].type, "start");
    assert.equal(records[1].eventCount, 3);
    assert.equal(records[1].endedAt - records[1].startedAt, 1_000_000);
    assert.equal(records[1].longestGapMs, 300_000);
    assert.equal(records[1].gapHistogram[18], 3);
    assert.equal(records[1].gapHistogram[16], 1, "final silence is also measured");
  });
}

test("explicit stall cap resets only for ACP messages, not stderr or arbitrary stdout", async (t) => {
  const options = fixture(t);
  const promise = captureModelActivity(
    fakeAcpx(
      [
        [50_000, event("agent_thought_chunk", "thinking")],
        [100_000, "not an ACP event\n"],
      ],
      500_000,
    ),
    { ...options, stallTimeoutSeconds: 100 },
  );
  t.mock.timers.tick(50_000);
  t.mock.timers.tick(50_000);
  t.mock.timers.tick(50_000);
  const result = await promise;
  assert.equal(result.stalled, true);
  assert.equal(result.timedOut, true);
  const end = fs
    .readFileSync(`${options.promptFile}.activity.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(end.endedAt - end.startedAt, 150_000);
  assert.equal(end.eventCount, 1);
  assert.equal(end.longestGapMs, 100_000);
});

test("default silent call survives and live UI reports silence without cancellation", async (t) => {
  const options = fixture(t);
  const state = initialState({});
  setProgressSink((kind, data) => reduceEvent(state, kind, data));
  const promise = captureModelActivity(fakeAcpx([], 2_000_000), options);
  t.mock.timers.tick(1_000_000);
  const lines = renderFrame(state, { width: 110, theme: makeTheme({ depth: 0 }), now: Date.now(), spin: "." });
  assert.ok(lines.some((line) => line.includes("codex: no model activity for 16:40")));
  assert.equal(Object.keys(state.modelCalls).length, 1);
  t.mock.timers.tick(1_000_000);
  const result = await promise;
  assert.equal(result.timedOut, false);
  assert.equal(result.stalled, false);
  assert.deepEqual(state.modelCalls, {});
});

test("stream decodes split UTF-8 and excludes thoughts, tools and prompts from answer", async (t) => {
  const options = fixture(t);
  const bytes = Buffer.from(event("agent_message_chunk", "café"));
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const result = await captureModelActivity(async ({ onStdout }) => {
    onStdout(Buffer.from(event("agent_thought_chunk", "secret")));
    onStdout(bytes.subarray(0, split));
    onStdout(bytes.subarray(split));
    onStdout(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
        }),
      ),
    );
    return { code: 0, stdout: "", stderr: "" };
  }, options);
  assert.equal(result.stdout, "café");
  assert.deepEqual(result.usage, { input: 3, output: 4, total: 7 });
});
