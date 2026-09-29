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
  return transcript.querySelector('.placeholder') ? '' : transcript.innerText.trim();
}

function ensureTranscript() {
  const placeholder = transcript.querySelector('.placeholder');
  if (placeholder) placeholder.remove();
}

function appendTranscript(index, label, text) {
  archive.push({ index, label, text });
  ensureTranscript();
  const paragraph = document.createElement('p');
  paragraph.dataset.index = String(index);
  const time = document.createElement('time');
  time.textContent = label;
  paragraph.append(time, document.createTextNode(text));
  transcript.appendChild(paragraph);
  transcript.scrollTop = transcript.scrollHeight;
}

function showPreview(mediaUrl, label) {
  if (!mediaUrl) return;
  previewLabel.textContent = label || 'Clip';
  videoFrame.classList.add('has-video');
  if (preview.getAttribute('src') !== mediaUrl) {
    preview.src = mediaUrl;
    preview.play().catch(() => {});
  }
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
  if (block.videoUrl) {
    video.src = block.videoUrl;
    download.href = block.videoUrl;
    download.download = `bloque-${block.blockNumber}.mp4`;
  } else {
    video.hidden = true;
    download.hidden = true;
  }
  const formatted = card.querySelector('.formatted');
  formatted.textContent = block.formatted || block.formatError || 'Sin texto.';
  card.querySelector('.raw-details pre').textContent = block.rawText || '';
  blocksContainer.prepend(card);
  takeClosedParagraphs(block.lastIndex);
}

function renderSnapshot(data) {
  setStatus(data.state, data.message, data);
  transcript.innerHTML = '';
  for (const clip of data.openClips || []) {
    if (clip.text) appendTranscript(clip.index, clip.label, clip.text);
    showPreview(clip.mediaUrl, clip.label);
  }
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
  clock.textContent = '—';
  count.textContent = '0 clips';
  videoFrame.classList.remove('has-video');
  preview.removeAttribute('src');
  previewLabel.textContent = 'Sin video';
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
events.addEventListener('clip', event => {
  const data = JSON.parse(event.data);
  showPreview(data.mediaUrl, data.label);
  if (Number.isInteger(data.index)) count.textContent = segmentCount(data.index + 1);
});
events.addEventListener('transcript', event => {
  const data = JSON.parse(event.data);
  appendTranscript(data.index, data.label, data.text);
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
