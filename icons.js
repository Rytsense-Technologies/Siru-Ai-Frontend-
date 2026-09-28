// Line icons (24x24, drawn in currentColor) - instead of emoji, which render
// differently on every platform. icon('bell') returns an <svg>; markup uses
// <span class="icon" data-icon="bell"></span>, filled in by iconsHydrate().
const ICON_PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  package: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
  'mic-off': '<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V5a3 3 0 0 0-5.9-.6"/><path d="M17 16.9A7 7 0 0 1 5 11v-1M19 10v1a7 7 0 0 1-.1 1.2M12 18v4"/>',
  paperclip: '<path d="M21.4 11.1l-9.2 9.1a6 6 0 0 1-8.5-8.5l9.2-9.1a4 4 0 0 1 5.7 5.6l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  bag: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  store: '<path d="M3 9l1.5-5h15L21 9M4 9v11h16V9M3 9h18M9 20v-6h6v6"/>',
  doctor: '<path d="M6 3v5a4 4 0 0 0 8 0V3"/><path d="M10 12v2a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="10" r="2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  memory: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
};

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon-svg ${className}`.trim());
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

// <span data-icon="name"> placeholders, and later ones added by script.
function iconsHydrate(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => {
    const name = node.dataset.icon;
    if (node.dataset.iconDone === name) return;
    node.replaceChildren(icon(name));
    node.dataset.iconDone = name;
  });
}

// Swap an icon placeholder to another icon (mic -> mic-off, ...).
function iconSet(node, name) {
  if (!node) return;
  node.dataset.icon = name;
  iconsHydrate(node.parentNode || document);
}

iconsHydrate();
