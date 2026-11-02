// Informe de uso del bot para Nacho (admin): qué ha hecho cada comercial con el bot en un día.
import { actionsForDay, listChats, userMessagesListForDay } from './db.js';
import { isAdmin } from './env.js';

const MAX_PETICIONES = 6;
const corta = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fmt = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

export async function buildUsageReport(day: string): Promise<string> {
  const chats = await listChats();
  if (chats.length === 0) return 'No hay ningún grupo vinculado todavía.';

  const bloques: string[] = [];
  const inactivos: string[] = [];
  let totalMsgs = 0;
  let totalCambios = 0;

  for (const chat of chats) {
    const [msgs, acciones] = await Promise.all([userMessagesListForDay(chat.chat_id, day), actionsForDay(chat.chat_id, day)]);
    // Solo lo que escribe el comercial (no lo que escribe Nacho en el grupo)
    const delComercial = msgs.filter((m) => !isAdmin(Number(m.tg_user_id)));
    const hechas = acciones.filter((a) => a.status === 'done');
    const canceladas = acciones.filter((a) => a.status === 'cancelled').length;
    const fallidas = acciones.filter((a) => a.status === 'failed');

    if (delComercial.length === 0 && acciones.length === 0) {
      inactivos.push(chat.pipedrive_user_name);
      continue;
    }
    totalMsgs += delComercial.length;
    totalCambios += hechas.length;

    const l: string[] = [
      `**${chat.pipedrive_user_name}**: ${delComercial.length} mensajes, ${hechas.length} cambios hechos` +
        (canceladas ? `, ${canceladas} cancelados` : '') +
        (fallidas.length ? `, ${fallidas.length} fallidos` : ''),
    ];
    if (delComercial.length) {
      l.push('Qué pidió:');
      for (const m of delComercial.slice(0, MAX_PETICIONES)) {
        const texto = String(m.content).replace(/^[^:]{1,60}:\s/, ''); // quita el "Nombre: " del grupo
        l.push(`• ${m.hora} ${corta(texto)}`);
      }
      if (delComercial.length > MAX_PETICIONES) l.push(`• … y ${delComercial.length - MAX_PETICIONES} más`);
    }
    if (hechas.length) {
      l.push('Cambios en Pipedrive:');
      for (const a of hechas) l.push(`• ${corta(String(a.summary ?? a.tool).split('\n')[0])}`);
    }
    for (const a of fallidas) l.push(`⚠️ Falló: ${corta(String(a.summary ?? a.tool).split('\n')[0])} (${corta(String(a.detail ?? ''), 80)})`);
    bloques.push(l.join('\n'));
  }

  const out = [`📋 Uso del bot · ${fmt(day)}`, `${totalMsgs} mensajes y ${totalCambios} cambios en Pipedrive entre todos.`];
  if (bloques.length) out.push('', bloques.join('\n\n'));
  if (inactivos.length) out.push('', `Sin usar el bot: ${inactivos.join(', ')}.`);
  return out.join('\n');
}
