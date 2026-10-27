import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  annotatePrompts,
  makeCliRepo,
  makeCliUserHome,
  readJson,
  runCli,
  snapshotTree,
} from "./helpers/synthesis-cli.js";

/**
 * The synthesis orchestration, through `backpass propose` as a user runs it.
 *
 * These cover the run that produced the 0.1.7 "synthesis returned no parseable JSON
 * object": a shrink that extracted two neighbouring sections (whose removals the
 * measurement merges into ONE change), a turn that re-edited the staging copy so the ids
 * moved, and a final turn where the harness returned success with no text at all. Each of
 * those three is a separate condition with a separate right answer, and the assertions
 * here are what a user can see: the exit code, what was printed, what is in
 * `.backpass/proposal.json`, and what is left in `.backpass/synthesis/`.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_LAVISH = path.join(ROOT, "test", "fixtures", "fake-lavish", "lavish-axi");
const PIN = ["--synthesis-agent", "claude", "--synthesis-model", "fake-model"];

const MEMORY = [
  "# Demo agent memory",
  "",
  "## Build",
  "",
  "- Run `make build` before every push.",
  "",
  "## Release checklist",
  "",
  "- Tag the release commit with the version.",
  "- Push the tag before the artifacts.",
  "- Never hand-edit CHANGELOG.md.",
  "",
  "## Incident response",
  "",
  "- Page the on-call before rolling back.",
  "- Write the postmortem within two days.",
  "- Link the postmortem from the incident channel.",
  "",
  "## Style",
  "",
  "- Never use the em dash.",
  "",
].join("\n");

/** The two sections the editing turn lifts out, as one contiguous span of the file. */
const BOTH_SECTIONS = [
  "## Release checklist",
  "",
  "- Tag the release commit with the version.",
  "- Push the tag before the artifacts.",
  "- Never hand-edit CHANGELOG.md.",
  "",
  "## Incident response",
  "",
  "- Page the on-call before rolling back.",
  "- Write the postmortem within two days.",
  "- Link the postmortem from the incident channel.",
  "",
].join("\n");

/** What the editing turn leaves: one pointer block, so the removals measure as ONE change. */
const POINTERS = [
  "## Playbooks",
  "- Release steps: .agents/skills/release-checklist/SKILL.md",
  "- Incidents: .agents/skills/incident-response/SKILL.md",
  "",
].join("\n");

/** What an agent rewrites the copy into when it wants the two extractions measured apart. */
const SPLIT = [
  "## Release checklist",
  "",
  "- Release steps: .agents/skills/release-checklist/SKILL.md",
  "",
  "## Incident response",
  "",
  "- Incidents: .agents/skills/incident-response/SKILL.md",
  "",
].join("\n");

/** An extraction must carry every line it removes, so the fixture skills carry theirs. */
const SKILL_BODIES = {
  "release-checklist": [
    "## Release checklist",
    "",
    "- Tag the release commit with the version.",
    "- Push the tag before the artifacts.",
    "- Never hand-edit CHANGELOG.md.",
    "",
  ].join("\n"),
  "incident-response": [
    "## Incident response",
    "",
    "- Page the on-call before rolling back.",
    "- Write the postmortem within two days.",
    "- Link the postmortem from the incident channel.",
    "",
  ].join("\n"),
};
const skill = (name) => `---\nname: ${name}\ndescription: Load before ${name} work.\n---\n\n${SKILL_BODIES[name]}`;

const EDIT_TURN = {
  "AGENTS.md": { replace: [[BOTH_SECTIONS, POINTERS]] },
  ".agents/skills/release-checklist/SKILL.md": skill("release-checklist"),
  ".agents/skills/incident-response/SKILL.md": skill("incident-response"),
};

const QUOTE = {
  polarity: "negative",
  text: "session 1 re-derived the release steps by hand",
  source: "claude · s1 · turn 4",
};

const extract = (changes, title, extra = {}) => ({
  changes,
  kind: "extract",
  title,
  rationale: "the evidence shows these steps are looked up, not remembered",
  evidence: [QUOTE],
  transcripts: 3,
  ...extra,
});

/** The coalesced layout: one merged memory change (H1) plus the two created skills. */
const COALESCED_ANSWER = { edits: [extract(["H1", "H2", "H3"], "extract two playbooks")] };
/** The layout after the copy is split: each skill with its own measured change. */
const SPLIT_ANSWER = {
  edits: [extract(["H1", "H4"], "extract the release checklist"), extract(["H2", "H3"], "extract incident response")],
};
/** A turn that edits the copy so the ids the agent was given no longer describe it. */
const SPLIT_THE_COPY = { editFirst: { "AGENTS.md": { replace: [[POINTERS, SPLIT]] } }, reply: { edits: [] } };

const proposalOf = (dir) => readJson(path.join(dir, ".backpass", "proposal.json"));
const stagedTree = (dir) => snapshotTree(path.join(dir, ".backpass", "synthesis"));

const gitIn = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A clone that commits each step over `dir`'s history, for the target checkout to fast-forward to. */
function upstreamHistory(dir, steps) {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-updater-"));
  gitIn(clone, ["clone", "-q", dir, "."]);
  gitIn(clone, ["config", "user.email", "test@example.com"]);
  gitIn(clone, ["config", "user.name", "test"]);
  const commits = steps.map(({ files = {}, links = {} }) => {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(clone, name)), { recursive: true });
      fs.writeFileSync(path.join(clone, name), text);
    }
    for (const [name, target] of Object.entries(links)) {
      fs.rmSync(path.join(clone, name), { force: true });
      fs.symlinkSync(target, path.join(clone, name));
    }
    gitIn(clone, ["add", "-A"]);
    gitIn(clone, ["commit", "-qm", "upstream update"]);
    return gitIn(clone, ["rev-parse", "HEAD"]);
  });
  return { clone, commits };
}

