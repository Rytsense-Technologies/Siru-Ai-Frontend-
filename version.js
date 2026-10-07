// Which frontend build this page is running, and whether a newer one has been deployed since it loaded.
//
// FRONTEND_BUILD is the asset version this page's own scripts were loaded with (index.html's ?v=) - the code
// actually running, not a guess. The Inspector shows it beside the backend's build (GET /version), so two
// laptops can prove they run the same thing (production, 7 Oct: "the same URL behaves differently").
//
// A tab left open across a deployment keeps running the old scripts. When the deployed index.html names a
// newer version, a banner says so and offers a reload - never a reload on its own in the middle of a chat.
const FRONTEND_BUILD = (() => {
  try { return new URL(document.currentScript.src).searchParams.get('v') || 'unknown'; }
  catch { return 'unknown'; }
})();

async function frontendLatestBuild() {
  try {
    const res = await fetch(`/index.html?check=${Date.now()}`, {cache: 'no-store'});
    if (!res.ok) return null;
    const found = (await res.text()).match(/version\.js\?v=([^"'&]+)/);
    return found ? found[1] : null;
  } catch {
    return null;  // offline or blocked: nothing is claimed either way
  }
}

async function frontendCheckBuild() {
  const latest = await frontendLatestBuild();
  if (!latest || latest === FRONTEND_BUILD || document.getElementById('buildBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'buildBanner';
  banner.setAttribute('role', 'status');
  banner.className = 'build-banner';
  banner.textContent = 'A newer version of Siru is available. ';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'link-btn';
  reload.textContent = 'Reload';
  reload.onclick = () => location.reload();
  banner.append(reload);
  document.body.prepend(banner);
}

// On load, when the tab comes back into view, and every 10 minutes while open.
window.addEventListener('load', () => { frontendCheckBuild(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') frontendCheckBuild(); });
setInterval(frontendCheckBuild, 10 * 60 * 1000);
