import { env } from './env.js';

export async function tg<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
  return json.result;
}

/** Envía texto plano; trocea si pasa del límite. Los botones (extra) van solo en el último trozo. */
export async function send(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<any> {
  const body = text.trim() || '(sin texto)';
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += 3900) chunks.push(body.slice(i, i + 3900));
  let last: any;
  for (let i = 0; i < chunks.length; i++) {
    last = await tg('sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      link_preview_options: { is_disabled: true },
      ...(i === chunks.length - 1 ? extra : {}),
    });
  }
  return last;
}

export async function typing(chatId: number): Promise<void> {
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
}

let botUsername: string | undefined;
export async function getBotUsername(): Promise<string> {
  if (!botUsername) {
    const me = await tg<{ username: string }>('getMe');
    botUsername = me.username;
  }
  return botUsername;
}
