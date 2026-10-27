import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { extractJson, isBlankOutput, openSession, usageRecord } from "./acpx.js";
import { expandHomePath, userClaudeSkillsDir } from "./config.js";
import { renderEvidenceForPrompt } from "./fold.js";
import { renderInstructionIndex, resolveMemoryPath } from "./memory.js";
import { renderPrompt, render, loadPrompt } from "./prompts.js";
import { buildProposal, effectiveMaxEdits, ProposalViolation, renderChangesForPrompt } from "./proposal.js";
import {
  loadProjectSkills,
  renderSkillIndex,
  resolveOverflowTarget,
  resolveProjectSkillDirs,
  skillDescriptionTokens,
} from "./skills.js";
import { isSuppressedByRejection } from "./state.js";
import { SURFACE_TARGET } from "./target.js";
import { emitProgress } from "./progress.js";
import {
  READ_ONLY_SEARCH_PATH,
  measureWorkspace,
  prepareWorkspace,
  rebaseFingerprint,
  repoFilePath,
  repoFingerprint,
  workspacePathFor,
} from "./workspace.js";
import { UserError, color, info, warn } from "./logger.js";

/**
 * Stage 3 of the pipeline (design section 3): high-reasoning synthesis that turns folded
 * evidence into concrete edits.
 *
 * The agent never describes an edit for backpass to locate - it makes the edit, with its
 * harness's own file tools, in a staging copy of the memory file and project skills
 * (`src/workspace.js`). A run starts in one session with two kinds of turn:
 *
 *   edit      the synthesis prompt; the agent edits `./AGENTS.md` in the staging copy
 *   annotate  backpass measures the copy against the original (`src/diff.js`) and shows
 *             the changes by id; the agent attaches kind, title, rationale, and evidence
 *
 * An empty annotation turn is retried once in a fresh session, as described below.
 *
 * The annotation is what the mechanical gates validate (`buildProposal`). A parseable
 * gate-rejected answer is saved before the agent is re-prompted with the exact breaches;
 * judged answers are bounded by ANNOTATE_TURNS, then backpass fails loudly rather than
 * quietly trimming the result (design section 6). The repo is fingerprinted around each
 * turn; a harness that wrote past the staging copy is an error, never a silent apply.
 *
 * Three things an annotate turn can be are deliberately kept apart, because they call for
 * different responses and produce different advice at the end of a failed run:
 *
 *   the files moved      the ids the agent was asked about no longer exist. It is shown the
 *                        fresh measurement and answers again; this is not a failed
 *                        annotation and never costs an annotation attempt (REMEASURE_TURNS
 *                        bounds it instead).
 *   the turn was empty   the adapter returned success with no text at all. The model never
 *                        spoke, so there is nothing to correct - the annotation is retried
 *                        once in a NEW session, since the accumulated context of the old
 *                        one is the likeliest reason it collapsed.
 *   the answer was judged the model spoke and the gates ruled. Only this consumes an
 *                        annotation attempt, and only this writes a rejected proposal.
 */

/** Annotation attempts per run: the first answer plus re-prompts with the exact violations. */
export const ANNOTATE_TURNS = 3;
/**
 * Turns per run the agent may spend re-editing instead of answering. Counted for the whole
 * run, not consecutively: an agent that alternates editing and answering is still an agent
 * that never finishes, and the loop has to end.
 */
export const REMEASURE_TURNS = 3;
/** Fresh-session retries for an adapter turn that produced no text at all. */
export const EMPTY_TURN_RETRIES = 1;

const EMPTY_TURN_VIOLATION =
  "the synthesis harness ended its turn with no output at all - no JSON, no prose, no tool call";
const UNPARSEABLE_VIOLATION = "synthesis answered with text, but not with a JSON object";
const KEPT_EDITING_VIOLATION = "synthesis kept editing the staging copy instead of annotating the measured changes";
const EDIT_EMPTY_VIOLATION =
  "the synthesis edit turn left the staging copy byte-identical to the original, so its first annotate turn had nothing to describe";

/**
 * The budget the prompts frame is the always-loaded surface: the memory file plus
 * every skill description line, the same sum the mechanical gate measures
 * (`buildProposal`). Framing one number and gating another would set the model up to
 * fail a gate it was never told about.
 */
function budgetRule(memoryFile, config, maxEdits, descriptionTokens = 0, { extraction = true } = {}) {
  const remaining = config.budgetTokens - memoryFile.tokens - descriptionTokens;
  const counted = descriptionTokens
    ? ` The budget counts this file plus every skill description line (${descriptionTokens} tok of descriptions today); skill bodies stay free until triggered.`
    : "";
  if (remaining <= 0 && !extraction) {
    return (
      `This file is ALREADY ${Math.abs(remaining)} tokens OVER its budget, so this run is a SHRINK PLAN. ` +
      `You are NOT expected to reach ${config.budgetTokens} tokens in one run - the ${maxEdits}-edit cap ` +
      `makes that impossible and later runs continue the work. What is required is real progress: the edit ` +
      `set MUST be net-negative. Remove what has its harm-evidence floor, tighten what the evidence ` +
      `supports rewriting, and make any addition name the removal that pays for it.`
    );
  }
  if (remaining <= 0) {
    return (
      `The always-loaded surface is ALREADY ${Math.abs(remaining)} tokens OVER budget, so this run is a SHRINK ` +
      `PLAN. You are NOT expected to reach ${config.budgetTokens} tokens in one run - the ` +
      `${maxEdits}-edit cap for this run makes that impossible and later runs continue the work. ` +
      `What is required is real progress: the edit set MUST be net-negative, so lead with skill ` +
      `extractions of long, narrow, crisply-triggered sections - extraction frees the removed ` +
      `always-loaded tokens for the price of one description line and loses nothing, and it never needs removal ` +
      `evidence. Deleting an ` +
      `instruction outright still needs its harm-evidence floor; the budget never lowers that ` +
      `bar. Any addition must name the removal or extraction that pays for it. Make the largest ` +
      `honest reduction you can justify from the evidence.` +
      counted
    );
  }
  if (remaining < config.budgetTokens * 0.15) {
    return (
      `Only ${remaining} tokens of headroom remain. Treat this as zero-sum: every addition must ` +
      `name its offsetting removal${extraction ? " or skill extraction" : ""}. The post-edit always-loaded surface must stay at or below ` +
      `${config.budgetTokens} tokens.` +
      counted
    );
  }
  return (
    `The post-edit always-loaded surface must stay at or below ${config.budgetTokens} tokens ` +
    `(${remaining} tokens of headroom today).${counted}`
  );
}

