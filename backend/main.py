"""
AutoPlanner — FastAPI application.

Routes:
  GET  /api/assignments     Fetch and return processed weekly schedule from Canvas
  POST /api/generate-doc    Call Apps Script to create/update a Google Doc (nested document tabs per week)
  GET  /health              Health check

Run locally (from the repo root, so `backend` resolves as a package):
  uvicorn backend.main:app --reload
  Open http://127.0.0.1:8000/ — the UI is served from the same server as the API.

You can still open frontend/index.html directly; set “AutoPlanner API URL” to http://127.0.0.1:8000 if fetch fails.

The Canvas API token, Canvas base URL, Apps Script URL, and timezone are all
read from a .env file in the backend/ directory. Copy .env.example to .env
and fill in the values before running.
"""

# WHAT THIS FILE IS: the "front desk" of the AutoPlanner server (the backend).
# A server is a program that sits and waits for requests, then answers them.
# CLC staff open the AutoPlanner web page (frontend/index.html) in their browser. When they click
# buttons on that page, the page sends requests here, and this file decides what to do.
# It offers two main jobs:
#   1. "Get this student's assignments": it asks Canvas (the school's online class system) using
#      canvas_api.py, then tidies the list into weeks and days using processor.py.
#   2. "Make or update this student's Google Doc": it passes that schedule to google_docs.py, which
#      sends it to the Google Apps Script web app (apps_script/Code.gs) that writes the planner Doc.
# It also hands out the web page itself, so staff can open the tool from this same address.
#
# Bring in the tools this file needs: some built into Python, some installed add-ons
# (FastAPI runs the web server, httpx talks to other websites, dotenv reads the settings file),
# and the three helper files from this same backend folder.
import asyncio
import os
from pathlib import Path
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from backend.canvas_api import get_all_assignments, get_self_profile
from backend.google_docs import send_to_apps_script
from backend.processor import build_weekly_schedule

# Load .env from the backend/ directory regardless of where uvicorn is invoked from.
# Running `uvicorn backend.main:app` from case-a-clc-workflow/ means the working
# directory is case-a-clc-workflow/, not backend/ — so we resolve the path explicitly.
# (The .env file is a private settings file kept only on the server computer. It holds things
# like the Apps Script web address and the school's time zone. "override=True" means the values
# in that file win over any settings with the same name that the computer already had.)
load_dotenv(Path(__file__).parent / ".env", override=True)

# Create the web server itself and give it a name and version number.
# Everything below attaches "routes" to it: web addresses it knows how to answer.
app = FastAPI(title="AutoPlanner API", version="1.0.0")

# Allow all origins for local development.
# In production, restrict to your specific frontend origin.
# Browsers normally refuse to let a web page on one website talk to a server on a different
# website. This setting (called CORS) tells browsers "any website may call this server".
# It is needed because the public page lives on GitHub Pages while this server lives elsewhere.
# Only reading (GET) and sending (POST) requests are allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# Small helper: look up one setting (by its name, such as "APPS_SCRIPT_URL") from the server's
# settings and hand back its value. If the setting is missing or blank, stop right away and send
# the web page a clear error saying the server was not set up correctly and how to fix it.
# (Error code 500 means "something is wrong on the server's side, not the visitor's.")
def _get_env(key: str) -> str:
    """Return a required environment variable or raise a clear HTTP 500."""
    value = os.getenv(key)
    if not value:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Server misconfiguration: environment variable '{key}' is not set. "
                f"Copy backend/.env.example to backend/.env and fill in all values."
            ),
        )
    return value


# ---------------------------------------------------------------------------
# GET /api/assignments
# ---------------------------------------------------------------------------

