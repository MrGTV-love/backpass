import test from "node:test";
import assert from "node:assert/strict";

import { reportError } from "../src/cli.js";
import { AcpxError } from "../src/acpx.js";

function capture(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return lines;
}

test("a timed-out harness call exits 1 with its message and a retry hint, not a stack trace", (t) => {
  const lines = capture(t);
  const err = new AcpxError("acpx claude session prompt timed out after 900s", { timedOut: true });

  assert.equal(reportError(err), 1);

  const output = lines.join("\n");
  assert.match(output, /error acpx claude session prompt timed out after 900s/);
  assert.match(output, /rerun to retry/);
  assert.match(output, /timeoutSeconds/);
  assert.doesNotMatch(output, /\n\s+at /);
  assert.equal(lines.length, 2);
});

test("a timed-out adapter-configuration check gets a load hint, not timeoutSeconds advice", (t) => {
  const lines = capture(t);
  const err = new AcpxError("acpx config show timed out verifying the codex adapter configuration", {
    timedOut: true,
    stage: "verify",
  });

  assert.equal(reportError(err), 1);

  const output = lines.join("\n");
  assert.match(output, /error acpx config show timed out verifying the codex adapter configuration/);
  assert.match(output, /too slow to start/);
  assert.match(output, /rerun when the host is less loaded/);
  assert.doesNotMatch(output, /timeoutSeconds/);
  assert.doesNotMatch(output, /\n\s+at /);
  assert.equal(lines.length, 2);
});

test("a non-timeout harness failure keeps its stack trace", (t) => {
  const lines = capture(t);
  const err = new AcpxError("acpx claude exec failed: exit 1");

  assert.equal(reportError(err), 1);

  const output = lines.join("\n");
  assert.match(output, /AcpxError: acpx claude exec failed: exit 1/);
  assert.match(output, /\n\s+at /);
  assert.doesNotMatch(output, /rerun to retry/);
});
