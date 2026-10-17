export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export function adminIds(): number[] {
  return (process.env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

export const isAdmin = (id?: number): boolean => !!id && adminIds().includes(id);

export const privateEnabled = (): boolean => process.env.PRIVATE_CHAT_ENABLED === 'true';