# JOB 1: fetch one student's assignments.
# The web page calls this address once per student when staff click "Fetch all students".
# It is given:
#   - weeks_ahead: how many calendar weeks to include, counting this week (1 to 12, default 2)
#   - canvas_token: that student's Canvas token (a long secret password the student made in
#     Canvas that lets this tool read their classes and assignments on their behalf)
#   - canvas_base_url: the school's Canvas web address, e.g. https://yourschool.instructure.com
# It gives back the student's schedule, grouped by week and then by day, plus the student's name
# and their Canvas ID number.
@app.get("/api/assignments", summary="Fetch and process Canvas assignments")
async def get_assignments(
    weeks_ahead: int = Query(2, ge=1, le=12, description="Calendar weeks from this Monday"),
    canvas_token: Optional[str] = None,
    canvas_base_url: Optional[str] = None,
) -> dict[str, Any]:
    """Fetch all upcoming assignments from Canvas, normalize them, and return
    a structured weekly schedule grouped Mon–Sun.

    Query params:
      weeks_ahead (int, default 2): how many weeks forward to include
      canvas_token (str, optional): Canvas API token — overrides CANVAS_API_TOKEN in .env
      canvas_base_url (str, optional): Canvas base URL — overrides CANVAS_BASE_URL in .env

    Credentials passed as query params take priority over .env so the frontend
    UI works without any .env Canvas config.
    """
    # Use the token and Canvas address the web page sent. If the page did not send them,
    # fall back to backup values in the server's settings file (and error if those are missing).
    # The time zone always comes from the settings file; if it is missing, use US Eastern time.
    token = canvas_token or _get_env("CANVAS_API_TOKEN")
    base_url = canvas_base_url or _get_env("CANVAS_BASE_URL")
    timezone_name = os.getenv("TIMEZONE", "America/New_York")

    # Ask Canvas for two things: every assignment in the student's current classes,
    # and the student's own profile (their name and Canvas ID number).
    try:
        # canvas_api.py uses synchronous httpx to keep it simple and testable.
        # asyncio.to_thread offloads it to a thread pool so we never block
        # FastAPI's async event loop.
        # In plain words: talking to Canvas can take several seconds. Doing it "on the side"
        # lets the server keep answering other requests meanwhile, which matters because the
        # page asks for every student at the same time.
        def _fetch_canvas():
            pairs = get_all_assignments(token, base_url)
            profile = get_self_profile(token, base_url)
            return pairs, profile

        raw_pairs, profile = await asyncio.to_thread(_fetch_canvas)
    # Canvas answered, but with an error (for example, the token is wrong or expired).
    # Pass along Canvas's error code and the first 200 characters of its message.
    # (Error code 502 means "a service this server depends on had a problem.")
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Canvas API returned an error: "
                f"HTTP {exc.response.status_code} — {exc.response.text[:200]}"
            ),
        )
    # Canvas could not be reached at all (wrong address, no internet, or it took too long).
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach Canvas at {base_url}: {exc}",
        )

    # Hand the raw Canvas list to processor.py, which drops past-due and undated work,
    # keeps only the requested weeks, and sorts everything into weeks and days.
    schedule = build_weekly_schedule(raw_pairs, timezone_name, weeks_ahead)
    # Pick the student's name for the Doc title: their full Canvas name, or their short name,
    # or simply "Student" if Canvas gave neither.
    display_name = (
        (profile.get("name") or profile.get("short_name") or "Student") or "Student"
    )
    schedule["student_full_name"] = str(display_name).strip() or "Student"
    # Stable id for the token holder — used by the frontend to reuse the same Google Doc
    # across roster edits and browsers (per Canvas user), not the ephemeral UI row id.
    cid = profile.get("id")
    if cid is not None:
        schedule["canvas_user_id"] = cid
    # Send the finished schedule back to the web page, which shows it on that student's tab.
    return schedule


# ---------------------------------------------------------------------------
# POST /api/generate-doc
# ---------------------------------------------------------------------------

