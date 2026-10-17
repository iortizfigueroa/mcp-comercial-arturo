// Resumen diario que se manda a cada grupo (comercial + Nacho).
import { actionsForDay, userMessagesForDay, type ChatBinding } from './db.js';
import * as pd from './pipedrive.js';
import { addDays, todayMadrid, utcToMadrid } from './time.js';

const MAX = 10;
const list = (items: string[]) =>
  items.slice(0, MAX).map((s) => `- ${s}`).join('\n') + (items.length > MAX ? `\n- … y ${items.length - MAX} más` : '');

export async function buildSummary(chat: ChatBinding): Promise<string> {
  const today = todayMadrid();
  const tomorrow = addDays(today, 1);
  const uid = chat.pipedrive_user_id;

  const [actions, nMsgs, openActs, openDeals] = await Promise.all([
    actionsForDay(chat.chat_id, today),
    userMessagesForDay(chat.chat_id, today),
    pd.listActivities(uid, { done: 0 }),
    pd.listDeals(uid, 'open'),
  ]);

  const mine = openActs.filter((a) => pd.ownerId(a) === uid);
  const withDate = mine.map((a) => ({ a, l: utcToMadrid(a.due_date, a.due_time) }));
  const label = ({ a, l }: { a: any; l: { date: string; time: string | null } }, showDate: boolean) =>
    `${showDate ? `${l.date} ` : ''}${l.time ? `${l.time} ` : ''}${a.subject}${a.deal_title ? ` · ${a.deal_title}` : ''}`;

  const vencidas = withDate.filter((x) => x.l.date && x.l.date < today).sort((x, y) => x.l.date.localeCompare(y.l.date));
  const hoyPend = withDate.filter((x) => x.l.date === today);
  const manana = withDate.filter((x) => x.l.date === tomorrow).sort((x, y) => (x.l.time ?? '').localeCompare(y.l.time ?? ''));
  const sinTarea = openDeals.filter((d) => pd.ownerId(d) === uid && !d.next_activity_date);

  const hechas = actions.filter((r) => r.status === 'done');
  const canceladas = actions.filter((r) => r.status === 'cancelled').length;
  const fallidas = actions.filter((r) => r.status === 'failed').length;

  const out: string[] = [`📊 Resumen del día · ${chat.pipedrive_user_name} · ${today}`];

  out.push(
    `\n🤖 Con el bot hoy: ${nMsgs} mensajes, ${hechas.length} cambios hechos` +
      (canceladas ? `, ${canceladas} cancelados` : '') +
      (fallidas ? `, ${fallidas} fallidos` : ''),
  );
  if (hechas.length) out.push(list(hechas.map((r) => String(r.summary ?? r.tool).split('\n')[0])));

  out.push(`\n⏰ Tareas vencidas: ${vencidas.length}`);
  if (vencidas.length) out.push(list(vencidas.map((x) => label(x, true))));

  if (hoyPend.length) {
    out.push(`\n🕐 De hoy sin marcar como hechas: ${hoyPend.length}`);
    out.push(list(hoyPend.map((x) => label(x, false))));
  }

  out.push(`\n📅 Mañana: ${manana.length}`);
  if (manana.length) out.push(list(manana.map((x) => label(x, false))));

  out.push(`\n🧊 Deals abiertos sin próxima tarea: ${sinTarea.length} de ${openDeals.length}`);
  if (sinTarea.length) out.push(list(sinTarea.map((d) => d.title)));

  return out.join('\n');
}
