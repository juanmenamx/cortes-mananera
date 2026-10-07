const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  CLIP_STEP_SECONDS,
  addSeconds,
  buildClipUrl,
  clock,
  clockAt,
  instantAt,
  parseClipUrl,
  rangeLabel,
  segmentPlan,
  stampDeadline
} = require('./lib/clips');

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(__dirname, '..', 'transcriptor-mananera', '.env'), ['PORT']);
loadEnv(path.join(__dirname, '..', 'news-notas-ai', '.env'), ['PORT']);

const { assertTranscriptionReady, extractPeople, formatBlock, looksLikeHallucination, mergeRosters, transcribe } = require('./lib/transcribe');

const PORT = Number(process.env.PORT || 4311);
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUT_DIR = process.env.CORTES_DIR || path.join(process.env.USERPROFILE || os.homedir(), 'Videos', 'Cortes de la conferencia');
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'cortes-mananera', 'temp');
const FFMPEG = process.env.FFMPEG_PATH || path.join(__dirname, '..', 'youtube-portable', 'bin', 'ffmpeg.exe');
const GRACE_MS = Number(process.env.CLIP_GRACE_MS || 60000);
const POLL_MS = 2000;
const PRECIO_URL = 'https://pmedia.efinf.com/sc-be/api/sc/getPrecio.php';
const BLOQUES_URL = 'https://pmedia.efinf.com/sc-be/api/sc/getBloques.php';
const NOTE_HEADER_URL = 'https://pmedia.efinf.com/sc-be/api/sc/setNoteHeader.php';
const BLOQUES_IP_PREFIX = '192.168.10.';
const PRECIO_MEDIO = 17452;
const PRECIO_PROGRAMA = 7016;
const NOTE_HEADER_FIXED = {
  opcion: 'crear',
  tipo: 'cabeceo',
  cabeceo: 1,
  id_medio: PRECIO_MEDIO,
  id_programa: PRECIO_PROGRAMA,
  ids_conductores: '5957',
  id_genero: 139,
  id_user: 57,
  id_user_data4: 2667,
  id_rec: 516,
  alerta: 1
};

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let active = null;
const clients = new Set();

function log(message, extra = null) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function loadEnv(file, ignore = []) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    if (ignore.includes(key) || key in process.env) continue;
    process.env[key] = line.slice(split + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function sendEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(payload);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAuthError(error) {
  return /api key|invalid_api_key|unauthorized|permission denied/i.test(error?.message || '');
}

function publicError(error) {
  if (isAuthError(error)) return 'OpenAI rechazó la clave de acceso. Revisa OPENAI_API_KEY.';
  return String(error?.message || 'Error interno').replace(/sk-[A-Za-z0-9_-]+/g, '[clave]');
}

function createLock() {
  let chain = Promise.resolve();
  return function exclusive(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  };
}

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Solicitud demasiado grande'));
        request.destroy();
        return;
      }
      parts.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    request.on('error', reject);
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `ffmpeg terminó con código ${code}`));
    });
  });
}

function publishCut(output, filename) {
  const saved = path.join(OUTPUT_DIR, filename);
  fs.copyFileSync(output, saved);
  return saved;
}

function mediaUrl(sessionId, kind, filename) {
  return `/media/${sessionId}/${kind}/${encodeURIComponent(filename)}`;
}

function publicClip(session, clip) {
  return {
    index: clip.index,
    label: clip.label,
    from: clip.from,
    to: clip.to,
    text: clip.text,
    words: clip.words || [],
    offset: clip.offset || 0,
    mediaUrl: mediaUrl(session.id, 'clips', clip.filename),
    sourceMediaUrl: clip.sourceMediaUrl || ''
  };
}

function snapshot(session) {
  return {
    state: session.stopping ? 'stopped' : 'running',
    message: session.message || 'Siguiendo clips',
    clock: session.clock || '—',
    count: session.clips.length,
    previewUrl: session.previewUrl || '',
    sources: session.sources || [],
    openClips: session.clips.filter(clip => clip.ready && clip.blockNumber == null).map(clip => publicClip(session, clip)),
    blocks: session.blocks
  };
}

async function clipIsVideo(url, session) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const watch = setInterval(() => {
    if (session?.stopping) controller.abort();
  }, 200);
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    const type = (response.headers.get('content-type') || '').toLowerCase();
    return type.includes('video/');
  } catch (error) {
    if (error.name !== 'AbortError') log('No se pudo consultar el clip', { message: publicError(error) });
    return false;
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
}

