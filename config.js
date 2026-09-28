// Public runtime configuration - the ONE place the backend's address is set.
// Everything here is sent to every browser: never put a key, password or
// token in this file.
//
//   apiBaseUrl  the backend (FastAPI) origin, e.g. https://<service>.onrender.com
//               Empty = local development: the address saved under "Server
//               settings" on the sign-in page, else http://<this host>:8010.
//
// On Vercel this file is regenerated at build time from the project's
// PUBLIC_API_BASE_URL environment variable (scripts/write-config.mjs);
// the copy in the repository is the local-development one.
window.SIRU_CONFIG = Object.freeze({
  apiBaseUrl: '',
});
