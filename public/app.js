const urlInput = document.querySelector('#clip-url');
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
  advancing = false;
  delete preview.dataset.stalled;
  previewLabel.textContent = file.label || 'Clip';
  videoFrame.classList.add('has-video');
  preview.src = file.mediaUrl;
  revealCues(file.mediaUrl, 0);
  for (const earlier of files.slice(0, index)) revealCues(earlier.mediaUrl, PLAYABLE_SECONDS);
  const started = preview.play();
  if (started) started.catch(() => {});
}

function advancePlayback() {
  if (advancing) return;
  advancing = true;
  const file = files[playIndex];
  if (file) revealCues(file.mediaUrl, PLAYABLE_SECONDS);
  if (files[playIndex + 1]) playFile(playIndex + 1);
  else {
    advancing = false;
    preview.dataset.stalled = '1';
  }
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
preview.addEventListener('ended', () => advancePlayback());

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
  urlInput.disabled = running;
  newBlockButton.disabled = !running;
  if (meta.clock) clock.textContent = meta.clock;
  if (Number.isInteger(meta.count)) count.textContent = segmentCount(meta.count);
}

function segmentCount(value) {
  return `${value} ${value === 1 ? 'segmento' : 'segmentos'}`;
}

function currentTranscript() {
  const paragraphs = [...transcript.querySelectorAll('p[data-index]')];
  if (!paragraphs.length) return '';
  return paragraphs.map(paragraph => {
    const heading = paragraph.querySelector(':scope > time')?.textContent || '';
    const words = [...paragraph.querySelectorAll('.word')].map(span => {
      const stamp = span.querySelector('time')?.textContent || '';
      const word = [...span.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(' ').trim();
      return `[${stamp}] ${word}`;
    });
    return `[${heading}] ${words.join(' ')}`.trim();
  }).join('\n\n');
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
  paragraph.classList.add('pending');
  const heading = document.createElement('time');
  heading.textContent = cue.label;
  paragraph.append(heading);
  for (const word of cue.words) {
    const span = document.createElement('span');
    span.className = 'word pending';
    const stamp = document.createElement('time');
    stamp.textContent = word.clock;
    span.append(stamp, document.createTextNode(` ${word.word}`));
    paragraph.append(document.createTextNode(' '), span);
  }
  transcript.appendChild(paragraph);
  archive.push({
    index: cue.index,
    label: cue.label,
    text: cue.words.map(word => `[${word.clock}] ${word.word}`).join(' ')
  });
}

function takeClosedParagraphs(lastIndex) {
  if (!Number.isInteger(lastIndex)) return;
  for (const paragraph of [...transcript.querySelectorAll('p[data-index]')]) {
    if (Number(paragraph.dataset.index) <= lastIndex) paragraph.remove();
  }
  if (!transcript.querySelector('p')) {
    transcript.innerHTML = '<p class="placeholder">Bloque siguiente en curso…</p>';
  }
}

function addBlockCard(block) {
  if (!block || seenBlocks.has(block.blockNumber)) return;
  seenBlocks.add(block.blockNumber);
  blocksSection.hidden = false;
  const card = document.createElement('article');
  card.className = 'block-card';
  const ready = Boolean(block.videoUrl) && !block.formatError;
  const failed = Boolean(block.cutError || block.formatError);
  card.innerHTML = `
    <div class="block-card-head">
      <strong>Bloque ${block.blockNumber}</strong>
      <span class="block-state ${ready ? 'ready' : failed ? 'error' : ''}"></span>
    </div>
    <p class="block-meta"></p>
    <video class="block-video" controls playsinline></video>
    <p class="saved-path"></p>
    <pre class="formatted" contenteditable="true"></pre>
    <div class="block-card-actions">
      <a class="secondary download-block" download>Descargar video</a>
      <button class="secondary copy-block">Copiar para WhatsApp</button>
    </div>
    <details class="raw-details">
      <summary>Ver transcripción original</summary>
      <pre></pre>
    </details>`;
  const state = card.querySelector('.block-state');
  state.textContent = block.cutError
    ? 'No se pudo cortar el video'
    : block.formatError
      ? 'Video listo; falló el texto'
      : 'Listo para revisar';
  card.querySelector('.block-meta').textContent = `${block.label} · ${segmentCount(block.clipCount)}`;
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
  card.querySelector('.raw-details pre').textContent = block.rawText || '';
  blocksContainer.prepend(card);
  takeClosedParagraphs(block.lastIndex);
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
  for (const block of data.blocks || []) addBlockCard(block);
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
  const url = urlInput.value.trim();
  if (!url) return setStatus('error', 'Pega primero la liga de un clip.');
  transcript.innerHTML = '<p class="placeholder">Buscando el primer clip…</p>';
  blocksContainer.innerHTML = '';
  blocksSection.hidden = true;
  seenBlocks.clear();
  archive.length = 0;
  resetPlayback();
  clock.textContent = '—';
  count.textContent = '0 segmentos';
  setStatus('connecting', 'Buscando el primer clip…');
  try {
    await post('/api/start', { url });
  } catch (error) {
    setStatus('error', error.message);
  }
});

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true;
  newBlockButton.disabled = true;
  try {
    const result = await post('/api/stop', { transcription: currentTranscript() });
    if (result.block) addBlockCard(result.block);
  } catch (error) {
    setStatus('error', error.message);
  }
});

newBlockButton.addEventListener('click', async () => {
  newBlockButton.disabled = true;
  try {
    const result = await post('/api/cerrar-bloque', { transcription: currentTranscript() });
    if (result.block) addBlockCard(result.block);
    else setStatus('running', result.message || 'El bloque todavía no tiene clips.', { clock: clock.textContent });
  } catch (error) {
    setStatus('error', error.message);
  } finally {
    if (running) newBlockButton.disabled = false;
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(transcript.innerText.trim());
  const original = copyButton.textContent;
  copyButton.textContent = 'Copiado';
  setTimeout(() => { copyButton.textContent = original; }, 1200);
});

downloadButton.addEventListener('click', () => {
  if (!archive.length) return;
  const cleanText = archive.map(item => `[${item.label}] ${item.text}`).join('\n\n');
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
  const button = event.target.closest('.copy-block');
  if (!button) return;
  const text = button.closest('.block-card').querySelector('.formatted').innerText.trim();
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
events.addEventListener('block', event => addBlockCard(JSON.parse(event.data)));
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
