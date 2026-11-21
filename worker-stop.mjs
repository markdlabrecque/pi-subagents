export const KILL_GRACE_MS = 5_000;

/** Request shutdown once; the caller still waits for proof of exit. */
export function workerStop(child) {
  let timer;
  return {
    request() {
      if (timer || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    },
    clear() { clearTimeout(timer); },
  };
}