async function waitForClip(session, url, stamp) {
  const deadline = stampDeadline(stamp, CLIP_STEP_SECONDS, GRACE_MS);
  while (!session.stopping) {
    if (await clipIsVideo(url, session)) return true;
    if (session.stopping || Date.now() >= deadline) return false;
    session.message = `Esperando el clip de las ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`;
    sendEvent('status', { state: 'running', message: session.message, clock: session.clock, count: session.clips.length });
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_MS, Math.max(remaining, 0)));
  }
  return false;
}

async function downloadClip(url, dest) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (!response.ok || !type.includes('video/')) throw new Error('El clip dejó de estar disponible al descargarlo.');
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = Number(response.headers.get('content-length'));
  const incomplete = bytes.length < 1000
    || (Number.isFinite(expected) && expected > bytes.length)
    || !bytes.includes(Buffer.from('moov'));
  if (incomplete) throw new Error('El clip todavía se está grabando.');
  fs.writeFileSync(dest, bytes);
}

async function extractAudio(videoFile, wavFile) {
  await run(FFMPEG, [
    '-y', '-i', videoFile,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', wavFile
  ]);
}

async function cutSegment(sourceFile, dest, offset, duration) {
  await run(FFMPEG, [
    '-y', '-i', sourceFile,
    '-ss', String(offset), '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '16000', '-ac', '1',
    dest
  ]);
}

