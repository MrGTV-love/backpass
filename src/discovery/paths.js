/**
 * Recorded paths, read on the machine backpass runs on.
 *
 * A harness records paths in the spelling of the system it ran on. On POSIX, drive
 * paths (`C:\work\repo`, `C:/work/repo`) and backslash UNC paths (`\\server\share`)
 * resolve under the process cwd, risking false association with the current repo.
 * Forward-slash UNC paths (`//server/share`) are absolute on POSIX but resolve as local
 * paths rather than Windows network shares, so they must also be refused.
 *
 * Every reader that resolves a recorded path - association, user-scope project keys, and
 * nested-file attribution - goes through `localPath` first, so a path that names no place
 * on this machine is refused once, here, instead of being resolved against the wrong
 * base. On Windows the recorded spelling is already local.
 */

const WINDOWS_DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const WINDOWS_UNC = /^(?:\\\\[^\\/]|\/\/[^\\/])/;

/** True for a Windows drive or UNC path, whatever system reads it. */
export function isWindowsPath(recorded) {
  return typeof recorded === "string" && (WINDOWS_DRIVE.test(recorded) || WINDOWS_UNC.test(recorded));
}

/**
 * The recorded path as this machine spells it, or null when it names no place here.
 *
 * @param {unknown} recorded
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {string | null}
 */
export function localPath(recorded, { platform = process.platform } = {}) {
  if (typeof recorded !== "string" || !recorded) return null;
  if (platform === "win32") return recorded;
  return isWindowsPath(recorded) ? null : recorded;
}
