# Siru AI - frontend

The Siru web app: plain HTML, CSS and JavaScript - no framework, no bundler,
no npm dependencies. It talks only to the Siru backend API
(**Siru-ai-service**, a separate repository, run locally); it never
connects to a database, Redis or any AI provider itself, and holds no
secret. Voice goes through LiveKit with a short-lived room token the backend
issues (`POST /v1/voice/token`); the LiveKit browser SDK is loaded from
jsDelivr.

## The backend address - `config.js`

`config.js` is the one place the backend's address is set:

| Where | `apiBaseUrl` | Result |
|---|---|---|
| local development | `''` (as committed) | the address saved under **Server settings** on the sign-in page, else `http://<this host>:8010` |

Only public values belong in `config.js` - every browser downloads it.

## Local development

Start the backend (Siru-ai-service) on port 8010, then from this folder:

```bash
python dev/serve.py --port 5500
```

Open <http://localhost:5500>. `--bind 0.0.0.0` serves it to the LAN (add the
page's origin to the backend's `CORS_ALLOW_ORIGINS`). `dev/serve.py` is a
development convenience only: like `python -m http.server`, but with
`Cache-Control: no-cache` so edits show up on a normal reload, and it never
serves dotfiles or `dev/`. Its test:

```bash
python -m unittest discover -s dev -p "test_*.py"
```

`images/generate.py` regenerates the product illustrations (development only).

