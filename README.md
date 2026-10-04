# Case A — AutoPlanner (CLC Workflow Automation)

| | |
|---|---|
| **Client** | Supported Study Hall staff at the Center for Learning and Collaboration (CLC), Pomfret School |
| **Developers** | Luke Ryan, Jack Weinberg |
| **Club lead** | Cayden Auyang |
| **Status** | 🟢 Multi-student UI, per-student Google Docs with By Class / By Day tables, frontend on GitHub Pages, backend on Render |
| **Live site** | https://civicaiclub.github.io/case-a-clc-workflow/ (talks to the hosted backend, see step 6) |
| **Staff guides** | [`docs/handoff/`](docs/handoff/): quick start for CLC staff, token guide for students, demo script |

## The problem

CLC staff spend hours each week logging into individual student Canvas accounts and transcribing assignment data into to-do lists in Google Docs.

## What AutoPlanner does

Teachers collect **each student's** Canvas API token, paste them into the UI (one row per student), fetch everyone's assignments in parallel, preview each schedule on a tab, and export a **separate Google Doc per student**. Each Doc has one nested document tab per week; the **Status** and **Notes** columns the teacher edits are preserved across re-runs (keyed by Canvas assignment URL).

## Stack

- **Backend:** Python 3.11+ / FastAPI (`backend/`). Talks to the Canvas REST API and to the Apps Script web app.
- **Frontend:** one static HTML page, no build step (`frontend/index.html`). Served by the backend locally, or by GitHub Pages.
- **Google Apps Script** web app that creates/updates the Google Doc via the Docs API (`apps_script/Code.gs`, manifest in `apps_script/appsscript.json`).

```
Frontend (index.html, static)
  → GET  /api/assignments (X-Canvas-Token header) → Canvas (per-student token from the teacher's UI)
  → POST /api/generate-doc                 → Apps Script → Google Doc (per student)
```

## Repository layout

```
case-a-clc-workflow/
├── backend/
│   ├── main.py            FastAPI routes; also serves frontend/ at /
│   ├── canvas_api.py      Canvas REST client (pagination handled)
│   ├── processor.py       Data normalization and weekly grouping
│   ├── google_docs.py     Apps Script HTTP client (retries, redirects)
│   ├── requirements.txt   Pinned Python dependencies
│   └── .env.example       Every environment variable, documented (copy to .env)
├── frontend/
│   ├── index.html         Single-page UI (no build step)
│   └── .nojekyll          Keeps GitHub Pages from running Jekyll
├── apps_script/
│   ├── Code.gs            Google Apps Script web app (paste into script.google.com)
│   └── appsscript.json    Apps Script manifest (Docs API advanced service + scopes)
├── docs/handoff/          Guides for CLC staff and students, plus the demo script
├── render.yaml            Render Blueprint: hosts the backend (step 6)
├── .cursor/rules/         Committed Cursor rules for this repo (nothing to paste into your IDE)
└── .github/workflows/     CI checks on every PR; deploys frontend/ to GitHub Pages on every push to main
```

## Setup from a fresh clone

### Prerequisites

- Python 3.11 or newer (`python3 --version`)
- A Google account to deploy the Apps Script
- A Canvas LMS account with API-token access (each student generates their own; see "Getting a Canvas API token" below)

### 1. Clone

```bash
git clone https://github.com/CivicAIClub/case-a-clc-workflow.git
cd case-a-clc-workflow
```

### 2. Deploy the Google Apps Script

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the default `myFunction` and paste the entire contents of `apps_script/Code.gs`.
3. **Services (+)** → add **Google Docs API** (or paste `apps_script/appsscript.json` into the manifest via Project Settings → "Show appsscript.json").
4. **Project Settings (⚙)** → **Script Properties** → add the optional properties below.
5. Select the function **`checkSetup`** in the toolbar → **Run**, authorize, and read the log. It confirms the folder and secret settings.
6. **Deploy → New deployment** → type **Web app** → Execute as **Me** → Who has access **Anyone** → **Deploy**, authorize, and copy the **Web App URL** (ends in `/exec`).

The script runs as the account that deployed it, so the Docs are owned by that account.

| Script Property | Required | What it does |
|---|---|---|
| `DOCS_FOLDER_ID` | no, but set it for any hosted backend | ID (or URL) of a Drive folder. New student Docs are created there, so everyone the folder is shared with can open them. Docs that already exist stay where they are. While it's set, the script **only updates Docs inside this folder**, so a request can't change any other Doc the deploying account can edit. Unset: new Docs go to the deployer's My Drive and any Doc ID is accepted. |
| `APPS_SCRIPT_SECRET` | no, but set it for any hosted backend | Shared secret. When set, the script rejects requests that don't carry the same value, which the backend sends from its `APPS_SCRIPT_SECRET` env var. Unset: every request is accepted. |

After any later change to `Code.gs`, redeploy a **new version** (Manage deployments → ✏️ → Version: **New version** → Deploy). The URL stays the same. Script Properties take effect immediately; they don't need a new version.

### 3. Configure the backend

```bash
cp backend/.env.example backend/.env
```

