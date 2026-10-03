// Delivery date-range helpers. Nigeria is UTC+1 all year (no daylight saving).

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 30;     // a window can be at most 30 days wide
const MAX_AHEAD_DAYS = 90;      // and cannot end more than 90 days from today

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : fallback;
}

// The window every paid order gets automatically (days after payment). Change with
// the DELIVERY_MIN_DAYS / DELIVERY_MAX_DAYS secrets on Fly. The seller can adjust it per order.
function defaultWindowDays() {
  const min = intFromEnv('DELIVERY_MIN_DAYS', 3);
  const max = intFromEnv('DELIVERY_MAX_DAYS', 7);
  return { min, max: Math.max(min, max) };
}

const toDay = ms => new Date(ms).toISOString().slice(0, 10);

// Today's date in Nigeria as YYYY-MM-DD.
function lagosToday(now = Date.now()) {
  return toDay(now + 60 * 60 * 1000);
}

// Strict YYYY-MM-DD. Returns the day number (UTC midnight in ms) or null.
function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || toDay(ms) !== value) return null; // rejects 2026-02-31 etc.
  return ms;
}

// Returns { ok: true, from, to } or { ok: false, message }.
function validateWindow(from, to, now = Date.now()) {
  const f = parseDay(from);
  const t = parseDay(to);
  if (f === null || t === null) return { ok: false, message: 'Please choose a valid start and end date.' };

  const today = parseDay(lagosToday(now));
  if (f < today) return { ok: false, message: 'The start date cannot be in the past.' };
  if (t < f) return { ok: false, message: 'The end date cannot be before the start date.' };
  if ((t - f) / DAY_MS > MAX_WINDOW_DAYS) return { ok: false, message: `The delivery window can be at most ${MAX_WINDOW_DAYS} days wide.` };
  if ((t - today) / DAY_MS > MAX_AHEAD_DAYS) return { ok: false, message: `The end date cannot be more than ${MAX_AHEAD_DAYS} days from today.` };

  return { ok: true, from, to };
}

module.exports = { defaultWindowDays, lagosToday, parseDay, validateWindow, MAX_WINDOW_DAYS, MAX_AHEAD_DAYS };
