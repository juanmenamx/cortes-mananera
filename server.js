const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  CLIP_STEP_SECONDS,
  addSeconds,
  buildClipUrl,
  clock,
  parseClipUrl,
  rangeLabel,
  segmentPlan,
  stampDeadline
} = require('./lib/clips');

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(__dirname, '..', 'transcriptor-mananera', '.env'), ['PORT']);
loadEnv(path.join(__dirname, '..', 'news-notas-ai', '.env'), ['PORT']);

const { assertTranscriptionReady, formatBlock, looksLikeHallucination, transcribe } = require('./lib/transcribe');

const PORT = Number(process.env.PORT || 4311);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TEMP_DIR = path.join(__dirname, 'temp');
const FFMPEG = process.env.FFMPEG_PATH || path.join(__dirname, '..', 'youtube-portable', 'bin', 'ffmpeg.exe');
const GRACE_MS = Number(process.env.CLIP_GRACE_MS || 60000);
const POLL_MS = 2000;

fs.mkdirSync(TEMP_DIR, { recursive: true });

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
    mediaUrl: mediaUrl(session.id, 'clips', clip.filename)
  };
}

function snapshot(session) {
  return {
    state: session.stopping ? 'stopped' : 'running',
    message: session.message || 'Siguiendo clips',
    clock: session.clock || '—',
    count: session.clips.length,
    previewUrl: session.previewUrl || '',
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
  if (bytes.length < 1000) throw new Error('El clip llegó vacío.');
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
    .map(clip => `[${clip.label}] ${clip.text}`)
    .join('\n\n');
}

async function buildBlock(session, clips, blockNumber, editedText) {
  const from = clips[0].from;
  const to = clips[clips.length - 1].to;
  const filename = `bloque-${String(blockNumber).padStart(2, '0')}-${clips[0].stamp}-${clips[clips.length - 1].toStamp}.mp4`;
  const output = path.join(session.dir, 'cortes', filename);
  const rawText = String(editedText || '').trim() || serverTranscript(clips);
  const block = {
    blockNumber,
    from,
    to,
    label: `${from}–${to}`,
    clipCount: clips.length,
    lastIndex: clips[clips.length - 1].index,
    rawText,
    formatted: '',
    formatError: '',
    videoUrl: '',
    cutError: ''
  };

  const tasks = [
    cutVideos(clips, output).then(() => {
      block.videoUrl = mediaUrl(session.id, 'cortes', filename);
    }).catch(error => {
      block.cutError = error.message;
      log('No se pudo cortar el bloque', { blockNumber, message: error.message });
    })
  ];

  if (rawText) {
    tasks.push(formatBlock({
      transcription: rawText,
      blockNumber,
      sourceUrl: clips[0].url,
      stamp: clips[0].stamp
    }).then(text => {
      block.formatted = text;
    }).catch(error => {
      block.formatError = publicError(error);
      log('No se pudo formatear el bloque', { blockNumber, message: error.message });
    }));
  } else {
    block.formatted = 'Este bloque no contiene voz transcrita.';
  }

  await Promise.all(tasks);
  return block;
}

async function closeBlock(session, editedText) {
  return session.exclusive(async () => {
    session.pause = true;
    while (session.busy) await sleep(40);
    const clips = session.clips.filter(clip => clip.ready && clip.blockNumber == null);
    session.pause = false;
    if (!clips.length) return null;
    const blockNumber = session.nextBlock;
    session.nextBlock += 1;
    for (const clip of clips) clip.blockNumber = blockNumber;
    const block = await buildBlock(session, clips, blockNumber, editedText);
    session.blocks.push(block);
    return block;
  });
}

function segmentFilename(source, stamp, offset) {
  const base = `${source.prefix}${stamp}${source.ext}`.replace(/[^\w.\-]+/g, '_');
  const parsed = path.parse(base);
  return `${parsed.name}-${String(offset).padStart(2, '0')}${parsed.ext}`;
}

async function publishSegment(session, source, fileStamp, url, sourceFile, part) {
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
    ready: false,
    blockNumber: null
  };

  session.message = `Transcribiendo ${clip.label}`;
  sendEvent('status', { state: 'running', message: session.message, clock: clip.label, count: session.clips.length });
  await cutSegment(sourceFile, file, part.offset, part.duration);
  try {
    await extractAudio(file, wav);
    const text = await transcribe(wav);
    if (!looksLikeHallucination(text, session.lastText)) {
      clip.text = text;
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
  if (clip.text) sendEvent('transcript', { index: clip.index, text: clip.text, label: clip.label });
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
      await publishSegment(session, source, stamp, url, sourceFile, part);
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
  let stamp = source.stamp;
  while (!session.stopping) {
    while (session.pause && !session.stopping) await sleep(40);
    if (session.stopping) return;
    const url = buildClipUrl(source, stamp);
    const found = await waitForClip(session, url, stamp);
    if (!found) {
      if (!session.clips.length) throw new Error('No se encontró ese clip. Revisa la liga y que el archivo ya exista.');
      return;
    }
    while (session.pause && !session.stopping) await sleep(40);
    if (session.stopping) return;
    try {
      await ingestClip(session, source, stamp);
    } catch (error) {
      if (isAuthError(error)) throw error;
      log('No se pudo incorporar el clip', { stamp, message: publicError(error) });
      sendEvent('notice', { message: `Se omitió el clip de las ${clock(stamp)}.` });
    }
    stamp = addSeconds(stamp, CLIP_STEP_SECONDS);
  }
}

function clearPreviousSessions() {
  for (const entry of fs.readdirSync(TEMP_DIR)) {
    fs.rmSync(path.join(TEMP_DIR, entry), { recursive: true, force: true });
  }
}

async function startSession(clipUrl) {
  if (active) throw new Error('Ya hay una captura en curso. Deténla antes de iniciar otra.');
  const source = parseClipUrl(clipUrl);
  if (!source) throw new Error('La liga no tiene el formato de clip: nombre-AAAAMMDDhhmmss.mp4');
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
    finalBlock: null,
    exclusive: createLock()
  };
  active = session;
  sendEvent('status', { state: 'connecting', message: session.message, clock: session.clock, count: 0 });
  log('Captura iniciada', { id, url: source.url });

  session.done = (async () => {
    let failed = false;
    try {
      await runLoop(session, source);
      if (!session.stopReason) session.stopReason = 'ended';
      session.finalBlock = await closeBlock(session, session.pendingText);
      if (session.finalBlock && session.stopReason === 'ended') sendEvent('block', session.finalBlock);
    } catch (error) {
      failed = true;
      const message = publicError(error);
      log('La captura terminó con error', { message });
      try {
        session.finalBlock = await closeBlock(session, session.pendingText);
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
      session.pendingText = body.transcription;
      session.stopReason = 'stopped';
      session.stopping = true;
      await session.done;
      return json(response, 200, { ok: true, block: session.finalBlock });
    }

    if (request.method === 'POST' && request.url === '/api/cerrar-bloque') {
      if (!active) return json(response, 400, { error: 'No hay una captura en curso.' });
      const body = JSON.parse(await collectBody(request) || '{}');
      const block = await closeBlock(active, body.transcription);
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
