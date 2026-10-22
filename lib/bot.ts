// Lógica del bot: comandos, mensajes y botones de confirmación.
import { runAgent } from './agent.js';
import * as db from './db.js';
import { isAdmin, privateEnabled } from './env.js';
import * as pd from './pipedrive.js';
import { buildSummary } from './summary.js';
import { getBotUsername, send, sendRich, tg, typing } from './telegram.js';
import { executeWrite, type Ctx } from './tools.js';

const HELP = `Soy el asistente de Pipedrive. Escríbeme normal, por ejemplo:
- qué tareas tengo hoy
- pasa Clínica Sol a negociación
- he llamado a Dermasalud, quieren demo; ponme visita el jueves a las 11
- qué deals no tienen próxima tarea
- marca como perdida la de Estética Luna, se van con otro proveedor

Antes de cambiar nada te pediré confirmación con un botón.
Comandos: /resumen (resumen de hoy), /olvidar (empezar conversación de cero), /ayuda`;

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export async function handleUpdate(update: any): Promise<void> {
  await db.ensureSchema();
  if (!(await db.markUpdate(update.update_id))) return; // reintento de Telegram

  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message;
  if (!msg) return;
  if (msg.migrate_to_chat_id) return db.migrateChat(msg.chat.id, msg.migrate_to_chat_id);

  const text: string | undefined = msg.text ?? msg.caption;
  const from = msg.from;
  if (!text || !from || from.is_bot) return;

  const chatId: number = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const admin = isAdmin(from.id);
  const botName = await getBotUsername();

  // ---------- Comandos ----------
  if (text.startsWith('/')) {
    const [cmdRaw, ...args] = text.trim().split(/\s+/);
    const [cmd, target] = cmdRaw.slice(1).toLowerCase().split('@');
    if (target && target !== botName.toLowerCase()) return; // comando para otro bot
    return handleCommand(cmd, args.join(' '), { chatId, isGroup, admin, fromId: from.id });
  }

  // ---------- Chat privado ----------
  if (!isGroup) {
    if (!privateEnabled()) {
      await send(chatId, 'De momento úsame desde el grupo que tenemos con Nacho. 👍');
      return;
    }
    const binding = await db.getChatByComercial(from.id);
    if (!binding) {
      await send(
        chatId,
        'Todavía no te reconozco. Escribe cualquier cosa una vez en el grupo que tenemos con Nacho y a partir de ahí ya puedes usarme también aquí.',
      );
      return;
    }
    return converse(chatId, binding, from.id, text);
  }

  // ---------- Grupo ----------
  const mentioned = text.toLowerCase().includes(`@${botName.toLowerCase()}`);
  const replyToBot = msg.reply_to_message?.from?.username === botName;
  const binding = await db.getChat(chatId);
  if (!binding) {
    if (mentioned || replyToBot) await send(chatId, 'Este grupo no está vinculado a ningún comercial. Nacho: /vincular <nombre en Pipedrive>');
    return;
  }
  // El bot lee y responde a todo lo que se escribe en el grupo, sea del comercial o del admin
  if (!admin) await db.setComercial(chatId, from.id);

  const clean = text.replace(new RegExp(`@${botName}`, 'ig'), '').trim();
  if (!clean) return;
  // En el grupo puede escribir más de una persona: indicamos quién habla
  const who = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Usuario';
  return converse(chatId, binding, from.id, `${who}${admin ? ' (Nacho, responsable)' : ''}: ${clean}`);
}

