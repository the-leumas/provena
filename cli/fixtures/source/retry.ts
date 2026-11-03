import type { Job } from './queue.js';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** Retry failed background jobs with a capped exponential delay. */
export function retryJob(job: Job, now: number): Job {
  const attempt = job.attempt + 1;
  const delay = Math.min(BASE_DELAY_MS * 2 ** job.attempt, MAX_DELAY_MS);
  return { ...job, attempt, availableAt: now + delay };
}
