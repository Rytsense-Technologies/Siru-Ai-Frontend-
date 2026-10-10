// The full stack for the end-to-end tests: the REAL backend API (FastAPI, its
// real routes, auth, graph, databases) and this frontend's static server -
// nothing mocked. Playwright's globalSetup starts both and writes what the
// tests need (URLs, the two throwaway accounts) to test-results/e2e-stack.json.
//
//   SIRU_BACKEND_DIR   the backend checkout (default ../voice_to_voice-medical-flow)
//   SIRU_PYTHON        its Python (default <backend>/.venv/Scripts/python.exe or python)
//   E2E_API_PORT / E2E_WEB_PORT   (default 8020 / 5520)
//   E2E_EXTERNAL=1     use a stack that is already running instead
//                      (E2E_API_URL, E2E_WEB_URL, E2E_ACCOUNTS=<json file>)
//
// The accounts are made for this run only: two buyers with random passwords,
// hashed by the backend's own passwords.hash_password, handed to the API as
// TEST_USER_* (development-only accounts) in ITS environment - never written
// to any .env. The API's database, Redis, LiveKit and model settings are the
// backend's own (.env / the environment): USER_SERVICE_MODE=sandbox in CI (the
// throwaway Postgres), readonly locally (the client RDS, read only).
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.resolve(__dirname, '..', '..');
const OUT = path.join(FRONTEND, 'test-results', 'e2e-stack.json');

function backendDir() {
  if (process.env.SIRU_BACKEND_DIR) return path.resolve(process.env.SIRU_BACKEND_DIR);
  // The backend checkout beside this one (its current name first, then the older one).
  const beside = ['Siru-Ai-Backend', 'voice_to_voice-medical-flow'].map(name => path.join(FRONTEND, '..', name));
  return beside.find(dir => fs.existsSync(dir)) || beside[0];
}

function python(backend) {
  if (process.env.SIRU_PYTHON) return process.env.SIRU_PYTHON;
  const venv = path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return fs.existsSync(venv) ? venv : 'python';
}

// node:http, not fetch: Node's fetch (undici) asserts and crashes on the
// Python dev server's HTTP/1.0 connection close.
function get(url) {
  const http = require('node:http');
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => { response.resume(); resolve(response.statusCode); });
    request.setTimeout(3000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function waitFor(url, seconds) {
  const until = Date.now() + seconds * 1000;
  let last = '';
  while (Date.now() < until) {
    try {
      const status = await get(url);
      if (status >= 200 && status < 300) return;
      last = `HTTP ${status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not come up in ${seconds}s (${last})`);
}

function accounts(py, backend) {
  const made = ['a', 'b'].map(tag => ({
    email: `e2e-${tag}-${crypto.randomBytes(4).toString('hex')}@siru.test`,
    password: crypto.randomBytes(18).toString('base64url'),
    name: `E2E Buyer ${tag.toUpperCase()}`,
  }));
  const hashes = execFileSync(py, ['-c',
    'import sys, json; from multi_agent_framework.api.passwords import hash_password; '
    + 'print(json.dumps([hash_password(p) for p in json.load(sys.stdin)]))'],
  { cwd: backend, input: JSON.stringify(made.map(a => a.password)), encoding: 'utf8' });
  JSON.parse(hashes).forEach((hash, i) => { made[i].hash = hash; });
  return made;
}

module.exports = async function globalSetup() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (process.env.E2E_EXTERNAL === '1') {
    const stack = {
      api: process.env.E2E_API_URL, web: process.env.E2E_WEB_URL,
      accounts: JSON.parse(fs.readFileSync(process.env.E2E_ACCOUNTS, 'utf8')), external: true,
    };
    await waitFor(`${stack.api}/healthz`, 30);
    await waitFor(`${stack.web}/index.html`, 30);
    fs.writeFileSync(OUT, JSON.stringify(stack));
    return async () => {};
  }
  const backend = backendDir();
  const py = python(backend);
  const apiPort = Number(process.env.E2E_API_PORT || 8020);
  const webPort = Number(process.env.E2E_WEB_PORT || 5520);
  const web = `http://127.0.0.1:${webPort}`;
  const api = `http://127.0.0.1:${apiPort}`;
  const made = accounts(py, backend);
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
    ENVIRONMENT: process.env.ENVIRONMENT || 'dev',
    AUTH_MODE: 'jwt',
    AUTH_JWT_SECRET: crypto.randomBytes(36).toString('base64url'),
    // Only this run's two accounts sign in (the development test-account list).
    LOGIN_EMAIL: '', LOGIN_PASSWORD_HASH: '',
    TEST_USER_EMAILS: made.map(a => a.email).join(','),
    TEST_USER_PASSWORD_HASHES: made.map(a => a.hash).join(','),
    TEST_USER_NAMES: made.map(a => a.name).join(','),
    CORS_ALLOW_ORIGINS: JSON.stringify([web]),
  };
  const logs = fs.openSync(path.join(path.dirname(OUT), 'e2e-api.log'), 'w');
  // The backend's own development launcher (scripts/dev_start.py): it marks the launch as a local development
  // one, which the API requires before it accepts ENVIRONMENT=dev (CFG-01) - plain uvicorn is refused.
  // --loopback-db points the app database at this machine without changing the backend's .env.
  const apiProcess = spawn(py, ['scripts/dev_start.py', '--only', 'api', '--loopback-db', '--host', '127.0.0.1',
    '--port', String(apiPort)], { cwd: backend, env, stdio: ['ignore', logs, logs] });
  const webProcess = spawn(py, ['dev/serve.py', '--bind', '127.0.0.1', '--port', String(webPort)],
    { cwd: FRONTEND, stdio: 'ignore' });
  const stop = async () => { apiProcess.kill(); webProcess.kill(); };
  try {
    await waitFor(`${api}/healthz`, 90);
    await waitFor(`${web}/index.html`, 30);
  } catch (error) {
    await stop();
    throw error;
  }
  fs.writeFileSync(OUT, JSON.stringify({
    api, web, external: false,
    accounts: made.map(({ email, password, name }) => ({ email, password, name })),
  }));
  return stop;
};

module.exports.stack = () => JSON.parse(fs.readFileSync(OUT, 'utf8'));