function upstreamCommit(dir, files) {
  const { clone, commits } = upstreamHistory(dir, [{ files }]);
  return { clone, next: commits[0] };
}

const newestReflogRecord = (dir) =>
  fs
    .readFileSync(path.join(dir, ".git", "logs", "HEAD"), "utf8")
    .trimEnd()
    .split("\n")
    .at(-1);

for (const { how, attributes } of [
  { how: "merge" },
  { how: "pull" },
  { how: "merge", attributes: "*.md text eol=crlf\n" },
]) {
  const label = attributes ? `${how} fast-forward under eol=crlf` : `${how} fast-forward`;
  test(`a clean ${label} during synthesis preserves the measured proposal`, () => {
    const skillPath = ".agents/skills/build/SKILL.md";
    const original = "---\nname: build\ndescription: Build the project.\n---\n\nRun make build.\n";
    const updated = original.replace("make build", "make release");
    const dir = makeCliRepo({
      memory: MEMORY,
      files: { [skillPath]: original, ...(attributes ? { ".gitattributes": attributes } : {}) },
    });
    const { clone, next } = upstreamCommit(dir, { [skillPath]: updated });
    if (how === "pull") {
      gitIn(dir, ["remote", "add", "origin", clone]);
      gitIn(dir, ["fetch", "-q", "origin"]);
      gitIn(dir, ["branch", "-q", "-u", "origin/main"]);
    }
    const run = runCli(dir, ["propose", ...PIN], {
      script: {
        edit: EDIT_TURN,
        repoGit:
          how === "pull"
            ? [{ cwd: dir, args: ["-c", "pull.rebase=false", "pull"] }]
            : [
                { cwd: dir, args: ["fetch", "-q", clone, "main"] },
                { cwd: dir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
              ],
        annotations: [{ reply: COALESCED_ANSWER }],
      },
    });
    assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), next);
    if (how === "pull") assert.match(gitIn(dir, ["reflog", "-1", "--format=%gs"]), /^pull: Fast-forward$/);
    assert.equal(
      fs.readFileSync(path.join(dir, skillPath), "utf8"),
      attributes ? updated.replaceAll("\n", "\r\n") : updated,
    );
    assert.equal(run.status, 0, run.output);
    assert.equal(proposalOf(dir).edits[0].kind, "extract");
    assert.deepEqual(proposalOf(dir).violations ?? [], []);
  });
}

test("a fast-forward with an expired synthesis-start reflog refuses with a clear reason", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const updated = `${MEMORY}\n- Updated by the upstream commit.\n`;
  const { clone } = upstreamCommit(dir, { "AGENTS.md": updated });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["merge", "--ff-only", "FETCH_HEAD"],
        ["reflog", "expire", "--expire=all", "--all"],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("AGENTS.md changed in the repository during synthesis"), run.output);
  assert.ok(run.output.includes("the synthesis-start HEAD entry cannot be found in the reflog"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), updated);
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "AGENTS.md"]), "");
});

for (const scenario of [
  {
    name: "an unrelated src/ commit",
    edit: { "src/app.js": "export const app = 2;\n" },
    after: [
      ["add", "src"],
      ["commit", "-qm", "unrelated work"],
    ],
  },
  {
    name: "checkout -b tmp and back to main",
    after: [
      ["checkout", "-q", "-b", "tmp"],
      ["checkout", "-q", "main"],
    ],
  },
  {
    name: "150 unrelated same-content checkouts",
    after: [
      ["branch", "tmp"],
      ...Array.from({ length: 150 }, (_, i) => ["checkout", "-q", i % 2 === 0 ? "tmp" : "main"]),
    ],
  },
  {
    name: "a local commit that edits AGENTS.md",
    edit: { "AGENTS.md": `${MEMORY}\n- An unsafe committed edit.\n` },
    after: [["commit", "-qam", "harness wrote the repository"]],
    refused: true,
  },
]) {
  test(`a fast-forward followed by ${scenario.name} is judged only on fingerprinted files`, () => {
    const skillPath = ".agents/skills/build/SKILL.md";
    const original = "---\nname: build\ndescription: Build the project.\n---\n\nRun make build.\n";
    const updated = original.replace("make build", "make release");
    const dir = makeCliRepo({
      memory: MEMORY,
      files: { [skillPath]: original, "src/app.js": "export const app = 1;\n" },
    });
    const { clone, next } = upstreamCommit(dir, { [skillPath]: updated });
    const edits = Object.fromEntries(
      Object.entries(scenario.edit || {}).map(([name, text]) => [path.join(dir, name), text]),
    );
    const run = runCli(dir, ["propose", ...PIN], {
      script: {
        edit: { ...EDIT_TURN, ...edits },
        repoGit: [["fetch", "-q", clone, "main"], ["merge", "--ff-only", "FETCH_HEAD"], ...scenario.after].map(
          (args) => ({ cwd: dir, args }),
        ),
        annotations: [{ reply: COALESCED_ANSWER }],
      },
    });
    assert.equal(gitIn(dir, ["merge-base", "--is-ancestor", next, "HEAD"]), "");
    assert.equal(gitIn(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    assert.equal(fs.readFileSync(path.join(dir, skillPath), "utf8"), updated);
    if (scenario.refused) {
      assert.equal(run.status, 1, run.output);
      assert.ok(run.output.includes("AGENTS.md"), run.output);
      assert.ok(run.output.includes("changed in the repository during synthesis"), run.output);
      assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
      assert.equal(gitIn(dir, ["status", "--porcelain", "--", "AGENTS.md"]), "");
    } else {
      assert.equal(run.status, 0, run.output);
      assert.equal(proposalOf(dir).edits[0].kind, "extract");
      assert.deepEqual(proposalOf(dir).violations ?? [], []);
    }
  });
}

test("a local AGENTS.md commit replayed as a fast-forward from the starting commit still refuses", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const start = gitIn(dir, ["rev-parse", "HEAD"]);
  const replayed = `${MEMORY}\n- An unsafe replayed edit.\n`;
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: { ...EDIT_TURN, [path.join(dir, "AGENTS.md")]: replayed },
      repoGit: [
        ["commit", "-qam", "harness wrote the repository"],
        ["checkout", "-q", "--detach", start],
        ["merge", "-q", "--ff-only", "main"],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.match(gitIn(dir, ["reflog", "-1", "--format=%gs"]), /^merge main: Fast-forward$/);
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "AGENTS.md"]), "");
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), replayed);
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("AGENTS.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

test("a replayed local commit with a partially expired start reflog still refuses", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const start = gitIn(dir, ["rev-parse", "HEAD"]);
  const replayed = `${MEMORY}\n- An unsafe replayed edit.\n`;
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: { ...EDIT_TURN, [path.join(dir, "AGENTS.md")]: replayed },
      repoGit: [
        ["commit", "-qam", "harness wrote the repository"],
        ["checkout", "-q", "--detach", start],
        ["merge", "-q", "--ff-only", "main"],
        ["reflog", "delete", "HEAD@{3}"],
        ["reflog", "delete", "HEAD@{2}"],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.match(gitIn(dir, ["reflog", "-1", "--format=%gs"]), /^merge main: Fast-forward$/);
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "AGENTS.md"]), "");
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), replayed);
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("the synthesis-start HEAD entry cannot be found in the reflog"), run.output);
  assert.ok(run.output.includes("AGENTS.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

test("a fast-forward does not excuse an uncommitted edit to another fingerprinted file", () => {
  const skillPath = ".agents/skills/build/SKILL.md";
  const original = "---\nname: build\ndescription: Build the project.\n---\n\nRun make build.\n";
  const dir = makeCliRepo({ memory: MEMORY, files: { [skillPath]: original } });
  const { clone } = upstreamCommit(dir, { [skillPath]: original.replace("make build", "make release") });
  const direct = `${MEMORY}\n- An unsafe direct edit.\n`;
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: { ...EDIT_TURN, [path.join(dir, "AGENTS.md")]: direct },
      repoGit: [
        { cwd: dir, args: ["fetch", "-q", clone, "main"] },
        { cwd: dir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
      ],
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("AGENTS.md changed in the repository during synthesis"), run.output);
  assert.ok(!run.output.includes(skillPath), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), direct);
});

test("a fast-forward through a symlinked CLAUDE.md pointer preserves the measured proposal", () => {
  const dir = makeCliRepo({ memory: MEMORY, links: { "CLAUDE.md": "AGENTS.md" } });
  const updated = MEMORY.replace("- Never use the em dash.", "- Never use the em dash or en dash.");
  const { clone, next } = upstreamCommit(dir, { "AGENTS.md": updated });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        { cwd: dir, args: ["fetch", "-q", clone, "main"] },
        { cwd: dir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
      ],
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), next, run.output);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), updated);
  assert.ok(!run.output.includes("changed in the repository during synthesis"), run.output);
  assert.equal(run.status, 0, run.output);
  assert.equal(proposalOf(dir).edits[0].kind, "extract");
});

