const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const statusText = document.querySelector('#status');
const indicator = document.querySelector('#indicator');
const clock = document.querySelector('#clock');
const count = document.querySelector('#count');
const transcript = document.querySelector('#transcript');
const copyButton = document.querySelector('#copy');
const downloadButton = document.querySelector('#download');
const clearButton = document.querySelector('#clear');
const newBlockButton = document.querySelector('#new-block');
const participants = document.querySelector('#participants');
const reporters = document.querySelector('#reporters');
const participantsGroup = document.querySelector('#participants-group');
const reportersGroup = document.querySelector('#reporters-group');
const addParticipantButton = document.querySelector('#add-participant');
const addReporterButton = document.querySelector('#add-reporter');
const kindParticipacion = document.querySelector('#kind-participacion');
const kindPregunta = document.querySelector('#kind-pregunta');
const peopleHint = document.querySelector('#people-hint');
const clearSelectionButton = document.querySelector('#clear-selection');
const cutError = document.querySelector('#cut-error');
const listening = document.querySelector('#listening');
let cutKind = 'participacion';
const blocksSection = document.querySelector('#blocks-section');
const blocksContainer = document.querySelector('#blocks');
const preview = document.querySelector('#preview');
const previewLabel = document.querySelector('#preview-label');
const videoFrame = document.querySelector('.video-frame');

let running = false;
let sawSnapshot = false;
const archive = [];
const seenBlocks = new Set();
const files = [];
const cues = [];
let playIndex = -1;
let advancing = false;
const PLAYABLE_SECONDS = 30;

function resetPlayback() {
  files.length = 0;
  cues.length = 0;
  playIndex = -1;
  advancing = false;
  delete preview.dataset.stalled;
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  videoFrame.classList.remove('has-video');
  previewLabel.textContent = 'Sin video';
}

function enqueueSource(mediaUrl, label) {
  if (!mediaUrl || files.some(file => file.mediaUrl === mediaUrl)) return;
  const stalled = preview.dataset.stalled === '1';
  files.push({ mediaUrl, label });
  if (playIndex < 0) playFile(0);
  else if (stalled) playFile(playIndex + 1);
}

function playFile(index) {
  const file = files[index];
  if (!file) return;
  playIndex = index;
  advancing = true;
  delete preview.dataset.stalled;
  previewLabel.textContent = file.label || 'Clip';
  videoFrame.classList.add('has-video');
  preview.src = file.mediaUrl;
  revealCues(file.mediaUrl, 0);
  for (const earlier of files.slice(0, index)) revealCues(earlier.mediaUrl, PLAYABLE_SECONDS);
  const release = () => { advancing = false; };
  const started = preview.play();
  if (started) started.then(release, release);
  else release();
}

function advancePlayback() {
  if (advancing) return;
  const file = files[playIndex];
  if (file) revealCues(file.mediaUrl, PLAYABLE_SECONDS);
  if (files[playIndex + 1]) {
    playFile(playIndex + 1);
    return;
  }
  preview.dataset.stalled = '1';
  if (preview.currentTime >= PLAYABLE_SECONDS) preview.pause();
}

function revealCues(mediaUrl, time) {
  for (const cue of cues) {
    if (cue.sourceMediaUrl !== mediaUrl) continue;
    mountCue(cue);
    const paragraph = transcript.querySelector(`p[data-index="${cue.index}"]`);
    if (!paragraph || !cue.words) continue;
    const spans = [...paragraph.querySelectorAll('.word')];
    let revealed = false;
    cue.words.forEach((word, index) => {
      if (word.shown || time + 0.05 < word.at) return;
      word.shown = true;
      revealed = true;
      spans[index]?.classList.remove('pending');
    });
    if (revealed) {
      paragraph.classList.remove('pending');
      transcript.scrollTop = transcript.scrollHeight;
    }
  }
}

