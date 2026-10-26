import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";

import { emitProgress } from "./progress.js";

/**
 * Observe acpx's JSONL ACP stream, not quiet output (which buffers until prompt end).
 * acpx 0.19.4 output-lylSoEBd.js:284-285 writes each ACP message immediately.
 * Events are activity, not a heartbeat: silent reasoning need not emit anything.
 * No measured idle/loaded silence bound exists yet. Default termination is disabled;
 * the per-prompt *.activity.jsonl histogram supplies calibration for a future bound.
 *
 * A session setup `step` (config show, sessions new, set) emits no ACP stream: it is
 * timed and shown live, and its structured stdout is returned untouched. Its record
 * lands beside the prompt it prepares; with no prompt file it is shown live only.
 */
export async function captureModelActivity(
  capture,
  { promptFile, stallTimeoutSeconds = undefined, agent, step = null },
) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const start = performance.now();
  let last = start;
  let lastActivityAt = startedAt;
  let eventCount = 0;
  let longestGapMs = 0;
  // Bucket i counts gaps in [2**i, 2**(i+1)) ms; bucket 0 includes sub-ms gaps.
  const gapHistogram = Array(64).fill(0);
  let timer;
  let stalled = false;
  let pending = "";
  let text = "";
  let legacyText = "";
  let errors = "";
  let usage = null;
  const decoder = new StringDecoder("utf8");
  const id = `${promptFile ?? step}:${process.pid}:${start}`;
  const record = (value) => {
    if (promptFile) fs.appendFileSync(`${promptFile}.activity.jsonl`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  };
  const gap = (now) => {
    const ms = Math.max(0, now - last);
    longestGapMs = Math.max(longestGapMs, ms);
    gapHistogram[Math.min(63, Math.floor(Math.log2(Math.max(1, ms))))] += 1;
    last = now;
  };
  const arm = () => {
    clearTimeout(timer);
    if (stallTimeoutSeconds > 0) {
      // Explicit user choice only, not an inferred safe silence duration.
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, stallTimeoutSeconds * 1000);
    }
  };
  const line = (value) => {
    let message;
    try {
      message = JSON.parse(value);
    } catch {
      // Older adapters/CLI fixtures can still return plain assistant text.
      legacyText += `${value}\n`;
      return;
    }
    if (message?.jsonrpc !== "2.0") {
      legacyText += `${value}\n`;
      return;
    }
    gap(performance.now());
    eventCount += 1;
    lastActivityAt = Date.now();
    emitProgress("model:activity", { id, agent, step, lastActivityAt });
    arm();
    const update = message.params?.update;
    if (
      message.method === "session/update" &&
      update?.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text"
    ) {
      text += update.content.text;
    }
    if (message.error && message.id === null) {
      // Match acpx's quiet diagnostic contract: only acpx's terminal onError object
      // (buildJsonRpcErrorResponse, id null; output-lylSoEBd.js:109-115,287-297) is a
      // diagnostic. The stream also carries error replies to individual tool requests
      // (non-null ids), which quiet output never prints. The terminal object keeps
      // adapter details and detailCode in data (output-lylSoEBd.js:72-107,925-929),
      // carrying AUTH_REQUIRED/model rejection even when message is generic.
      const data = message.error.data;
      const qualifier = [data?.acpxCode, data?.detailCode].filter((value) => typeof value === "string").join(" ");
      const detail =
        typeof data?.details === "string" && data.details.trim()
          ? data.details.trim()
          : message.error.message || JSON.stringify(message.error);
      errors += `[acpx] error: ${qualifier ? `${qualifier} ` : ""}${String(detail).replace(/\r\n?|\n/g, " ")}\n`;
    }
    if (message.result?.usage) {
      const raw = message.result.usage;
      usage = {};
      for (const [key, aliases] of Object.entries({
        input: ["inputTokens", "input_tokens"],
        output: ["outputTokens", "output_tokens"],
        cache_read: ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"],
        cache_write: ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"],
        total: ["totalTokens", "total_tokens"],
      })) {
        const value = aliases.map((alias) => raw[alias]).find((n) => typeof n === "number" && Number.isFinite(n));
        if (value !== undefined) usage[key] = value;
      }
    }
  };
  const drain = () => {
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const value = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (value.trim()) line(value);
    }
  };
  record({ type: "start", id, agent, step, startedAt, stallTimeoutSeconds: stallTimeoutSeconds ?? null });
  emitProgress("model:activity", { id, agent, step, lastActivityAt });
  arm();
  try {
    if (step) return { ...(await capture({ signal: controller.signal })), stalled };
    const result = await capture({
      signal: controller.signal,
      onStdout(chunk) {
        pending += decoder.write(chunk);
        drain();
      },
    });
    pending += decoder.end();
    drain();
    if (pending.trim()) line(pending);
    return {
      ...result,
      stdout: eventCount ? text : legacyText.trim(),
      stderr: `${result.stderr}${errors}`,
      usage,
      stalled,
    };
  } finally {
    clearTimeout(timer);
    gap(performance.now());
    emitProgress("model:activity:end", { id });
    record({
      type: "end",
      id,
      step,
      startedAt,
      endedAt: Date.now(),
      eventCount,
      lastActivityAt,
      longestGapMs,
      gapHistogram,
      stalled,
    });
  }
}
