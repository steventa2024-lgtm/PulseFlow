import { Cron } from 'croner';

export class ScheduleError extends Error {
  readonly code = 'INVALID_SCHEDULE';
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function makeCron(expression: string, timezone: string): Cron {
  if (!isValidTimezone(timezone)) throw new ScheduleError(`Unknown timezone "${timezone}"`);
  try {
    return new Cron(expression, { timezone, paused: true, legacyMode: true });
  } catch (e) {
    throw new ScheduleError(`Invalid cron expression "${expression}": ${(e as Error).message}`);
  }
}

/** Validates a cron expression (5 or 6 fields) and timezone. Returns an error message or null. */
export function validateCron(expression: string, timezone = 'UTC'): string | null {
  try {
    makeCron(expression, timezone);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Next fire time strictly after `after`, evaluated in `timezone` so wall-clock schedules
 * follow DST transitions (e.g. 09:00 local stays 09:00 local across the change).
 */
export function nextCronRun(expression: string, timezone: string, after: Date): Date | null {
  const cron = makeCron(expression, timezone);
  return cron.nextRun(after) ?? null;
}

export function nextCronRuns(expression: string, timezone: string, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextCronRun(expression, timezone, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

export type MissedRunPolicy = 'skip' | 'runOnce';

/**
 * Decides what to do with fire times that passed while the host was not running.
 * `skip` drops them; `runOnce` fires a single catch-up run (never a burst).
 */
export function missedRuns(expression: string, timezone: string, lastRunAt: Date, now: Date, policy: MissedRunPolicy): Date[] {
  const due: Date[] = [];
  let cursor = lastRunAt;
  for (let i = 0; i < 10_000; i++) {
    const next = nextCronRun(expression, timezone, cursor);
    if (!next || next.getTime() > now.getTime()) break;
    due.push(next);
    cursor = next;
  }
  if (policy === 'skip' || due.length === 0) return [];
  return [due[due.length - 1]!];
}