function rememberCue(data) {
  let cue = cues.find(item => item.index === data.index);
  if (!cue) {
    cue = { index: data.index, text: '', offset: 0, sourceMediaUrl: '', label: '', words: null, mounted: false };
    cues.push(cue);
  }
  if (data.label) cue.label = data.label;
  if (Number.isFinite(data.offset)) cue.offset = data.offset;
  if (data.sourceMediaUrl) cue.sourceMediaUrl = data.sourceMediaUrl;
  if (data.text) cue.text = data.text;
  if (Array.isArray(data.words) && data.words.length && !cue.words?.length) {
    cue.words = data.words.map(word => ({ ...word, shown: false }));
  }
  if (!cue.text && !cue.words?.length) return;
  const fileIndex = files.findIndex(file => file.mediaUrl === cue.sourceMediaUrl);
  const passed = fileIndex >= 0 && (fileIndex < playIndex || (fileIndex === playIndex && preview.dataset.stalled === '1'));
  if (passed) revealCues(cue.sourceMediaUrl, PLAYABLE_SECONDS);
  else if (files[playIndex]?.mediaUrl === cue.sourceMediaUrl) revealCues(cue.sourceMediaUrl, preview.currentTime || 0);
}

preview.addEventListener('timeupdate', () => {
  const file = files[playIndex];
  if (!file || advancing) return;
  if (preview.currentTime >= PLAYABLE_SECONDS) {
    advancePlayback();
    return;
  }
  revealCues(file.mediaUrl, preview.currentTime);
});
preview.addEventListener('ended', () => {
  if (!advancing) advancePlayback();
});

function setStatus(state, message, meta = {}) {
  running = state === 'running' || state === 'connecting';
  statusText.textContent = message || ({
    idle: 'Lista para comenzar',
    running: 'Transcribiendo',
    stopped: 'Captura detenida.'
  }[state] || state);
  indicator.className = `indicator ${state === 'running' || state === 'connecting' ? 'running' : state === 'error' ? 'error' : ''}`;
  startButton.disabled = running;
  stopButton.disabled = !running;
  newBlockButton.disabled = !running;
  listening.hidden = state !== 'running';
  if (meta.clock) clock.textContent = meta.clock;
  if (Number.isInteger(meta.count)) count.textContent = segmentCount(meta.count);
}

function segmentCount(value) {
  return `${value} ${value === 1 ? 'segmento' : 'segmentos'}`;
}

