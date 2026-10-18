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

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Texto con enlaces estilo [texto](https://...) -> HTML de Telegram. Lo demás se escapa. */
export function toHtml(text: string): string {
  return escapeHtml(text).replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
    `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  );
}

/** Envía texto con enlaces clicables. Trocea por líneas; si Telegram rechaza el HTML, lo manda en texto plano. */
export async function sendRich(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<any> {
  const lines = (text.trim() || '(sin texto)').split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur && (cur + '\n' + line).length > 3500) { chunks.push(cur); cur = line; }
    else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  let last: any;
  for (let i = 0; i < chunks.length; i++) {
    const ex = i === chunks.length - 1 ? extra : {};
    try {
      last = await tg('sendMessage', {
        chat_id: chatId, text: toHtml(chunks[i]), parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }, ...ex,
      });
    } catch {
      last = await tg('sendMessage', { chat_id: chatId, text: chunks[i], link_preview_options: { is_disabled: true }, ...ex });
    }
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
