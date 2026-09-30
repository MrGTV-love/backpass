import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { associate, globToRegExp, passesStrict } from "../src/discovery/association.js";
import { isWindowsPath, localPath } from "../src/discovery/paths.js";
import { normalizeRemote } from "../src/repo.js";

/** A repo identity backed by one real directory, so tier-1/tier-3 liveness is genuine. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-assoc-"));
  const live = fs.realpathSync(dir);
  return {
    repo: {
      name: "demo",
      root: live,
      realRoot: live,
      worktrees: [live],
      remotes: ["github.com/acme/demo"],
    },
    live,
  };
}

test("normalizeRemote collapses ssh, https and .git spellings to one identity", () => {
  const expected = "github.com/acme/demo";
  assert.equal(normalizeRemote("git@github.com:acme/demo.git"), expected);
  assert.equal(normalizeRemote("https://github.com/acme/demo"), expected);
  assert.equal(normalizeRemote("https://user@github.com/acme/demo.git/"), expected);
  assert.equal(normalizeRemote("ssh://git@github.com/acme/demo.git"), expected);
  assert.equal(normalizeRemote(""), null);
});

test("tier 1: a cwd that is a worktree, or sits inside one, is deterministic", () => {
  const { repo, live } = makeRepo();

  const exact = associate({ cwd: live }, repo);
  assert.equal(exact.tier, 1);
  assert.equal(exact.confidence, "exact");

  const nested = associate({ cwd: path.join(live, "src", "deep") }, repo);
  assert.equal(nested.tier, 1);
  assert.equal(nested.confidence, "nested");
});

test("tier 2: a recorded remote associates a session whose worktree is long gone", () => {
  const { repo } = makeRepo();
  const result = associate(
    { cwd: "/vanished/worktree/somewhere", remotes: ["https://github.com/acme/demo.git"] },
    repo,
  );
  assert.equal(result.tier, 2);
  assert.equal(result.confidence, "remote");
});

test("tier 3: a dead path ending in the repo name is best-effort only", () => {
  const { repo } = makeRepo();
  const result = associate({ cwd: "/vanished/treehouse/7/demo" }, repo);
  assert.equal(result.tier, 3);
  assert.equal(result.confidence, "path");
});

test("tier 3 never fires for a live path that belongs to a different repo", () => {
  const { repo } = makeRepo();
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-")));
  assert.equal(associate({ cwd: other }, repo), null);
});

test("a user worktree glob promotes a dead path to tier 3", () => {
  const { repo } = makeRepo();
  const cwd = "/vanished/.treehouse/demo-abc123/4/checkout";

  assert.equal(associate({ cwd }, repo), null);

  const globbed = associate({ cwd }, repo, { worktreeGlobs: ["/vanished/.treehouse/demo-*/*/*"] });
  assert.equal(globbed.tier, 3);
  assert.equal(globbed.confidence, "glob");
});

test("tier 1.5: a live sibling clone is deterministic, not a foreign live path", () => {
  const { repo } = makeRepo();
  const sibling = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-sibling-")));
  repo.siblingWorktrees = [sibling];

  const exact = associate({ cwd: sibling }, repo);
  assert.equal(exact.tier, 1.5);
  assert.equal(exact.confidence, "sibling");

  const nested = associate({ cwd: path.join(sibling, "src") }, repo);
  assert.equal(nested.tier, 1.5);

  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demo-other-")));
  assert.equal(associate({ cwd: other }, repo), null);
});

/** Run `fn` with the process cwd inside `dir`, the way `backpass` runs from inside a checkout. */
function fromInside(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

const WINDOWS_CWDS = [
  "C:\\work\\demo",
  "C:/work/demo",
  "D:\\Projects\\foo",
  "\\\\server\\share\\demo",
  "//server/share/demo",
];

test(
  "a Windows cwd matches no path tier on POSIX, even when backpass runs inside the clone",
  { skip: process.platform === "win32" && "Windows spells these paths natively" },
  () => {
    const { repo, live } = makeRepo();
    fromInside(live, () => {
      for (const cwd of WINDOWS_CWDS) {
        assert.equal(associate({ cwd }, repo), null, `${cwd} is no path on this machine`);
        assert.equal(associate({ cwd, gitRoot: cwd }, repo), null, `${cwd} as a recorded root matches nothing either`);
        assert.equal(
          associate({ cwd, remotes: [] }, repo, { worktreeGlobs: ["**"] }),
          null,
          `${cwd} never reaches the best-effort tier`,
        );
      }
      const remote = associate({ cwd: "C:\\work\\demo", remotes: ["git@github.com:acme/demo.git"] }, repo);
      assert.equal(remote.tier, 2, "a recorded remote still associates the session");
    });
  },
);

test("a Windows cwd from another machine reaches no tier over there either", () => {
  const { repo } = makeRepo();
  const facts = { "C:/work/demo": { exists: false, real: "C:/work/demo" } };
  assert.equal(associate({ cwd: "C:/work/demo" }, repo, { facts, host: "mac-home" }), null);
  const remote = associate({ cwd: "C:/work/demo", remotes: ["https://github.com/acme/demo"] }, repo, {
    facts,
    host: "mac-home",
  });
  assert.equal(remote.tier, 2);
});

test("localPath refuses a Windows path only where it names no place", () => {
  for (const cwd of WINDOWS_CWDS) {
    assert.equal(isWindowsPath(cwd), true, cwd);
    assert.equal(localPath(cwd, { platform: "linux" }), null, cwd);
    assert.equal(localPath(cwd, { platform: "darwin" }), null, cwd);
    assert.equal(localPath(cwd, { platform: "win32" }), cwd, cwd);
  }
  for (const posix of ["/home/me/demo", "relative/demo", "/", "a:b/c"]) {
    assert.equal(isWindowsPath(posix), false, posix);
    assert.equal(localPath(posix, { platform: "linux" }), posix, posix);
  }
  assert.equal(localPath("", { platform: "linux" }), null);
  assert.equal(localPath(null, { platform: "linux" }), null);
});

test("--strict keeps only the deterministic tiers", () => {
  assert.equal(passesStrict({ tier: 1 }, true), true);
  assert.equal(passesStrict({ tier: 1.5 }, true), true);
  assert.equal(passesStrict({ tier: 2 }, true), true);
  assert.equal(passesStrict({ tier: 3 }, true), false);
  assert.equal(passesStrict({ tier: 3 }, false), true);
  assert.equal(passesStrict(null, false), false);
});

test("globToRegExp treats * as one segment and ** as many", () => {
  assert.ok(globToRegExp("/a/*/c").test("/a/b/c"));
  assert.ok(!globToRegExp("/a/*/c").test("/a/b/x/c"));
  assert.ok(globToRegExp("/a/**/c").test("/a/b/x/c"));
});
