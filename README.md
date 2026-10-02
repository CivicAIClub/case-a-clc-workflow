# Case A — AutoPlanner (CLC Workflow Automation)

| | |
|---|---|
| **Client** | Supported Study Hall staff at the Center for Learning and Collaboration (CLC), Pomfret School |
| **Developers** | Luke Ryan, Jack Weinberg |
| **Club lead** | Cayden Auyang |
| **Status** | 🟢 Multi-student UI, per-student Google Docs with By Class / By Day tables, frontend deployed to GitHub Pages |
| **Live frontend** | https://civicaiclub.github.io/case-a-clc-workflow/ (static page only; it needs a hosted backend, see step 6) |

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
├── .cursor/rules/         Committed Cursor rules for this repo (nothing to paste into your IDE)
└── .github/workflows/     Deploys frontend/ to GitHub Pages on every push to main
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
4. **Deploy → New deployment** → type **Web app** → Execute as **Me** → Who has access **Anyone** → **Deploy**, authorize, and copy the **Web App URL** (ends in `/exec`).

After any later change to `Code.gs`, redeploy a **new version** (Manage deployments → ✏️ → New version). The URL stays the same.

### 3. Configure the backend

```bash
cp backend/.env.example backend/.env
```

Open `backend/.env` and fill in:

| Variable | Required | What it is |
|---|---|---|
| `APPS_SCRIPT_URL` | yes | Web App URL from step 2 |
| `TIMEZONE` | yes | IANA timezone for due dates and week grouping, e.g. `America/New_York` |
| `CANVAS_API_TOKEN` | no | Fallback token, used only if the UI does not send a per-student token |
| `CANVAS_BASE_URL` | no | Fallback Canvas URL (the UI sends `canvas_base_url` too) |

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

Tokens and Doc IDs are stored in the browser's localStorage, not on the server.

### 6. Public site (GitHub Pages) + hosted API

The frontend is static; GitHub Pages cannot run Python.

1. **Frontend:** `.github/workflows/deploy-pages.yml` publishes `frontend/` to the `gh-pages` branch on every push to `main` (or run it manually from the Actions tab). The site is at https://civicaiclub.github.io/case-a-clc-workflow/.
2. **Backend:** deploy the FastAPI app somewhere with HTTPS (Render, Railway, Fly.io, a school server). Set `APPS_SCRIPT_URL` and `TIMEZONE` in that host's environment. Browsers may only call it from the origins in `ALLOWED_ORIGINS` (default: `https://civicaiclub.github.io`, `http://127.0.0.1:8000`, `http://localhost:8000`); add others there, comma-separated. CORS doesn't stop non-browser clients, so a publicly hosted backend also needs its own access check.
3. On the public site, set **AutoPlanner API URL** to your backend's base URL (no trailing slash required). Everything else works as in step 5.

## Getting a Canvas API token (for each student)

1. Log into Canvas → profile picture → **Settings**.
2. Scroll to **Approved Integrations** → **+ New Access Token**.
3. Purpose: "AutoPlanner"; leave expiry blank for dev use.
4. Copy the token immediately (Canvas will not show it again) and paste it into the student's row in AutoPlanner.

## Working on this repo

- Branch from `main` as `feature/<short-description>`, `fix/<short-description>`, or `chore/<short-description>` (lowercase, hyphens).
- Every change goes through a pull request with at least one approval. `main` cannot be pushed to directly.
- Never commit secrets. `.env` is ignored; `.env.example` holds only placeholders.
- Cursor rules for this project are committed in `.cursor/rules/`. You do not need to paste anything into your IDE settings.
- The full Git walkthrough for beginners is the club's **[Developer Onboarding Guide](https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md)**.

## History

This repository was split out of the club monorepo (`CivicAIClub/Civic-AI-Github-Repository`, `projects/case-a-clc-workflow/`) on 2026-09-18 with full history preserved.
