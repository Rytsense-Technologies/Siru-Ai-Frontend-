// Untrusted values - catalog names and ids, image addresses, the model's text,
// anything a server or a merchant supplied - are DATA. They go into the page
// with textContent, setAttribute or a DOM property (img.src = safeImageUrl(..)),
// never pasted into an HTML string.
//
// escapeHtml is for the few HTML strings that remain: its output is safe in
// element text and inside a QUOTED attribute value (" or '). It is not a URL,
// style or script sanitizer - use safeImageUrl for addresses.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, ch => HTML_ESCAPES[ch]);
}

const SAFE_IMAGE_FALLBACK = 'images/medicine.svg';

// An image address from data: an http(s) URL, or a path on this site. Anything
// else - javascript:, data:, vbscript:, file:, a URL with credentials, raw
// quotes/brackets/spaces or control characters, one that doesn't parse -
// becomes `fallback`.
function safeImageUrl(value, fallback = SAFE_IMAGE_FALLBACK) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  // Characters a real address carries only percent-encoded: not an image address.
  // eslint-disable-next-line no-control-regex
  if (!text || /[\u0000-\u001f\u007f"'<>`\s]/.test(text)) return fallback;
  let url;
  try {
    url = new URL(text, document.baseURI);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
  if (url.username || url.password) return fallback;
  return url.href;
}

// <img> for a data-supplied address: always through safeImageUrl, and the
// placeholder if the address fails to load.
function safeImage(src, { alt = '', width, height, fallback = SAFE_IMAGE_FALLBACK } = {}) {
  const img = document.createElement('img');
  img.alt = alt;
  if (width) img.width = width;
  if (height) img.height = height;
  img.src = safeImageUrl(src, fallback);
  img.addEventListener('error', () => {
    const placeholder = safeImageUrl(fallback, SAFE_IMAGE_FALLBACK);
    if (img.src !== placeholder) img.src = placeholder;
  }, { once: true });
  return img;
}

if (typeof module !== 'undefined') module.exports = { escapeHtml, safeImageUrl, safeImage, SAFE_IMAGE_FALLBACK };
