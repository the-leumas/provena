import { retryJob } from './retry.js';

export interface Job {
  id: string;
  attempt: number;
  availableAt: number;
  run(): Promise<void>;
}

/** Keep failed jobs eligible for a later attempt without blocking the queue. */
export async function processQueue(jobs: Job[], now: number): Promise<Job[]> {
  const pending: Job[] = [];
  for (const job of jobs) {
    if (job.availableAt > now) {
      pending.push(job);
      continue;
    }
    try {
      await job.run();
    } catch {
      pending.push(retryJob(job, now));
    }
  }
  return pending;
}