async function cutVideos(clips, output) {
  if (clips.length === 1) {
    fs.copyFileSync(clips[0].file, output);
    return;
  }
  const listPath = output.replace(/\.mp4$/i, '-list.txt');
  const list = clips.map(clip => `file '${clip.file.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listPath, list);
  try {
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', output]);
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

function serverTranscript(clips) {
  return clips
    .filter(clip => clip.text)
    .map(clip => clip.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function sourceOrdinal(session, mediaUrl) {
  return session.sources.findIndex(item => item.mediaUrl === mediaUrl);
}

function timelinePoint(session, mediaUrl, time) {
  const index = sourceOrdinal(session, mediaUrl);
  if (index < 0) return null;
  return index * CLIP_STEP_SECONDS + time;
}

function clipSpan(session, clip) {
  const start = timelinePoint(session, clip.sourceMediaUrl, clip.offset || 0);
  if (start == null) return null;
  return { start, end: start + (clip.duration || 0) };
}

function coverage(session) {
  let max = 0;
  for (const clip of session.clips) {
    if (!clip.ready) continue;
    const span = clipSpan(session, clip);
    if (span) max = Math.max(max, span.end);
  }
  return max;
}

function pointClock(session, point) {
  const source = session.sources[sourceOrdinal(session, point.mediaUrl)];
  return clockAt(source.stamp, point.time);
}

function pointInstant(session, point) {
  const source = session.sources[sourceOrdinal(session, point.mediaUrl)];
  return instantAt(source.stamp, point.time);
}

function pmediaHeaders(extra = {}) {
  const token = process.env.PRECIO_API_TOKEN;
  if (!token) throw new Error('Falta PRECIO_API_TOKEN para consultar pmedia.');
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Api-Key': token,
    ...extra
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function bloquesQueryNow() {
  const now = new Date();
  const second = Math.floor(now.getSeconds() / 30) * 30;
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(second)}`;
  return {
    ip: `${BLOQUES_IP_PREFIX}69`,
    canal: 'HDMI2',
    idMedio: PRECIO_MEDIO,
    fecha: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`,
    inicio: '00:00:00',
    fin: '23:59:59',
    stamp
  };
}

function bloquesQuery(source, clipUrl) {
  const prefix = String(source.prefix || '');
  const match = prefix.match(/^(.*)-(\d+)-$/);
  const canal = match ? match[1] : 'HDMI2';
  const idMedio = match ? Number(match[2]) : PRECIO_MEDIO;
  const fecha = `${source.stamp.slice(0, 4)}-${source.stamp.slice(4, 6)}-${source.stamp.slice(6, 8)}`;
  const inicio = '00:00:00';
  let octet = '69';
  try {
    const segment = new URL(clipUrl).pathname.split('/').find(part => /^\d{1,3}$/.test(part));
    if (segment != null && Number(segment) <= 255) octet = String(Number(segment));
  } catch {
    octet = '69';
  }
  return { ip: `${BLOQUES_IP_PREFIX}${octet}`, canal, idMedio, fecha, inicio, fin: '23:59:59' };
}

async function fetchBloques30(query) {
  const url = new URL(BLOQUES_URL);
  url.searchParams.set('ip', query.ip);
  url.searchParams.set('canal', query.canal);
  url.searchParams.set('idMedio', String(query.idMedio));
  url.searchParams.set('fecha', query.fecha);
  url.searchParams.set('inicio', query.inicio);
  url.searchParams.set('fin', query.fin);
  url.searchParams.set('duraciones', '30s');
  const response = await fetch(url, {
    headers: pmediaHeaders(),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const detail = [body.error, body.detail].filter(Boolean).join(' ');
    throw new Error(detail || `No se pudieron consultar los bloques (${response.status})`);
  }
  const list = body.bloques?.['30s'];
  if (!Array.isArray(list)) throw new Error('La respuesta no incluye bloques de 30 segundos.');
  return list
    .filter(item => item?.url)
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
}

async function fetchPrecio({ fecha, duracion }) {
  const url = new URL(PRECIO_URL);
  url.searchParams.set('fecha', fecha);
  url.searchParams.set('id_medio', String(PRECIO_MEDIO));
  url.searchParams.set('id_programa', String(PRECIO_PROGRAMA));
  url.searchParams.set('duracion', String(duracion));
  const response = await fetch(url, {
    headers: pmediaHeaders(),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body.error || body.message || `No se pudo obtener el precio (${response.status})`);
  }
  if (body.data?.precio == null) throw new Error('La respuesta no incluye precio.');
  return body.data.precio;
}

function notePayload(block, precio) {
  return {
    ...NOTE_HEADER_FIXED,
    marcas: block.marcas,
    duracion: block.duracion,
    inicio_marca: block.inicio_marca,
    fin_marca: block.fin_marca,
    precio
  };
}

async function setNoteHeader(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  const response = await fetch(NOTE_HEADER_URL, {
    method: 'POST',
    headers: pmediaHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body,
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = [payload.error, payload.detail, payload.message].filter(Boolean).join('\n');
    throw new Error(detail || `No se pudo registrar la nota (${response.status})`);
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const id = data.id ?? data.id_nota ?? data.idNota ?? payload.id;
  const digest = data.digest ?? data.md5 ?? payload.digest ?? (typeof payload.data === 'string' ? payload.data : '');
  return {
    nota: id == null ? 'registrada' : `registrada ${id}`,
    digest: digest == null ? '' : String(digest)
  };
}

function wordsText(words) {
  return (words || []).map(word => word.word).join(' ').trim();
}

function normalizeCut(session, cut) {
  if (!cut || typeof cut.mediaUrl !== 'string' || !Number.isFinite(Number(cut.time))) return null;
  if (sourceOrdinal(session, cut.mediaUrl) < 0) return null;
  const time = Math.round(Math.min(CLIP_STEP_SECONDS, Math.max(0, Number(cut.time))) * 100) / 100;
  return { mediaUrl: cut.mediaUrl, time };
}

function endOfOpenContent(session) {
  let best = null;
  for (const clip of session.clips) {
    if (!clip.ready || clip.blockNumber != null) continue;
    const span = clipSpan(session, clip);
    if (!span || (best && span.end <= best.point)) continue;
    best = {
      mediaUrl: clip.sourceMediaUrl,
      time: Math.round((clip.offset + clip.duration) * 100) / 100,
      point: span.end
    };
  }
  return best;
}

function splitClipAt(session, clip, localTime) {
  const headDuration = Math.round((localTime - clip.offset) * 100) / 100;
  const tailDuration = Math.round((clip.duration - headDuration) * 100) / 100;
  const endClock = clockAt(clip.stamp, headDuration);
  const headWords = (clip.words || []).filter(word => word.at < localTime);
  const tailWords = (clip.words || []).filter(word => word.at >= localTime);
  clip.duration = headDuration;
  clip.to = endClock;
  clip.words = headWords;
  clip.text = wordsText(headWords);
  clip.label = `${clip.from}–${clip.to}`;
  const remainder = {
    index: session.clips.length,
    stamp: clip.stamp,
    toStamp: clip.toStamp,
    from: endClock,
    to: clockAt(clip.stamp, headDuration + tailDuration),
    label: '',
    url: clip.url,
    filename: clip.filename,
    file: clip.file,
    text: wordsText(tailWords),
    words: tailWords,
    offset: Math.round(localTime * 100) / 100,
    duration: tailDuration,
    sourceMediaUrl: clip.sourceMediaUrl,
    ready: true,
    blockNumber: null
  };
  remainder.label = `${remainder.from}–${remainder.to}`;
  session.clips.push(remainder);
  return remainder;
}

function localTime(session, clip, point) {
  return point - sourceOrdinal(session, clip.sourceMediaUrl) * CLIP_STEP_SECONDS;
}

function collectBlockClips(session, start, end) {
  const startPoint = timelinePoint(session, start.mediaUrl, start.time);
  const endPoint = timelinePoint(session, end.mediaUrl, end.time);
  const chosen = [];
  for (const clip of session.clips.filter(item => item.ready && item.blockNumber == null)) {
    const span = clipSpan(session, clip);
    if (!span || span.end <= startPoint + 0.04 || span.start >= endPoint - 0.04) continue;
    let piece = clip;
    if (span.start < startPoint - 0.04) {
      splitClipAt(session, clip, localTime(session, clip, startPoint));
      clip.blockNumber = -1;
      piece = session.clips[session.clips.length - 1];
    }
    const pieceSpan = clipSpan(session, piece);
    if (pieceSpan.end > endPoint + 0.04) splitClipAt(session, piece, localTime(session, piece, endPoint));
    if ((piece.duration || 0) < 0.04 && !(piece.words || []).length) continue;
    chosen.push(piece);
  }
  chosen.sort((a, b) => clipSpan(session, a).start - clipSpan(session, b).start);
  return chosen;
}

async function renderRange(session, start, end, output) {
  const startIndex = sourceOrdinal(session, start.mediaUrl);
  const endIndex = sourceOrdinal(session, end.mediaUrl);
  const pieces = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const source = session.sources[index];
    const from = index === startIndex ? start.time : 0;
    const to = index === endIndex ? end.time : CLIP_STEP_SECONDS;
    const duration = Math.round((to - from) * 100) / 100;
    if (duration < 0.08) continue;
    const piece = output.replace(/\.mp4$/i, `-parte-${pieces.length}.mp4`);
    await cutSegment(source.file, piece, from, duration);
    pieces.push(piece);
  }
  if (!pieces.length) throw new Error('El corte no incluye video.');
  if (pieces.length === 1) {
    fs.copyFileSync(pieces[0], output);
    return;
  }
  const listPath = output.replace(/\.mp4$/i, '-list.txt');
  fs.writeFileSync(listPath, pieces.map(file => `file '${file.replace(/\\/g, '/')}'`).join('\n'));
  try {
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', output]);
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

async function waitUntilCovered(session, endPoint) {
  const deadline = Date.now() + 12000;
  session.pause = true;
  while (session.busy && !session.stopping) await sleep(40);
  if (session.stopping || coverage(session) + 0.05 >= endPoint) return;
  session.pause = false;
  while (!session.stopping && coverage(session) + 0.05 < endPoint && Date.now() < deadline) await sleep(40);
  session.pause = true;
  while (session.busy && !session.stopping) await sleep(40);
}

async function buildBlock(session, clips, blockNumber, editedText, range) {
  const from = pointClock(session, range.start);
  const to = pointClock(session, range.end);
  const inicio = pointInstant(session, range.start);
  const fin = pointInstant(session, range.end);
  const duracion = Math.max(1, fin.epoch - inicio.epoch);
  const filename = `bloque-${String(blockNumber).padStart(2, '0')}-${from.replace(/[:.]/g, '')}-${to.replace(/[:.]/g, '')}.mp4`;
  const output = path.join(session.dir, 'cortes', filename);
  const rawText = serverTranscript(clips).trim() || String(editedText || '').trim();
  const rangeSource = session.sources[sourceOrdinal(session, range.start.mediaUrl)];
  const block = {
    blockNumber,
    from,
    to,
    label: `${from}–${to}`,
    clipCount: clips.length,
    lastIndex: clips.length ? clips[clips.length - 1].index : -1,
    rawText,
    formatted: '',
    formatError: '',
    videoUrl: '',
    savedPath: '',
    cut: range.end,
    cutError: '',
    marcas: `${inicio.fecha} ${inicio.clock}|${fin.fecha} ${fin.clock}`,
    duracion,
    inicio_marca: inicio.epoch,
    fin_marca: fin.epoch,
    fecha: inicio.fecha,
    precio: null,
    precioError: '',
    nota: '',
    noteError: '',
    digest: ''
  };

  const tasks = [
    renderRange(session, range.start, range.end, output).then(() => {
      block.videoUrl = mediaUrl(session.id, 'cortes', filename);
      block.savedPath = publishCut(output, filename);
    }).catch(error => {
      block.cutError = error.message;
      log('No se pudo cortar el bloque', { blockNumber, message: error.message });
    })
  ];

  tasks.push((async () => {
    let precio;
    try {
      precio = await fetchPrecio({ fecha: inicio.fecha, duracion });
      block.precio = precio;
    } catch (error) {
      block.precioError = publicError(error);
      block.envio = notePayload(block, '');
      log('No se pudo obtener el precio', { blockNumber, message: block.precioError });
      return;
    }
    const envio = notePayload(block, precio);
    block.envio = envio;
    try {
      const note = await setNoteHeader(envio);
      block.nota = note.nota;
      block.digest = note.digest;
    } catch (error) {
      block.noteError = publicError(error);
      log('No se pudo registrar la nota', { blockNumber, message: block.noteError });
    }
  })());

  if (rawText) {
    tasks.push((async () => {
      const wantRoster = blockNumber === 1 || session.cutMode?.kind === 'pregunta';
      const [rosterResult, formatResult] = await Promise.all([
        wantRoster
          ? extractPeople({ transcription: rawText, blockNumber, mode: session.cutMode }).catch(error => {
            log('No se pudieron rescatar las personas', { blockNumber, message: publicError(error) });
            return { funcionarios: [], reporteros: [] };
          })
          : Promise.resolve({ funcionarios: [], reporteros: [] }),
        formatBlock({
          transcription: rawText,
          blockNumber,
          sourceUrl: clips[0]?.url || '',
          stamp: clips[0]?.stamp || rangeSource.stamp,
          mode: session.cutMode
        }).then(result => ({ ok: true, result })).catch(error => {
          block.formatError = publicError(error);
          log('No se pudo formatear el bloque', { blockNumber, message: error.message });
          return { ok: false, roster: error.roster || { funcionarios: [], reporteros: [] } };
        })
      ]);
      const fromFormat = formatResult.ok ? formatResult.result : formatResult.roster;
      const people = mergeRosters(rosterResult, fromFormat);
      block.funcionarios = people.funcionarios;
      block.reporteros = people.reporteros;
      block.reportero = people.reportero;
      if (formatResult.ok) {
        let formatted = formatResult.result.text;
        const reporter = people.reporteros[0];
        if (session.cutMode?.kind === 'pregunta' && reporter) {
          formatted = formatted
            .replaceAll('Reportero: [nombre]', `Reportero: ${reporter.nombre}`)
            .replaceAll('Medio: [medio]', `Medio: ${reporter.medio || '[medio]'}`);
        }
        block.formatted = formatted;
      }
      if (blockNumber === 1) log('Funcionarios del primer bloque', { personas: people.funcionarios });
      if (session.cutMode?.kind === 'pregunta') log('Reporteros de la pregunta', { personas: people.reporteros });
    })());
  } else {
    block.formatted = 'Este bloque no contiene voz transcrita.';
  }

  await Promise.all(tasks);
  return block;
}

function normalizeMode(mode) {
  if (!mode) return { kind: 'participacion', speaker: { nombre: '', cargo: '', medio: '' }, participantes: [], reporteros: [] };
  const kind = mode?.kind === 'pregunta' ? 'pregunta' : 'participacion';
  const speaker = {
    nombre: String(mode?.speaker?.nombre || '').trim(),
    cargo: String(mode?.speaker?.cargo || '').trim(),
    medio: String(mode?.speaker?.medio || '').trim()
  };
  const clean = list => (Array.isArray(list) ? list : [])
    .map(person => ({
      nombre: String(person?.nombre || '').trim(),
      cargo: String(person?.cargo || '').trim(),
      medio: String(person?.medio || '').trim()
    }))
    .filter(person => person.nombre);
  return { kind, speaker, participantes: clean(mode?.participantes), reporteros: clean(mode?.reporteros) };
}

async function closeBlock(session, editedText, cutInput, mode) {
  return session.exclusive(async () => {
    try {
      if (!session.rangeStart && session.sources[0]) session.rangeStart = { mediaUrl: session.sources[0].mediaUrl, time: 0 };
      const start = session.rangeStart;
      let end = normalizeCut(session, cutInput) || endOfOpenContent(session);
      if (!start || !end) {
        log('No hubo video abierto para cerrar el bloque');
        return null;
      }
      const startPoint = timelinePoint(session, start.mediaUrl, start.time);
      let endPoint = timelinePoint(session, end.mediaUrl, end.time);
      if (startPoint == null || endPoint == null || endPoint - startPoint < 0.08) return null;
      await waitUntilCovered(session, endPoint);
      if (coverage(session) + 0.05 < endPoint) {
        const fallback = endOfOpenContent(session);
        if (!fallback || fallback.point - startPoint < 0.08) return null;
        end = { mediaUrl: fallback.mediaUrl, time: fallback.time };
      }
      log('Cerrando bloque', { numero: session.nextBlock, marcas: `${start.time}->${end.time}` });
      const clips = collectBlockClips(session, start, end);
      session.cutMode = normalizeMode(mode);
      const blockNumber = session.nextBlock;
      session.nextBlock += 1;
      for (const clip of clips) clip.blockNumber = blockNumber;
      const block = await buildBlock(session, clips, blockNumber, editedText, { start, end });
      session.blocks.push(block);
      session.rangeStart = end;
      sendEvent('block', block);
      log('Bloque listo', { numero: block.blockNumber, nota: block.nota || block.noteError || 'sin nota' });
      return block;
    } finally {
      if (!session.stopping) session.pause = false;
    }
  });
}

function segmentFilename(source, stamp, offset) {
  const base = `${source.prefix}${stamp}${source.ext}`.replace(/[^\w.\-]+/g, '_');
  const parsed = path.parse(base);
  return `${parsed.name}-${String(offset).padStart(2, '0')}${parsed.ext}`;
}

async function publishSegment(session, source, fileStamp, url, sourceFile, sourceMediaUrl, part) {
  const stamp = addSeconds(fileStamp, part.offset);
  const toStamp = addSeconds(stamp, part.duration);
  const filename = segmentFilename(source, fileStamp, part.offset);
  const file = path.join(session.dir, 'clips', filename);
  const wav = path.join(session.dir, 'audio', `${path.parse(filename).name}.wav`);
  const clip = {
    index: session.clips.length,
    stamp,
    toStamp,
    from: clock(stamp),
    to: clock(toStamp),
    label: rangeLabel(stamp, part.duration),
    url,
    filename,
    file,
    text: '',
    words: [],
    offset: part.offset,
    duration: part.duration,
    sourceMediaUrl,
    ready: false,
    blockNumber: null
  };

  session.message = `Transcribiendo ${clip.label}`;
  sendEvent('status', { state: 'running', message: session.message, clock: clip.label, count: session.clips.length });
  await cutSegment(sourceFile, file, part.offset, part.duration);
  try {
    await extractAudio(file, wav);
    const result = await transcribe(wav);
    const text = String(result?.text || '').trim();
    if (!looksLikeHallucination(text, session.lastText)) {
      clip.text = text;
      clip.words = (result.words || []).map(word => ({
        word: word.word,
        at: Math.round((part.offset + word.start) * 100) / 100,
        clock: clockAt(fileStamp, part.offset + word.start)
      }));
      session.lastText = text;
    }
  } catch (error) {
    log('Segmento sin transcripción utilizable', { file: filename, message: publicError(error) });
    if (isAuthError(error)) clip.authError = error;
    else sendEvent('notice', { message: `No se pudo transcribir ${clip.label}.` });
  } finally {
    fs.rmSync(wav, { force: true });
  }

  clip.ready = true;
  session.clips.push(clip);
  session.clock = clip.label;
  session.previewUrl = mediaUrl(session.id, 'clips', filename);
  session.message = clip.text ? 'Transcribiendo' : 'Segmento recibido; esperando voz clara…';
  sendEvent('clip', publicClip(session, clip));
  if (clip.text) sendEvent('transcript', publicClip(session, clip));
  else sendEvent('silence', { index: clip.index, label: clip.label });
  sendEvent('status', { state: 'running', message: session.message, clock: clip.label, count: session.clips.length });
  if (clip.authError) throw clip.authError;
}

async function ingestClip(session, source, stamp) {
  const sourceName = `${source.prefix}${stamp}${source.ext}`.replace(/[^\w.\-]+/g, '_');
  const sourceFile = path.join(session.dir, 'clips', sourceName);
  const url = buildClipUrl(source, stamp);
  const label = rangeLabel(stamp, CLIP_STEP_SECONDS);
  session.message = `Descargando ${label}`;
  sendEvent('status', { state: 'running', message: session.message, clock: label, count: session.clips.length });
  await downloadClip(url, sourceFile);
  const sourceMediaUrl = mediaUrl(session.id, 'clips', sourceName);
  session.sources.push({ mediaUrl: sourceMediaUrl, label, file: sourceFile, stamp });
  if (!session.rangeStart) session.rangeStart = { mediaUrl: sourceMediaUrl, time: 0 };
  session.previewUrl = sourceMediaUrl;
  sendEvent('source', { mediaUrl: sourceMediaUrl, label, playableSeconds: CLIP_STEP_SECONDS });

  for (const part of segmentPlan()) {
    while (session.pause && !session.stopping) await sleep(40);
    if (session.stopping) return;
    session.busy = true;
    if (session.pause || session.stopping) {
      session.busy = false;
      if (session.stopping) return;
      continue;
    }
    try {
      await publishSegment(session, source, stamp, url, sourceFile, sourceMediaUrl, part);
    } catch (error) {
      if (isAuthError(error)) throw error;
      log('No se pudo transcribir un segmento', { stamp, offset: part.offset, message: publicError(error) });
      sendEvent('notice', { message: `Se omitió el segmento de las ${clock(addSeconds(stamp, part.offset))}.` });
    } finally {
      session.busy = false;
    }
  }
}

async function runLoop(session, source) {
  const seen = new Set();
  const waiting = new Set();
  let lastStamp = source.stamp;
  let caughtUp = false;
  while (!session.stopping) {
    while (session.pause && !session.stopping) await sleep(40);
    if (session.stopping) return;
    let bloques = [];
    try {
      bloques = await fetchBloques30(session.bloquesQuery);
    } catch (error) {
      const message = publicError(error);
      log('No se pudieron consultar los bloques de 30 segundos', { message });
      sendEvent('notice', { message });
      if (!session.clips.length && Date.now() >= stampDeadline(lastStamp, CLIP_STEP_SECONDS, GRACE_MS)) throw error;
      await sleep(POLL_MS);
      continue;
    }
    if (!caughtUp && bloques.length) {
      const latest = bloques[bloques.length - 1];
      for (const item of bloques) {
        if (item.url !== latest.url) seen.add(item.url);
      }
      caughtUp = true;
      log('Se toma el último bloque de 30 segundos', { inicio: latest.inicio, url: latest.url });
    }
    const pending = bloques.filter(item => !seen.has(item.url));
    if (!pending.length) {
      const deadline = stampDeadline(lastStamp, CLIP_STEP_SECONDS, GRACE_MS);
      if (Date.now() >= deadline) {
        if (!session.clips.length) throw new Error('No se encontró un bloque de 30 segundos a partir de esa liga.');
        return;
      }
      session.message = 'Esperando el siguiente bloque de 30 segundos';
      sendEvent('status', { state: 'running', message: session.message, clock: session.clock, count: session.clips.length });
      await sleep(POLL_MS);
      continue;
    }
    let retry = false;
    for (const item of pending) {
      while (session.pause && !session.stopping) await sleep(40);
      if (session.stopping) return;
      const parsed = parseClipUrl(item.url);
      if (!parsed) {
        seen.add(item.url);
        log('Se omitió un bloque de 30 segundos sin liga válida', { url: item.url });
        continue;
      }
      try {
        await ingestClip(session, parsed, parsed.stamp);
        seen.add(item.url);
        waiting.delete(item.url);
        lastStamp = parsed.stamp;
      } catch (error) {
        if (isAuthError(error)) throw error;
        const newer = bloques.some(other => other.url !== item.url && !seen.has(other.url) && String(other.inicio) > String(item.inicio));
        if (newer) {
          seen.add(item.url);
          log('Se omitió un bloque de 30 segundos incompleto', { stamp: parsed.stamp, message: publicError(error) });
          continue;
        }
        if (!waiting.has(item.url)) {
          waiting.add(item.url);
          log('El bloque de 30 segundos todavía no está listo', { stamp: parsed.stamp, message: publicError(error) });
        }
        session.message = 'Esperando a que termine de grabarse el bloque de 30 segundos';
        sendEvent('status', { state: 'running', message: session.message, clock: session.clock, count: session.clips.length });
        retry = true;
        break;
      }
    }
    if (retry) await sleep(POLL_MS);
  }
}

function clearPreviousSessions() {
  for (const entry of fs.readdirSync(TEMP_DIR)) {
    fs.rmSync(path.join(TEMP_DIR, entry), { recursive: true, force: true });
  }
}

async function startSession(clipUrl) {
  if (active) throw new Error('Ya hay una captura en curso. Deténla antes de iniciar otra.');
  const pasted = String(clipUrl || '').trim();
  const parsed = pasted ? parseClipUrl(pasted) : null;
  if (pasted && !parsed) throw new Error('La liga no tiene el formato de clip: nombre-AAAAMMDDhhmmss.mp4');
  const query = parsed ? bloquesQuery(parsed, pasted) : bloquesQueryNow();
  const source = parsed || {
    dir: '',
    prefix: `${query.canal}-${query.idMedio}-`,
    ext: '.mp4',
    stamp: query.stamp,
    url: ''
  };
  assertTranscriptionReady();
  if (!fs.existsSync(FFMPEG)) throw new Error(`No se encontró ffmpeg en ${FFMPEG}`);

  clearPreviousSessions();
  const id = randomUUID();
  const dir = path.join(TEMP_DIR, id);
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cortes'), { recursive: true });

  const session = {
    id,
    dir,
    source,
    bloquesQuery: query,
    clips: [],
    blocks: [],
    nextBlock: 1,
    lastText: '',
    busy: false,
    pause: false,
    stopping: false,
    stopReason: '',
    message: 'Buscando el primer clip…',
    clock: rangeLabel(source.stamp),
    previewUrl: '',
    sources: [],
    rangeStart: null,
    pendingCut: null,
    finalBlock: null,
    exclusive: createLock()
  };
  active = session;
  sendEvent('status', { state: 'connecting', message: session.message, clock: session.clock, count: 0 });
  log('Captura iniciada', { id, url: source.url, bloques: query });

  session.done = (async () => {
    let failed = false;
    try {
      await runLoop(session, source);
      if (!session.stopReason) session.stopReason = 'ended';
      session.finalBlock = await closeBlock(session, session.pendingText, session.pendingCut, session.pendingMode);
      if (session.finalBlock && session.stopReason === 'ended') sendEvent('block', session.finalBlock);
    } catch (error) {
      failed = true;
      const message = publicError(error);
      log('La captura terminó con error', { message });
      try {
        session.finalBlock = await closeBlock(session, session.pendingText, session.pendingCut, session.pendingMode);
        if (session.finalBlock) sendEvent('block', session.finalBlock);
      } catch (cutError) {
        log('No se pudo cerrar el bloque tras el error', { message: publicError(cutError) });
      }
      sendEvent('error', { message });
      sendEvent('status', { state: 'error', message, clock: session.clock, count: session.clips.length });
    } finally {
      if (!failed) {
        const message = session.stopReason === 'ended'
          ? 'Se detuvo la generación de clips.'
          : 'Captura detenida.';
        sendEvent('status', { state: 'stopped', message, clock: session.clock, count: session.clips.length });
      }
      if (active === session) active = null;
    }
  })();

  return { ok: true, sessionId: id };
}

function resolveMedia(sessionId, kind, filename) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  if (kind !== 'clips' && kind !== 'cortes') return null;
  const name = path.basename(filename);
  if (!name || name !== filename) return null;
  const root = path.join(TEMP_DIR, sessionId, kind);
  const file = path.join(root, name);
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function serveFile(request, response) {
  const requestPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const relative = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404);
    response.end('No encontrado');
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const mediaMatch = request.method === 'GET' && request.url.match(/^\/media\/([^/]+)\/(clips|cortes)\/([^/?]+)/);
    if (mediaMatch) {
      const file = resolveMedia(mediaMatch[1], mediaMatch[2], decodeURIComponent(mediaMatch[3]));
      if (!file) return json(response, 404, { error: 'Archivo no encontrado' });
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': fs.statSync(file).size
      });
      fs.createReadStream(file).pipe(response);
      return;
    }

    if (request.method === 'GET' && request.url === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      if (active) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(active))}\n\n`);
      else response.write(`event: status\ndata: ${JSON.stringify({ state: 'idle', message: 'Lista para comenzar', clock: '—', count: 0 })}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }

    if (request.method === 'POST' && request.url === '/api/start') {
      const body = JSON.parse(await collectBody(request) || '{}');
      const result = await startSession(body.url);
      return json(response, 200, result);
    }

    if (request.method === 'POST' && request.url === '/api/stop') {
      if (!active) return json(response, 200, { ok: true, block: null });
      const body = JSON.parse(await collectBody(request) || '{}');
      const session = active;
      log('Deteniendo captura');
      session.pendingText = body.transcription;
      session.pendingCut = body.cut;
      session.pendingMode = body.mode;
      session.stopReason = 'stopped';
      session.stopping = true;
      session.pause = false;
      await session.done;
      return json(response, 200, { ok: true, block: session.finalBlock });
    }

    if (request.method === 'POST' && request.url === '/api/cerrar-bloque') {
      if (!active) return json(response, 400, { error: 'No hay una captura en curso.' });
      const body = JSON.parse(await collectBody(request) || '{}');
      const block = await closeBlock(active, body.transcription, body.cut, body.mode);
      if (!block) return json(response, 200, { block: null, message: 'El bloque todavía no tiene clips.' });
      return json(response, 200, { block });
    }

    if (request.method === 'GET') return serveFile(request, response);
    json(response, 404, { error: 'No encontrado' });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: error.message || 'Error interno' });
  }
});

server.listen(PORT, () => {
  console.log(`Cortes de la conferencia en http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  if (active) active.stopping = true;
  process.exit(0);
});