test("a fast-forward does not excuse an uncommitted retarget of the CLAUDE.md symlink", () => {
  const dir = makeCliRepo({ memory: MEMORY, files: { "B.md": MEMORY }, links: { "CLAUDE.md": "AGENTS.md" } });
  const { clone, next } = upstreamCommit(dir, { "B.md": MEMORY.replace("- Never use the em dash.", "- Never.") });
  const patch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-retarget-")), "retarget.patch");
  fs.writeFileSync(
    patch,
    [
      "diff --git a/CLAUDE.md b/CLAUDE.md",
      "--- a/CLAUDE.md",
      "+++ b/CLAUDE.md",
      "@@ -1 +1 @@",
      "-AGENTS.md",
      "\\ No newline at end of file",
      "+B.md",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        { cwd: dir, args: ["fetch", "-q", clone, "main"] },
        { cwd: dir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
        { cwd: dir, args: ["apply", patch] },
      ],
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), next);
  assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), "B.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "CLAUDE.md"]), "M CLAUDE.md");
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("CLAUDE.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

for (const scenario of [
  { name: "an untracked CLAUDE.md symlink" },
  { name: "an ignored CLAUDE.md symlink", ignore: true },
  {
    name: "an untracked CLAUDE.md symlink retargeted during synthesis",
    swap: { link: "B.md" },
    refused: true,
  },
  {
    name: "an untracked CLAUDE.md symlink replaced by a regular file",
    swap: { text: true },
    refused: true,
  },
]) {
  test(`a fast-forward of AGENTS.md through ${scenario.name} is judged by the link's own target`, () => {
    const dir = makeCliRepo({
      memory: MEMORY,
      files: {
        "B.md": `${MEMORY}\n- A different file.\n`,
        ...(scenario.ignore ? { ".gitignore": "CLAUDE.md\n" } : {}),
      },
      links: { "CLAUDE.md": "AGENTS.md" },
    });
    if (!scenario.ignore) {
      gitIn(dir, ["rm", "-q", "--cached", "CLAUDE.md"]);
      gitIn(dir, ["commit", "-qm", "untrack the pointer"]);
    }
    assert.equal(
      gitIn(dir, ["status", "--porcelain", "--ignored", "--", "CLAUDE.md"]),
      scenario.ignore ? "!! CLAUDE.md" : "?? CLAUDE.md",
    );
    const updated = MEMORY.replace("- Never use the em dash.", "- Never use the em dash or en dash.");
    const { clone, next } = upstreamCommit(dir, { "AGENTS.md": updated });
    const claude = path.join(dir, "CLAUDE.md");
    const swap = scenario.swap?.text ? { text: updated } : scenario.swap;
    const run = runCli(dir, ["propose", ...PIN], {
      script: {
        edit: EDIT_TURN,
        ...(swap ? { swap: { [claude]: swap } } : {}),
        repoGit: [
          { cwd: dir, args: ["fetch", "-q", clone, "main"] },
          { cwd: dir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
        ],
        annotations: [{ reply: COALESCED_ANSWER }],
      },
    });
    assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), next, run.output);
    assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), updated);
    if (scenario.refused) {
      assert.equal(fs.lstatSync(claude).isSymbolicLink(), Boolean(scenario.swap.link));
      assert.equal(run.status, 1, run.output);
      assert.ok(run.output.includes("CLAUDE.md changed in the repository during synthesis"), run.output);
      assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
    } else {
      assert.equal(fs.readlinkSync(claude), "AGENTS.md");
      assert.ok(!run.output.includes("changed in the repository during synthesis"), run.output);
      assert.equal(run.status, 0, run.output);
      assert.equal(proposalOf(dir).edits[0].kind, "extract");
    }
  });
}

