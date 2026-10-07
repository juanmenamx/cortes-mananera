const CLIP_STEP_SECONDS = 30;
const SEGMENT_SECONDS = 8;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function pad(value) {
  return String(value).padStart(2, '0');
}

function stampParts(stamp) {
  return {
    year: Number(stamp.slice(0, 4)),
    month: Number(stamp.slice(4, 6)),
    day: Number(stamp.slice(6, 8)),
    hour: Number(stamp.slice(8, 10)),
    minute: Number(stamp.slice(10, 12)),
    second: Number(stamp.slice(12, 14))
  };
}

function isValidStamp(stamp) {
  if (!/^\d{14}$/.test(stamp)) return false;
  const parts = stampParts(stamp);
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return false;
  if (parts.hour > 23 || parts.minute > 59 || parts.second > 59) return false;
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return date.getFullYear() === parts.year
    && date.getMonth() === parts.month - 1
    && date.getDate() === parts.day
    && date.getHours() === parts.hour
    && date.getMinutes() === parts.minute
    && date.getSeconds() === parts.second;
}

function addSeconds(stamp, seconds) {
  const parts = stampParts(stamp);
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second + seconds);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function clock(stamp) {
  return `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`;
}

function clockAt(stamp, seconds) {
  const parts = stampParts(stamp);
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  date.setTime(date.getTime() + Math.round(Number(seconds) * 1000));
  const hundredths = String(Math.floor(date.getMilliseconds() / 10)).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${hundredths}`;
}

function rangeLabel(stamp, stepSeconds = CLIP_STEP_SECONDS) {
  return `${clock(stamp)}–${clock(addSeconds(stamp, stepSeconds))}`;
}

function instantAt(stamp, seconds = 0) {
  const parts = stampParts(stamp);
  const date = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  date.setTime(date.getTime() + Math.round(Number(seconds) * 1000));
  return {
    clock: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    epoch: Math.floor(date.getTime() / 1000),
    fecha: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  };
}

function conferenceDate(stamp) {
  const parts = stampParts(stamp);
  const date = new Date(parts.year, parts.month - 1, parts.day);
  const text = `${WEEKDAYS[date.getDay()]} ${pad(parts.day)} de ${MONTHS[parts.month - 1]} de ${parts.year}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stampDeadline(stamp, stepSeconds = CLIP_STEP_SECONDS, graceMs = 60000) {
  const parts = stampParts(stamp);
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second).getTime()
    + (stepSeconds * 1000)
    + graceMs;
}

function parseClipUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const match = url.pathname.match(/^(.*\/)(.+-)(\d{14})(\.[A-Za-z0-9]+)$/);
  if (!match) return null;
  const [, dirPath, prefix, stamp, ext] = match;
  if (!isValidStamp(stamp)) return null;
  const source = {
    dir: `${url.origin}${dirPath}`,
    prefix,
    ext: ext.toLowerCase(),
    stamp
  };
  return { ...source, url: buildClipUrl(source, stamp) };
}

function buildClipUrl(source, stamp) {
  return `${source.dir}${source.prefix}${stamp}${source.ext}`;
}

function segmentPlan(totalSeconds = CLIP_STEP_SECONDS, size = SEGMENT_SECONDS) {
  const plan = [];
  for (let offset = 0; offset < totalSeconds; offset += size) {
    plan.push({ offset, duration: Math.min(size, totalSeconds - offset) });
  }
  return plan;
}

module.exports = {
  CLIP_STEP_SECONDS,
  SEGMENT_SECONDS,
  addSeconds,
  buildClipUrl,
  clock,
  clockAt,
  conferenceDate,
  instantAt,
  isValidStamp,
  parseClipUrl,
  rangeLabel,
  segmentPlan,
  stampDeadline
};
