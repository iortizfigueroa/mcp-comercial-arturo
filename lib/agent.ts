import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { getHistory, savePending } from './db.js';
import * as pd from './pipedrive.js';
import { nowMadridText, todayMadrid } from './time.js';
import { buildTools, isWriteTool, proposeWrite, runRead, type Ctx } from './tools.js';

// Lee ANTHROPIC_API_KEY. Si la clave no está ligada a un workspace, hay que indicarlo con ANTHROPIC_WORKSPACE_ID
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
const client = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {});
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

export interface Proposal {
  id: string;
  summary: string;
}

async function systemPrompt(ctx: Ctx): Promise<string> {
  const { stages, pipelines } = await pd.stagesAndPipelines();
  const etapas = pipelines
    .map((p: any) => {
      const ss = stages
        .filter((s: any) => s.pipeline_id === p.id)
        .sort((a: any, b: any) => a.order_nr - b.order_nr)
        .map((s: any) => `  ${s.id}: ${s.name}`)
        .join('\n');
      return `Embudo «${p.name}»:\n${ss}`;
    })
    .join('\n');

  return `Eres el asistente de Pipedrive de ${ctx.pdUserName}, comercial de Leaseir (equipos de depilación láser de diodo y radiofrecuencia para clínicas estéticas). Habláis por Telegram.
Hoy es ${nowMadridText()} (hora de Madrid). Fecha de hoy: ${todayMadrid()}.

Reglas:
- Solo trabajas con los deals y tareas de ${ctx.pdUserName}. Si pide algo de otro comercial o fuera de Pipedrive, dile que no puedes.
- En un grupo pueden escribir el comercial y Nacho (su responsable). Cada mensaje empieza por el nombre de quien escribe. Responde a quien te habla; si habla Nacho, trabajas igualmente sobre los deals de ${ctx.pdUserName}.
- Los cambios (etapa, ganado/perdido, tareas, notas) se hacen con las herramientas de escritura. No se ejecutan al momento: al comercial le aparece un botón para confirmar. Nunca digas que algo está hecho; di en una línea qué has dejado listo para confirmar.
- Antes de proponer un cambio sobre un deal que nombra, búscalo con buscar_deal. Si hay varios candidatos o ninguno, pregunta. No inventes IDs.
- Si pide varias cosas a la vez, propón cada una con su herramienta.
- Fechas relativas («mañana», «el martes», «la semana que viene») respecto a hoy, en hora de Madrid. Si no da hora, la tarea va sin hora.
- Si dice que ha hecho una llamada o visita, propón también la nota y pregunta si quiere programar el siguiente paso.
- Respuestas cortas, para leer en el móvil. Texto plano: sin tablas, sin negritas, sin markdown. Como mucho guiones y algún emoji.
- No enseñes IDs salvo que hagan falta para elegir entre varios deals.

Etapas (id: nombre):
${etapas}`;
}

/** Ejecuta un turno: devuelve el texto de respuesta y los cambios propuestos (pendientes de botón). */
export async function runAgent(ctx: Ctx, userText: string): Promise<{ text: string; proposals: Proposal[] }> {
  const [system, tools, history] = await Promise.all([systemPrompt(ctx), buildTools(), getHistory(ctx.chatId, 16)]);

  // La API exige empezar por "user" y alternar roles
  const messages: Anthropic.MessageParam[] = [];
  for (const h of history) {
    if (messages.length === 0 && h.role !== 'user') continue;
    const last = messages[messages.length - 1];
    if (last && last.role === h.role) last.content = `${last.content as string}\n${h.content}`;
    else messages.push({ role: h.role, content: h.content });
  }
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') last.content = `${last.content as string}\n${userText}`;
  else messages.push({ role: 'user', content: userText });

  const proposals: Proposal[] = [];
  let text = '';

  for (let i = 0; i < 8; i++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 1500, system, tools, messages });
    messages.push({ role: 'assistant', content: res.content });
    const textNow = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (res.stop_reason !== 'tool_use') {
      text = textNow;
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== 'tool_use') continue;
      try {
        let content: string;
        if (isWriteTool(b.name)) {
          const p = await proposeWrite(b.name, b.input, ctx);
          const id = randomUUID().replace(/-/g, '').slice(0, 12);
          await savePending(id, ctx.chatId, b.name, p.input, p.summary);
          proposals.push({ id, summary: p.summary });
          content = `Propuesta preparada: "${p.summary}". El comercial verá un botón para confirmarla; todavía NO está hecha.`;
        } else {
          content = await runRead(b.name, b.input, ctx);
        }
        results.push({ type: 'tool_result', tool_use_id: b.id, content });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: b.id, content: `Error: ${(e as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
    if (i === 7) text = textNow || 'Me he liado con demasiados pasos. ¿Me lo dices de otra forma?';
  }

  return { text, proposals };
}
