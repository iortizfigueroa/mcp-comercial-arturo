// Cliente mínimo de la API v1 de Pipedrive.
import { env } from './env.js';

type Q = Record<string, string | number | boolean | undefined | null>;

async function pd(method: 'GET' | 'POST' | 'PUT', path: string, query: Q = {}, body?: unknown): Promise<any> {
  const url = new URL(`https://${env('PIPEDRIVE_DOMAIN')}/api/v1${path}`);
  url.searchParams.set('api_token', env('PIPEDRIVE_API_TOKEN'));
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`Pipedrive ${res.status}: ${json.error ?? json.error_info ?? 'error desconocido'}`);
  }
  return json;
}

async function pdAll(path: string, query: Q = {}, max = 1500): Promise<any[]> {
  const out: any[] = [];
  let start = 0;
  while (out.length < max) {
    const j = await pd('GET', path, { ...query, start, limit: 500 });
    out.push(...(j.data ?? []));
    const pg = j.additional_data?.pagination;
    if (!pg?.more_items_in_collection) break;
    start = pg.next_start;
  }
  return out;
}

/** Propietario de un deal/actividad (user_id puede venir como número o como objeto). */
export function ownerId(x: any): number | undefined {
  const u = x?.user_id;
  if (u && typeof u === 'object') return Number(u.id);
  return u == null ? undefined : Number(u);
}

export const dealUrl = (id: number | string) => `https://${env('PIPEDRIVE_DOMAIN')}/deal/${id}`;

// ---------- Usuarios ----------
export async function listUsers(): Promise<any[]> {
  return (await pd('GET', '/users')).data ?? [];
}

// ---------- Etapas y embudos (caché 10 min) ----------
let stagesCache: { at: number; stages: any[]; pipelines: any[] } | undefined;
export async function stagesAndPipelines(): Promise<{ stages: any[]; pipelines: any[] }> {
  if (stagesCache && Date.now() - stagesCache.at < 10 * 60_000) return stagesCache;
  const [s, p] = await Promise.all([pd('GET', '/stages'), pd('GET', '/pipelines')]);
  stagesCache = { at: Date.now(), stages: s.data ?? [], pipelines: p.data ?? [] };
  return stagesCache;
}

// ---------- Tipos de actividad (caché 10 min) ----------
let typesCache: { at: number; types: any[] } | undefined;
export async function activityTypes(): Promise<any[]> {
  if (typesCache && Date.now() - typesCache.at < 10 * 60_000) return typesCache.types;
  const types = ((await pd('GET', '/activityTypes')).data ?? []).filter((t: any) => t.active_flag !== false);
  typesCache = { at: Date.now(), types };
  return types;
}

// ---------- Deals ----------
export const listDeals = (userId: number, status = 'open') => pdAll('/deals', { user_id: userId, status });
export const getDeal = async (id: number) => (await pd('GET', `/deals/${id}`)).data;
export const updateDeal = async (id: number, body: Record<string, unknown>) => (await pd('PUT', `/deals/${id}`, {}, body)).data;

export async function searchDeals(term: string): Promise<any[]> {
  const j = await pd('GET', '/deals/search', { term, limit: 50 });
  return (j.data?.items ?? []).map((i: any) => i.item);
}
export async function searchOrgs(term: string): Promise<any[]> {
  const j = await pd('GET', '/organizations/search', { term, limit: 10 });
  return (j.data?.items ?? []).map((i: any) => i.item);
}
export const orgDeals = (orgId: number) => pdAll(`/organizations/${orgId}/deals`, { status: 'all_not_deleted' }, 500);

// ---------- Actividades (tareas) ----------
export const listActivities = (userId: number, opts: { done?: 0 | 1; start_date?: string; end_date?: string } = {}) =>
  pdAll('/activities', { user_id: userId, ...opts });
export const dealActivities = async (dealId: number, done: 0 | 1 = 0) =>
  (await pd('GET', `/deals/${dealId}/activities`, { done, limit: 50 })).data ?? [];
export const getActivity = async (id: number) => (await pd('GET', `/activities/${id}`)).data;
export const createActivity = async (body: Record<string, unknown>) => (await pd('POST', '/activities', {}, body)).data;
export const updateActivity = async (id: number, body: Record<string, unknown>) => (await pd('PUT', `/activities/${id}`, {}, body)).data;

// ---------- Notas ----------
export const dealNotes = async (dealId: number, limit = 5) =>
  (await pd('GET', '/notes', { deal_id: dealId, limit, sort: 'add_time DESC' })).data ?? [];
export const createNote = async (body: Record<string, unknown>) => (await pd('POST', '/notes', {}, body)).data;