test("a fast-forward that retargets the CLAUDE.md symlink to an unchanged file preserves the measured proposal", () => {
  const moved = MEMORY.replace("- Never use the em dash.", "- Never use the em dash or en dash.");
  const dir = makeCliRepo({ memory: MEMORY, files: { "docs/AGENTS.md": moved }, links: { "CLAUDE.md": "AGENTS.md" } });
  const {
    clone,
    commits: [next],
  } = upstreamHistory(dir, [{ links: { "CLAUDE.md": "docs/AGENTS.md" } }]);
  assert.equal(gitIn(clone, ["diff", "--name-only", "HEAD~1", "HEAD"]), "CLAUDE.md");
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        { cwd: dir, args: ["fetch", "-q", clone, "main"] },
        { cwd: dir, args: ["merge", "--ff-only", "FETCH_HEAD"] },
      ],
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), next, run.output);
  assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), "docs/AGENTS.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "CLAUDE.md", "docs"]), "");
  assert.ok(!run.output.includes("changed in the repository during synthesis"), run.output);
  assert.equal(run.status, 0, run.output);
  assert.equal(proposalOf(dir).edits[0].kind, "extract");
});

test("a checkout that edits an intermediate CLAUDE.md target between retargeting fast-forwards still refuses", () => {
  const dir = makeCliRepo({
    memory: MEMORY,
    files: { "B.md": `${MEMORY}\n- B.\n`, "C.md": `${MEMORY}\n- C.\n` },
    links: { "CLAUDE.md": "AGENTS.md" },
  });
  const {
    clone,
    commits: [toB, editB, toC],
  } = upstreamHistory(dir, [
    { links: { "CLAUDE.md": "B.md" } },
    { files: { "B.md": `${MEMORY}\n- B, edited by a checkout.\n` } },
    { links: { "CLAUDE.md": "C.md" } },
  ]);
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["merge", "--ff-only", toB],
        ["checkout", "-q", "--detach", editB],
        ["merge", "--ff-only", toC],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), toC);
  assert.match(gitIn(dir, ["reflog", "-1", "--format=%gs"]), /: Fast-forward$/);
  assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), "C.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "CLAUDE.md", "B.md", "C.md"]), "");
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("CLAUDE.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

test("an uncommitted edit to an intermediate CLAUDE.md target between retargeting fast-forwards still refuses", () => {
  const dir = makeCliRepo({
    memory: MEMORY,
    files: { "B.md": `${MEMORY}\n- B.\n`, "C.md": `${MEMORY}\n- C.\n` },
    links: { "CLAUDE.md": "AGENTS.md" },
  });
  const {
    clone,
    commits: [toB, toC],
  } = upstreamHistory(dir, [{ links: { "CLAUDE.md": "B.md" } }, { links: { "CLAUDE.md": "C.md" } }]);
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-dirty-intermediate-"));
  const patch = path.join(patchDir, "edit.patch");
  fs.writeFileSync(path.join(clone, "B.md"), `${MEMORY}\n- B, uncommitted harness edit.\n`);
  fs.writeFileSync(patch, execFileSync("git", ["diff", "--", "B.md"], { cwd: clone, encoding: "utf8" }));
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["merge", "--ff-only", toB],
        ["apply", patch],
        ["merge", "--ff-only", toC],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  fs.rmSync(patchDir, { recursive: true, force: true });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), toC, run.output);
  assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), "C.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "CLAUDE.md", "AGENTS.md", "C.md"]), "");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "B.md"]), "M B.md");
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("CLAUDE.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

test("an untracked CLAUDE.md link does not hide an uncommitted historical target behind a tracked pointer", () => {
  const dir = makeCliRepo({
    memory: MEMORY,
    files: { "B.md": `${MEMORY}\n- B.\n`, "C.md": `${MEMORY}\n- C.\n` },
    links: { "CLAUDE.md": "POINTER.md", "POINTER.md": "AGENTS.md" },
  });
  gitIn(dir, ["rm", "--cached", "CLAUDE.md"]);
  gitIn(dir, ["commit", "-qm", "keep local CLAUDE pointer untracked"]);
  const {
    clone,
    commits: [toB, toC],
  } = upstreamHistory(dir, [{ links: { "POINTER.md": "B.md" } }, { links: { "POINTER.md": "C.md" } }]);
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-local-link-intermediate-"));
  const patch = path.join(patchDir, "edit.patch");
  fs.writeFileSync(path.join(clone, "B.md"), `${MEMORY}\n- B, uncommitted harness edit.\n`);
  fs.writeFileSync(patch, execFileSync("git", ["diff", "--", "B.md"], { cwd: clone, encoding: "utf8" }));
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["merge", "--ff-only", toB],
        ["apply", patch],
        ["merge", "--ff-only", toC],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  fs.rmSync(patchDir, { recursive: true, force: true });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), toC, run.output);
  assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), "POINTER.md");
  assert.equal(fs.readlinkSync(path.join(dir, "POINTER.md")), "C.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "POINTER.md", "AGENTS.md", "C.md"]), "");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "CLAUDE.md"]), "?? CLAUDE.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "B.md"]), "M B.md");
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("CLAUDE.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

test("an uncommitted edit to an absolute intermediate CLAUDE.md target between fast-forwards still refuses", () => {
  const dir = makeCliRepo({
    memory: MEMORY,
    files: { "B.md": `${MEMORY}\n- B.\n`, "C.md": `${MEMORY}\n- C.\n` },
    links: { "CLAUDE.md": "AGENTS.md" },
  });
  const {
    clone,
    commits: [toB, toC],
  } = upstreamHistory(dir, [{ links: { "CLAUDE.md": path.join(dir, "B.md") } }, { links: { "CLAUDE.md": "C.md" } }]);
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-absolute-intermediate-"));
  const patch = path.join(patchDir, "edit.patch");
  fs.writeFileSync(path.join(clone, "B.md"), `${MEMORY}\n- Dirty absolute historical B.\n`);
  fs.writeFileSync(patch, execFileSync("git", ["diff", "--", "B.md"], { cwd: clone, encoding: "utf8" }));
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["merge", "--ff-only", toB],
        ["apply", patch],
        ["merge", "--ff-only", toC],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  fs.rmSync(patchDir, { recursive: true, force: true });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), toC, run.output);
  assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), "C.md");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "CLAUDE.md", "AGENTS.md", "C.md"]), "");
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "B.md"]), "M B.md");
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("CLAUDE.md changed in the repository during synthesis"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

test("message-less reflog records are traversed, and a fast-forward around them is still excused", () => {
  const skillPath = ".agents/skills/build/SKILL.md";
  const original = "---\nname: build\ndescription: Build the project.\n---\n\nRun make build.\n";
  const updated = original.replace("make build", "make release");
  const dir = makeCliRepo({
    memory: MEMORY,
    files: { [skillPath]: original, "src/app.js": "export const app = 1;\n" },
  });
  gitIn(dir, ["update-ref", "HEAD", gitIn(dir, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "scripted"])]);
  assert.ok(!newestReflogRecord(dir).includes("\t"), newestReflogRecord(dir));
  const {
    clone,
    commits: [next, unrelated],
  } = upstreamHistory(dir, [
    { files: { [skillPath]: updated } },
    { files: { "src/app.js": "export const app = 2;\n" } },
  ]);
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["merge", "--ff-only", next],
        ["update-ref", "HEAD", unrelated],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), unrelated);
  assert.ok(!newestReflogRecord(dir).includes("\t"), newestReflogRecord(dir));
  assert.equal(fs.readFileSync(path.join(dir, skillPath), "utf8"), updated);
  assert.equal(run.status, 0, run.output);
  assert.equal(proposalOf(dir).edits[0].kind, "extract");
});

