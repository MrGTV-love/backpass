import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Loaded before every test file (`--import` in the package.json `test` script).
 *
 * Two things a test process must not share with the developer's machine:
 *
 * - The config home. `loadConfig` layers `$XDG_CONFIG_HOME/backpass/config.json` under
 *   every run, so a developer's own personal config - custom ladders, hosts, a `user`
 *   block - would otherwise change what the suite asserts about defaults and agent
 *   selection. Each test process therefore starts from an empty config home of its own.
 *   Tests that need a config home still set `XDG_CONFIG_HOME` themselves and restore
 *   this value after.
 * - The temp root. Tests create their fixtures with `fs.mkdtempSync(os.tmpdir())` and do
 *   not remove them, which left over a thousand directories behind per full run. Node's
 *   `os.tmpdir()` reads `TMPDIR` on every call, so pointing it at one per-process root
 *   (inherited by spawned CLI children) lets a single removal clean up everything.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-test-root-"));
process.env.TMPDIR = root;
const configHome = fs.mkdtempSync(path.join(root, "config-"));
process.env.XDG_CONFIG_HOME = configHome;
/** Make every directory under `dir` writable again, so a test that failed before restoring its
 * 0o555 fixture cannot keep the root from being removed. */
function restoreWritable(dir) {
  try {
    fs.chmodSync(dir, 0o755);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) restoreWritable(path.join(dir, entry.name));
    }
  } catch {
    // best-effort: the retry below reports nothing either way
  }
}

/** Best-effort removal: it must never add a stack trace to a run that is already ending. */
const removeRoot = () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    restoreWritable(root);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // leave it to the OS temp reaper rather than fail the exit
    }
  }
};
process.on("exit", removeRoot);

// A signal skips `exit`, so remove the directory here too, then re-raise the same signal
// so the process still ends with the conventional signal exit.
const signals = ["SIGINT", "SIGTERM"];
const onSignal = (signal) => {
  removeRoot();
  for (const s of signals) process.removeListener(s, onSignal);
  process.kill(process.pid, signal);
};
for (const signal of signals) process.once(signal, onSignal);
