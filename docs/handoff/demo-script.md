# AutoPlanner handoff demo (6 minutes)

For the Civic AI Club team presenting AutoPlanner to the CLC staff. Two roles: the **Presenter** talks, the **Driver** clicks. Use only a club member's own Canvas token; no real student data on screen.

## Before the meeting

- [ ] **15 minutes before:** open https://civicaiclub.github.io/case-a-clc-workflow/ on the demo laptop. This wakes the server. Click **Fetch all students** again 5 minutes before you start, so it doesn't fall back asleep.
- [ ] The demo student (your own token) is **already added**. Never paste a token while the projector is on.
- [ ] Your Doc **already exists**, so the live step is an update, not a create.
- [ ] Open tabs, in order: AutoPlanner, the Drive folder **AutoPlanner – CLC Student Planners**, your Doc.
- [ ] Print the [quick start](CLC-quick-start.md) for each staff member and a stack of [student token guides](student-token-guide.md).
- [ ] Notifications off, browser zoomed to 125%, other tabs closed.

## The script

**0:00–0:45 The problem** (Presenter)
"Today you log in to each student's Canvas and copy assignments into a Google Doc by hand. AutoPlanner does that copying for you: one Doc per student, refreshed whenever you click Update."

**0:45–1:30 One link** (Driver shows the page)
"This is the only link you need; bookmark it. There's nothing to set up: the server and our Canvas address are already filled in."

**1:30–2:30 Students and Fetch** (Driver clicks **Fetch all students**)
"Each student gives you a token from Canvas Settings; this sheet shows them how. You paste it here once. Fetch pulls the next four weeks for everyone." Show the student's tab: assignments by day, with priorities.

**2:30–3:45 The Doc** (Driver clicks **Update Google Doc**, then opens the Doc)
While it runs (about 30 seconds): "It's writing straight into a Google Doc in your shared folder." In the Doc, open the **Document tabs** sidebar: one tab per week, a **By Class** table and a **By Day** table.

**3:45–4:45 Status and Notes survive** (Driver)
Type "✅ Complete" in one Status cell and "Ask about the lab report" in its Notes cell. Back in AutoPlanner, click **Update Google Doc** again, then show both are still there. "Assignments refresh from Canvas, but your Status and Notes are never lost."

**4:45–5:30 Three things to know** (Presenter)
1. "The Docs live in this Drive folder, already shared with all four of you."
2. "Use one computer and one browser. AutoPlanner remembers students on that computer only."
3. "The timer only runs while this page is open. When in doubt, click Update all."

**5:30–6:00 Hand over** (Presenter)
Hand out the quick start and token guides. "If anything looks wrong, email us a screenshot of the message." Take questions.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| "Waking up the server…" | The server was asleep (no use for 15 minutes). | Wait up to a minute. It continues by itself. |
| "Could not reach the AutoPlanner server…" | It didn't wake within 90 seconds, or the hosting service is down. | Wait a minute and click again. Club: check the backend's `/health` page and the Render dashboard. |
| A red tab: "Canvas API returned an error: HTTP 401 … Invalid access token" | That student's token expired, was deleted, or was pasted incompletely. | Ask the student for a new token and paste it over the old one. |
| "Could not reach Canvas at …" | The Canvas base URL is wrong. | Set it to `https://pomfret.instructure.com`. |
| "Quota exceeded", "RESOURCE_EXHAUSTED" or "429" | Google limits how fast one account can edit Docs. AutoPlanner already slows down and retries. | Wait 2–3 minutes, then update students one at a time. Don't click Update repeatedly. |
| "Unauthorized: the secret … does not match" | The server and the Apps Script have different secrets. | Club: make `APPS_SCRIPT_SECRET` in Render match the Script Property. |
| "AutoPlanner only updates Docs in the … folder, and this student's Doc is not in it" | That student's Doc was moved out of the shared folder. | Move it back into **AutoPlanner – CLC Student Planners** and click Update again. |
| "DOCS_FOLDER_ID is set, but this account cannot open that Drive folder" | The shared folder was deleted, moved, or unshared from the account that runs the script. | Club: fix the folder or the `DOCS_FOLDER_ID` Script Property. |
| Two Docs for one student | The student was added on a second computer, or the browser's data was cleared. | Keep the Doc with the Status/Notes, delete the other, and stick to one computer. |
| The schedule didn't run | The page was closed or the computer was asleep at that time. | Click **Update all students' Docs**. |
