// Cron de Vercel: resumen diario a las 9:30 hora de Madrid, todos los días.
// Vercel programa en UTC, así que se lanza a las 7:30 y 8:30 UTC y solo envía la que cae a las 9 en Madrid
// (cubre horario de verano e invierno). Cada grupo recibe como mucho un resumen al día.
import { claimSummary, ensureSchema, listChats, releaseSummary } from '../../lib/db.js';
import { adminIds, env } from '../../lib/env.js';
import { buildUsageReport } from '../../lib/report.js';
import { buildSummary } from '../../lib/summary.js';
import { sendRich } from '../../lib/telegram.js';
import { addDays, todayMadrid } from '../../lib/time.js';

const madridHour = () =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

export async function GET(req: Request): Promise<Response> {
  if (req.headers.get('authorization') !== `Bearer ${env('CRON_SECRET')}`) {
    return new Response('forbidden', { status: 403 });
  }
  const hour = madridHour();
  if (hour !== 9) return Response.json({ skipped: true, madridHour: hour });

  await ensureSchema();
  const today = todayMadrid();
  const results: { chat: number; ok: boolean; error?: string }[] = [];
  for (const chat of await listChats()) {
    if (!(await claimSummary(chat.chat_id, today))) continue;
    try {
      await sendRich(chat.chat_id, await buildSummary(chat));
      results.push({ chat: chat.chat_id, ok: true });
    } catch (e) {
      console.error('resumen', chat.chat_id, e);
      await releaseSummary(chat.chat_id, today).catch(() => undefined);
      results.push({ chat: chat.chat_id, ok: false, error: (e as Error).message });
    }
  }
  // Informe de uso del día anterior, en privado a cada admin
  for (const admin of adminIds()) {
    if (!(await claimSummary(admin, today))) continue;
    try {
      await sendRich(admin, await buildUsageReport(addDays(today, -1)));
      results.push({ chat: admin, ok: true });
    } catch (e) {
      console.error('informe admin', admin, e);
      await releaseSummary(admin, today).catch(() => undefined);
      results.push({ chat: admin, ok: false, error: (e as Error).message });
    }
  }
  return Response.json({ enviados: results.filter((r) => r.ok).length, results });
}
