// Resumen diario (9:30, todos los días) que se manda a cada grupo.
// Se recogen los deals abiertos del comercial con su contexto y Claude escribe el resumen con el estilo de Nacho.
import type Anthropic from '@anthropic-ai/sdk';
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

// Embudo y etapas del resumen (leaseir.pipedrive.com)
const PIPELINE_SINGLE_LEADS = 5;
const STAGE_GANADO = 46;
const STAGES_NEVERA = new Set([41, 45]); // 41 Nevera no interesado, 45 Nevera cualificados

/** Recoge los deals del comercial en Single Leads (solo lectura) en un formato compacto para Claude. */
async function collect(uid: number) {
  const today = todayMadrid();
  const [deals, acts, { stages }] = await Promise.all([
    pd.listDeals(uid, 'open'),
    pd.listActivities(uid, { done: 0 }),
    pd.stagesAndPipelines(),
  ]);
  const stageName = new Map<number, string>(stages.map((s: any) => [s.id, s.name]));
  const enSingle = deals.filter((d) => pd.ownerId(d) === uid && Number(d.pipeline_id) === PIPELINE_SINGLE_LEADS);
  const vivos = enSingle.filter((d) => d.stage_id !== STAGE_GANADO && !STAGES_NEVERA.has(d.stage_id));
  const nevera = enSingle.filter((d) => STAGES_NEVERA.has(d.stage_id));

  const actsByDeal = new Map<number, any[]>();
  for (const a of acts.filter((a) => pd.ownerId(a) === uid && a.deal_id)) {
    const l = utcToMadrid(a.due_date, a.due_time);
    const t = {
      asunto: a.subject,
      tipo: a.type,
      fecha: l.date || undefined,
      hora: l.time ?? undefined,
      estado: !l.date ? 'sin fecha' : l.date < today ? 'vencida' : l.date === today ? 'hoy' : 'próxima',
    };
    actsByDeal.set(a.deal_id, [...(actsByDeal.get(a.deal_id) ?? []), t]);
  }

  const notas = async (id: number, n: number) =>
    (await pd.dealNotes(id, n).catch(() => [])).map((x: any) => ({ fecha: day(x.add_time), texto: clean(x.content, 500) }));

  const leads = await pool(vivos, 5, async (d) => {
    const ns = await notas(d.id, 3);
    return {
      nombre: d.title,
      link: pd.dealUrl(d.id),
      etapa: stageName.get(d.stage_id) ?? `etapa ${d.stage_id}`,
      alta: day(d.add_time),
      ultima_nota: ns[0] ?? null,
      notas_anteriores: ns.slice(1),
      actividades_abiertas: actsByDeal.get(d.id) ?? [],
    };
  });

  const neveraInfo = await pool(nevera, 5, async (d) => ({
    nombre: d.title,
    link: pd.dealUrl(d.id),
    etapa: stageName.get(d.stage_id) ?? `etapa ${d.stage_id}`,
    ultimas_notas: await notas(d.id, 2),
  }));

  return { hoy: today, ayer: addDays(today, -1), leads_vivos: leads, en_nevera: neveraInfo };
}

export async function buildSummary(chat: ChatBinding): Promise<string> {
  const data = await collect(chat.pipedrive_user_id);
  const nombre = chat.pipedrive_user_name.split(/\s+/)[0];
  if (data.leads_vivos.length === 0 && data.en_nevera.length === 0) {
    return `${nombre}, no tienes deals abiertos en Single Leads.`;
  }

  const system = `Escribes el resumen diario de leads de ${nombre}, comercial de Leaseir (equipos de depilación láser de diodo y radiofrecuencia para clínicas estéticas), a partir de su embudo "Single Leads" de Pipedrive. Lo lee en Telegram a primera hora. Es solo lectura: no propones haber cambiado nada.
Hoy es ${nowMadridText()} (hoy ${data.hoy}, ayer ${data.ayer}).

Datos que recibes:
- leads_vivos: deals abiertos de ${nombre} en Single Leads (sin ganados ni nevera), con etapa, fecha de alta, última nota, notas anteriores y actividades abiertas (vencidas, de hoy y próximas).
- en_nevera: deals en las etapas de nevera, solo para detectar los que no tienen motivo.

Antes de contar: excluye de leads_vivos los que según las notas se han derivado a un distribuidor. No los cuentes ni los menciones como leads vivos.

Clasificación:
- Recién entrados: dados de alta en los últimos días.
- Calientes: interés claro (propuesta, precio, demo, quiere comprar o alquilar pronto).
- Esperan a una fecha: el lead ha dado un plazo (abre en enero, espera licencia…) y la tarea está puesta.
- En marcha (opcional): avanzan con su siguiente paso al día.
- Parados: sin respuesta o con tareas vencidas hace tiempo. Enseña entre 6 y 8 y cuenta el resto ("y X más").
- Nevera sin motivo: de en_nevera, los que no tienen ninguna nota que explique por qué están ahí.
- Si se envió dossier o precio y no hay respuesta: pide seguimiento, NUNCA sugieras mandarlo a la nevera.

Formato:
- En español, tuteando, frases naturales y sin relleno.
- Empieza con una frase con el total de leads vivos y cuántos calientes y cuántos parados hay.
- Secciones con el título en negrita y el número entre paréntesis (por ejemplo **Calientes (4)**). Omite las vacías.
- Cada lead en una línea que empieza por "• ": Nombre ([link](URL)) usando su link, y 1-2 frases: qué quiere, qué se hizo y la siguiente acción con fecha (formato 19/10; "ayer", "hoy" o "mañana" cuando toque). Si la tarea ya no encaja con la última nota, dilo.
- Cierra con una lectura general de 1-2 frases y las prioridades.
- Sin tablas ni otros formatos: solo **negrita** en los títulos, "• " y los [link](URL).
- No inventes nada que no esté en los datos.`;

  // Los modelos nuevos piensan siempre (adaptive thinking) y el pensamiento cuenta dentro de max_tokens.
  // effort 'low' reduce cuánto piensa; max_tokens con margen para que siempre quede sitio para el texto.
  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: `Datos de Pipedrive de ${nombre}:\n${JSON.stringify(data)}` }],
  } as any) as Anthropic.Message;
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
    .trim();
  if (!text) {
    const tipos = res.content.map((b) => b.type).join(',') || 'nada';
    console.error('resumen vacío', { stop_reason: res.stop_reason, tipos, usage: res.usage, leads: data.leads_vivos.length });
    return `${nombre}, no he podido generar el resumen de hoy (motivo: ${res.stop_reason}; bloques: ${tipos}).`;
  }
  return text;
}
