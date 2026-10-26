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

/** @type {[boolean, boolean, NodeJS.Signals][]} */
const scenarios = [
  [false, true, "SIGINT"],
  [false, false, "SIGTERM"],
  [true, true, "SIGTERM"],
  [true, false, "SIGINT"],
];
for (const [session, tui, signal] of scenarios) {
  test(
    `interrupting uncapped ${session ? "session" : "exec"} (${tui ? "TUI" : "plain"}, ${signal}) stops its model process`,
    { skip: process.platform === "win32" && "POSIX group cancellation" },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-cancel-"));
      const pidsFile = path.join(dir, "pids.json");
      const closeFile = path.join(dir, "closed");
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
  console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'working'}}}}));
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
setProgressSink(() => {
  if (!announced && fs.existsSync(${JSON.stringify(pidsFile)})) {
    announced=true;
    process.send(JSON.parse(fs.readFileSync(${JSON.stringify(pidsFile)},'utf8')));
  }
});
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
        parent.kill(signal);
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
