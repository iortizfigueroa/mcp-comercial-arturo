// Cron de Vercel (L-V 18:00 UTC = 19:00 en Madrid en horario de invierno). Manda el resumen a cada grupo.
import { ensureSchema, listChats } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { buildSummary } from '../../lib/summary.js';
import { send } from '../../lib/telegram.js';

export async function GET(req: Request): Promise<Response> {
  if (req.headers.get('authorization') !== `Bearer ${env('CRON_SECRET')}`) {
    return new Response('forbidden', { status: 403 });
  }
  await ensureSchema();
  const results: { chat: number; ok: boolean; error?: string }[] = [];
  for (const chat of await listChats()) {
    try {
      await send(chat.chat_id, await buildSummary(chat));
      results.push({ chat: chat.chat_id, ok: true });
    } catch (e) {
      console.error('resumen', chat.chat_id, e);
      results.push({ chat: chat.chat_id, ok: false, error: (e as Error).message });
    }
  }
  return Response.json({ enviados: results.filter((r) => r.ok).length, results });
}
