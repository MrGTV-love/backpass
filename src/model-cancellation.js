/**
 * User interruption is not a model deadline. Stop captured ACP process groups and
 * close named sessions (whose acpx queue owners are detached from the prompt CLI)
 * before exiting, including when the live TUI handles the same signal.
 *
 * Session closes run only after every in-flight capture has settled, so a close
 * registered before `sessions new` never races the creation it has to undo.
 * A second signal exits at once: cleanup waits on acpx, which may never answer.
 */
const captures = new Set();
const sessions = new Set();
let cancellation = null;

function register(set, cleanup) {
  set.add(cleanup);
  return () => set.delete(cleanup);
}

export function registerModelCleanup(cleanup) {
  return register(captures, cleanup);
}

export function registerSessionCleanup(close) {
  return register(sessions, close);
}

export function isCancellingModelCalls() {
  return cancellation !== null;
}

export function cancelModelCalls() {
  if (!cancellation) {
    const settle = (set) => Promise.allSettled([...set].map((cleanup) => Promise.resolve().then(cleanup)));
    cancellation = settle(captures)
      .then(() => settle(sessions))
      .then(() => {});
  }
  return cancellation;
}

let signalled = false;
for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })) {
  process.on(signal, () => {
    if (signalled) process.exit(exitCode);
    signalled = true;
    void cancelModelCalls().finally(() => process.exit(exitCode));
  });
}
