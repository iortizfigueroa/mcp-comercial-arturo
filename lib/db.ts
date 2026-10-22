import { neon } from '@neondatabase/serverless';
import { env } from './env.js';

type Row = Record<string, any>;
let _sql: ReturnType<typeof neon> | undefined;
function db() {
  if (!_sql) _sql = neon(env('DATABASE_URL'));
  return _sql;
}
async function q(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
  return (await db()(strings, ...values)) as Row[];
}

let ready = false;
export async function ensureSchema(): Promise<void> {
  if (ready) return;
  // Un grupo de Telegram = un comercial de Pipedrive
  await q`CREATE TABLE IF NOT EXISTS chats (
    chat_id BIGINT PRIMARY KEY,
    pipedrive_user_id INT NOT NULL,
    pipedrive_user_name TEXT NOT NULL,
    comercial_tg_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Historial de conversación (también sirve de registro de lo que pide)
  await q`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    tg_user_id BIGINT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  await q`CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_id, id)`;
  // Cambios propuestos pendientes de botón ✅/❌
  await q`CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    tool TEXT NOT NULL,
    input JSONB NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Registro de cambios ejecutados / cancelados / fallidos
  await q`CREATE TABLE IF NOT EXISTS action_log (
    id SERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    pipedrive_user_id INT,
    tg_user_id BIGINT,
    tool TEXT NOT NULL,
    input JSONB,
    summary TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  // Un resumen diario por grupo y día
  await q`CREATE TABLE IF NOT EXISTS summary_sent (
    chat_id BIGINT NOT NULL,
    day DATE NOT NULL,
    PRIMARY KEY (chat_id, day)
  )`;
  // Para no procesar dos veces el mismo update si Telegram reintenta
  await q`CREATE TABLE IF NOT EXISTS processed_updates (
    update_id BIGINT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT now()
  )`;
  ready = true;
}

export interface ChatBinding {
  chat_id: number;
  pipedrive_user_id: number;
  pipedrive_user_name: string;
  comercial_tg_id: number | null;
}
const toBinding = (r: Row): ChatBinding => ({
  chat_id: Number(r.chat_id),
  pipedrive_user_id: Number(r.pipedrive_user_id),
  pipedrive_user_name: r.pipedrive_user_name,
  comercial_tg_id: r.comercial_tg_id == null ? null : Number(r.comercial_tg_id),
});

export async function markUpdate(updateId: number): Promise<boolean> {
  const rows = await q`INSERT INTO processed_updates (update_id) VALUES (${updateId})
    ON CONFLICT DO NOTHING RETURNING update_id`;
  return rows.length > 0;
}

export async function getChat(chatId: number): Promise<ChatBinding | null> {
  const rows = await q`SELECT * FROM chats WHERE chat_id = ${chatId}`;
  return rows[0] ? toBinding(rows[0]) : null;
}

export async function getChatByComercial(tgUserId: number): Promise<ChatBinding | null> {
  const rows = await q`SELECT * FROM chats WHERE comercial_tg_id = ${tgUserId} ORDER BY created_at LIMIT 1`;
  return rows[0] ? toBinding(rows[0]) : null;
}

export async function listChats(): Promise<ChatBinding[]> {
  return (await q`SELECT * FROM chats ORDER BY created_at`).map(toBinding);
}

export async function bindChat(chatId: number, pdUserId: number, pdUserName: string): Promise<void> {
  await q`INSERT INTO chats (chat_id, pipedrive_user_id, pipedrive_user_name)
    VALUES (${chatId}, ${pdUserId}, ${pdUserName})
    ON CONFLICT (chat_id) DO UPDATE SET pipedrive_user_id = EXCLUDED.pipedrive_user_id,
      pipedrive_user_name = EXCLUDED.pipedrive_user_name, comercial_tg_id = NULL`;
}

export async function unbindChat(chatId: number): Promise<void> {
  await q`DELETE FROM chats WHERE chat_id = ${chatId}`;
}

export async function setComercial(chatId: number, tgUserId: number): Promise<void> {
  await q`UPDATE chats SET comercial_tg_id = ${tgUserId} WHERE chat_id = ${chatId} AND comercial_tg_id IS NULL`;
}

export async function migrateChat(oldId: number, newId: number): Promise<void> {
  await q`UPDATE chats SET chat_id = ${newId} WHERE chat_id = ${oldId}`;
  await q`UPDATE messages SET chat_id = ${newId} WHERE chat_id = ${oldId}`;
}

export async function addMessage(chatId: number, role: 'user' | 'assistant', content: string, tgUserId?: number): Promise<void> {
  await q`INSERT INTO messages (chat_id, tg_user_id, role, content) VALUES (${chatId}, ${tgUserId ?? null}, ${role}, ${content})`;
}

/** Últimos mensajes desde el último /olvidar, en orden cronológico. */
export async function getHistory(chatId: number, limit = 16): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  const rows = await q`SELECT role, content FROM messages
    WHERE chat_id = ${chatId}
      AND id > COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = ${chatId} AND role = 'reset'), 0)
      AND role IN ('user', 'assistant')
    ORDER BY id DESC LIMIT ${limit}`;
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

export async function resetHistory(chatId: number): Promise<void> {
  await q`INSERT INTO messages (chat_id, role, content) VALUES (${chatId}, 'reset', '')`;
}

export async function savePending(id: string, chatId: number, tool: string, input: unknown, summary: string): Promise<void> {
  await q`INSERT INTO pending_actions (id, chat_id, tool, input, summary)
    VALUES (${id}, ${chatId}, ${tool}, ${JSON.stringify(input)}::jsonb, ${summary})`;
}

export async function takePending(id: string, chatId: number, newStatus: 'running' | 'cancelled'): Promise<Row | null> {
  // Cambia el estado solo si seguía pendiente y tiene menos de 24 h: así un doble clic no ejecuta dos veces
  const rows = await q`UPDATE pending_actions SET status = ${newStatus}
    WHERE id = ${id} AND chat_id = ${chatId} AND status = 'pending' AND created_at > now() - interval '24 hours'
    RETURNING *`;
  return rows[0] ?? null;
}

export async function finishPending(id: string, status: 'done' | 'failed'): Promise<void> {
  await q`UPDATE pending_actions SET status = ${status} WHERE id = ${id}`;
}

export async function logAction(a: {
  chatId: number;
  pdUserId?: number;
  tgUserId?: number;
  tool: string;
  input?: unknown;
  summary?: string;
  status: 'done' | 'cancelled' | 'failed';
  detail?: string;
}): Promise<void> {
  await q`INSERT INTO action_log (chat_id, pipedrive_user_id, tg_user_id, tool, input, summary, status, detail)
    VALUES (${a.chatId}, ${a.pdUserId ?? null}, ${a.tgUserId ?? null}, ${a.tool},
      ${a.input === undefined ? null : JSON.stringify(a.input)}::jsonb, ${a.summary ?? null}, ${a.status}, ${a.detail ?? null})`;
}

/** Acciones de un día (fecha de Madrid YYYY-MM-DD). */
export async function actionsForDay(chatId: number, day: string): Promise<Row[]> {
  return q`SELECT * FROM action_log
    WHERE chat_id = ${chatId} AND (created_at AT TIME ZONE 'Europe/Madrid')::date = ${day}::date
    ORDER BY id`;
}

/** Nº de mensajes que el comercial ha enviado al bot en un día. */
export async function userMessagesForDay(chatId: number, day: string): Promise<number> {
  const rows = await q`SELECT COUNT(*)::int AS n FROM messages
    WHERE chat_id = ${chatId} AND role = 'user' AND (created_at AT TIME ZONE 'Europe/Madrid')::date = ${day}::date`;
  return Number(rows[0]?.n ?? 0);
}

/** Marca el resumen de hoy como enviado. Devuelve false si ya se había enviado. */
export async function claimSummary(chatId: number, day: string): Promise<boolean> {
  const rows = await q`INSERT INTO summary_sent (chat_id, day) VALUES (${chatId}, ${day}::date)
    ON CONFLICT DO NOTHING RETURNING chat_id`;
  return rows.length > 0;
}

export async function releaseSummary(chatId: number, day: string): Promise<void> {
  await q`DELETE FROM summary_sent WHERE chat_id = ${chatId} AND day = ${day}::date`;
}
