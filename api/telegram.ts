// Webhook de Telegram. Responde 200 al momento y procesa en segundo plano.
import { waitUntil } from '@vercel/functions';
import { handleUpdate } from '../lib/bot.js';
import { env } from '../lib/env.js';

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env('TELEGRAM_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await req.json();
  waitUntil(handleUpdate(update).catch((e) => console.error('handleUpdate', e)));
  return new Response('ok');
}
