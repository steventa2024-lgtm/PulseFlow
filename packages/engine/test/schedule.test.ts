import { describe, expect, it } from 'vitest';
import { isValidTimezone, missedRuns, nextCronRun, nextCronRuns, validateCron } from '../src';

describe('cron schedules', () => {
  it('validates expressions and timezones', () => {
    expect(validateCron('0 9 * * 1-5')).toBeNull();
    expect(validateCron('not a cron')).toMatch(/./);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
  });

  it('computes weekday runs in the workflow timezone', () => {
    // Friday 2026-01-09 10:00 Berlin → next weekday 09:00 is Monday 2026-01-12 08:00Z (CET = UTC+1)
    const next = nextCronRun('0 9 * * 1-5', 'Europe/Berlin', new Date('2026-01-09T09:00:00Z'));
    expect(next?.toISOString()).toBe('2026-01-12T08:00:00.000Z');
  });

  it('follows daylight saving changes (America/New_York, 2026-03-08)', () => {
    const runs = nextCronRuns('0 9 * * *', 'America/New_York', new Date('2026-03-06T15:00:00Z'), 3);
    expect(runs.map((d) => d.toISOString())).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
  });

  it('does not run a skipped local time twice or invent one in the spring-forward gap', () => {
    // 02:30 does not exist on 2026-03-08 in New York; croner (legacy mode) moves it forward instead of skipping the day.
    const runs = nextCronRuns('30 2 * * *', 'America/New_York', new Date('2026-03-07T12:00:00Z'), 2);
    expect(new Set(runs.map((d) => d.toISOString())).size).toBe(2);
    expect(runs[0]!.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('reports missed runs according to policy', () => {
    const last = new Date('2026-01-05T09:00:00Z');
    const now = new Date('2026-01-08T12:00:00Z');
    expect(missedRuns('0 9 * * *', 'UTC', last, now, 'skip')).toEqual([]);
    const once = missedRuns('0 9 * * *', 'UTC', last, now, 'runOnce');
    expect(once).toHaveLength(1);
    expect(once[0]!.toISOString()).toBe('2026-01-08T09:00:00.000Z');
  });
});