async function converse(chatId: number, binding: db.ChatBinding, tgUserId: number, text: string): Promise<void> {
  const ctx: Ctx = {
    chatId: binding.chat_id,
    tgUserId,
    pdUserId: binding.pipedrive_user_id,
    pdUserName: binding.pipedrive_user_name,
  };
  await typing(chatId);
  try {
    const { text: reply, proposals } = await runAgent(ctx, text);
    await db.addMessage(ctx.chatId, 'user', text, tgUserId);
    const memo = proposals.length ? `\n[Propuesto para confirmar: ${proposals.map((p) => p.summary.split('\n')[0]).join(' | ')}]` : '';
    await db.addMessage(ctx.chatId, 'assistant', (reply || '(sin texto)') + memo);

    if (reply) await sendRich(chatId, reply);
    for (const p of proposals) {
      await send(chatId, `¿Confirmo?\n${p.summary}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Confirmar', callback_data: `ok:${p.id}` },
            { text: '❌ Cancelar', callback_data: `no:${p.id}` },
          ]],
        },
      });
    }
  } catch (e) {
    console.error(e);
    await send(chatId, `⚠️ Ha fallado algo: ${(e as Error).message}`);
  }
}

async function handleCallback(cb: any): Promise<void> {
  const data: string = cb.data ?? '';
  const [verb, id] = data.split(':');
  const chatId: number | undefined = cb.message?.chat?.id;
  const messageId: number | undefined = cb.message?.message_id;
  const answer = (text?: string) => tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => undefined);
  if (!chatId || !messageId || !id) return void (await answer());

  const binding = (await db.getChat(chatId)) ?? (await db.getChatByComercial(cb.from.id));
  if (!binding) return void (await answer('Chat no vinculado'));
  const edit = (text: string) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(() => undefined);
  const ctx: Ctx = {
    chatId: binding.chat_id,
    tgUserId: cb.from.id,
    pdUserId: binding.pipedrive_user_id,
    pdUserName: binding.pipedrive_user_name,
  };

  if (verb === 'no') {
    const p = await db.takePending(id, binding.chat_id, 'cancelled');
    if (!p) return void (await answer('Ya no está pendiente'));
    await db.logAction({ chatId: ctx.chatId, pdUserId: ctx.pdUserId, tgUserId: ctx.tgUserId, tool: p.tool, input: p.input, summary: p.summary, status: 'cancelled' });
    await db.addMessage(ctx.chatId, 'assistant', `[Cancelado: ${String(p.summary).split('\n')[0]}]`);
    await edit(`❌ Cancelado\n${p.summary}`);
    return void (await answer('Cancelado'));
  }

  if (verb === 'ok') {
    const p = await db.takePending(id, binding.chat_id, 'running');
    if (!p) return void (await answer('Ya no está pendiente (caducado o ya hecho)'));
    await answer('Haciéndolo…');
    try {
      const result = await executeWrite(p.tool, p.input, ctx);
      await db.finishPending(id, 'done');
      await db.logAction({ chatId: ctx.chatId, pdUserId: ctx.pdUserId, tgUserId: ctx.tgUserId, tool: p.tool, input: p.input, summary: p.summary, status: 'done', detail: result });
      await db.addMessage(ctx.chatId, 'assistant', `[Hecho: ${String(p.summary).split('\n')[0]}]`);
      await edit(`✅ Hecho\n${p.summary}`);
    } catch (e) {
      const err = (e as Error).message;
      await db.finishPending(id, 'failed');
      await db.logAction({ chatId: ctx.chatId, pdUserId: ctx.pdUserId, tgUserId: ctx.tgUserId, tool: p.tool, input: p.input, summary: p.summary, status: 'failed', detail: err });
      await edit(`⚠️ No se pudo hacer\n${p.summary}\n\nMotivo: ${err}`);
    }
    return;
  }
  await answer();
}

async function handleCommand(
  cmd: string,
  arg: string,
  c: { chatId: number; isGroup: boolean; admin: boolean; fromId: number },
): Promise<void> {
  switch (cmd) {
    case 'miid':
      await send(c.chatId, `Tu ID de Telegram: ${c.fromId}\nID de este chat: ${c.chatId}`);
      return;

    case 'start':
    case 'ayuda':
    case 'help':
      if (!c.isGroup && !privateEnabled()) {
        await send(c.chatId, 'De momento úsame desde el grupo que tenemos con Nacho. 👍');
        return;
      }
      await send(c.chatId, HELP);
      return;

    case 'vincular': {
      if (!c.admin) return void (await send(c.chatId, 'Solo Nacho puede vincular grupos.'));
      if (!c.isGroup) return void (await send(c.chatId, 'Esto se hace dentro del grupo del comercial.'));
      if (!arg) return void (await send(c.chatId, 'Uso: /vincular <nombre del comercial en Pipedrive>'));
      const users = (await pd.listUsers()).filter((u) => u.active_flag !== false);
      const idMatch = arg.match(/^id:(\d+)$/i);
      const hits = idMatch
        ? users.filter((u) => u.id === Number(idMatch[1]))
        : users.filter((u) => norm(u.name ?? '').includes(norm(arg)) || norm(u.email ?? '').startsWith(norm(arg)));
      if (hits.length === 0) {
        await send(c.chatId, `No encuentro a «${arg}» en Pipedrive. Usuarios activos:\n${users.map((u) => `- ${u.name} (id:${u.id})`).join('\n')}`);
        return;
      }
      if (hits.length > 1) {
        await send(c.chatId, `Hay varios. Repite con el id:\n${hits.map((u) => `- ${u.name} · ${u.email} → /vincular id:${u.id}`).join('\n')}`);
        return;
      }
      const u = hits[0];
      await db.bindChat(c.chatId, u.id, u.name);
      await send(c.chatId, `✅ Grupo vinculado a ${u.name} (${u.email}).\nDesde ahora todo lo que escriba el comercial aquí va contra sus deals y tareas. Resumen diario a las 9:30, todos los días.`);
      return;
    }

    case 'desvincular':
      if (!c.admin) return;
      await db.unbindChat(c.chatId);
      await send(c.chatId, 'Grupo desvinculado.');
      return;

    case 'resumen': {
      const binding = c.isGroup ? await db.getChat(c.chatId) : await db.getChatByComercial(c.fromId);
      if (!binding) return void (await send(c.chatId, 'Este chat no está vinculado.'));
      await typing(c.chatId);
      await sendRich(c.chatId, await buildSummary(binding));
      return;
    }

    case 'olvidar': {
      const binding = c.isGroup ? await db.getChat(c.chatId) : await db.getChatByComercial(c.fromId);
      if (!binding) return;
      await db.resetHistory(binding.chat_id);
      await send(c.chatId, 'Hecho, empezamos de cero.');
      return;
    }

    default:
      return;
  }
}
