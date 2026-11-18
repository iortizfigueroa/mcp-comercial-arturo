// Herramientas que Claude puede usar. Todas filtran por el comercial del chat (pdUserId):
// nunca se lee ni se toca un deal o una tarea de otro.
import type Anthropic from '@anthropic-ai/sdk';
import * as pd from './pipedrive.js';
import { isDate, isTime, madridToUtc, todayMadrid, utcToMadrid } from './time.js';

export interface Ctx {
  chatId: number;
  tgUserId: number;
  pdUserId: number;
  pdUserName: string;
}

// ---------- Ayudas ----------
async function stageNamer(): Promise<(id: number) => string> {
  const { stages, pipelines } = await pd.stagesAndPipelines();
  const pName = new Map<number, string>(pipelines.map((p: any) => [p.id, p.name]));
  const sById = new Map<number, any>(stages.map((s: any) => [s.id, s]));
  const multi = pipelines.length > 1;
  return (id: number) => {
    const s = sById.get(id);
    if (!s) return `etapa ${id}`;
    return multi ? `${s.name} (${pName.get(s.pipeline_id) ?? 'embudo'})` : s.name;
  };
}

function compactDeal(d: any, stageName: (id: number) => string) {
  return {
    id: d.id,
    titulo: d.title,
    link: pd.dealUrl(d.id),
    organizacion: d.org_name ?? d.org_id?.name ?? d.organization?.name ?? undefined,
    contacto: d.person_name ?? d.person_id?.name ?? d.person?.name ?? undefined,
    etapa: stageName(d.stage_id ?? d.stage?.id),
    estado: d.status,
    valor: d.value ? `${d.value} ${d.currency ?? ''}`.trim() : undefined,
    proxima_tarea: d.next_activity_date
      ? `${d.next_activity_date}${d.next_activity_subject ? ` · ${d.next_activity_subject}` : ''}`
      : 'ninguna',
    actualizado: typeof d.update_time === 'string' ? d.update_time.slice(0, 10) : undefined,
  };
}

function compactActivity(a: any, today = todayMadrid()) {
  const l = utcToMadrid(a.due_date, a.due_time);
  return {
    id: a.id,
    asunto: a.subject,
    tipo: a.type,
    fecha: l.date || undefined,
    hora: l.time ?? undefined,
    hecha: !!a.done,
    vencida: !a.done && !!l.date && l.date < today ? true : undefined,
    deal: a.deal_title ?? undefined,
    deal_id: a.deal_id ?? undefined,
    deal_link: a.deal_id ? pd.dealUrl(a.deal_id) : undefined,
    organizacion: a.org_name ?? undefined,
  };
}

async function ownDeal(id: unknown, ctx: Ctx): Promise<any> {
  const dealId = Number(id);
  if (!Number.isInteger(dealId) || dealId <= 0) throw new Error('deal_id no válido');
  const deal = await pd.getDeal(dealId).catch(() => null);
  if (!deal) throw new Error(`No existe el deal ${dealId}`);
  if (pd.ownerId(deal) !== ctx.pdUserId) throw new Error('Ese deal no es de este comercial; no puedo tocarlo.');
  return deal;
}

async function ownActivity(id: unknown, ctx: Ctx): Promise<any> {
  const actId = Number(id);
  if (!Number.isInteger(actId) || actId <= 0) throw new Error('activity_id no válido');
  const act = await pd.getActivity(actId).catch(() => null);
  if (!act) throw new Error(`No existe la tarea ${actId}`);
  if (pd.ownerId(act) !== ctx.pdUserId) throw new Error('Esa tarea no es de este comercial; no puedo tocarla.');
  return act;
}

const fmtFecha = (date: string, time?: string | null) => (time ? `${date} ${time}` : date);

// ---------- Lectura (se ejecutan directamente) ----------
type ReadHandler = (input: any, ctx: Ctx) => Promise<unknown>;