test("a message-less HEAD move that changes AGENTS.md refuses as a direct change, not as lost history", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const updated = `${MEMORY}\n- Moved in by a scripted ref update.\n`;
  const { clone, next } = upstreamCommit(dir, { "AGENTS.md": updated });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      repoGit: [
        ["fetch", "-q", clone, "main"],
        ["update-ref", "HEAD", next],
        ["checkout", "HEAD", "--", "AGENTS.md"],
      ].map((args) => ({ cwd: dir, args })),
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(gitIn(dir, ["rev-parse", "HEAD"]), next);
  assert.ok(!newestReflogRecord(dir).includes("\t"), newestReflogRecord(dir));
  assert.equal(gitIn(dir, ["status", "--porcelain", "--", "AGENTS.md"]), "");
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), updated);
  assert.equal(run.status, 1, run.output);
  assert.ok(run.output.includes("AGENTS.md changed in the repository during synthesis"), run.output);
  assert.ok(!run.output.includes("cannot be found in the reflog"), run.output);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
});

for (const scenario of [
  { name: "an uncommitted src/ edit and new file", git: [] },
  {
    name: "an unrelated src/ commit",
    git: [
      ["add", "src"],
      ["commit", "-qm", "unrelated work"],
    ],
  },
]) {
  test(`${scenario.name} outside the fingerprint does not discard synthesis`, () => {
    const dir = makeCliRepo({ memory: MEMORY, files: { "src/app.js": "export const app = 1;\n" } });
    const run = runCli(dir, ["propose", ...PIN], {
      script: {
        edit: {
          ...EDIT_TURN,
          [path.join(dir, "src", "app.js")]: "export const app = 2;\n",
          [path.join(dir, "src", "new.js")]: "export const fresh = true;\n",
        },
        repoGit: scenario.git.map((args) => ({ cwd: dir, args })),
        annotations: [{ reply: COALESCED_ANSWER }],
      },
    });
    assert.equal(run.status, 0, run.output);
    assert.equal(proposalOf(dir).edits[0].kind, "extract");
    assert.equal(fs.readFileSync(path.join(dir, "src", "app.js"), "utf8"), "export const app = 2;\n");
    assert.equal(fs.readFileSync(path.join(dir, "src", "new.js"), "utf8"), "export const fresh = true;\n");
  });
}

