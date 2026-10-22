// Resumen diario (9:30, todos los días) que se manda a cada grupo.
// Se recogen los deals abiertos del comercial con su contexto y Claude escribe el resumen con el estilo de Nacho.
import { claude, MODEL } from './claude.js';
import type { ChatBinding } from './db.js';
import * as pd from './pipedrive.js';
import { addDays, nowMadridText, todayMadrid, utcToMadrid } from './time.js';

const clean = (html: unknown, max = 350) =>
  String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const day = (s: unknown) => (typeof s === 'string' && s ? s.slice(0, 10) : undefined);

/** Ejecuta fn sobre items con como mucho n en paralelo. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Recoge los datos de Pipedrive del comercial en un formato compacto para Claude. */
async function collect(uid: number) {
  const today = todayMadrid();
  const [deals, acts, { stages, pipelines }] = await Promise.all([
    pd.listDeals(uid, 'open'),
    pd.listActivities(uid, { done: 0 }),
    pd.stagesAndPipelines(),
  ]);
  const mine = deals.filter((d) => pd.ownerId(d) === uid);
  const stageById = new Map<number, any>(stages.map((s: any) => [s.id, s]));
  const pipeName = new Map<number, string>(pipelines.map((p: any) => [p.id, p.name]));

  const actsByDeal = new Map<number, any[]>();
  const sueltas: any[] = [];
  for (const a of acts.filter((a) => pd.ownerId(a) === uid)) {
    const l = utcToMadrid(a.due_date, a.due_time);
    const t = { asunto: a.subject, tipo: a.type, fecha: l.date || undefined, hora: l.time ?? undefined, vencida: !!l.date && l.date < today };
    if (a.deal_id) actsByDeal.set(a.deal_id, [...(actsByDeal.get(a.deal_id) ?? []), t]);
    else sueltas.push(t);
  }

  const leads = await pool(mine, 5, async (d) => {
    const st = stageById.get(d.stage_id);
    const notes = await pd.dealNotes(d.id, 3).catch(() => []);
    return {
      nombre: d.title,
      link: pd.dealUrl(d.id),
      organizacion: d.org_name ?? d.org_id?.name ?? undefined,
      embudo: pipeName.get(st?.pipeline_id ?? d.pipeline_id) ?? undefined,
      etapa: st?.name,
      valor: d.value ? `${d.value} ${d.currency ?? ''}`.trim() : undefined,
      etiquetas: d.label ?? undefined,
      creado: day(d.add_time),
      etapa_desde: day(d.stage_change_time),
      ultima_actividad_hecha: day(d.last_activity_date),
      ultimo_email_recibido: day(d.last_incoming_mail_time),
      ultimo_email_enviado: day(d.last_outgoing_mail_time),
      tareas_pendientes: actsByDeal.get(d.id) ?? [],
      ultimas_notas: notes.map((n: any) => ({ fecha: day(n.add_time), texto: clean(n.content) })),
    };
  });

  return { hoy: today, ayer: addDays(today, -1), leads, tareas_sin_deal: sueltas };
}

const STYLE = `Ejemplo de estilo (datos inventados; copia el TONO y la ESTRUCTURA, nunca estos nombres):

Pablo, tienes 12 leads vivos en Single Leads: 3 calientes y 6 parados. No cuento a Marta Gil, que lleva Lourdes, ni los 2 que tienes en la nevera.

**Recién entrados (1)**
• Clínica Aurora ([link](https://x/deal/1)) tiene dos centros en Sevilla. Le escribiste por email y por WhatsApp y no ha contestado. La tarea de insistirle venció el 19/10.

**Calientes (3)**
• Laura Pérez ([link](https://x/deal/2)) aceptó el alquiler y quiere arrancar antes de diciembre. La llamada sigue pendiente desde el 15/10 y es lo más urgente.
• Estética Mar ([link](https://x/deal/3)) tiene la propuesta desde agosto y la compara con otro diodo. El seguimiento venció el 19/10.

**Esperan a una fecha (1)**
• Centro Nube ([link](https://x/deal/4)) retoma el proyecto en enero, y tienes tarea el 12/01.

**Parados (6)**
• Ana Ruiz ([link](https://x/deal/5)) no contesta desde el 9/10.
• Centro Uno ([link](https://x/deal/6)), Velvet ([link](https://x/deal/7)) y Lúa ([link](https://x/deal/8)) tienen el seguimiento vencido desde julio.

**En la nevera sin motivo (1)**
• Spa Norte ([link](https://x/deal/9)) no tiene el motivo apuntado.

Tienes las notas al día, pero se te acumulan tareas vencidas. Lo que puede cerrarse pronto son Laura y Estética Mar, y Laura va primero. Si me dices qué pasó con cada uno, lo actualizo en Pipedrive o paso a la nevera los parados.`;

export async function buildSummary(chat: ChatBinding): Promise<string> {
  const data = await collect(chat.pipedrive_user_id);
  const nombre = chat.pipedrive_user_name.split(/\s+/)[0];
  if (data.leads.length === 0 && data.tareas_sin_deal.length === 0) {
    return `${nombre}, no tienes deals abiertos ni tareas pendientes en Pipedrive.`;
  }

  const system = `Escribes el resumen diario de Pipedrive para ${nombre}, comercial de Leaseir (equipos de depilación láser de diodo y radiofrecuencia para clínicas estéticas). Lo lee en Telegram a primera hora.
Hoy es ${nowMadridText()} (hoy ${data.hoy}, ayer ${data.ayer}).

Cómo escribirlo:
- Empieza con una frase: cuántos leads vivos tiene (por embudo si hay varios), cuántos calientes y cuántos parados, y a quién no cuentas y por qué (los que en las notas lleva otra persona, los que están en la nevera).
- Agrupa en secciones con el título en negrita y el número entre paréntesis: Recién entrados, Calientes, Esperan a una fecha, Parados, En la nevera sin motivo. Omite las secciones vacías. Puedes añadir otra si hace falta de verdad.
- Clasifica leyendo las notas, las tareas y las fechas: caliente = hay interés real y siguiente paso claro; parado = sin respuesta o con seguimiento vencido hace tiempo; "esperan a una fecha" = el cliente ha puesto un plazo. "Nevera" = etapa o etiqueta de nevera/congelado/en pausa.
- Una línea por lead que empieza por "• ", con el nombre seguido de ([link](URL)) usando su link, y en una o dos frases lo que importa: quién es, en qué punto está y qué tarea vencida o próxima tiene. Si varios parados están igual, júntalos en una línea.
- Si una tarea ya no encaja con lo que dicen las notas, dilo.
- Fechas en formato 19/10; usa "ayer", "hoy" o "mañana" cuando toque.
- Cierra con un párrafo corto: cómo lleva las notas y las tareas, qué puede cerrarse pronto y qué va primero, y ofrece actualizar Pipedrive o pasar a la nevera los parados.
- Tutea, frases naturales, sin relleno. Sin tablas ni otros formatos: solo **negrita** en los títulos de sección, "• " y los [link](URL).
- No inventes nada que no esté en los datos.

${STYLE}`;

  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system,
    messages: [{ role: 'user', content: `Datos de Pipedrive de ${nombre}:\n${JSON.stringify(data)}` }],
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
    .trim();
  return text || `${nombre}, no he podido generar el resumen de hoy.`;
}