function budgetState(memoryFile, config, descriptionTokens = 0) {
  const ratio = (memoryFile.tokens + descriptionTokens) / config.budgetTokens;
  if (ratio > 1) return "OVER BUDGET";
  if (ratio > 0.85) return "near budget";
  return "within budget";
}

export function renderRejections(rejections) {
  const entries = Object.values(rejections.entries || {});
  if (!entries.length) return "(none)";
  return entries
    .map((e) => {
      const bits = [`rejected ${e.rejectedAt.slice(0, 10)} with ${e.transcripts} session(s) of evidence`];
      const ids = [...(e.gapIds || []), ...(e.instructionIds || [])];
      if (ids.length) bits.push(`ids ${ids.join(", ")}`);
      if (e.reason) bits.push(`reason ${e.reason}`);
      return `- [${e.kind}] ${e.title} (${bits.join("; ")})`;
    })
    .join("\n");
}

function harnessCountsOf(transcripts) {
  const counts = {};
  for (const t of transcripts) counts[t.harness] = (counts[t.harness] || 0) + 1;
  return counts;
}

function synthesisGit(cwd, args) {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

const MAX_LINK_HOPS = 40;

/** Both checkout and historical-tree chains follow relative or absolute links only within the git root. */
function resolveLinkTarget(top, link, target, rest) {
  const absolute = path.resolve(path.dirname(link), target, ...rest);
  const relative = path.relative(top, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? absolute : null;
}

/**
 * Every in-repository path on the way to a fingerprinted file: each symlink it
 * passes through, then the file itself. A direct edit anywhere on the chain is a direct edit.
 */
function resolutionChain(top, absolute) {
  const chain = [];
  let current = absolute;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const relative = path.relative(top, current);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const parts = relative.split(path.sep);
    let link = null;
    for (let i = 0; i < parts.length && !link; i += 1) {
      const at = path.join(top, ...parts.slice(0, i + 1));
      let stat;
      try {
        stat = fs.lstatSync(at);
      } catch {
        break;
      }
      if (stat.isSymbolicLink()) link = { at, rest: parts.slice(i + 1) };
    }
    chain.push(relative.split(path.sep).join("/"));
    if (!link) return chain;
    if (link.rest.length) chain[chain.length - 1] = path.relative(top, link.at).split(path.sep).join("/");
    current = resolveLinkTarget(top, link.at, fs.readlinkSync(link.at), link.rest);
    if (!current) return null;
  }
  return null;
}

/** Fingerprinted keys as paths from the git top, before any symlink is followed. */
function gitOrigins(top, repo, files) {
  const root = fs.realpathSync(repo.root);
  const out = {};
  for (const file of files) {
    const relative = path.relative(repo.root, repoFilePath(repo, file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const origin = path.relative(top, path.join(root, relative));
    if (origin && !origin.startsWith("..") && !path.isAbsolute(origin)) out[file] = origin.split(path.sep).join("/");
  }
  return out;
}

/** Fingerprinted keys as git names them, through any symlinked pointer or skills dir. */
function gitChains(top, repo, files) {
  const out = {};
  for (const [file, origin] of Object.entries(gitOrigins(top, repo, files))) {
    const chain = resolutionChain(top, path.join(top, origin));
    if (chain) out[file] = chain;
  }
  return out;
}

/**
 * In-repository paths for each fingerprint, read from a commit's tree instead of the checkout.
 * Relative and absolute links use the checkout's target-resolution rule; an outside target
 * is not traversed, while an in-repository target is followed as recorded on each side.
 */
function treeChainPaths(top, commit, origins) {
  const prefixes = (relative) => relative.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const paths = new Map(Object.keys(origins).map((file) => [file, new Set()]));
  let pending = Object.entries(origins).map(([file, relative]) => ({ file, relative }));
  for (let hop = 0; hop < MAX_LINK_HOPS && pending.length; hop += 1) {
    const links = new Map();
    const entries = synthesisGit(top, [
      "ls-tree",
      "-z",
      commit,
      "--",
      ...new Set(pending.flatMap(({ relative }) => prefixes(relative))),
    ]);
    for (const entry of entries.split("\0")) {
      const match = /^120000 blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
      if (match) links.set(match[2], match[1]);
    }
    const next = [];
    for (const { file, relative } of pending) {
      const link = prefixes(relative).find((prefix) => links.has(prefix));
      paths.get(file).add(link ?? relative);
      if (!link) continue;
      const target = synthesisGit(top, ["cat-file", "blob", links.get(link)]);
      const resolved = resolveLinkTarget(top, path.join(top, link), target, [relative.slice(link.length + 1)]);
      if (resolved) next.push({ file, relative: path.relative(top, resolved).split(path.sep).join("/") });
    }
    pending = next;
  }
  return paths;
}

function linkTarget(at) {
  try {
    return fs.lstatSync(at).isSymbolicLink() ? fs.readlinkSync(at, { encoding: "buffer" }) : null;
  } catch {
    return null;
  }
}

/**
 * Git's own clean check, so checkout filters (autocrlf, smudge) do not read as edits.
 * Git cannot call an untracked or ignored symlink clean, so each one is returned apart with
 * its target, to be judged by that target alone; an untracked regular file stays dirty.
 */
function checkoutState(top, paths) {
  const dirty = [];
  const links = new Map();
  if (!paths.length) return { dirty, links };
  const entries = synthesisGit(top, [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored",
    "--no-renames",
    "--",
    ...paths,
  ])
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    const relative = entry.slice(3);
    const target = /^(\?\?|!!) /.test(entry) ? linkTarget(path.join(top, relative)) : null;
    if (target) links.set(relative, target);
    else dirty.push(relative);
  }
  return { dirty, links };
}

/** Newest-first raw records preserve operation identity, including both object IDs. */
function* headReflogRecords(file) {
  const fd = fs.openSync(file, "r");
  try {
    let position = fs.fstatSync(fd).size;
    let pending = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(position, 64 * 1024);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      if (fs.readSync(fd, chunk, 0, size, position) !== size) throw new Error("HEAD reflog changed while reading");
      const data = Buffer.concat([chunk, pending]);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i -= 1) {
        if (data[i] !== 10) continue;
        if (i + 1 < end) yield data.subarray(i + 1, end).toString("utf8");
        end = i;
      }
      pending = Buffer.from(data.subarray(0, end));
    }
    if (pending.length) yield pending.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function newestHeadReflogRecord(file) {
  for (const record of headReflogRecords(file)) return record;
  return null;
}

/** Only the fingerprinted files are inspected; the rest of the checkout is not backpass's to judge. */
function repoGitState(repo, files) {
  try {
    const [top, head] = synthesisGit(repo.root, ["rev-parse", "--show-toplevel", "HEAD"]).trim().split("\n");
    const root = fs.realpathSync(top);
    const chains = gitChains(root, repo, files);
    const origins = gitOrigins(root, repo, files);
    const reflog = path.resolve(root, synthesisGit(root, ["rev-parse", "--git-path", "logs/HEAD"]).trim());
    const startRecord = newestHeadReflogRecord(reflog);
    if (!startRecord || startRecord.split(" ", 2)[1] !== head) return null;
    return {
      root,
      head,
      reflog,
      startRecord,
      origins,
      chains,
      ...checkoutState(root, [...new Set(Object.values(chains).flat())]),
    };
  } catch {
    // User-scope memory and directory-only fixtures need not be git checkouts.
    return null;
  }
}

const REFLOG_UNAVAILABLE =
  "the synthesis-start HEAD entry cannot be found in the reflog; expired or rewritten history cannot establish which moves changed the fingerprinted files";

/**
 * Every HEAD move since the exact raw record captured at the start, not its mutable
 * index or a repeated commit hash. Both object IDs must join the next record, so partial
 * expiry cannot hide a local commit behind a later fast-forward. Judged only on the fingerprinted
 * paths it changes, following relative and absolute in-repository symlink targets in both
 * commits as well as at the start and now; outside targets are not traversed. A move that
 * changes none is left alone; one that does must be an ordinary
 * merge/pull fast-forward (a record with no message never is), or the exemption is lost,
 * since a harness's own commit, checkout, reset, or rebase looks the same as anyone else's.
 * Reflogs describe operations, not actors: a harness can itself fast-forward (or forge a
 * reflog). This is accidental write-through detection, not a sandbox against hostile tools.
 * Returns the fingerprinted paths fast-forwards changed and each fingerprinted file's visited
 * chain paths for the final cleanliness check, a reason when the synthesis-start boundary is unavailable,
 * or null for other unsafe moves.
 */
function fastForwardFiles(git, paths) {
  if (!paths.length) return { files: new Set(), visitedPaths: new Map() };
  try {
    const head = synthesisGit(git.root, ["rev-parse", "--verify", "HEAD"]).trim();
    const files = new Set();
    const visitedPaths = new Map(Object.entries(git.chains).map(([file, chain]) => [file, new Set(chain)]));
    let expected = head;
    let unsafe = false;
    const trees = new Map();
    const chainPaths = (commit) => {
      if (!trees.has(commit)) trees.set(commit, treeChainPaths(git.root, commit, git.origins));
      return trees.get(commit);
    };
    for (const record of headReflogRecords(git.reflog)) {
      const match = /^([0-9a-f]+) ([0-9a-f]+) [^\t]*(?:\t(.*))?$/.exec(record);
      if (!match) return { reason: REFLOG_UNAVAILABLE };
      const [, from, to, subject = ""] = match;
      if (to !== expected) return { reason: REFLOG_UNAVAILABLE };
      if (record === git.startRecord) {
        if (to !== git.head) return { reason: REFLOG_UNAVAILABLE };
        if (synthesisGit(git.root, ["rev-parse", "--verify", "HEAD"]).trim() !== head) return null;
        return unsafe ? null : { files, visitedPaths };
      }
      if (!unsafe && from !== to) {
        const moved = new Set(paths);
        for (const tree of [chainPaths(from), chainPaths(to)]) {
          for (const [file, chain] of tree) {
            if (!visitedPaths.has(file)) visitedPaths.set(file, new Set());
            for (const relative of chain) {
              moved.add(relative);
              visitedPaths.get(file).add(relative);
            }
          }
        }
        const touched = synthesisGit(git.root, ["diff", "--name-only", "--no-renames", "-z", from, to, "--", ...moved])
          .split("\0")
          .filter(Boolean);
        if (touched.length) {
          if (!/^(merge|pull)( .*)?: Fast-forward$/.test(subject)) unsafe = true;
          else {
            synthesisGit(git.root, ["merge-base", "--is-ancestor", from, to]);
            for (const file of touched) files.add(file);
          }
        }
      }
      expected = from;
    }
    return { reason: REFLOG_UNAVAILABLE };
  } catch (error) {
    if (error?.code === "ENOENT") return { reason: REFLOG_UNAVAILABLE };
    // Missing/pruned reflogs and non-forward history cannot establish an exemption.
  }
  return null;
}

/**
 * The changed fingerprinted files a clean fast-forward fully explains: a fast-forward changed
 * a path on its resolution chain (the file or a link retargeted upstream), no other kind of
 * move touched any chain, its starting chain was clean, and every in-repository path visited
 * on its own chains is clean now, including relative or absolute intermediate link targets
 * the current pointer no longer reaches. Targets outside the git root are not traversed.
 * An untracked or ignored symlink on a starting chain counts as clean only while it is still
 * an untracked or ignored symlink to the byte-identical target.
 */
function explainedByFastForward(repo, git, changed) {
  if (!git || !changed.length) return { files: new Set() };
  try {
    const chains = gitChains(git.root, repo, changed);
    const advanced = fastForwardFiles(git, [
      ...new Set([...Object.values(git.chains).flat(), ...Object.values(chains).flat()]),
    ]);
    if (!advanced?.files) return { files: new Set(), reason: advanced?.reason };
    const paths = (file) => [
      ...new Set([...git.chains[file], ...chains[file], ...(advanced.visitedPaths.get(file) ?? [])]),
    ];
    const named = changed.filter(
      (file) =>
        git.chains[file] &&
        chains[file] &&
        paths(file).some((relative) => advanced.files.has(relative)) &&
        !git.chains[file].some((relative) => git.dirty.includes(relative)),
    );
    const now = checkoutState(git.root, [...new Set(named.flatMap(paths))]);
    const unclean = (relative) =>
      git.links.has(relative)
        ? !now.links.get(relative)?.equals(git.links.get(relative))
        : now.dirty.includes(relative) || now.links.has(relative);
    return { files: new Set(named.filter((file) => !paths(file).some(unclean))) };
  } catch {
    return { files: new Set() };
  }
}

/**
 * The repo must be exactly as fingerprinted, except clean committed fast-forwards;
 * the staging copy is still the only place for the synthesis harness to write.
 *
 * Skills staging withheld are left out: such a file is one backpass has guaranteed it will
 * never write, so aborting a run over a third party's edit to it would discard measured
 * work for nothing. That holds on every run for the two reasons staging settles before it
 * narrows - the path resolves outside the repository, or into a location nothing may
 * write. It does not hold for the one reason it settles after: a skill withheld only as a
 * duplicate of a name already staged is still fingerprinted on a narrowed run, which never
 * reaches that decision. An ordinary repository skill stays fingerprinted either way. A
 * fingerprinted path can still resolve outside the repository - that is the ordinary
 * user-scope layout - so a change there is reported for what it is rather than as a direct
 * repository edit. A change inside the repository is reported as what was observed, since
 * a concurrent editor in a shared workspace looks the same as a harness (#199). A
 * configured `skillSearchPaths` root is the one withheld reason that stays fingerprinted
 * anyway: its read-only promise is not "backpass will never write this," it is "nothing
 * may ever write this," so a change there must still fail the run.
 */
function assertRepoUntouched(repo, before, workspace) {
  const after = repoFingerprint(repo, Object.keys(before.files));
  const changed = Object.keys(before.files).filter((file) => before.files[file] !== after[file]);
  if (!changed.length) return;
  const insideRepo = (file) => {
    try {
      resolveMemoryPath(repo.root, file);
      return true;
    } catch {
      return false;
    }
  };
  const searchPathSkill = (file) =>
    workspace.unstageable.some(
      (entry) => entry.reason === READ_ONLY_SEARCH_PATH && (file === entry.path || file.startsWith(`${entry.path}/`)),
    );
  const explained = explainedByFastForward(
    repo,
    before.git,
    changed.filter((file) => insideRepo(file) && !searchPathSkill(file)),
  );
  const moved = changed.filter((file) => !explained.files.has(file));
  if (!moved.length) return;
  // The fingerprint only proves a file changed, not who changed it: in a shared workspace
  // another session or a cron job can edit it mid-run. The harness is named only when the
  // repository file now equals the staging copy, which a bystander has no reason to produce.
  const matchesStaging = (file) => {
    const staged = workspace.stagedPaths?.get(file) ?? workspacePathFor(file);
    try {
      return (
        fs.readFileSync(path.join(workspace.root, staged), "utf8") === fs.readFileSync(repoFilePath(repo, file), "utf8")
      );
    } catch {
      return false;
    }
  };
  const inside = moved.filter(insideRepo);
  const outside = moved.filter((file) => !inside.includes(file));
  const wroteThrough = inside.filter(matchesStaging);
  const claims = [];
  if (explained.reason) claims.push(explained.reason);
  if (inside.length) {
    claims.push(`${inside.join(", ")} changed in the repository during synthesis`);
  }
  if (wroteThrough.length) {
    claims.push(
      `${wroteThrough.join(", ")} now matches the staging copy (${workspace.root}), so the synthesis harness likely wrote it directly`,
    );
  }
  if (outside.length) {
    claims.push(
      `${outside.join(", ")} changed during synthesis; ` +
        `${outside.length > 1 ? "those paths resolve" : "that path resolves"} outside the repository`,
    );
  }
  throw new UserError(
    `${claims.join("; also ")}; nothing was proposed`,
    wroteThrough.length
      ? `inspect the change with \`git diff\`, restore the file, and re-run - a harness that edits outside its cwd cannot be trusted with the synthesis role`
      : inside.length
        ? `inspect the change with \`git diff\` and re-run - another process (a concurrent agent session or a scheduled job) may have edited the file mid-run; run from a worktree snapshot if other writers share this directory, and if nothing else was writing, suspect the synthesis harness`
        : `inspect the file and re-run - either the synthesis harness wrote through the link to a skill it was told is read-only, or another process changed the shared library mid-run`,
  );
}

function targetRule(target, memoryPath, skillsDir, stagedTargetPath = null, unstageable = []) {
  if (target.nested) {
    const dir = path.posix.dirname(memoryPath);
    return (
      `0. **This run trains the nested memory file \`./${memoryPath}\` only.** Harnesses load it on top of ` +
      `the root memory file, and only when a session works under \`${dir}/\`; every session in the evidence ` +
      `below worked there. Skills belong to the root surface: do not create, extend, or edit a skill, and do ` +
      `not extract - the extraction rules and the placement table below do not apply to this run. A lesson ` +
      `that is not specific to \`${dir}/\` belongs in the root memory file, which its own pass trains.\n`
    );
  }
  if (target.kind === "skill") {
    return (
      `0. **This run targets \`./${stagedTargetPath || workspacePathFor(target.path)}\` only.** It is the one staged file. ` +
      `Do not edit \`./${memoryPath}\` or any other skill, and do not create a skill; extraction does not apply.\n`
    );
  }
  if (target.kind === "memory") {
    return (
      `0. **This run targets \`./${memoryPath}\` only.** The skills listed above live in the repository and are ` +
      `read-only: do not edit them. You may still extract a NEW skill under \`./${skillsDir}/\`.\n`
    );
  }
  if (unstageable.length) {
    return (
      `0. **The skills marked \`read-only\` above are not in your staging copy**, for the reason each row ` +
      `gives, and backpass cannot write them at that path. Read them for grounding and treat what they ` +
      `already cover as covered - do not edit them, re-create them, or copy their content into ` +
      `\`./${memoryPath}\`.\n`
    );
  }
  return "";
}

/**
 * Everything the edit and annotation turns need: prompt values, the `buildProposal`
 * context, and the overflow target.
 */
function synthesisSetup({ memoryFile, summary, config, repo, harnessCounts, scope = null, routing = null }) {
  const state = config.state;
  const rejections = state.readRejections();
  const userScope = scope?.kind === "user";
  // A nested memory file is trained on its own: skills belong to the root surface, so
  // none is staged, billed, or offered as an extraction target (`src/nested.js`).
  const nested = config.target?.nested === true;
  const overflow = resolveOverflowTarget(repo.root, config.skillsDir, {
    claudeSkillsDir: userScope ? userClaudeSkillsDir() : undefined,
    allowExternal: userScope,
  });
  if (!nested) for (const w of overflow.warnings) warn(w);
  const skillDirs = nested
    ? []
    : resolveProjectSkillDirs(repo.root, overflow.dir, config.skillsDirs || [], { exact: userScope });
  const skillFiles = nested
    ? []
    : loadProjectSkills(repo.root, overflow.dir, config.skillsDirs || [], { exact: userScope });
  // `skillSearchPaths` rides `skillDirs` for awareness (config.js), but staging must
  // refuse it unconditionally - unlike the rest of `skillDirs`, it is never writable, in
  // no scope, so `prepareWorkspace` needs the raw roots to enforce that independently of
  // `allowExternal`.
  const searchPathRoots = (config.skillSearchPaths || []).map((p) => expandHomePath(p));
  // The budget is the whole always-loaded surface whatever the target: a skill target
  // moves it by that skill's description-line delta, nothing else changes.
  const descriptionTokens = skillDescriptionTokens(skillFiles);
  const maxEdits = effectiveMaxEdits(memoryFile, config, descriptionTokens);
  const target = config.target || SURFACE_TARGET;

  const common = {
    MEMORY_PATH: workspacePathFor(memoryFile.path),
    BUDGET_RULE: budgetRule(memoryFile, config, maxEdits, descriptionTokens, { extraction: !nested }),
    MAX_EDITS: String(maxEdits),
    MIN_GAP_EVIDENCE: String(config.minGapEvidence),
  };

  const context = {
    memoryFile,
    config: { ...config, skillsDir: overflow.dir, skillDirs },
    repo,
    scope,
    summary,
    harnessCounts,
    rejections,
    isSuppressed: isSuppressedByRejection,
    skillFiles,
    target,
    routing,
  };

  const promptDir = path.join(state.root, "prompts");
  fs.mkdirSync(promptDir, { recursive: true });

  return {
    state,
    rejections,
    overflow,
    skillDirs,
    skillFiles,
    searchPathRoots,
    target,
    nested,
    descriptionTokens,
    maxEdits,
    common,
    context,
    promptDir,
  };
}

/**
 * The header a fresh annotation session needs. An in-session annotate turn inherits the
 * repository, the budget, and the evidence from the editing turn that preceded it; the
 * fresh session used after an empty reply would otherwise be asked to quote evidence it
 * has never been shown.
 */
function prefaceFor({ memoryFile, summary, config, repo, workspaceRoot, descriptionTokens = 0 }) {
  return render(loadPrompt("annotate-preface"), {
    MEMORY_PATH: workspacePathFor(memoryFile.path),
    REPO_NAME: repo.name,
    REPO_ROOT: repo.root,
    WORKSPACE_ROOT: workspaceRoot,
    CURRENT_TOKENS: String(memoryFile.tokens + descriptionTokens),
    BUDGET_STATE: budgetState(memoryFile, config, descriptionTokens),
    TRANSCRIPT_COUNT: String(summary.analyzedSessions),
    EVIDENCE: renderEvidenceForPrompt(summary),
  });
}

const REMEASURE_NOTICE =
  `\n\n## The files moved after they were measured\n\nYou changed the files again during your last turn, so the ids you were given no longer ` +
  `describe them. Nothing is wrong with the shape of your answer - annotate the re-measured ` +
  `changes above instead. This did not use up an annotation attempt.\n`;

const rejectionBlock = (violations) =>
  `\n\n## Your previous answer was rejected\n\nIt violated these hard rules. Fix every one of them ` +
  `(edit the files first if a change must go or move) and return the corrected JSON object only.\n\n` +
  `${violations.map((v) => `- ${v}`).join("\n")}\n`;

/** The headline of a failed run, named after the condition it actually ended on. */
function terminalMessage(reason, attempts, violations) {
  if (reason === "empty") {
    return "synthesis ended its turn with no output, in the run's session and again in a fresh one";
  }
  if (reason === "editing") {
    return `synthesis kept editing the staging copy instead of annotating it (${REMEASURE_TURNS} re-measurements)`;
  }
  if (reason === "edit-empty") {
    return "synthesis made no changes to the staging copy during the edit turn, so its first annotate turn had nothing to describe";
  }
  return (
    `synthesis could not produce a valid proposal after ${Math.max(attempts - 1, 0)} re-prompt(s) ` +
    `(${violations.length} violation(s))`
  );
}

/**
 * Drive the annotate turns to a valid proposal, or throw a `ProposalViolation` describing
 * the condition the run actually ended on.
 *
 * `holder.session` is the live session; the loop replaces it when it needs a fresh one and
 * the caller closes whatever is in the holder at the end.
 */
async function annotateLoop({
  holder,
  freshSession,
  workspace,
  fingerprint,
  repo,
  context,
  common,
  promptDir,
  timeoutSeconds,
  promptRetries,
  usage,
  notes,
  noteOnce,
  overflow,
  progress,
  renderPreface,
  startFresh = false,
}) {
  const { memoryFile, config } = context;
  const state = config.state;

  let attempts = 0;
  let remeasures = 0;
  let emptyTurns = 0;
  let violationsToShow = [];
  let justRemeasured = false;
  let owePreface = startFresh;
  /** @type {{ attempt: number, violations: string[], notes?: string[] } | null} */
  let saved = null;
  /** @type {{ reason: string, violations: string[] }} */
  let terminal;
  // Whether the edit turn that preceded this loop left the staging copy untouched - a
  // stray out-of-scope edit still counts as touched, so it is never hidden behind
  // "edit-empty". Only the very first turn's measurement answers that question; a later
  // remeasure reflects edits made during annotation instead, which "editing" already covers.
  let editMadeNoChanges = false;

  for (let turn = 1; ; turn += 1) {
    assertRepoUntouched(repo, fingerprint, workspace);
    const measured = measureWorkspace(workspace);
    if (turn === 1) editMadeNoChanges = measured.changes.length === 0 && !(measured.stray || []).length;

    let prompt = renderPrompt("annotate", {
      ...common,
      PREFACE: owePreface ? renderPreface() : "",
      CHANGES: renderChangesForPrompt(measured, memoryFile),
    });
    owePreface = false;
    if (justRemeasured) prompt += REMEASURE_NOTICE;
    else if (violationsToShow.length) prompt += rejectionBlock(violationsToShow);

    const promptFile = path.join(promptDir, `synthesis-annotate-${turn}.md`);
    fs.writeFileSync(promptFile, prompt);
    progress("annotate", { attempt: attempts + 1, turn, changes: measured.changes.length });

    const result = await holder.prompt({
      promptFile,
      approveAll: true,
      timeoutSeconds,
      promptRetries,
    });
    usage.push(usageRecord(holder.ranWith, result));
    for (const note of result.notes || []) noteOnce(note);

    // The agent may keep editing during an annotate turn; the ids it was answering about
    // are then stale, so the answer is dropped and the fresh measurement shown instead.
    // That is a measurement problem, not a failed annotation: it costs no attempt.
    assertRepoUntouched(repo, fingerprint, workspace);
    if (measureWorkspace(workspace).signature !== measured.signature) {
      remeasures += 1;
      justRemeasured = true;
      violationsToShow = [];
      if (remeasures >= REMEASURE_TURNS) {
        terminal = { reason: "editing", violations: [KEPT_EDITING_VIOLATION] };
        break;
      }
      warn(
        `synthesis edited the staging copy again; re-measuring and re-annotating ` +
          `(annotation attempt ${attempts + 1} of ${ANNOTATE_TURNS} is still unspent)`,
      );
      emitProgress("synth:remeasure", { turn, attempt: attempts + 1, remeasures });
      continue;
    }
    justRemeasured = false;

    // An empty turn is not a bad answer; it is no answer. Retry it once in a new session,
    // because the accumulated context of this one is the likeliest reason it collapsed -
    // unless the edit turn left nothing to describe in the first place, in which case a
    // fresh session would be shown the same empty diff and retrying is pointless.
    if (isBlankOutput(result.text)) {
      if (turn === 1 && editMadeNoChanges) {
        terminal = { reason: "edit-empty", violations: [EDIT_EMPTY_VIOLATION] };
        break;
      }
      emptyTurns += 1;
      if (emptyTurns > EMPTY_TURN_RETRIES) {
        terminal = { reason: "empty", violations: [EMPTY_TURN_VIOLATION] };
        break;
      }
      warn("synthesis ended its turn with no output; retrying the annotation once in a fresh session");
      emitProgress("synth:empty", { turn, attempt: attempts + 1, emptyTurns });
      await holder.session.close();
      holder.session = await freshSession();
      // The new session knows nothing, so it is given the preface; `violationsToShow` is
      // kept because those gates are still what the run's annotation has to satisfy.
      owePreface = true;
      continue;
    }

    attempts += 1;
    const parsed = extractJson(result.text);
    if (!parsed) {
      if (turn === 1 && editMadeNoChanges) {
        terminal = { reason: "edit-empty", violations: [EDIT_EMPTY_VIOLATION] };
        break;
      }
      violationsToShow = [UNPARSEABLE_VIOLATION];
      if (attempts >= ANNOTATE_TURNS) {
        terminal = { reason: "unparseable", violations: violationsToShow };
        break;
      }
      warn(`synthesis violated 1 gate(s); re-prompting with the exact violations`);
      emitProgress("synth:violations", { attempt: attempts, violations: violationsToShow });
      continue;
    }

    const { proposal, violations } = buildProposal(parsed, { ...context, measured });
    proposal.notes = [...proposal.notes, ...notes];
    proposal.usage = usage;
    proposal.overflowTarget = overflow;
    proposal.attempt = attempts;
    if (!violations.length) {
      emitProgress("synth:done", { edits: proposal.edits.length, attempt: attempts });
      return { proposal, violations: [] };
    }

    violationsToShow = violations;
    proposal.violations = violations;
    // Keep the rejected proposal so a loud failure is still inspectable. It records which
    // attempt produced it, so a later empty turn cannot be reported as its author.
    state.writeProposal(proposal);
    saved = { attempt: attempts, violations, notes: proposal.notes };
    if (attempts >= ANNOTATE_TURNS) {
      terminal = { reason: "gates", violations };
      break;
    }
    warn(`synthesis violated ${violations.length} gate(s); re-prompting with the exact violations`);
    emitProgress("synth:violations", { attempt: attempts, violations });
  }

  throw new ProposalViolation(terminalMessage(terminal.reason, attempts, terminal.violations), terminal.violations, {
    reason: terminal.reason,
    attempts,
    saved,
    proposalPath: saved ? state.proposalPath : null,
  });
}

export async function synthesizeProposal({
  memoryFile,
  summary,
  config,
  repo,
  transcripts,
  runNote = "",
  scope = null,
  routing = null,
}) {
  config.state.clearProposal();
  const harnessCounts = harnessCountsOf(transcripts);
  const {
    state,
    rejections,
    overflow,
    skillDirs,
    skillFiles,
    searchPathRoots,
    target,
    nested,
    descriptionTokens,
    maxEdits,
    common,
    context,
    promptDir,
  } = synthesisSetup({
    memoryFile,
    summary,
    config,
    repo,
    harnessCounts,
    scope,
    routing,
  });

  // Staging holds only the write surface: every skill on a surface run, none of them on
  // a memory-file target (new extracts are still measured), just the one on a skill target.
  const stagedSkills = target.kind === "surface" ? null : target.kind === "skill" ? [target.path] : [];
  const workspaceOptions = {
    state,
    repo,
    memoryFile,
    skillsDir: overflow.dir,
    skillDirs,
    stagedSkills,
    allowExternal: scope?.kind === "user",
    searchPathRoots,
  };
  let workspace = prepareWorkspace(workspaceOptions);
  const stagedSkillsDir =
    workspace.skillMappings.find((mapping) => mapping.logical === overflow.dir)?.staged ||
    workspacePathFor(overflow.dir);
  // Unstaged skills keep their repository paths in the index: the model may read them
  // there for grounding, and the target rule says they are not writable. The ones staging
  // confined out are also marked, so a run that narrows nothing still says so.
  const readOnlyReason = (file) =>
    workspace.unstageable.find((entry) => file === entry.path || file.startsWith(`${entry.path}/`))?.reason || null;
  const stagedSkillFiles = skillFiles.map((skill) => ({
    ...skill,
    path: workspace.stagedPaths.get(skill.path) || skill.path,
    readOnly: readOnlyReason(skill.path),
  }));

  const editValues = {
    ...common,
    TARGET_RULE: targetRule(
      target,
      workspace.memoryWorkspacePath,
      stagedSkillsDir,
      target.kind === "skill" ? workspace.stagedPaths.get(target.path) || workspacePathFor(target.path) : null,
      stagedSkillFiles.filter((skill) => skill.readOnly),
    ),
    REPO_NAME: repo.name,
    REPO_ROOT: repo.root,
    TRANSCRIPT_COUNT: String(summary.analyzedSessions),
    RUN_NOTE: runNote,
    HARNESS_SUMMARY:
      Object.entries(harnessCounts)
        .map(([h, n]) => `${h} ${n}`)
        .join(" · ") || "none",
    CURRENT_TOKENS: String(memoryFile.tokens + descriptionTokens),
    BUDGET_TOKENS: String(config.budgetTokens),
    BUDGET_STATE: budgetState(memoryFile, config, descriptionTokens),
    INSTRUCTION_INDEX: renderInstructionIndex(memoryFile),
    SKILLS_DIR: stagedSkillsDir,
    SKILL_INDEX: nested
      ? "(skills belong to the root surface; a nested memory file run does not edit them)"
      : renderSkillIndex(stagedSkillFiles),
    BUDGET_COUNT: nested
      ? "The count is this file alone: it loads on top of the root memory\nfile, which has a budget of its own."
      : "The count is this file PLUS every skill's `description:` line;\nskill bodies are free until triggered.",
    EVIDENCE: renderEvidenceForPrompt(summary),
    REJECTIONS: renderRejections(rejections),
  };

  const editPromptFile = path.join(promptDir, "synthesis-edit.md");
  fs.writeFileSync(editPromptFile, renderPrompt("synthesis", editValues));

  // A search-path skill is unstageable like any other read-only skill, but unlike the
  // rest of them the read-only promise it carries must be enforceable: a direct write to
  // it has to be detected, not silently excused the way an ordinary withheld skill is
  // (design note above `assertRepoUntouched`). It stays in the fingerprint so a change
  // there still fails the run loudly.
  const fingerprintFiles = [
    ...new Set(
      [memoryFile.path, ...config.memoryFiles, ...(config.nestedMemoryFiles || []), routing?.rootPath].filter(Boolean),
    ),
    ...skillFiles
      .filter((skill) => {
        const reason = readOnlyReason(skill.path);
        return !reason || reason === READ_ONLY_SEARCH_PATH;
      })
      .map((skill) => skill.path),
  ];
  const fingerprint = { files: repoFingerprint(repo, fingerprintFiles), git: repoGitState(repo, fingerprintFiles) };
  const sessionName = `backpass-synth-${process.pid}`;
  const timeoutSeconds = Math.max(config.timeoutSeconds, 900);
  const usage = [];
  const notes = [];
  const noteOnce = (note) => {
    // The same adapter limitation is reported on every turn; say it once.
    if (notes.includes(note)) return;
    notes.push(note);
    warn(note);
  };

  const pick = await config.agents.resolve("synthesis");
  info(
    `${color.cyan("·")} synthesizing ${nested ? `${memoryFile.path} (nested) ` : ""}with ${pick.agent}` +
      `${pick.model ? ` (${pick.model})` : ""}` +
      `${pick.effort ? ` effort=${pick.effort}` : ""}`,
  );
  let ranWith = pick.agent;
  let chosen = pick;
  const progress = (phase, extra = {}) =>
    emitProgress("synth:start", {
      agent: ranWith,
      model: pick.model,
      effort: pick.effort,
      phase,
      maxEdits,
      sessionName,
      gapClusters: summary.totals.gapClusters,
      instructions: summary.instructions.length,
      suppressed: Object.keys(rejections.entries || {}).length,
      ...extra,
    });

  // A classifiable failure (not logged in, model rejected, adapter missing) falls
  // through to the next ladder candidate; the switch is recorded in the notes so the
  // proposal's provenance is visible. Once the editing turn has run, later turns stay
  // on the same candidate - a run never silently switches models after real work.
  /** @type {{ session: Awaited<ReturnType<typeof openSession>> | null, ranWith: string, prompt: Function }} */
  const holder = {
    session: null,
    ranWith,
    prompt(args) {
      if (!this.session) throw new Error("synthesis session is not open");
      return this.session.prompt(args);
    },
  };
  let attempted = false;
  const editResult = await config.agents.withFallthrough("synthesis", async (current) => {
    ranWith = current.agent;
    holder.ranWith = current.agent;
    chosen = current;
    if (current !== pick) notes.push(`synthesis fell through to ${current.agent} (${current.model})`);
    // A candidate after the first runs behind a harness that may already have written to the
    // repository; rebasing over that write would hide it, so it is reported before the rebuild.
    if (attempted) assertRepoUntouched(repo, fingerprint, workspace);
    workspace = prepareWorkspace(workspaceOptions);
    rebaseFingerprint(fingerprint.files, workspace);
    attempted = true;
    progress("edit", { attempt: 1 });
    holder.session = await openSession({
      agent: current.agent,
      model: current.model,
      effort: current.effort,
      sessionName,
      cwd: workspace.root,
      writeAccess: true,
    });
    try {
      return await holder.session.prompt({
        promptFile: editPromptFile,
        approveAll: true,
        timeoutSeconds,
        promptRetries: config.promptRetries,
      });
    } catch (err) {
      await holder.session.close();
      holder.session = null;
      throw err;
    }
  });
  usage.push(usageRecord(ranWith, editResult));
  for (const note of editResult.notes || []) noteOnce(note);

  let serial = 1;
  const freshSession = () =>
    openSession({
      agent: chosen.agent,
      model: chosen.model,
      effort: chosen.effort,
      sessionName: `${sessionName}-r${(serial += 1)}`,
      cwd: workspace.root,
      writeAccess: true,
    });

  try {
    return await annotateLoop({
      holder,
      freshSession,
      workspace,
      fingerprint,
      repo,
      context,
      common,
      promptDir,
      timeoutSeconds,
      promptRetries: config.promptRetries,
      usage,
      notes,
      noteOnce,
      overflow,
      progress,
      renderPreface: () =>
        prefaceFor({ memoryFile, summary, config, repo, workspaceRoot: workspace.root, descriptionTokens }),
    });
  } finally {
    await holder.session.close();
  }
}
