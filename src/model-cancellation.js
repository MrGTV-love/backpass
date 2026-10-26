/**
 * User interruption is not a model deadline. Stop captured ACP process groups and
 * close named sessions (whose acpx queue owners are detached from the prompt CLI)
 * before exiting, including when the live TUI handles the same signal.
 */
const cleanups = new Set();
let cancellation = null;

export function registerModelCleanup(cleanup) {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function isCancellingModelCalls() {
  return cancellation !== null;
}

export function cancelModelCalls() {
  if (!cancellation) {
    cancellation = Promise.allSettled([...cleanups].map((cleanup) => Promise.resolve().then(cleanup))).then(() => {});
  }
  return cancellation;
}

for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })) {
  process.on(signal, () => {
    void cancelModelCalls().finally(() => process.exit(exitCode));
  });
}