# This describes the exact shape of the information the web page must send when asking for a
# Google Doc. The server checks each incoming request against it and rejects anything that
# doesn't fit (for example, if the list of weeks is missing).
# Any extra pieces the page sends (such as the Canvas ID number) are quietly ignored.
class GenerateDocRequest(BaseModel):
    """Schedule payload plus optional existing Google Doc to update."""

    # Let each field below be filled in using either its Python name or its alternate name.
    model_config = ConfigDict(populate_by_name=True)

    # The three required pieces: the schedule grouped by week, how many assignments it holds,
    # and the date and time the schedule was built. These come straight from JOB 1's answer.
    weeks: dict[str, Any]
    total_assignments: int
    generated_at: str
    # Optional: the student's name, used to title the Google Doc.
    # The page may send it spelled "student_full_name" or "studentFullName"; either is accepted.
    # When passed on to Apps Script, it is always spelled "studentFullName".
    student_full_name: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("student_full_name", "studentFullName"),
        serialization_alias="studentFullName",
        description="From Canvas profile; used for the Google Doc title.",
    )
    # Optional: the ID of this student's existing Google Doc, if one was made before.
    # With it, Apps Script updates that same Doc instead of making a new one.
    # "spreadsheetId" is an older name from when the planner was a Google Sheet; it still works.
    document_id: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("documentId", "spreadsheetId"),
        serialization_alias="documentId",
        description="If set, add/update week tabs inside this Doc instead of creating a new file.",
    )


# JOB 2: create or update one student's Google Doc planner.
# The web page calls this when staff click "Create / Update Google Doc" for a student.
# It is given that student's schedule (the answer from JOB 1), plus their existing Doc's ID
# if there is one. It gives back a link to the Doc and the Doc's ID, which the web page
# saves in the browser so the next run updates the same Doc.
@app.post("/api/generate-doc", summary="Create or update Google Doc via Apps Script")
async def generate_doc(body: GenerateDocRequest) -> dict[str, Optional[str]]:
    """Send the weekly schedule to Apps Script, which writes **Google Docs**
    with nested **document tabs** (one tab per calendar week under ``CLC Planner``).
    Pass ``documentId`` from a prior response to reuse the same file.

    Returns:
      ``docUrl``, ``documentId`` (for localStorage / next requests).
    """
    # Look up the web address of the Google Apps Script helper from the settings file,
    # trimming off any stray spaces.
    script_url = _get_env("APPS_SCRIPT_URL").strip()

    # Pass the schedule to google_docs.py, which sends it to Apps Script and waits for the Doc.
    # "by_alias" uses the names Apps Script expects (e.g. "documentId"), and "exclude_none"
    # leaves out optional pieces that are empty, such as the Doc ID for a brand-new student.
    try:
        result = await send_to_apps_script(
            script_url, body.model_dump(by_alias=True, exclude_none=True)
        )
    # Apps Script answered with an error code. Pass it along with the first 200 characters.
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Apps Script returned an error: "
                f"HTTP {exc.response.status_code} — {exc.response.text[:200]}"
            ),
        )
    # Apps Script could not be reached at all, even after retrying. The message lists the
    # usual causes so whoever set up the server knows what to check.
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not reach Apps Script Web App: {exc}. "
                "Check APPS_SCRIPT_URL in backend/.env matches Deploy → Manage deployments "
                "(ends with /exec), deployment access is “Anyone”, no VPN/firewall blocking "
                "script.google.com, then restart uvicorn."
            ),
        )
    # Apps Script replied, but reported a problem of its own or left out the Doc link.
    # Pass its message straight to the web page.
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Success: send the Doc link and Doc ID back to the web page.
    return result


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------

# A simple "are you awake?" check. Visiting /health just answers "ok", which lets a person
# or a hosting service confirm the server is running without touching Canvas or Google.
@app.get("/health", summary="Health check")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# Serve the static frontend from the same origin as the API (avoids file:// + fetch issues).
# In plain words: find the frontend folder next to this backend folder and, if it exists, show
# its web page (index.html) to anyone who visits the server's main address.
# This must come last: it answers every address not already claimed above, so if it came first
# it would swallow requests meant for /api/assignments and the others.
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if _FRONTEND_DIR.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(_FRONTEND_DIR), html=True),
        name="frontend",
    )
