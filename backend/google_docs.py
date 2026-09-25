"""
Sends the weekly schedule to a Google Apps Script Web App,
which creates or updates a **Google Doc** using **document tabs** (one nested tab per week).

The Apps Script Web App must be deployed with:
  - Execute as: Me (the script owner's Google account)
  - Who has access: Anyone

The Web App URL is stored in .env (APPS_SCRIPT_URL) and treated as a secret.

Note on redirects:
  Apps Script Web Apps respond to POST with a 302 redirect; httpx uses
  follow_redirects=True so the final JSON body is readable.

Reliability:
  - Longer connect timeout, HTTP/1.1 only (http2=False), and a few retries
    help with flaky networks and cold Apps Script starts.
"""

# WHAT THIS FILE IS: the "mail carrier" between AutoPlanner and Google.
# This server cannot write Google Docs by itself. Instead, a small Google program called an
# Apps Script (the code in apps_script/Code.gs) lives in a Google account and does the writing.
# That script has its own private web address. This file packs up one student's weekly
# schedule, sends it to that address, and waits for the reply: a link to the student's
# Google Doc and the Doc's ID number.
# main.py calls this file when staff click "Create / Update Google Doc" on the web page, and
# passes the reply back to the page.
#
# Bring in the tools this file needs: asyncio lets us pause between retries without freezing
# the server, and httpx sends web requests.
import asyncio
from typing import Any, Optional

import httpx


# Send one student's schedule to the Apps Script and get back their Google Doc.
# It is given the Apps Script's web address and the schedule (plus the student's name and,
# if they already have one, their existing Doc's ID). It gives back the Doc's link and,
# usually, its ID. If Google can't be reached, it tries up to three times before giving up.
async def send_to_apps_script(script_url: str, weekly_data: dict[str, Any]) -> dict[str, Optional[str]]:
    """POST the weekly schedule JSON to the Apps Script Web App.

    Returns:
        dict with ``docUrl`` and usually ``documentId``.

    Raises:
        httpx.HTTPStatusError: If Apps Script returns a non-2xx status.
        ValueError: If the response JSON is missing ``docUrl`` or contains ``error``.
    """
    # Trim stray spaces from the address. If nothing is left, stop with a clear error.
    script_url = (script_url or "").strip()
    if not script_url:
        raise ValueError("APPS_SCRIPT_URL is empty after trim.")

    # How long to wait: up to 30 seconds to connect to Google, and up to 2 minutes overall.
    # Writing a whole Doc can take a while, and the script can be slow to "wake up" if it
    # hasn't been used recently.
    timeout = httpx.Timeout(120.0, connect=30.0)

    # Try up to three times (attempts number 0, 1, and 2).
    for attempt in range(3):
        try:
            # Open a connection to Google.
            # "follow_redirects" matters: Google answers the first request by pointing to a
            # second address where the real reply waits, and we must follow it to read the reply.
            # "http2=False" uses the older, simpler way of talking to websites, which proved
            # more dependable with Apps Script.
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=True,
                http2=False,
            ) as client:
                # Send the schedule as JSON (a standard text format for passing organized
                # information between programs). The "User-Agent" line simply names this tool.
                # If Google answers with an error code, stop here; main.py reports it.
                response = await client.post(
                    script_url,
                    json=weekly_data,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "AutoPlanner/1.0 (+https://github.com)",
                    },
                )
                response.raise_for_status()

            # Read the Apps Script's reply.
            body: dict[str, Any] = response.json()

            # The Apps Script ran but reported a problem (for example, it couldn't open the Doc).
            # Pass its message along.
            if body.get("error"):
                raise ValueError(str(body["error"]))

            # A successful reply must include a link to the Doc. If it doesn't, something
            # went wrong, so report the whole reply to help with troubleshooting.
            doc_url = body.get("docUrl")
            if not doc_url:
                raise ValueError(
                    f"Apps Script response missing 'docUrl'. Full response: {body}"
                )

            # Build the answer: the Doc's link, plus its ID number if the script sent one.
            # "spreadsheetId" is an older name from when the planner was a Google Sheet.
            # The web page saves this ID so it updates the same Doc next time.
            out: dict[str, Optional[str]] = {"docUrl": doc_url}
            did = body.get("documentId") or body.get("spreadsheetId")
            if did:
                out["documentId"] = str(did)
            return out

        # Google couldn't be reached, or took too long. On the first two tries, wait a moment
        # (2 seconds, then 4 seconds) and try again, since the problem is often a brief network
        # hiccup. On the third failure, give up and let main.py report the error.
        # Other problems (an error code or a bad reply from Google) are not retried.
        except httpx.RequestError as exc:
            if attempt < 2:
                await asyncio.sleep(2.0 * (attempt + 1))
                continue
            raise
