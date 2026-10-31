// Notas de voz de Telegram -> texto.
// Usa ElevenLabs (ELEVENLABS_API_KEY) o, si no hay, OpenAI Whisper (OPENAI_API_KEY).
import { env } from './env.js';
import { tg } from './telegram.js';

export const sttEnabled = () => !!(process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY);

/** Descarga el audio de Telegram (máx. 20 MB, límite de la API de bots). */
async function download(fileId: string): Promise<{ data: ArrayBuffer; name: string }> {
  const f = await tg<{ file_path: string }>('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env('TELEGRAM_BOT_TOKEN')}/${f.file_path}`);
  if (!res.ok) throw new Error(`No pude descargar el audio (${res.status})`);
  return { data: await res.arrayBuffer(), name: f.file_path.split('/').pop() || 'audio.ogg' };
}

export async function transcribe(fileId: string, mime = 'audio/ogg'): Promise<string> {
  const { data, name } = await download(fileId);
  const form = new FormData();
  form.append('file', new Blob([data], { type: mime }), name.endsWith('.oga') ? name.replace(/\.oga$/, '.ogg') : name);

  if (process.env.ELEVENLABS_API_KEY) {
    form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
    form.append('language_code', 'spa');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      body: form,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${JSON.stringify(j.detail ?? j).slice(0, 200)}`);
    return String(j.text ?? '').trim();
  }

  if (process.env.OPENAI_API_KEY) {
    form.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
    form.append('language', 'es');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${j.error?.message ?? 'error'}`);
    return String(j.text ?? '').trim();
  }

  throw new Error('No hay servicio de transcripción configurado');
}