test("user scope with a git-tracked HOME is not refused for churn outside the fingerprint", () => {
  const project = makeCliRepo({ memory: MEMORY });
  const { home, env } = makeCliUserHome({ memory: MEMORY, project });
  const run = runCli(project, ["propose", "--scope", "user", ...PIN], {
    env,
    script: {
      edit: {
        ".agents/AGENTS.md": { replace: [[BOTH_SECTIONS, POINTERS]] },
        "__SKILLS_DIR__/release-checklist/SKILL.md": skill("release-checklist"),
        "__SKILLS_DIR__/incident-response/SKILL.md": skill("incident-response"),
        [path.join(home, ".zsh_history")]: "git status\n",
      },
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });
  assert.equal(run.status, 0, run.output);
  const proposal = readJson(path.join(home, ".config", "backpass", "user", "proposal.json"));
  assert.equal(proposal.scope, "user");
  assert.equal(proposal.edits[0].kind, "extract");
  assert.ok(gitIn(home, ["status", "--porcelain"]).includes(".zsh_history"));
});

for (const scenario of [
  { name: "uncommitted tracked edit", file: "AGENTS.md", text: `${MEMORY}\n- An unsafe direct edit.\n` },
  {
    name: "staged tracked edit",
    file: "AGENTS.md",
    text: `${MEMORY}\n- An unsafe staged edit.\n`,
    git: [["add", "AGENTS.md"]],
  },
  {
    name: "harness-made commit",
    file: "AGENTS.md",
    text: `${MEMORY}\n- An unsafe committed edit.\n`,
    git: [
      ["add", "AGENTS.md"],
      ["commit", "-qm", "harness wrote the repository"],
    ],
  },
]) {
  test(`synthesis refuses a ${scenario.name} and names the changed file`, () => {
    const dir = makeCliRepo({ memory: MEMORY });
    const run = runCli(dir, ["propose", ...PIN], {
      script: {
        edit: { ...EDIT_TURN, [path.join(dir, scenario.file)]: scenario.text },
        repoGit: (scenario.git || []).map((args) => ({ cwd: dir, args })),
        annotations: [{ reply: COALESCED_ANSWER }],
      },
    });
    assert.equal(run.status, 1, run.output);
    assert.ok(run.output.includes(`${scenario.file} changed in the repository during synthesis`), run.output);
    assert.ok(run.output.includes("nothing was proposed"), run.output);
    assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);
    assert.equal(fs.readFileSync(path.join(dir, scenario.file), "utf8"), scenario.text);
    if (scenario.git) {
      const status = execFileSync("git", ["status", "--porcelain", "--", scenario.file], {
        cwd: dir,
        encoding: "utf8",
      });
      if (scenario.name === "harness-made commit") assert.equal(status, "", "a clean harness commit must still refuse");
      else assert.ok(status.startsWith("M "), status);
    }
  });
}

test("propose stages extracts in an existing configured Claude skills directory", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".backpassrc.json"), JSON.stringify({ skillsDir: ".claude\\skills\\" }));
  const claudePointers = POINTERS.replaceAll(".agents/skills", ".claude/skills");
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: {
        "AGENTS.md": { replace: [[BOTH_SECTIONS, claudePointers]] },
        "__SKILLS_DIR__/release-checklist/SKILL.md": skill("release-checklist"),
        "__SKILLS_DIR__/incident-response/SKILL.md": skill("incident-response"),
      },
      annotations: [{ reply: COALESCED_ANSWER }],
    },
  });

  assert.equal(run.status, 0, `the run should succeed:\n${run.output}`);
  const staged = stagedTree(dir);
  assert.ok(staged[".claude/skills/release-checklist/SKILL.md"]);
  assert.ok(staged[".claude/skills/incident-response/SKILL.md"]);
  assert.equal(staged[".agents/skills/release-checklist/SKILL.md"], undefined);
  assert.deepEqual(
    proposalOf(dir).edits[0].hunks.map((hunk) => hunk.file),
    ["AGENTS.md"],
  );
  assert.deepEqual(
    proposalOf(dir)
      .edits[0].skills.map((skill) => skill.path)
      .sort(),
    [".claude/skills/incident-response/SKILL.md", ".claude/skills/release-checklist/SKILL.md"],
  );
});

test("a remeasurement is not a failed annotation: it costs no attempt, and the new ids get a real one", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        // 1: judged and rejected - the one edit carries no evidence quote.
        { reply: { edits: [extract(["H1", "H2", "H3"], "extract two playbooks", { evidence: [] })] } },
        // 2: the agent splits the copy instead of answering. The ids move.
        SPLIT_THE_COPY,
        // 3: judged and rejected again - H4 is left out of every edit.
        { reply: { edits: [extract(["H1", "H4"], "extract the release checklist")] } },
        // 4: the third and last annotation attempt, and it passes.
        { reply: SPLIT_ANSWER },
      ],
    },
  });

  assert.equal(run.status, 0, `the run should succeed:\n${run.output}`);
  assert.equal(run.annotateTurns(), 4, "four turns, because one of them only moved the files");
  const proposal = proposalOf(dir);
  assert.equal(proposal.attempt, 3, "three annotation attempts were judged, not four");
  assert.deepEqual(proposal.violations ?? [], []);
  assert.equal(proposal.edits.length, 2);

  // turn 1 plain · turn 2 corrects turn 1 · turn 3 re-annotates the moved ids · turn 4 corrects turn 3
  const prompts = annotatePrompts(dir);
  assert.equal(prompts.length, 4);
  assert.ok(prompts[1].includes("Your previous answer was rejected"));
  assert.ok(prompts[1].includes("carries no verbatim evidence quote"));
  assert.ok(prompts[2].includes("The files moved after they were measured"));
  assert.ok(
    !prompts[2].includes("Your previous answer was rejected"),
    "the turn after a remeasurement asks for an annotation, not a correction",
  );
  assert.ok(prompts[2].includes("did not use up an annotation attempt"));
  assert.ok(prompts[2].includes("[H4: new file"), "and it asks about the re-measured ids");
  assert.ok(prompts[3].includes("Your previous answer was rejected"));
  assert.ok(prompts[3].includes("is not part of any edit"));
});

test("the remeasurement limit stops on the declared third file-moving turn", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        SPLIT_THE_COPY,
        { editFirst: { "AGENTS.md": { replace: [[SPLIT, POINTERS]] } }, reply: { edits: [] } },
        SPLIT_THE_COPY,
        { reply: SPLIT_ANSWER },
      ],
    },
  });

  assert.equal(run.status, 1, `the run should stop at the limit:\n${run.output}`);
  assert.equal(run.annotateTurns(), 3);
  assert.match(run.stderr, /kept editing the staging copy instead of annotating it \(3 re-measurements\)/);
});

