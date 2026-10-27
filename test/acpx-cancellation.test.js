import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const acpxModule = pathToFileURL(path.resolve("src/acpx.js")).href;
const tuiModule = pathToFileURL(path.resolve("src/tui/index.js")).href;
const progressModule = pathToFileURL(path.resolve("src/progress.js")).href;

/** @type {[boolean, boolean, NodeJS.Signals, boolean?][]} */
const scenarios = [
  [false, true, "SIGINT"],
  [false, false, "SIGTERM"],
  [true, true, "SIGTERM"],
  [true, false, "SIGINT"],
  [true, true, "SIGINT", true],
];
for (const [session, tui, signal, closing = false] of scenarios) {
  test(
    `interrupting uncapped ${session ? "session" : "exec"} (${tui ? "TUI" : "plain"}, ${signal}${closing ? ", during close" : ""}) stops its model process`,
    { skip: process.platform === "win32" && "POSIX group cancellation" },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-cancel-"));
      const pidsFile = path.join(dir, "pids.json");
      const closeFile = path.join(dir, "closed");
      const releaseFile = path.join(dir, "release-close");
      const fake = path.join(dir, "acpx");
      const promptFile = path.join(dir, "prompt.md");
      fs.writeFileSync(promptFile, "keep working");
      fs.writeFileSync(
        fake,
        `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('sessions')) {
  if (args.includes('close')) {
    fs.writeFileSync(${JSON.stringify(closeFile)}, 'closed');
    if (${closing}) {
      const finish = () => {
        if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
        const {model} = JSON.parse(fs.readFileSync(${JSON.stringify(pidsFile)}, 'utf8'));
        try { process.kill(-model, 'SIGKILL'); } catch {}
        process.exit(0);
      };
      fs.watch(${JSON.stringify(dir)}, finish);
      setInterval(finish, 10);
      return;
    }
    if (fs.existsSync(${JSON.stringify(pidsFile)})) {
      const {model} = JSON.parse(fs.readFileSync(${JSON.stringify(pidsFile)}, 'utf8'));
      try { process.kill(-model, 'SIGKILL'); } catch {}
    }
  }
  process.exit(0);
}
const model = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], {
  detached: ${session}, stdio: ['ignore', 'pipe', 'ignore']
});
model.stdout.once('data', () => {
  fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({acpx:process.pid,model:model.pid}));
  const update = {jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:${closing ? "'agent_message_chunk'" : "'agent_thought_chunk'"},content:{type:'text',text:'working'}}}};
  process.stdout.write(JSON.stringify(update)+'\\n', () => { if (${closing}) process.exit(0); });
});
setInterval(()=>{},1000);
`,
        { mode: 0o755 },
      );
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...process.env, BACKPASS_ACPX_BIN: fake };
      delete env.NO_COLOR;
      delete env.CI;
      const script = `
import fs from 'node:fs';
import {PassThrough} from 'node:stream';
import {execOneShot, sessionPrompt} from ${JSON.stringify(acpxModule)};
import {startTui} from ${JSON.stringify(tuiModule)};
import {setProgressSink} from ${JSON.stringify(progressModule)};
if (${tui}) {
  const stderr = new PassThrough(); stderr.isTTY=true; stderr.columns=110; stderr.getColorDepth=()=>1;
  stderr.resume();
  await startTui({flags:{},config:{theme:'dark',discovery:{since:'all'}},repo:{name:'cancel-smoke',worktrees:[]},version:'test'}, {stderr});
}
let announced=false;
const announce = () => {
  if (!announced && fs.existsSync(${JSON.stringify(closing ? closeFile : pidsFile)})) {
    announced=true;
    process.send(JSON.parse(fs.readFileSync(${JSON.stringify(pidsFile)},'utf8')));
  }
};
if (${closing}) {
  fs.watch(${JSON.stringify(dir)}, announce);
  process.on(${JSON.stringify(signal)}, () => process.send({interrupted:true}));
} else setProgressSink(announce);
await (${session} ? sessionPrompt : execOneShot)({agent:'codex',sessionName:'cancel-smoke',promptFile:${JSON.stringify(promptFile)},cwd:${JSON.stringify(dir)}});
`;
      const parent = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      parent.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
      const exited = new Promise((resolve) => parent.once("exit", (code, signal) => resolve({ code, signal })));
      let pids;
      try {
        pids = await new Promise((resolve, reject) => {
          parent.once("message", resolve);
          parent.once("error", reject);
          parent.once("exit", () => reject(new Error(`parent exited before model readiness: ${stderr}`)));
        });
        const interrupted = closing
          ? new Promise((resolve, reject) => {
              parent.once("message", resolve);
              parent.once("exit", () => reject(new Error("parent exited before handling interruption")));
            })
          : null;
        parent.kill(signal);
        if (interrupted) {
          await interrupted;
          fs.writeFileSync(releaseFile, "finish close");
        }
        const result = await exited;
        assert.equal(result.code, signal === "SIGINT" ? 130 : 143, stderr);
        for (const [kind, pid] of Object.entries(pids)) {
          let alive = true;
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            alive = false;
          }
          assert.equal(alive, false, `${kind} ${pid} outlived interrupted backpass`);
        }
        if (session) assert.equal(fs.readFileSync(closeFile, "utf8"), "closed");
        if (!closing) {
          const records = fs
            .readFileSync(`${promptFile}.activity.jsonl`, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const starts = records.filter((record) => record.type === "start");
          const ends = records.filter((record) => record.type === "end");
          assert.equal(ends.length, starts.length, "interruption left an activity call unfinished");
          for (const start of starts) {
            assert.equal(ends.filter((end) => end.id === start.id).length, 1, "activity must finalize exactly once");
          }
          const promptStart = starts.filter((record) => record.step === null);
          assert.equal(promptStart.length, 1);
          const end = ends.find((record) => record.id === promptStart[0].id);
          assert.equal(end.eventCount, 1, "the actual ACP event was not recorded before exit");
          assert.equal(
            end.gapHistogram.reduce((sum, count) => sum + count, 0),
            2,
            "startup and final gaps are both recorded",
          );
          assert.ok(end.longestGapMs > 0);
          assert.equal(end.stalled, false, "user interruption is not an inferred stall");
          assert.ok(end.endedAt >= end.lastActivityAt);
        }
      } finally {
        parent.kill("SIGKILL");
        if (!pids && fs.existsSync(pidsFile)) pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
        if (pids) {
          try {
            process.kill(-pids.acpx, "SIGKILL");
          } catch {
            // A passing case already stopped this fixture process.
          }
          try {
            process.kill(session ? -pids.model : pids.model, "SIGKILL");
          } catch {
            // A passing case already stopped this fixture process.
          }
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
