// Public runtime configuration - the ONE place the backend's address is set.
// Everything here is sent to every browser: never put a key, password or
// token in this file.
//
//   apiBaseUrl  the backend (FastAPI) origin. Empty = the address saved under
//               "Server settings" on the sign-in page, else http://<this host>:8010
//               - the local API.
window.SIRU_CONFIG = Object.freeze({
  apiBaseUrl: '',
});