Open `backend/.env` and fill in:

| Variable | Required | What it is |
|---|---|---|
| `APPS_SCRIPT_URL` | yes | Web App URL from step 2 |
| `APPS_SCRIPT_SECRET` | if the Script Property is set | Same value as the `APPS_SCRIPT_SECRET` Script Property. Sent with every Apps Script call. |
| `TIMEZONE` | yes | IANA timezone for due dates and week grouping, e.g. `America/New_York` |
| `CANVAS_API_TOKEN` | no | Fallback token, used only if the UI does not send a per-student token |
| `CANVAS_BASE_URL` | no | Fallback Canvas URL (the UI sends `canvas_base_url` too) |
| `ALLOWED_ORIGINS` | no | Comma-separated sites whose pages may call the API from a browser. Default: the GitHub Pages site plus `http://127.0.0.1:8000` and `http://localhost:8000` |

`.env` is gitignored. Never commit it.

### 4. Install and run the backend

Run these **from the repo root** (the app is imported as `backend.main`):

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload
```

Check `http://127.0.0.1:8000/health` → `{"status":"ok"}`.

### 5. Use the app locally

Open **http://127.0.0.1:8000/**. The backend serves the frontend on the same origin, so leave **AutoPlanner API URL** blank. Set your school's **Canvas base URL** (e.g. `https://pomfret.instructure.com`), click **+ Add student**, paste each student's Canvas API token, then **Fetch all students**. Review each schedule on its tab and use **Create / Update Google Doc** per student.

Tokens and Doc IDs are stored in the browser's localStorage, not on the server. That means each browser has its own student list: a second computer doesn't know which Docs already exist and would create new ones.

**Auto-update schedule:** "Run at these times" only runs while the AutoPlanner page is open in a browser tab on a computer that's awake. A closed tab, a closed laptop or a sleeping computer skips the run. Nothing runs on the server by itself.

### 6. Public site (GitHub Pages) + hosted API (Render)

The frontend is static; GitHub Pages cannot run Python.

1. **Frontend:** `.github/workflows/deploy-pages.yml` publishes `frontend/` to the `gh-pages` branch on every push to `main` (or run it manually from the Actions tab). The site is at https://civicaiclub.github.io/case-a-clc-workflow/.
2. **Backend:** hosted on [Render](https://render.com)'s free plan from `render.yaml`:
   1. Sign in to Render with GitHub and give it access to `CivicAIClub/case-a-clc-workflow`.
   2. **New → Blueprint** → pick this repo. Render reads `render.yaml` and asks for the two secret values: `APPS_SCRIPT_URL` and `APPS_SCRIPT_SECRET`. `TIMEZONE`, `ALLOWED_ORIGINS` and `PYTHON_VERSION` come from the file.
   3. **Deploy Blueprint.** The service deploys from `main` and redeploys on every push to `main`. Change secrets later under the service's **Environment** tab.
   4. Check `https://<service>.onrender.com/health` returns `{"status":"ok"}`.
3. **Connect them:** set `DEFAULT_API_BASE` near the top of the `<script>` in `frontend/index.html` to the Render URL (no trailing slash). The public site then fills in **AutoPlanner API URL** by itself; staff can still change it.

Things to know about the hosted backend:

- **It sleeps.** A free Render service sleeps after 15 minutes without requests and takes about a minute to wake. The page pings `/health` when it opens and before each action, and shows "Waking up the server…" if the reply takes more than 3 seconds.
- **CORS:** browsers may only call it from the origins in `ALLOWED_ORIGINS` (`https://civicaiclub.github.io` on Render). CORS doesn't stop non-browser clients, so a publicly hosted backend also needs its own access check. `APPS_SCRIPT_SECRET` protects the Apps Script, not the backend.
- **Nothing is stored on the server.** Tokens and Doc IDs stay in the staff member's browser (see step 5).

## Getting a Canvas API token (for each student)

1. Log into Canvas → profile picture → **Settings**.
2. Scroll to **Approved Integrations** → **+ New Access Token**.
3. Purpose: "AutoPlanner"; leave expiry blank for dev use.
4. Copy the token immediately (Canvas will not show it again) and paste it into the student's row in AutoPlanner.

The student-facing version (expiry June 2027, give it only to CLC staff) is [`docs/handoff/student-token-guide.md`](docs/handoff/student-token-guide.md).

## Working on this repo

- Branch from `main` as `feature/<short-description>`, `fix/<short-description>`, or `chore/<short-description>` (lowercase, hyphens).
- Every change goes through a pull request with at least one approval. `main` cannot be pushed to directly.
- Never commit secrets. `.env` is ignored; `.env.example` holds only placeholders.
- Cursor rules for this project are committed in `.cursor/rules/`. You do not need to paste anything into your IDE settings.
- The full Git walkthrough for beginners is the club's **[Developer Onboarding Guide](https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md)**.

## History

This repository was split out of the club monorepo (`CivicAIClub/Civic-AI-Github-Repository`, `projects/case-a-clc-workflow/`) on 2026-09-18 with full history preserved.
