// All authoritative comparisons use server epoch milliseconds. Persist UTC ISO timestamps.
export function effectiveDuration(override: number | null, defaultSeconds: number): number {
  const duration = override ?? defaultSeconds;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 3600) throw new Error('Invalid answer duration.');
  return duration;
}

export function createAnswerTimer(durationSeconds: number, now: number) {
  effectiveDuration(durationSeconds, durationSeconds);
  return { startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + durationSeconds * 1000).toISOString() };
}

export function projectAnswerTimer(startedAt: string, deadlineAt: string, now: number) {
  const deadline = Date.parse(deadlineAt);
  return { serverNow: new Date(now).toISOString(), deadlineAt,
    durationSeconds: (deadline - Date.parse(startedAt)) / 1000,
    remainingMs: Math.max(0, deadline - now), expired: now >= deadline };
}
