// Utilidades de fecha/hora en Europe/Madrid.
// Pipedrive guarda due_time de las actividades en UTC; el comercial habla en hora de Madrid.

const TZ = 'Europe/Madrid';

function parts(d: Date): Record<string, string> {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const m: Record<string, string> = {};
  for (const x of p) m[x.type] = x.value;
  return m;
}

/** Minutos que Madrid va por delante de UTC en ese instante (60 o 120). */
function offsetMin(d: Date): number {
  const m = parts(d);
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return Math.round((asUtc - d.getTime()) / 60000);
}

export function todayMadrid(d: Date = new Date()): string {
  const m = parts(d);
  return `${m.year}-${m.month}-${m.day}`;
}

export function nowMadridText(): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Fecha+hora de Madrid -> due_date/due_time en UTC para Pipedrive. */
export function madridToUtc(date: string, time: string): { due_date: string; due_time: string } {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const u = new Date(guess - offsetMin(new Date(guess)) * 60000);
  return { due_date: u.toISOString().slice(0, 10), due_time: u.toISOString().slice(11, 16) };
}

/** due_date/due_time de Pipedrive (UTC) -> fecha y hora de Madrid. Sin hora, la fecha no se toca. */
export function utcToMadrid(date: string, time?: string | null): { date: string; time: string | null } {
  if (!date) return { date: '', time: null };
  if (!time) return { date, time: null };
  const u = new Date(`${date}T${time.slice(0, 5)}:00Z`);
  if (Number.isNaN(u.getTime())) return { date, time: null };
  const m = parts(u);
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${m.hour}:${m.minute}` };
}