test("an empty turn is retried once in a fresh session, with the evidence it would otherwise have lost", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ empty: true }, { reply: COALESCED_ANSWER }] },
  });

  assert.equal(run.status, 0, `the run should succeed:\n${run.output}`);
  assert.match(run.stderr, /ended its turn with no output; retrying the annotation once in a fresh session/);
  assert.equal(run.editTurns(), 1, "the expensive editing turn is not repeated");
  assert.equal(run.sessionsOpened(), 2, "the retry runs in a new session, not the one that went quiet");

  const sessions = run.calls().filter((c) => c.session);
  assert.equal(new Set(sessions.map((c) => c.session)).size, 2);
  assert.notEqual(
    run.calls().find((c) => c.turn === "annotate" && c.prompt.includes("joining a synthesis run")).session,
    run.calls().find((c) => c.turn === "edit").session,
  );

  // The fresh session never saw the editing turn, so the annotate prompt has to carry the
  // repository, the file, and the evidence every edit must quote.
  const [, retry] = annotatePrompts(dir);
  assert.ok(retry.includes("You are joining a synthesis run already in progress"));
  assert.ok(retry.includes("The edits below are already made."));
  assert.ok(retry.includes("session 1 re-derived the release steps by hand"), "the evidence travels with it");
  assert.ok(retry.includes("## Measured changes"));

  const proposal = proposalOf(dir);
  assert.deepEqual(proposal.violations ?? [], []);
  assert.equal(proposal.attempt, 1, "the empty turn was never an annotation attempt");
  assert.equal(proposal.edits.length, 1);
});

test("a run that ends on an empty turn says so, and never reads an older proposal as that turn's answer", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        { reply: { edits: [extract(["H1", "H2", "H3"], "extract two playbooks", { evidence: [] })] } },
        SPLIT_THE_COPY,
        { empty: true },
        { empty: true },
      ],
    },
  });

  assert.equal(run.status, 1, `the run should fail:\n${run.output}`);
  assert.equal(run.sessionsOpened(), 2, "the empty turn was retried in a fresh session before giving up");

  // The failure is named after the turn that ended the run.
  assert.match(run.stderr, /ended its turn with no output at all/);
  assert.match(run.stderr, /no output, in the run's session and again in a fresh one/);
  assert.doesNotMatch(run.stderr, /no parseable JSON/);

  // The proposal on disk is from an earlier attempt, and is reported as such rather than
  // as what the empty turn produced.
  assert.match(run.stderr, /it is from annotation attempt 1, not the turn above/);
  assert.match(run.stderr, /carries no verbatim evidence quote/);

  // The advice is about the condition the run actually ended on.
  assert.match(run.stderr, /run `backpass propose` again to start a fresh synthesis session/);
  assert.doesNotMatch(run.stderr, /stronger synthesis model/);
  assert.doesNotMatch(run.stderr, /--budget/);
  assert.doesNotMatch(run.stderr, /--max-edits/);

  const proposal = proposalOf(dir);
  assert.equal(proposal.attempt, 1);
  assert.equal(proposal.edits.length, 0);
  assert.ok(proposal.violations.some((v) => /carries no verbatim evidence quote/.test(v)));
  assert.ok(
    !proposal.violations.some((v) => /no output|parseable JSON/.test(v)),
    "the empty turn wrote nothing into the rejected proposal",
  );
  const staged = stagedTree(dir);
  assert.ok(staged["AGENTS.md"].includes("## Incident response"));
  assert.ok(staged[".agents/skills/release-checklist/SKILL.md"]);
  assert.ok(staged[".agents/skills/incident-response/SKILL.md"]);
});

test("an edit turn that changes nothing, then answers blank, fails as edit-empty rather than a generic empty turn", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: { edit: {}, annotations: [{ empty: true }] },
  });

  assert.equal(run.status, 1, `the run should fail:\n${run.output}`);
  assert.equal(run.editTurns(), 1);
  // Retrying in a fresh session would show the same empty diff again, so the first blank
  // turn ends the run immediately instead of spending the usual empty-turn retry.
  assert.equal(run.annotateTurns(), 1);
  assert.equal(run.sessionsOpened(), 1);

  assert.match(run.stderr, /made no changes to the staging copy during the edit turn/);
  assert.doesNotMatch(run.stderr, /no output, in the run's session and again in a fresh one/);
  assert.match(run.stderr, /run `backpass propose` again, or pin a different harness with --synthesis-agent/);

  assert.ok(!fs.existsSync(path.join(dir, ".backpass", "proposal.json")), "no proposal was saved");
});

test("an edit turn that only writes a stray out-of-scope file is not mistaken for an untouched staging copy", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: { "scratch.txt": "notes left behind by the edit turn" },
      annotations: [{ empty: true }, { empty: true }],
    },
  });

  assert.equal(run.status, 1, `the run should fail:\n${run.output}`);
  assert.equal(
    run.sessionsOpened(),
    2,
    "a stray-only edit still counts as touched, so the usual empty-turn retry runs instead of an immediate edit-empty",
  );
  assert.match(run.stderr, /no output, in the run's session and again in a fresh one/);
  assert.doesNotMatch(run.stderr, /made no changes to the staging copy during the edit turn/);
});

test("a rejected proposal's notes are printed with the failure", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        {
          reply: {
            edits: [extract(["H1", "H2", "H3"], "extract two playbooks", { evidence: [] })],
            notes: ["Code Mode is unavailable because code-mode host is disabled."],
          },
        },
      ],
    },
  });

  assert.equal(run.status, 1, `the run should fail:\n${run.output}`);
  assert.match(run.stderr, /carries no verbatim evidence quote/);
  assert.match(run.stderr, /the rejected proposal noted:/);
  assert.match(run.stderr, /code-mode host is disabled/);
});

