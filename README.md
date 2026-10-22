# Bot de comerciales Leaseir (Telegram + Pipedrive)

Cada comercial tiene un grupo de Telegram con Nacho y el bot. El comercial escribe en lenguaje normal
("qué tengo hoy", "pasa Clínica Sol a negociación", "ponme llamada a Dermasalud el martes a las 10")
y el bot consulta o prepara el cambio en Pipedrive. **Todo cambio se confirma con un botón ✅/❌.**

- Solo ve y toca los deals y tareas del comercial vinculado al grupo (filtrado en el servidor).
- El bot lee y responde a todo lo que se escribe en el grupo, también lo de Nacho, siempre sobre los deals del comercial vinculado.
- El comercial puede usarlo en el grupo y también en privado (`PRIVATE_CHAT_ENABLED=true`). Para que le reconozca en privado, tiene que haber escrito antes una vez en el grupo. Lo que haga en privado queda igual en el registro y en el resumen diario del grupo.
- Registro: cada mensaje y cada cambio (hecho, cancelado o fallido) queda en Postgres.
- Resumen diario a las 9:30 (hora de Madrid), todos los días, en cada grupo: Claude lee los deals abiertos, tareas y notas del comercial y escribe un resumen por grupos (recién entrados, calientes, esperan fecha, parados, nevera) con enlace a cada deal. También a demanda con `/resumen`.

## Puesta en marcha

### 1. Telegram (@BotFather)
1. `/revoke` → elige el bot → te da un **token nuevo** (el anterior se compartió en un chat; mejor rotarlo).
2. `/setprivacy` → elige el bot → **Disable**. Hazlo **antes** de meter el bot en el grupo (si ya está dentro, sácalo y vuelve a añadirlo).

### 2. Claves
- **Anthropic**: en console.anthropic.com → API Keys → Create Key (la cuenta necesita saldo). Vale la de tu otra app si ya la tienes.
- **Pipedrive**: tu token personal → Pipedrive → tu avatar → Preferencias personales → API. Con él el bot puede ver todos los deals y filtra por comercial. Los cambios salen a tu nombre en el historial; las notas van firmadas con el nombre del comercial.

### 3. GitHub + Vercel
1. Sube esta carpeta a un repo (p. ej. `leaseir-bot-comerciales`).
2. Vercel → Add New → Project → importa el repo (sin framework, sin build).
3. En el proyecto → Storage → Create Database → **Neon (Postgres)** → conectar. Rellena `DATABASE_URL` solo.
4. Settings → Environment Variables (ver `.env.example`):

| Variable | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token nuevo de BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | cadena aleatoria larga (solo letras, números, `_` y `-`) |
| `ADMIN_TELEGRAM_IDS` | tu ID de Telegram (paso 5) |
| `PRIVATE_CHAT_ENABLED` | `true` (o `false` para que solo funcione en el grupo) |
| `ANTHROPIC_API_KEY` | la clave de Anthropic |
| `PIPEDRIVE_DOMAIN` | `leaseir.pipedrive.com` |
| `PIPEDRIVE_API_TOKEN` | tu token de Pipedrive |
| `CRON_SECRET` | otra cadena aleatoria |

5. Deploy.

### 4. Conectar el webhook
Abre en el navegador (dominio de **producción**):
`https://<tu-proyecto>.vercel.app/api/setup?key=<TELEGRAM_WEBHOOK_SECRET>`
Debe devolver `{"ok":true,"bot":"@...","webhook":"..."}`. Crea también las tablas.

### 5. Tu ID de admin
Escríbele al bot en privado `/miid`. Pon ese número en `ADMIN_TELEGRAM_IDS` y redeploy.

### 6. Grupo del comercial
1. Crea un grupo con el comercial y el bot.
2. En el grupo escribe `/vincular arturo`. Si hay varios usuarios con ese nombre, te da los ids para `/vincular id:123`.
3. Prueba: el comercial escribe "qué tareas tengo hoy".

## Comandos
- `/resumen` – resumen de hoy
- `/olvidar` – borra el contexto de la conversación (el registro se mantiene)
- `/ayuda`
- `/miid` – tu ID y el del chat
- `/vincular <nombre>` y `/desvincular` – solo admin, dentro del grupo

## Horario del resumen
Vercel programa en UTC: el cron se lanza a las 7:30 y 8:30 UTC y solo envía la ejecución que cae a las 9 en Madrid, así vale en verano e invierno. Un resumen por grupo y día (tabla `summary_sent`).

## Chat privado
Con `PRIVATE_CHAT_ENABLED=true` el comercial abre el bot en privado y funciona igual. Se le reconoce por su ID de Telegram, que el bot guarda la primera vez que escribe en el grupo. Para desactivarlo: `false` y redeploy.

## Ver el registro (consultas en Neon)
```sql
-- Cambios de los últimos 7 días
SELECT created_at AT TIME ZONE 'Europe/Madrid' AS cuando, status, summary
FROM action_log WHERE created_at > now() - interval '7 days' ORDER BY id DESC;

-- Lo que ha escrito el comercial
SELECT created_at AT TIME ZONE 'Europe/Madrid' AS cuando, content
FROM messages WHERE role = 'user' ORDER BY id DESC LIMIT 50;
```

## Estructura
- `api/telegram.ts` – webhook
- `api/setup.ts` – conectar webhook y crear tablas
- `api/cron/resumen.ts` – resumen diario
- `lib/agent.ts` – Claude con herramientas
- `lib/tools.ts` – herramientas de Pipedrive (lectura libre; escritura con confirmación). Reutilizable para el MCP.
- `lib/bot.ts` – comandos, mensajes, botones
- `lib/summary.ts`, `lib/pipedrive.ts`, `lib/db.ts`, `lib/time.ts`, `lib/telegram.ts`
