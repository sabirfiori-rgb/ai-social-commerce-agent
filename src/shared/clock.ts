/**
 * Time helpers. All timestamps in the system are ISO-8601 strings (UTC) unless
 * explicitly a "local wall-clock" for scheduling.
 */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

/** Format a Date into `YYYY-MM-DD` and `HH:mm` parts for a given IANA timezone. */
export function partsInTimezone(date: Date, timeZone: string): { date: string; time: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: get('weekday'),
  };
}

/** Parse a `HH:mm` string to minutes-since-midnight, or null if invalid. */
export function parseHhmm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Given a list of `HH:mm` posting slots and a reference instant, return the ISO
 * timestamp of the next slot at or after the reference (searching up to 14 days).
 */
export function nextSlot(slots: string[], from: Date, timeZone: string): string {
  const valid = slots.map(parseHhmm).filter((n): n is number => n !== null).sort((a, b) => a - b);
  if (valid.length === 0) {
    // default: +1 hour
    return new Date(from.getTime() + 3_600_000).toISOString();
  }
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const probe = new Date(from.getTime() + dayOffset * 86_400_000);
    const { time } = partsInTimezone(probe, timeZone);
    const nowMinutes = parseHhmm(time) ?? 0;
    for (const slot of valid) {
      if (dayOffset === 0 && slot <= nowMinutes) continue;
      // Build a Date at that local slot. Approximate by adjusting from probe midnight.
      const local = partsInTimezone(probe, timeZone);
      const iso = localWallClockToIso(local.date, minutesToHhmm(slot), timeZone);
      if (iso && new Date(iso).getTime() >= from.getTime()) return iso;
    }
  }
  return new Date(from.getTime() + 3_600_000).toISOString();
}

export function minutesToHhmm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Convert a local wall-clock (date + HH:mm in a given IANA tz) to a UTC ISO string.
 * Uses the tz offset computed at that instant (handles DST within a minute).
 */
export function localWallClockToIso(dateYmd: string, hhmm: string, timeZone: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  const tm = parseHhmm(hhmm);
  if (!dm || tm === null) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  const h = Math.floor(tm / 60);
  const mi = tm % 60;

  // Start from a UTC guess, then correct using the tz's actual offset at that time.
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset).toISOString();
}

/** Offset in ms between the given IANA tz and UTC at the given instant. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - date.getTime();
}