test("rejected proposal notes cannot inject terminal controls", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: EDIT_TURN,
      annotations: [
        {
          reply: {
            edits: [extract(["H1", "H2", "H3"], "extract two playbooks", { evidence: [] })],
            notes: ["permission failure\u001b]52;c;dGVzdA==\u0007\nforged diagnostic"],
          },
        },
      ],
    },
  });

  assert.equal(run.status, 1, `the run should fail:\n${run.output}`);
  assert.match(run.stderr, /permission failure.*forged diagnostic/);
  // eslint-disable-next-line no-control-regex -- these terminal controls are the malicious input
  assert.doesNotMatch(run.stderr, /\u001b|\u0007/);
});

test("a failed synthesis invalidates an older applicable proposal", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const succeeded = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ reply: COALESCED_ANSWER }] },
  });
  assert.equal(succeeded.status, 0, `the first proposal should succeed:\n${succeeded.output}`);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), true);

  const failed = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ reply: "not json" }] },
  });
  assert.equal(failed.status, 1, `the second synthesis should fail:\n${failed.output}`);
  assert.equal(fs.existsSync(path.join(dir, ".backpass", "proposal.json")), false);

  const applied = runCli(dir, ["apply", "--no-open"]);
  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /no proposal to apply/);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), MEMORY);
});

test("skills whose removals merged into one change ship as one decision, and apply writes them together", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: { edit: EDIT_TURN, annotations: [{ reply: COALESCED_ANSWER }] },
  });

  assert.equal(run.status, 0, `two skills against one merged change is a legal extract:\n${run.output}`);

  // The loss signal reaches the deciding model whole: the negative's class and its
  // effect text are in the synthesis prompt, not just a sign and a bare quote.
  const editPrompt = fs.readFileSync(path.join(dir, ".backpass", "prompts", "synthesis-edit.md"), "utf8");
  assert.match(
    editPrompt,
    /- \[harm\] "session 1 re-derived the release steps by hand" :: following the stale steps wasted a turn/,
  );
  assert.match(editPrompt, /harm-sessions=3/);

  // Extraction is offered as an available option, not urged: the deciding model must not
  // read the prompt as pushing it toward a skill when the evidence does not ask for one.
  assert.match(editPrompt, /You can extract a long, narrow, crisply-triggered section instead of deleting it/);
  assert.ok(!/Prefer extracting/.test(editPrompt), "hard rule 8 states permission, never preference");
  assert.ok(
    !/nearly pure budget profit/.test(editPrompt),
    "the placement table's follow-up states the mechanics, it does not re-add the nudge",
  );

  const proposal = proposalOf(dir);
  assert.equal(proposal.edits.length, 1, "one merged change cannot be accepted in halves, so it is one decision");
  assert.equal(proposal.edits[0].hunks.length, 1);
  assert.deepEqual(proposal.edits[0].skills.map((s) => s.name).sort(), ["incident-response", "release-checklist"]);
  assert.equal(proposal.stats.skillExtractions, 2, "two skills, on one card");

  const applied = runCli(dir, ["apply", "--no-open"], { env: applyEnv("e1=accepted") });
  assert.equal(applied.status, 0, `apply should write both skills:\n${applied.output}`);

  const memory = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(memory.includes("- Release steps: .agents/skills/release-checklist/SKILL.md"));
  assert.ok(memory.includes("- Incidents: .agents/skills/incident-response/SKILL.md"));
  assert.ok(!memory.includes("- Page the on-call before rolling back."));
  for (const name of ["release-checklist", "incident-response"]) {
    const written = fs.readFileSync(path.join(dir, ".agents", "skills", name, "SKILL.md"), "utf8");
    assert.ok(written.includes(`name: ${name}`), `${name} was written, so the pointer is not dangling`);
  }
});

test("skills measured as separate changes stay separate decisions: bundling them is refused with the fix", () => {
  const dir = makeCliRepo({ memory: MEMORY });
  const run = runCli(dir, ["propose", ...PIN], {
    script: {
      edit: { ...EDIT_TURN, "AGENTS.md": { replace: [[BOTH_SECTIONS, SPLIT]] } },
      // One extract for two skills whose removals were measured apart: taking that as one
      // decision would deny the reviewer a choice the file can actually honour.
      annotations: [
        { reply: { edits: [extract(["H1", "H2", "H3", "H4"], "extract both playbooks")] } },
        { reply: SPLIT_ANSWER },
      ],
    },
  });

  assert.equal(run.status, 0, `the corrected answer should pass:\n${run.output}`);
  const second = annotatePrompts(dir)[1];
  assert.ok(second.includes("groups 2 created skills against 2 separate changes"));
  assert.ok(second.includes("give each skill its own extract"));

  const proposal = proposalOf(dir);
  assert.equal(proposal.edits.length, 2);
  assert.deepEqual(
    proposal.edits.map((e) => e.skills.length),
    [1, 1],
  );

  // Both cards are decidable on their own: one accepted, one rejected, and the file takes
  // exactly the accepted half.
  const applied = runCli(dir, ["apply", "--no-open"], { env: applyEnv("e1=accepted e2=rejected") });
  assert.equal(applied.status, 0, `apply should honour the split decision:\n${applied.output}`);
  const memory = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(memory.includes("- Release steps: .agents/skills/release-checklist/SKILL.md"));
  assert.ok(memory.includes("- Page the on-call before rolling back."), "the rejected extraction stayed in the file");
  assert.equal(fs.existsSync(path.join(dir, ".agents", "skills", "release-checklist", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(dir, ".agents", "skills", "incident-response", "SKILL.md")), false);
});

/** The fake review surface, answering with one decision vector. */
function applyEnv(decisions) {
  const scenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "backpass-lavish-")), "scenario.json");
  fs.writeFileSync(
    scenario,
    JSON.stringify({
      polls: [
        `prompts[1]{uid,prompt,selector,tag,text}:\n  "1","BACKPASS_DECISIONS ${decisions}",button#btn-apply,choice,${decisions}`,
      ],
    }),
  );
  return { BACKPASS_LAVISH_BIN: FAKE_LAVISH, FAKE_LAVISH_SCENARIO: scenario };
}