function addPerson(container, fields, values = {}) {
  const row = document.createElement('div');
  row.className = 'person';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'person-check';
  check.setAttribute('aria-label', 'Seleccionar');
  check.append(document.createElement('span'));
  const fieldsBox = document.createElement('div');
  fieldsBox.className = 'person-fields';
  for (const field of fields) {
    const input = document.createElement('input');
    input.dataset.field = field;
    input.placeholder = field === 'nombre' ? 'Nombre' : field === 'cargo' ? 'Cargo' : 'Medio';
    input.value = values[field] || '';
    fieldsBox.append(input);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger remove-person';
  remove.textContent = 'Quitar';
  row.append(check, fieldsBox, remove);
  container.append(row);
}

function readPeople(container, extraField) {
  return [...container.querySelectorAll('.person')].map(row => ({
    nombre: row.querySelector('[data-field="nombre"]').value.trim(),
    [extraField]: row.querySelector(`[data-field="${extraField}"]`).value.trim()
  })).filter(person => person.nombre);
}

function mergePeople(container, extraField, incoming) {
  for (const person of incoming || []) {
    const nombre = String(person?.nombre || '').trim();
    const extra = String(person[extraField] || '').trim();
    if (!nombre) continue;
    const rows = [...container.querySelectorAll('.person')];
    const same = rows.find(row => {
      const current = row.querySelector('[data-field="nombre"]').value.trim();
      return current.localeCompare(nombre, 'es', { sensitivity: 'base' }) === 0;
    });
    if (same) {
      const field = same.querySelector(`[data-field="${extraField}"]`);
      if (field && !field.value.trim() && extra) field.value = extra;
      continue;
    }
    const blank = rows.find(row => !row.querySelector('[data-field="nombre"]').value.trim());
    if (blank) {
      blank.querySelector('[data-field="nombre"]').value = nombre;
      blank.querySelector(`[data-field="${extraField}"]`).value = extra;
      continue;
    }
    addPerson(container, ['nombre', extraField], { nombre, [extraField]: extra });
  }
}

function activeList() {
  return cutKind === 'pregunta' ? reporters : participants;
}

function personFromRow(row, extraField) {
  const nombre = row.querySelector('[data-field="nombre"]').value.trim();
  if (!nombre) return null;
  return {
    nombre,
    [extraField]: row.querySelector(`[data-field="${extraField}"]`).value.trim()
  };
}

function selectedSpeaker() {
  const row = activeList().querySelector('.person.selected');
  if (!row) return null;
  return personFromRow(row, cutKind === 'pregunta' ? 'medio' : 'cargo');
}

function pickSpeaker() {
  if (selectedSpeaker()) return;
  const extra = cutKind === 'pregunta' ? 'medio' : 'cargo';
  const rows = [...activeList().querySelectorAll('.person')].filter(row => personFromRow(row, extra));
  if (rows.length === 1) selectPerson(rows[0]);
}

function selectPerson(row) {
  const list = row.closest('.people-list');
  list.querySelectorAll('.person.selected').forEach(item => item.classList.remove('selected'));
  row.classList.add('selected');
}

function setCutKind(kind) {
  cutKind = kind === 'pregunta' ? 'pregunta' : 'participacion';
  kindParticipacion.classList.toggle('active', cutKind === 'participacion');
  kindPregunta.classList.toggle('active', cutKind === 'pregunta');
  participantsGroup.classList.toggle('is-target', cutKind === 'participacion');
  reportersGroup.classList.toggle('is-target', cutKind === 'pregunta');
  peopleHint.innerHTML = cutKind === 'pregunta'
    ? '<strong>¿Quién hace la pregunta?</strong> Corrige nombre o medio si es necesario y selecciona al reportero antes de finalizar.'
    : '<strong>¿Quién o quiénes participaron en este bloque?</strong> Corrige nombre o cargo si es necesario y selecciona antes de finalizar.';
}

function cutMode() {
  return {
    kind: cutKind,
    speaker: selectedSpeaker(),
    participantes: readPeople(participants, 'cargo'),
    reporteros: readPeople(reporters, 'medio')
  };
}

function absorbPeople(block) {
  if (Array.isArray(block?.funcionarios)) mergePeople(participants, 'cargo', block.funcionarios);
  const reporteros = Array.isArray(block?.reporteros) && block.reporteros.length
    ? block.reporteros
    : (block?.reportero ? [block.reportero] : []);
  if (reporteros.length) mergePeople(reporters, 'medio', reporteros);
}

function cutPosition() {
  const file = files[playIndex];
  if (!file || !preview.getAttribute('src')) return null;
  let time = Number(preview.currentTime);
  if (!Number.isFinite(time) || time < 0) time = 0;
  if (time > PLAYABLE_SECONDS) time = PLAYABLE_SECONDS;
  return { mediaUrl: file.mediaUrl, time: Math.round(time * 100) / 100 };
}

function ensureTranscript() {
  const placeholder = transcript.querySelector('.placeholder');
  if (placeholder) placeholder.remove();
}

function mountCue(cue) {
  if (cue.mounted || (!cue.text && !cue.words?.length)) return;
  if (!cue.words?.length && cue.text) {
    cue.words = [{ word: cue.text, at: cue.offset, clock: cue.label, shown: false }];
  }
  cue.mounted = true;
  ensureTranscript();
  const paragraph = document.createElement('p');
  paragraph.dataset.index = String(cue.index);
  paragraph.dataset.media = cue.sourceMediaUrl || '';
  paragraph.classList.add('pending');
  const heading = document.createElement('time');
  heading.textContent = cue.label;
  paragraph.append(heading);
  for (const word of cue.words) {
    const span = document.createElement('span');
    span.className = 'word pending';
    span.dataset.at = String(word.at);
    const stamp = document.createElement('time');
    stamp.textContent = word.clock;
    span.append(stamp, document.createTextNode(` ${word.word}`));
    paragraph.append(document.createTextNode(' '), span);
  }
  transcript.appendChild(paragraph);
  archive.push({
    index: cue.index,
    label: cue.label,
    text: cue.words.map(word => word.word).join(' ')
  });
}

function takeClosedParagraphs(block) {
  const cut = block?.cut;
  if (!cut || !Number.isFinite(cut.time)) {
    const lastIndex = block?.lastIndex;
    if (!Number.isInteger(lastIndex)) return;
    for (const paragraph of [...transcript.querySelectorAll('p[data-index]')]) {
      if (Number(paragraph.dataset.index) <= lastIndex) paragraph.remove();
    }
  } else {
    for (const cue of cues) {
      const fileIndex = files.findIndex(file => file.mediaUrl === cue.sourceMediaUrl);
      const cutIndex = files.findIndex(file => file.mediaUrl === cut.mediaUrl);
      if (fileIndex < 0 || cutIndex < 0 || fileIndex > cutIndex) continue;
      const keep = fileIndex < cutIndex ? [] : (cue.words || []).filter(word => word.at >= cut.time);
      transcript.querySelector(`p[data-index="${cue.index}"]`)?.remove();
      const archived = archive.findIndex(item => item.index === cue.index);
      if (archived >= 0) archive.splice(archived, 1);
      cue.mounted = false;
      cue.words = keep.map(word => ({ ...word, shown: false }));
      if (!keep.length) {
        cue.mounted = true;
        continue;
      }
      mountCue(cue);
    }
    const playing = files[playIndex];
    if (playing) revealCues(playing.mediaUrl, preview.currentTime || 0);
  }
  if (!transcript.querySelector('p')) {
    transcript.innerHTML = '<p class="placeholder">Bloque siguiente en curso…</p>';
  }
}

function plainTranscript(text) {
  return String(text || '')
    .replace(/\[[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{2})?(?:–[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{2})?)?\]\s*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cutFactsText(block) {
  const envio = {
    ...(block.fecha ? { fecha: block.fecha } : {}),
    ...(block.envio || {}),
    marcas: block.marcas,
    duracion: block.duracion,
    inicio_marca: block.inicio_marca,
    fin_marca: block.fin_marca,
    precio: block.precio == null || block.precio === '' ? (block.precioError || '—') : block.precio,
    digest: block.digest || '—'
  };
  return Object.entries(envio).map(([key, value]) => `${key}: ${value ?? '—'}`).join('\n');
}

function addBlockCard(block) {
  if (!block || seenBlocks.has(block.blockNumber)) return;
  seenBlocks.add(block.blockNumber);
  blocksSection.hidden = false;
  const card = document.createElement('article');
  card.className = 'block-card';
  const ready = Boolean(block.videoUrl) && !block.formatError && !block.noteError;
  const failed = Boolean(block.cutError || block.formatError || block.noteError);
  card.innerHTML = `
    <div class="block-card-head">
      <strong>Bloque ${block.blockNumber}</strong>
      <span class="block-state ${ready ? 'ready' : failed ? 'error' : ''}"></span>
    </div>
    <p class="block-meta"></p>
    <pre class="cut-facts"></pre>
    <p class="note-state" hidden></p>
    <video class="block-video" controls playsinline></video>
    <p class="saved-path"></p>
    <pre class="formatted" contenteditable="true"></pre>
    <div class="block-card-actions">
      <a class="secondary download-block" download>Descargar video</a>
      <button class="secondary copy-facts">Copiar datos del corte</button>
      <button class="secondary copy-block">Copiar para WhatsApp</button>
    </div>
    <details class="raw-details">
      <summary>Ver transcripción original</summary>
      <pre></pre>
    </details>`;
  const state = card.querySelector('.block-state');
  state.textContent = block.cutError
    ? 'No se pudo cortar el video'
    : block.noteError
      ? 'No se registró la nota'
      : block.formatError
        ? 'Video listo; falló el texto'
        : 'Listo para revisar';
  card.querySelector('.block-meta').textContent = `${block.label} · ${segmentCount(block.clipCount)}`;
  card.querySelector('.cut-facts').textContent = cutFactsText(block);
  const note = card.querySelector('.note-state');
  if (block.noteError) {
    note.hidden = false;
    note.classList.add('error');
    note.textContent = block.noteError;
  } else if (block.nota) {
    note.hidden = false;
    note.textContent = `Nota ${block.nota}`;
  }
  const video = card.querySelector('.block-video');
  const download = card.querySelector('.download-block');
  const saved = card.querySelector('.saved-path');
  if (block.videoUrl) {
    video.src = block.videoUrl;
    download.href = block.videoUrl;
    download.download = `bloque-${block.blockNumber}.mp4`;
    saved.textContent = block.savedPath ? `Guardado en ${block.savedPath}` : '';
  } else {
    video.hidden = true;
    download.hidden = true;
    saved.hidden = true;
  }
  const formatted = card.querySelector('.formatted');
  formatted.textContent = block.formatted || block.formatError || 'Sin texto.';
  card.querySelector('.raw-details pre').textContent = plainTranscript(block.rawText);
  blocksContainer.prepend(card);
  takeClosedParagraphs(block);
}

function renderSnapshot(data) {
  setStatus(data.state, data.message, data);
  resetPlayback();
  transcript.innerHTML = '';
  for (const source of data.sources || []) enqueueSource(source.mediaUrl, source.label);
  for (const clip of data.openClips || []) rememberCue(clip);
  if (files.length) playFile(files.length - 1);
  if (!transcript.querySelector('p')) {
    transcript.innerHTML = '<p class="placeholder">La transcripción aparecerá aquí…</p>';
  }
  for (const block of data.blocks || []) {
    absorbPeople(block);
    addBlockCard(block);
  }
}

async function post(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No se pudo completar la operación.');
  return result;
}

startButton.addEventListener('click', async () => {
  transcript.innerHTML = '<p class="placeholder">Buscando el bloque de 30 segundos…</p>';
  blocksContainer.innerHTML = '';
  blocksSection.hidden = true;
  seenBlocks.clear();
  archive.length = 0;
  resetPlayback();
  clock.textContent = '—';
  count.textContent = '0 segmentos';
  setStatus('connecting', 'Buscando el bloque de 30 segundos…');
  try {
    await post('/api/start', {});
  } catch (error) {
    setStatus('error', error.message);
  }
});

function showCutError(message) {
  cutError.hidden = !message;
  cutError.textContent = message || '';
}

function revealBlock(block) {
  showCutError('');
  absorbPeople(block);
  addBlockCard(block);
  blocksSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function stopSession() {
  pickSpeaker();
  stopButton.disabled = true;
  newBlockButton.disabled = true;
  setStatus('connecting', 'Deteniendo y generando la nota…');
  stopButton.disabled = true;
  newBlockButton.disabled = true;
  try {
    const result = await post('/api/stop', { cut: cutPosition(), mode: cutMode() });
    if (result.block) revealBlock(result.block);
    else showCutError('La captura se detuvo, pero este tramo no tenía video para armar el bloque.');
  } catch (error) {
    showCutError(error.message);
    setStatus('error', error.message);
  }
}

stopButton.addEventListener('click', stopSession);

newBlockButton.addEventListener('click', async () => {
  pickSpeaker();
  newBlockButton.disabled = true;
  setStatus('running', 'Cortando el bloque y generando la nota…', { clock: clock.textContent });
  newBlockButton.disabled = true;
  try {
    const result = await post('/api/cerrar-bloque', { cut: cutPosition(), mode: cutMode() });
    if (result.block) revealBlock(result.block);
    else showCutError(result.message || 'El video todavía está en el inicio de este bloque.');
  } catch (error) {
    showCutError(error.message);
    setStatus('error', error.message);
  } finally {
    if (running) newBlockButton.disabled = false;
  }
});

kindParticipacion.addEventListener('click', () => setCutKind('participacion'));
kindPregunta.addEventListener('click', () => setCutKind('pregunta'));
addParticipantButton.addEventListener('click', () => addPerson(participants, ['nombre', 'cargo']));
addReporterButton.addEventListener('click', () => addPerson(reporters, ['nombre', 'medio']));
document.addEventListener('click', event => {
  const button = event.target.closest('.remove-person');
  if (button) {
    button.closest('.person').remove();
    return;
  }
  if (event.target.closest('input')) return;
  const row = event.target.closest('.person');
  if (row) selectPerson(row);
});
clearSelectionButton.addEventListener('click', () => {
  activeList().querySelectorAll('.person.selected').forEach(item => item.classList.remove('selected'));
});
addPerson(participants, ['nombre', 'cargo']);
addPerson(reporters, ['nombre', 'medio']);

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(transcript.innerText.trim());
  const original = copyButton.textContent;
  copyButton.textContent = 'Copiado';
  setTimeout(() => { copyButton.textContent = original; }, 1200);
});

downloadButton.addEventListener('click', () => {
  if (!archive.length) return;
  const cleanText = archive.map(item => item.text).join('\n\n');
  const blob = new Blob([`${cleanText}\n`], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `transcripcion-clips-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
});

clearButton.addEventListener('click', () => {
  transcript.innerHTML = '<p class="placeholder">La transcripción aparecerá aquí…</p>';
});

blocksContainer.addEventListener('click', async event => {
  const button = event.target.closest('.copy-block, .copy-facts');
  if (!button) return;
  const card = button.closest('.block-card');
  const text = button.classList.contains('copy-facts')
    ? card.querySelector('.cut-facts').innerText.trim()
    : card.querySelector('.formatted').innerText.trim();
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = 'Copiado';
  setTimeout(() => { button.textContent = original; }, 1200);
});

const events = new EventSource('/api/events');
events.addEventListener('snapshot', event => {
  if (sawSnapshot) return;
  sawSnapshot = true;
  renderSnapshot(JSON.parse(event.data));
});
events.addEventListener('status', event => {
  const data = JSON.parse(event.data);
  setStatus(data.state, data.message, data);
});
events.addEventListener('source', event => {
  const data = JSON.parse(event.data);
  enqueueSource(data.mediaUrl, data.label);
});
events.addEventListener('clip', event => {
  const data = JSON.parse(event.data);
  rememberCue(data);
  if (Number.isInteger(data.index)) count.textContent = segmentCount(data.index + 1);
});
events.addEventListener('transcript', event => {
  rememberCue(JSON.parse(event.data));
});
events.addEventListener('block', event => {
  const block = JSON.parse(event.data);
  absorbPeople(block);
  addBlockCard(block);
});
events.addEventListener('silence', event => {
  const data = JSON.parse(event.data);
  const placeholder = transcript.querySelector('.placeholder');
  if (placeholder) placeholder.textContent = `${data.label} recibido, sin voz transcrita.`;
});
events.addEventListener('notice', event => {
  const data = JSON.parse(event.data);
  if (running) statusText.textContent = data.message;
});
events.addEventListener('error', event => {
  if (!event.data) return;
  try { setStatus('error', JSON.parse(event.data).message); } catch {}
});