const READ: Record<string, { def: Anthropic.Tool; run: ReadHandler }> = {
  mis_deals: {
    def: {
      name: 'mis_deals',
      description:
        'Lista los deals del comercial. Por defecto los abiertos. Se puede filtrar por etapa o quedarse solo con los que no tienen próxima tarea.',
      input_schema: {
        type: 'object',
        properties: {
          estado: { type: 'string', enum: ['open', 'won', 'lost', 'all_not_deleted'], description: 'Por defecto open' },
          etapa_id: { type: 'integer', description: 'Solo deals en esta etapa' },
          sin_proxima_tarea: { type: 'boolean', description: 'Solo deals sin próxima tarea programada' },
        },
      },
    },
    run: async (input, ctx) => {
      const name = await stageNamer();
      let deals = await pd.listDeals(ctx.pdUserId, input.estado ?? 'open');
      deals = deals.filter((d) => pd.ownerId(d) === ctx.pdUserId);
      if (input.etapa_id) deals = deals.filter((d) => d.stage_id === Number(input.etapa_id));
      if (input.sin_proxima_tarea) deals = deals.filter((d) => !d.next_activity_date);
      deals.sort((a, b) => String(b.update_time).localeCompare(String(a.update_time)));
      return { total: deals.length, mostrando: Math.min(deals.length, 60), deals: deals.slice(0, 60).map((d) => compactDeal(d, name)) };
    },
  },

  buscar_deal: {
    def: {
      name: 'buscar_deal',
      description:
        'Busca deals del comercial por texto (nombre del deal, de la clínica/organización o notas). Úsala siempre antes de proponer cambios sobre un deal nombrado.',
      input_schema: {
        type: 'object',
        properties: { texto: { type: 'string', description: 'Al menos 2 caracteres' } },
        required: ['texto'],
      },
    },
    run: async (input, ctx) => {
      const texto = String(input.texto ?? '').trim();
      if (texto.length < 2) throw new Error('Texto demasiado corto');
      const name = await stageNamer();
      const found = new Map<number, any>();
      for (const it of await pd.searchDeals(texto)) {
        if (Number(it.owner?.id) === ctx.pdUserId) found.set(it.id, it);
      }
      if (found.size === 0) {
        // Si no sale por título, probamos por organización
        for (const org of (await pd.searchOrgs(texto)).slice(0, 3)) {
          for (const d of await pd.orgDeals(org.id)) if (pd.ownerId(d) === ctx.pdUserId) found.set(d.id, d);
        }
      }
      return { resultados: [...found.values()].slice(0, 15).map((d) => compactDeal(d, name)) };
    },
  },

  ver_deal: {
    def: {
      name: 'ver_deal',
      description: 'Detalle de un deal del comercial: datos, tareas pendientes y últimas notas.',
      input_schema: { type: 'object', properties: { deal_id: { type: 'integer' } }, required: ['deal_id'] },
    },
    run: async (input, ctx) => {
      const deal = await ownDeal(input.deal_id, ctx);
      const name = await stageNamer();
      const [acts, notes] = await Promise.all([pd.dealActivities(deal.id, 0), pd.dealNotes(deal.id, 5)]);
      return {
        ...compactDeal(deal, name),
        telefono: deal.person_id?.phone?.[0]?.value,
        email: deal.person_id?.email?.[0]?.value,
        tareas_pendientes: acts.map((a: any) => compactActivity(a)),
        ultimas_notas: notes.map((n: any) => ({
          fecha: String(n.add_time ?? '').slice(0, 10),
          texto: String(n.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
        })),
      };
    },
  },

  mis_tareas: {
    def: {
      name: 'mis_tareas',
      description:
        'Tareas (actividades) del comercial. Por defecto todas las pendientes, incluidas las vencidas. Fechas en hora de Madrid.',
      input_schema: {
        type: 'object',
        properties: {
          estado: { type: 'string', enum: ['pendientes', 'hechas'] },
          desde: { type: 'string', description: 'YYYY-MM-DD' },
          hasta: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
    run: async (input, ctx) => {
      const done: 0 | 1 = input.estado === 'hechas' ? 1 : 0;
      const acts = (
        await pd.listActivities(ctx.pdUserId, {
          done,
          start_date: isDate(input.desde) ? input.desde : undefined,
          end_date: isDate(input.hasta) ? input.hasta : undefined,
        })
      ).filter((a) => pd.ownerId(a) === ctx.pdUserId);
      const today = todayMadrid();
      const list = acts
        .map((a) => compactActivity(a, today))
        .sort((a, b) => `${a.fecha ?? '9'}${a.hora ?? ''}`.localeCompare(`${b.fecha ?? '9'}${b.hora ?? ''}`));
      return { total: list.length, tareas: list.slice(0, 80) };
    },
  },
};


// ---------- Alta de leads: configuración de Pipedrive (leaseir.pipedrive.com) ----------
const PIPELINE_SINGLE_LEADS = 5;
const F = {
  orgCiudad: '2588ebf2635f92b75a7291b208536961ebece135',
  orgProvincia: 'e69e43abad2a72c755cd1e4dda98f97bed4258cc',
  orgOrigen: 'b8d3ba16764fb7b5da8e6ad1576e79c150ccbcb6',
  orgComercial: 'e9a50d55834a0fe97eba6f1c7e0e7fbffdb9e8d8',
  orgPais: 'e4d411634d14026c59658bfb3c61503778ebc9cc',
  orgTipoCuenta: '940deb6059d9a0d7a8bacd53247a37d2e1b815de',
  orgTelefono: 'fd7c6cc2ef2b810e84b20daf21b63380345ab08b',
  orgEmail: 'b984255b9589467521790f10cc4bff189cda3913',
  dealTieneCentro: '862b7eaa6ac5d37209038d9a8f5949fcac13e070',
  dealNumCentros: '5e8effe65bdb68e814e3ca7b88bb8cb49c1569ca',
  dealTecnologia: '9b82c50c4340a555ca5dff9fa2ba985e4d7be4c4',
};
const ORIGEN_ID: Record<string, number> = {
  busqueda_propia: 66, referencia: 67, redes_sociales: 68, web_telefono: 69, otros: 73, distribuidor: 158,
};
const ORIGEN_LABEL: Record<string, string> = {
  busqueda_propia: 'búsqueda propia', referencia: 'referencia', redes_sociales: 'redes sociales',
  web_telefono: 'web/teléfono', otros: 'otros', distribuidor: 'distribuidor',
};
const TIENE_CENTRO_ID: Record<string, number> = { si: 168, lo_va_a_montar: 169, no: 170 };
const TECNO_ID: Record<string, number> = {
  diodo: 171, alejandrita: 172, ipl: 173, shr: 174, ndyag: 175, cera_hilo_otros: 176, ninguna: 177,
};
const COMERCIAL_OPCIONES: [string, number][] = [
  ['david', 27], ['francisco', 28], ['oliver', 29], ['carlo', 30], ['janna', 31], ['maria martire', 32],
  ['arturo', 33], ['ignacio', 34], ['malak', 152], ['iñigo', 153],
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const str = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : undefined;
};
const digits = (s: string) => s.replace(/\D/g, '');
function comercialAsignado(pdUserName: string): number | undefined {
  const n = norm(pdUserName);
  return COMERCIAL_OPCIONES.find(([k]) => n.startsWith(norm(k)))?.[1];
}

/** Busca si el lead ya existe (por teléfono, email, organización o deal con el mismo nombre). */
async function findDuplicate(l: { clinica?: string; contacto?: string; telefono?: string; email?: string }): Promise<
  { motivo: string; ownerId?: number; label: string; dealId?: number } | null
> {
  const checks: Promise<{ motivo: string; ownerId?: number; label: string; dealId?: number } | null>[] = [];
  if (l.email) {
    checks.push(
      pd.search('persons', l.email, { fields: 'email', exact: true }).then((r) =>
        r[0] ? { motivo: 'mismo email', ownerId: Number(r[0].owner?.id), label: r[0].name } : null,
      ),
    );
  }
  if (l.telefono && digits(l.telefono).length >= 6) {
    const tail = digits(l.telefono).slice(-9);
    checks.push(
      pd.search('persons', tail, { fields: 'phone' }).then((r) => {
        const hit = r.find((p: any) => (p.phones ?? []).some((ph: string) => digits(String(ph)).endsWith(tail)));
        return hit ? { motivo: 'mismo teléfono', ownerId: Number(hit.owner?.id), label: hit.name } : null;
      }),
    );
  }
  const nombre = l.clinica ?? l.contacto;
  if (nombre) {
    checks.push(
      pd.search('deals', nombre, { fields: 'title', exact: true }).then((r) =>
        r[0] ? { motivo: 'deal con el mismo nombre', ownerId: Number(r[0].owner?.id), label: r[0].title, dealId: r[0].id } : null,
      ),
    );
  }
  if (l.clinica) {
    checks.push(
      pd.search('organizations', l.clinica, { fields: 'name', exact: true }).then((r) =>
        r[0] ? { motivo: 'organización con el mismo nombre', ownerId: Number(r[0].owner?.id), label: r[0].name } : null,
      ),
    );
  }
  const res = await Promise.all(checks);
  return res.find(Boolean) ?? null;
}

// ---------- Escritura (proponer -> botón ✅ -> ejecutar) ----------
interface WriteTool {
  def: (types: any[]) => Anthropic.Tool;
  /** Valida y devuelve el resumen legible + el input normalizado. Lanza error si algo no cuadra. */
  propose: (input: any, ctx: Ctx) => Promise<{ summary: string; input: any }>;
  /** Ejecuta en Pipedrive. Devuelve texto corto de resultado. */
  execute: (input: any, ctx: Ctx) => Promise<string>;
}

const WRITE: Record<string, WriteTool> = {
  cambiar_etapa: {
    def: () => ({
      name: 'cambiar_etapa',
      description: 'Propone mover un deal del comercial a otra etapa. El usuario lo confirma con un botón.',
      input_schema: {
        type: 'object',
        properties: { deal_id: { type: 'integer' }, etapa_id: { type: 'integer' } },
        required: ['deal_id', 'etapa_id'],
      },
    }),
    propose: async (input, ctx) => {
      const deal = await ownDeal(input.deal_id, ctx);
      const { stages } = await pd.stagesAndPipelines();
      const target = stages.find((s: any) => s.id === Number(input.etapa_id));
      if (!target) throw new Error(`No existe la etapa ${input.etapa_id}`);
      if (deal.stage_id === target.id) throw new Error('El deal ya está en esa etapa');
      const name = await stageNamer();
      return {
        summary: `Mover «${deal.title}»: ${name(deal.stage_id)} → ${name(target.id)}`,
        input: { deal_id: deal.id, etapa_id: target.id },
      };
    },
    execute: async (input, ctx) => {
      await ownDeal(input.deal_id, ctx);
      await pd.updateDeal(input.deal_id, { stage_id: input.etapa_id });
      return 'Etapa cambiada';
    },
  },

  cerrar_deal: {
    def: () => ({
      name: 'cerrar_deal',
      description: 'Propone marcar un deal del comercial como ganado o perdido (con motivo si es perdido).',
      input_schema: {
        type: 'object',
        properties: {
          deal_id: { type: 'integer' },
          resultado: { type: 'string', enum: ['ganado', 'perdido'] },
          motivo: { type: 'string', description: 'Motivo de pérdida' },
        },
        required: ['deal_id', 'resultado'],
      },
    }),
    propose: async (input, ctx) => {
      const deal = await ownDeal(input.deal_id, ctx);
      const won = input.resultado === 'ganado';
      const motivo = !won && input.motivo ? String(input.motivo).slice(0, 250) : undefined;
      return {
        summary: `Marcar «${deal.title}» como ${won ? 'GANADO 🎉' : 'PERDIDO'}${motivo ? ` (motivo: ${motivo})` : ''}`,
        input: { deal_id: deal.id, status: won ? 'won' : 'lost', lost_reason: motivo },
      };
    },
    execute: async (input, ctx) => {
      await ownDeal(input.deal_id, ctx);
      await pd.updateDeal(input.deal_id, { status: input.status, ...(input.lost_reason ? { lost_reason: input.lost_reason } : {}) });
      return input.status === 'won' ? 'Deal ganado' : 'Deal perdido';
    },
  },

  crear_tarea: {
    def: (types) => ({
      name: 'crear_tarea',
      description:
        'Propone crear una tarea (actividad) para el comercial, normalmente ligada a un deal suyo. Fecha y hora en hora de Madrid; sin hora si no la dice.',
      input_schema: {
        type: 'object',
        properties: {
          asunto: { type: 'string' },
          tipo: {
            type: 'string',
            enum: types.length ? types.map((t: any) => t.key_string) : undefined,
            description: `Tipo de actividad: ${types.map((t: any) => `${t.key_string} = ${t.name}`).join(', ')}`,
          },
          fecha: { type: 'string', description: 'YYYY-MM-DD' },
          hora: { type: 'string', description: 'HH:MM (opcional)' },
          duracion_min: { type: 'integer', description: 'Opcional' },
          deal_id: { type: 'integer', description: 'Deal al que va ligada (recomendado)' },
          nota: { type: 'string', description: 'Opcional' },
        },
        required: ['asunto', 'tipo', 'fecha'],
      },
    }),
    propose: async (input, ctx) => {
      const types = await pd.activityTypes();
      const tipo = types.find((t: any) => t.key_string === input.tipo);
      if (!tipo) throw new Error(`Tipo de tarea desconocido: ${input.tipo}`);
      if (!isDate(input.fecha)) throw new Error('La fecha debe ser YYYY-MM-DD');
      if (input.hora !== undefined && input.hora !== '' && !isTime(input.hora)) throw new Error('La hora debe ser HH:MM');
      const deal = input.deal_id ? await ownDeal(input.deal_id, ctx) : null;
      const asunto = String(input.asunto ?? '').trim().slice(0, 200);
      if (!asunto) throw new Error('Falta el asunto');
      return {
        summary: `Nueva tarea: ${tipo.name} «${asunto}» · ${fmtFecha(input.fecha, input.hora || null)}${deal ? ` · en «${deal.title}»` : ''}`,
        input: {
          asunto,
          tipo: tipo.key_string,
          fecha: input.fecha,
          hora: input.hora || null,
          duracion_min: Number.isInteger(input.duracion_min) ? input.duracion_min : null,
          deal_id: deal?.id ?? null,
          nota: input.nota ? String(input.nota).slice(0, 2000) : null,
        },
      };
    },
    execute: async (input, ctx) => {
      if (input.deal_id) await ownDeal(input.deal_id, ctx);
      const when = input.hora ? madridToUtc(input.fecha, input.hora) : { due_date: input.fecha };
      const dur = input.duracion_min
        ? `${String(Math.floor(input.duracion_min / 60)).padStart(2, '0')}:${String(input.duracion_min % 60).padStart(2, '0')}`
        : undefined;
      const act = await pd.createActivity({
        subject: input.asunto,
        type: input.tipo,
        ...when,
        ...(dur ? { duration: dur } : {}),
        ...(input.deal_id ? { deal_id: input.deal_id } : {}),
        ...(input.nota ? { note: input.nota } : {}),
        user_id: ctx.pdUserId,
      });
      return `Tarea creada (id ${act?.id})`;
    },
  },

  completar_tarea: {
    def: () => ({
      name: 'completar_tarea',
      description: 'Propone marcar como hecha una tarea del comercial.',
      input_schema: { type: 'object', properties: { activity_id: { type: 'integer' } }, required: ['activity_id'] },
    }),
    propose: async (input, ctx) => {
      const a = await ownActivity(input.activity_id, ctx);
      if (a.done) throw new Error('Esa tarea ya está hecha');
      const l = utcToMadrid(a.due_date, a.due_time);
      return {
        summary: `Marcar como hecha: «${a.subject}» (${fmtFecha(l.date, l.time)}${a.deal_title ? ` · ${a.deal_title}` : ''})`,
        input: { activity_id: a.id },
      };
    },
    execute: async (input, ctx) => {
      await ownActivity(input.activity_id, ctx);
      await pd.updateActivity(input.activity_id, { done: 1 });
      return 'Tarea completada';
    },
  },

  reprogramar_tarea: {
    def: () => ({
      name: 'reprogramar_tarea',
      description: 'Propone cambiar la fecha (y hora opcional) de una tarea del comercial. Hora de Madrid.',
      input_schema: {
        type: 'object',
        properties: {
          activity_id: { type: 'integer' },
          fecha: { type: 'string', description: 'YYYY-MM-DD' },
          hora: { type: 'string', description: 'HH:MM (opcional)' },
        },
        required: ['activity_id', 'fecha'],
      },
    }),
    propose: async (input, ctx) => {
      const a = await ownActivity(input.activity_id, ctx);
      if (!isDate(input.fecha)) throw new Error('La fecha debe ser YYYY-MM-DD');
      if (input.hora && !isTime(input.hora)) throw new Error('La hora debe ser HH:MM');
      const l = utcToMadrid(a.due_date, a.due_time);
      return {
        summary: `Reprogramar «${a.subject}»: ${fmtFecha(l.date, l.time)} → ${fmtFecha(input.fecha, input.hora || null)}`,
        input: { activity_id: a.id, fecha: input.fecha, hora: input.hora || null },
      };
    },
    execute: async (input, ctx) => {
      await ownActivity(input.activity_id, ctx);
      const when = input.hora ? madridToUtc(input.fecha, input.hora) : { due_date: input.fecha, due_time: '' };
      await pd.updateActivity(input.activity_id, when);
      return 'Tarea reprogramada';
    },
  },

  crear_lead: {
    def: () => ({
      name: 'crear_lead',
      description:
        'Propone dar de alta un lead nuevo del comercial en Pipedrive (embudo Single Leads): crea la organización (clínica/centro), la persona de contacto y el deal a su nombre. Antes comprueba que no exista ya. Obligatorio solo el nombre de la clínica o de la persona. Teléfono y email son opcionales, pero pídeselos antes si no los ha dado; el resto solo si lo ha dicho.',
      input_schema: {
        type: 'object',
        properties: {
          clinica: { type: 'string', description: 'Nombre de la clínica / centro / empresa (si lo hay)' },
          contacto: { type: 'string', description: 'Nombre de la persona de contacto' },
          telefono: { type: 'string' },
          email: { type: 'string' },
          ciudad: { type: 'string' },
          provincia: { type: 'string' },
          pais: { type: 'string', description: 'País, si lo dice (p. ej. España, Italia, Mexico)' },
          origen: {
            type: 'string',
            enum: ['redes_sociales', 'web_telefono', 'busqueda_propia', 'referencia', 'distribuidor', 'otros'],
            description: 'Cómo llegó el lead, solo si lo dice o es evidente',
          },
          tiene_centro: { type: 'string', enum: ['si', 'lo_va_a_montar', 'no'] },
          num_centros: { type: 'number' },
          tecnologia_actual: {
            type: 'array',
            items: { type: 'string', enum: ['diodo', 'alejandrita', 'ipl', 'shr', 'ndyag', 'cera_hilo_otros', 'ninguna'] },
          },
          etapa_id: {
            type: 'integer',
            enum: [42, 38, 43, 44],
            description: '42 Lead interesado sin contactar (por defecto), 38 Escrito varios emails, 43 Lead cualificado, 44 Demo / negociación',
          },
          nota: { type: 'string', description: 'Contexto del lead: qué quiere, de dónde viene, qué se habló' },
        },
      },
    }),
    propose: async (input, ctx) => {
      const clinica = str(input.clinica, 150);
      const contacto = str(input.contacto, 120);
      const telefono = str(input.telefono, 40);
      const email = str(input.email, 150)?.toLowerCase();
      if (!clinica && !contacto) throw new Error('Falta el nombre de la clínica o de la persona de contacto');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`El email «${email}» no parece válido`);
      const etapa = [42, 38, 43, 44].includes(Number(input.etapa_id)) ? Number(input.etapa_id) : 42;

      // ¿Ya existe? Teléfono, email, organización o deal con el mismo nombre (de cualquier comercial)
      const dup = await findDuplicate({ clinica, contacto, telefono, email });
      if (dup) {
        if (dup.ownerId === ctx.pdUserId) {
          throw new Error(`Ya tienes este lead en Pipedrive: ${dup.label}${dup.dealId ? ` (${pd.dealUrl(dup.dealId)})` : ''}. No creo otro.`);
        }
        throw new Error(`Ya existe en Pipedrive un contacto igual (${dup.motivo}) y lo lleva otro comercial. No lo creo; que lo revise Nacho.`);
      }

      const titulo = clinica ?? contacto!;
      const name = await stageNamer();
      const datos = [
        contacto && clinica ? `contacto ${contacto}` : null,
        telefono ? `tel. ${telefono}` : null,
        email,
        [str(input.ciudad, 80), str(input.pais, 40)].filter(Boolean).join(', ') || null,
        input.origen ? `origen: ${ORIGEN_LABEL[input.origen as string] ?? input.origen}` : null,
        !telefono && !email ? 'sin teléfono ni email' : !telefono ? 'sin teléfono' : !email ? 'sin email' : null,
      ].filter(Boolean);
      return {
        summary: `Nuevo lead en Single Leads: «${titulo}» · ${name(etapa)}${datos.length ? `\n${datos.join(' · ')}` : ''}${input.nota ? `\nNota: ${String(input.nota).slice(0, 200)}` : ''}`,
        input: {
          clinica,
          contacto,
          telefono,
          email,
          ciudad: str(input.ciudad, 80),
          provincia: str(input.provincia, 80),
          pais: str(input.pais, 40),
          origen: ORIGEN_ID[input.origen as string] ?? null,
          tiene_centro: TIENE_CENTRO_ID[input.tiene_centro as string] ?? null,
          num_centros: Number.isFinite(Number(input.num_centros)) && Number(input.num_centros) > 0 ? Number(input.num_centros) : null,
          tecnologia: Array.isArray(input.tecnologia_actual)
            ? input.tecnologia_actual.map((t: string) => TECNO_ID[t]).filter(Boolean)
            : [],
          etapa,
          nota: str(input.nota, 4000),
        },
      };
    },
    execute: async (input, ctx) => {
      // Segunda comprobación por si alguien lo ha creado entre la propuesta y el botón
      const dup = await findDuplicate(input);
      if (dup) throw new Error(`Ya existe en Pipedrive (${dup.motivo}); no lo creo dos veces.`);

      let orgId: number | undefined;
      if (input.clinica) {
        const orgBody: Record<string, unknown> = { name: input.clinica, owner_id: ctx.pdUserId };
        if (input.ciudad) orgBody[F.orgCiudad] = input.ciudad;
        if (input.provincia) orgBody[F.orgProvincia] = input.provincia;
        if (input.origen) orgBody[F.orgOrigen] = String(input.origen);
        if (input.telefono) orgBody[F.orgTelefono] = input.telefono;
        if (input.email) orgBody[F.orgEmail] = input.email;
        orgBody[F.orgTipoCuenta] = '98'; // Clinica
        const comercial = comercialAsignado(ctx.pdUserName);
        if (comercial) orgBody[F.orgComercial] = comercial;
        if (input.pais) {
          const p = (await pd.orgFieldOptions(F.orgPais).catch(() => [])).find((o) => norm(o.label) === norm(input.pais));
          if (p) orgBody[F.orgPais] = p.id;
        }
        orgId = (await pd.createOrg(orgBody))?.id;
      }

      const person = await pd.createPerson({
        name: input.contacto ?? input.clinica,
        owner_id: ctx.pdUserId,
        ...(orgId ? { org_id: orgId } : {}),
        ...(input.telefono ? { phone: [{ value: input.telefono, primary: true, label: 'work' }] } : {}),
        ...(input.email ? { email: [{ value: input.email, primary: true, label: 'work' }] } : {}),
      });

      const dealBody: Record<string, unknown> = {
        title: input.clinica ?? input.contacto,
        pipeline_id: PIPELINE_SINGLE_LEADS,
        stage_id: input.etapa,
        user_id: ctx.pdUserId,
        person_id: person?.id,
        ...(orgId ? { org_id: orgId } : {}),
      };
      if (input.tiene_centro) dealBody[F.dealTieneCentro] = input.tiene_centro;
      if (input.num_centros) dealBody[F.dealNumCentros] = input.num_centros;
      if (input.tecnologia?.length) dealBody[F.dealTecnologia] = input.tecnologia.join(',');
      const deal = await pd.createDeal(dealBody);

      if (input.nota && deal?.id) {
        await pd.createNote({ deal_id: deal.id, content: `${input.nota}\n\n— ${ctx.pdUserName} (vía bot de Telegram)` });
      }
      return `Lead creado: ${pd.dealUrl(deal?.id)}`;
    },
  },

  anadir_nota: {
    def: () => ({
      name: 'anadir_nota',
      description: 'Propone añadir una nota a un deal del comercial (resumen de visita, llamada, etc.).',
      input_schema: {
        type: 'object',
        properties: { deal_id: { type: 'integer' }, texto: { type: 'string' } },
        required: ['deal_id', 'texto'],
      },
    }),
    propose: async (input, ctx) => {
      const deal = await ownDeal(input.deal_id, ctx);
      const texto = String(input.texto ?? '').trim().slice(0, 4000);
      if (!texto) throw new Error('La nota está vacía');
      return {
        summary: `Nota en «${deal.title}»:\n${texto.length > 300 ? `${texto.slice(0, 300)}…` : texto}`,
        input: { deal_id: deal.id, texto },
      };
    },
    execute: async (input, ctx) => {
      await ownDeal(input.deal_id, ctx);
      // Con el token de admin la nota sale a nombre del admin: firmamos para que se sepa de quién es
      await pd.createNote({ deal_id: input.deal_id, content: `${input.texto}\n\n— ${ctx.pdUserName} (vía bot de Telegram)` });
      return 'Nota añadida';
    },
  },
};

export const isWriteTool = (name: string) => name in WRITE;

export async function buildTools(): Promise<Anthropic.Tool[]> {
  const types = await pd.activityTypes().catch(() => []);
  return [...Object.values(READ).map((t) => t.def), ...Object.values(WRITE).map((t) => t.def(types))];
}

export async function runRead(name: string, input: any, ctx: Ctx): Promise<string> {
  const t = READ[name];
  if (!t) throw new Error(`Herramienta desconocida: ${name}`);
  return JSON.stringify(await t.run(input ?? {}, ctx));
}

export async function proposeWrite(name: string, input: any, ctx: Ctx) {
  const t = WRITE[name];
  if (!t) throw new Error(`Herramienta desconocida: ${name}`);
  return t.propose(input ?? {}, ctx);
}

export async function executeWrite(name: string, input: any, ctx: Ctx): Promise<string> {
  const t = WRITE[name];
  if (!t) throw new Error(`Herramienta desconocida: ${name}`);
  return t.execute(input, ctx);
}
