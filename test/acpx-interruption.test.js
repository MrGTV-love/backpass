import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

/**
 * Real-process interruption of backpass while acpx is mid-call. The fake acpx's
 * `sessions new` starts a detached "queue owner" (as acpx does) that only `sessions
 * close` stops; `FAKE_MODE` picks which call hangs.
 */
const acpxModule = pathToFileURL(path.resolve("src/acpx.js")).href;
const posixOnly = { skip: process.platform === "win32" && "POSIX group cancellation", timeout: 60_000 };

function fixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-interrupt-"));
  const files = {
    owner: path.join(dir, "owner.pid"),
    closePid: path.join(dir, "close.pid"),
    closed: path.join(dir, "closed"),
    release: path.join(dir, "release-close"),
    running: path.join(dir, "prompt-running"),
    rejected: path.join(dir, "rejected"),
    prompt: path.join(dir, "prompt.md"),
  };
  fs.writeFileSync(files.prompt, "keep working");
  const fake = path.join(dir, "acpx");
  fs.writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
const files = ${JSON.stringify(files)};
const mode = ${JSON.stringify(mode)};
const hang = () => setInterval(() => {}, 1000);
if (args.includes('sessions') && args.includes('new')) {
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  owner.unref();
  // Existence is the readiness signal: never expose a transient empty PID file.
  fs.writeFileSync(files.owner + '.tmp', String(owner.pid));
  fs.renameSync(files.owner + '.tmp', files.owner);
  if (mode === 'probe-create') hang();
  else process.exit(0);
} else if (args.includes('sessions') && args.includes('close')) {
  fs.writeFileSync(files.closePid, String(process.pid));
  if (fs.existsSync(files.owner)) {
    try { process.kill(Number(fs.readFileSync(files.owner, 'utf8')), 'SIGKILL'); } catch {}
  }
  fs.writeFileSync(files.closed, 'closed');
  if (mode === 'hang-close') hang();
  else if (mode === 'slow-close') {
    const done = () => { if (fs.existsSync(files.release)) process.exit(0); };
    setInterval(done, 10);
  } else process.exit(0);
} else if (args.includes('status')) {
  if (mode === 'probe-status') {
    fs.writeFileSync(files.running, 'status');
    hang();
  } else process.exit(0);
} else if (args.includes('--file')) {
  fs.writeFileSync(files.running, 'prompt');
  hang();
} else process.exit(0);
`,
    { mode: 0o755 },
  );
  return { dir, fake, files };
}

function start({ dir, fake }, body) {
  const script = `
import fs from 'node:fs';
import {execOneShot, probeSession, sessionPrompt} from ${JSON.stringify(acpxModule)};
const cwd = ${JSON.stringify(dir)};
${body}
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, BACKPASS_ACPX_BIN: fake },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  /** @type {Promise<{ code: number | null, stderr: string }>} */
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
  return { child, exited };
}

async function waitFor(file, exited) {
  let done = false;
  exited.then(() => (done = true));
  while (!fs.existsSync(file)) {
    if (done) throw new Error(`backpass exited before ${path.basename(file)}: ${(await exited).stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

for (const mode of ["probe-create", "probe-status"]) {
  test(`interrupting the availability probe during ${mode.slice(6)} closes its detached owner`, posixOnly, async () => {
    const env = fixture(mode);
    const { child, exited } = start(env, `await probeSession({agent:'codex', sessionName:'probe-smoke', cwd});`);
    let owner;
    try {
      await waitFor(mode === "probe-create" ? env.files.owner : env.files.running, exited);
      owner = Number(fs.readFileSync(env.files.owner, "utf8"));
      child.kill("SIGINT");
      const result = await exited;
      assert.equal(result.code, 130, result.stderr);
      assert.equal(fs.readFileSync(env.files.closed, "utf8"), "closed");
      assert.equal(alive(owner), false, `probe owner ${owner} outlived interrupted backpass`);
    } finally {
      child.kill("SIGKILL");
      if (owner) {
        try {
          process.kill(owner, "SIGKILL");
        } catch {
          // A passing case already stopped the owner.
        }
      }
      fs.rmSync(env.dir, { recursive: true, force: true });
    }
  });
}

test("a second signal exits while a session close is still waiting on acpx", posixOnly, async () => {
  const env = fixture("hang-close");
  const { child, exited } = start(
    env,
    `await sessionPrompt({agent:'codex', sessionName:'escape', promptFile:${JSON.stringify(env.files.prompt)}, cwd});`,
  );
  try {
    await waitFor(env.files.running, exited);
    child.kill("SIGINT");
    await waitFor(env.files.closed, exited);
    child.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.code, 143, result.stderr);
  } finally {
    child.kill("SIGKILL");
    const fixturePids = [env.files.owner, env.files.closePid]
      .filter((file) => fs.existsSync(file))
      .map((file) => Number(fs.readFileSync(file, "utf8")));
    for (const pid of fixturePids) {
      try {
        // The second signal deliberately bypasses product cleanup. The fixture
        // owns both detached groups and must reap them even when an assertion fails.
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        assert.equal(error.code, "ESRCH", `could not stop fixture group ${pid}: ${error.message}`);
      }
    }
    await exited;
    while (fixturePids.some(alive)) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(alive(child.pid), false, "the backpass fixture process survived teardown");
    for (const pid of fixturePids) assert.equal(alive(pid), false, `fixture process ${pid} survived teardown`);
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("a model call started during interruption never fails before backpass exits", posixOnly, async () => {
  const env = fixture("slow-close");
  const { child, exited } = start(
    env,
    `process.on('SIGINT', () => {
  execOneShot({agent:'codex', promptFile:${JSON.stringify(env.files.prompt)}, cwd}).catch(() =>
    fs.writeFileSync(${JSON.stringify(env.files.rejected)}, 'failed'));
});
await sessionPrompt({agent:'codex', sessionName:'flood', promptFile:${JSON.stringify(env.files.prompt)}, cwd});`,
  );
  try {
    await waitFor(env.files.running, exited);
    child.kill("SIGINT");
    await waitFor(env.files.closed, exited);
    fs.writeFileSync(env.files.release, "finish close");
    const result = await exited;
    assert.equal(result.code, 130, result.stderr);
    assert.equal(fs.existsSync(env.files.rejected), false, "an interrupted run recorded a model-call failure");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});
