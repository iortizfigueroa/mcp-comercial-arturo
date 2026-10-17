// Se abre una vez en el navegador tras desplegar:
//   https://<tu-proyecto>.vercel.app/api/setup?key=<TELEGRAM_WEBHOOK_SECRET>
// Conecta el webhook de Telegram, registra los comandos y crea las tablas.
import { ensureSchema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { tg } from '../lib/telegram.js';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const secret = env('TELEGRAM_WEBHOOK_SECRET');
  if (url.searchParams.get('key') !== secret) return new Response('forbidden', { status: 403 });

  const host = req.headers.get('x-forwarded-host') ?? url.host;
  const webhook = `https://${host}/api/telegram`;
  await tg('setWebhook', {
    url: webhook,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  await tg('setMyCommands', {
    commands: [
      { command: 'resumen', description: 'Resumen de hoy' },
      { command: 'olvidar', description: 'Empezar la conversación de cero' },
      { command: 'ayuda', description: 'Qué puedo hacer' },
    ],
  });
  await ensureSchema();
  const me = await tg<{ username: string }>('getMe');
  return Response.json({ ok: true, bot: `@${me.username}`, webhook });
}
