// In-process execution queue. Users may submit any number of runs; only the
// number actively hitting target APIs is capped. For a multi-instance rollout,
// replace this with a shared queue such as BullMQ/Redis.
const configuredConcurrency = Number.parseInt(process.env.MAX_CONCURRENT_RUNS || "4", 10);
const maxConcurrentRuns = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
  ? configuredConcurrency
  : 4;

let activeRuns = 0;
const pending = [];
let acceptingWork = true;
let idleResolver = null;

function restartingError() {
  const error = new Error("The service is restarting. Please submit the run again in a moment.");
  error.status = 503;
  error.expose = true;
  return error;
}

function notifyIfIdle() {
  if (activeRuns === 0 && pending.length === 0 && idleResolver) {
    idleResolver();
    idleResolver = null;
  }
}

function startNext() {
  while (activeRuns < maxConcurrentRuns && pending.length) {
    const job = pending.shift();
    activeRuns += 1;
    Promise.resolve()
      .then(job.work)
      .then(job.resolve, job.reject)
      .finally(() => {
        activeRuns -= 1;
        startNext();
        notifyIfIdle();
      });
  }
}

export function runWithCapacity(work) {
  return new Promise((resolve, reject) => {
    if (!acceptingWork) {
      reject(restartingError());
      return;
    }
    pending.push({ work, resolve, reject });
    startNext();
  });
}

export function getExecutionStats() {
  return { activeRuns, queuedRuns: pending.length, maxConcurrentRuns, acceptingWork };
}

// Stops new work during a controlled deploy. Pending callers receive a clear
// retryable error, while already-running target API calls are allowed to end.
export function beginQueueShutdown() {
  acceptingWork = false;
  while (pending.length) {
    pending.shift().reject(restartingError());
  }
  notifyIfIdle();
}

export function waitForQueueIdle() {
  if (activeRuns === 0 && pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    idleResolver = resolve;
  });
}
