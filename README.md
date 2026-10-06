# Case A — AutoPlanner (CLC Workflow Automation)

| | |
|---|---|
| **Client** | Supported Study Hall staff at the Center for Learning and Collaboration (CLC), Pomfret School |
| **Developers** | Luke Ryan, Jack Weinberg |
| **Club lead** | Cayden Auyang |
| **Status** | 🟢 Handed to the CLC: an Apps Script web app on the Pomfret Google domain, with automatic updates at 7 pm and midnight |
| **Web app** | https://script.google.com/a/macros/pomfret.org/s/AKfycby1FSQahq5fzxF9XHWZ5drKXFrfyF9e-y1o8cfwnGYY_uXVYKIZ6dFKk3muEGEKG3HA/exec (Pomfret sign-in, CLC staff only) |
| **Old address** | https://civicaiclub.github.io/case-a-clc-workflow/ now just links to the web app |
| **Staff guides** | [`docs/handoff/`](docs/handoff/): quick start for CLC staff, token guide for students, demo script and troubleshooting |

## The problem

CLC staff spend hours each week logging into individual student Canvas accounts and transcribing assignment data into to-do lists in Google Docs.

## What AutoPlanner does

CLC staff open one web page, signed in with their Pomfret Google account. They add each student once by pasting the student's Canvas access token. AutoPlanner then keeps **one Google Doc per student** in a shared Drive folder.

- Each Doc has one tab per week: a **By Class** table for every class the student takes (including classes with nothing due), then a **By Day** table. Every table uses the same full-width layout, written down at the top of `apps_script/Code.gs`.
- The **CLC Planner** tab is a one-page summary of this week by class. On Saturday and Sunday (New York time) it summarizes the coming week.
- Staff type **Status** (Not started, In progress or Complete, as plain text) and **Notes**. Both are kept across updates, keyed by the assignment's Canvas link, and follow an assignment whose due date moves to another week.
- Work due earlier in the week stays in its week as **Past due** (gray) until the week ends. Then the tab moves into a **Past weeks** tab, newest first, and its Priority cells turn gray in the same step. After that AutoPlanner never edits, rebuilds or deletes past weeks, and its Doc reads leave their content out so updates stay fast all year.
- At the bottom of every week tab, an **Added by staff** table (Assignment, Class, Day, Status, Notes) holds work that isn't on Canvas. AutoPlanner writes it back exactly, formatting included, on every update, and it moves into Past weeks with its week. The CLC Planner tab counts its rows.
- **CLC teachers** (optional, the `CLC_TEACHERS` Script Property): each teacher gets a folder inside the shared folder, named with their full name. A student's CLC teacher, picked on the page, decides which folder their Doc is in. Moving it is the same Doc and link. A Doc dragged between folders in Drive changes the student's teacher at the next page load or update. The page has a **Show** filter, and a signed-in CLC teacher starts on their own students.
- If a student's Doc is deleted or in the trash, AutoPlanner never writes to it: it makes a fresh Doc in the shared folder (or the student's teacher's folder) and says so on the student's row.
- Each row shows when the student's Canvas token expires (Canvas reports it; Pomfret limits tokens to about 90 days), and the page warns three weeks ahead (so tokens that run out over winter break are flagged before it).
- Updates run automatically every day at about 7 pm and just after midnight (New York time), or on demand from the page.

## How it works

Everything runs in one Google Apps Script project owned by the club lead's Pomfret account. There is no other server.

```
Staff browser (Index.html, signed in to Pomfret)
  → google.script.run → App.gs  (checks ALLOWED_USERS on every call)
       → Canvas.gs  → Canvas REST API (UrlFetchApp, the student's token)
       → Code.gs    → Google Docs API (writes the Doc in the shared folder)
Time-driven triggers (7 pm, midnight) → App.gs → same path, in batches
```

- **Web app:** executes as the owner (`USER_DEPLOYING`) and is open to **Anyone within Pomfret School** (`DOMAIN`). On top of that, every function the page can call checks the visitor's email (`Session.getActiveUser()`) against the `ALLOWED_USERS` Script Property.
- **Storage:** the student list, tokens and run summaries live in **Script Properties**, one property per student, with writes protected by `LockService`. Tokens never leave the server: the page only ever gets the last 4 characters, and tokens are never logged or put in messages.
- **Long runs:** Apps Script stops any run at the account's time limit (6 minutes by default; `measureTimeLimit` measures the real one and saves it in `RUNTIME_LIMIT_SECONDS`; the current owner's is 30 minutes). Reading the Doc used to be most of an update (about 1.25 MB per read, 10 reads). Reads now ask only for the text, links and positions AutoPlanner uses (about a fifth of a full read), and each week reuses the previous week's final read, so an update with 4 weeks reads the Doc 5 times.
  - An automatic batch (7 pm, midnight, `continueRun`) keeps starting students until 5 minutes short of the limit (25 minutes at most). A batch started from the page stops starting students after 2 minutes, so the page hears back quickly. Either way, a batch never starts a student whose last update time (plus 25%) wouldn't fit in what's left; it schedules `continueRun` a minute later instead.
  - Inside an update, a week is rebuilt only if it fits before the limit; otherwise the update stops cleanly between weeks and the rest is done next time.
  - A safety trigger, set to fire after the limit has passed, resumes a run whose batch was cut off.
- **Existing Docs:** when a student is added again, AutoPlanner finds their "First Last - CLC Assignments" Doc in the shared folder or a teacher's folder inside it, and reuses it.

## Repository layout

```
case-a-clc-workflow/
├── apps_script/            Everything that runs in Apps Script (paste these into the editor)
│   ├── appsscript.json     Manifest: Docs API service, permissions, web app settings
│   ├── Code.gs             Writes each student's Doc (tabs, tables, Status/Notes, folder rules)
│   ├── Canvas.gs           Reads Canvas, then sorts assignments into weeks and days
│   ├── App.gs              The web app: access checks, students, updates, triggers, setup, selfTest
│   └── Index.html          The page staff use (HTML, CSS and JavaScript in one file)
├── scripts/
│   └── copy-to-apps-script.sh   Copies each file to the clipboard, one at a time, for pasting
├── tests/                  Node tests that run the .gs files against pretend Google services
├── frontend/index.html     The "AutoPlanner has moved" page on GitHub Pages
├── docs/handoff/           Guides for CLC staff and students, demo script, troubleshooting
├── .cursor/rules/          Committed Cursor rules (nothing to paste into your IDE)
└── .github/workflows/      CI (tests on every PR) and the Pages deploy
```

## Updating the live app

clasp (Google's command-line tool) is blocked for Workspace for Education accounts marked under 18, so changes are pasted into the editor by hand.

1. Merge your change to `main` through a PR as usual.
2. Open the project at [script.google.com](https://script.google.com) as the owner.
3. In a terminal, run `scripts/copy-to-apps-script.sh` for every file, or `scripts/copy-to-apps-script.sh App.gs Index.html` for just the ones you changed. For each file it puts on your clipboard:
   - click that file in **Files** (or **+ → Script / HTML** to create it, typing the name without its extension)
   - click inside the code and press **⌘A, ⌘V, ⌘S**
4. **Deploy → Manage deployments**, then select the web app deployment and click the pencil icon. Set **Version** to **New version**, and click **Deploy**.
   - Pasting alone changes nothing for staff: the deployment keeps running its old version until you pick **New version**. "Script function not found: doGet" means you forgot this step.
   - The web app URL stays the same.
5. Use **Deploy → Test deployments** for a private `/dev` link that runs your latest saved code before you deploy it.

## Setting it up from scratch

Only needed for a brand-new project, for example to move AutoPlanner to a CLC staff account.

1. Create a Drive folder for the Docs and share it as **Editor** with the CLC staff.
2. At [script.google.com](https://script.google.com), click **New project**, then paste all five files (see above). Turn on **Project Settings → Show "appsscript.json" manifest file in editor** first.
3. **Project Settings → Script Properties:**

   | Property | Required | What it is |
   |---|---|---|
   | `ALLOWED_USERS` | yes | Comma-separated Pomfret emails allowed to use the page. Nobody else gets in. |
   | `DOCS_FOLDER_ID` | yes | The shared folder's ID or URL. New Docs are created there, and only Docs inside it (or a teacher's folder inside it) can be updated. |
   | `CLC_TEACHERS` | no | The CLC teachers, as `Full Name <email>` with commas between them, for example `Pat Example <pexample@pomfret.org>, Sam Sample <ssample@pomfret.org>`. Each gets a folder inside the shared folder. Empty: no teacher column, and every Doc stays in the shared folder. |
   | `CANVAS_BASE_URL` | no | Defaults to `https://pomfret.instructure.com`. |
   | `COURSE_EXCLUDE` | no | Comma-separated keywords, such as `advisory, dorm`. Classes whose name contains one are left out of the Docs entirely. Empty: every class is shown. |
   | `TEST_CANVAS_TOKEN` | only for `selfTest` | Your own Canvas token. `selfTest` deletes it when it finishes; `selfTestKeepToken` keeps it. |

   Properties named `student.*`, `token.*`, `busy.*`, `run.*`, `trigger.*`, `written.*`, `probe.*` and `teacherFolders` are written by the app, and so is `RUNTIME_LIMIT_SECONDS` (see `measureTimeLimit`). Don't edit them by hand.
4. In the editor, open **App.gs** (the function menu only lists functions from the open file). Run **setupTriggers** and approve the permissions. It installs the daily updates and logs a setup check.
5. Run **selfTest** (about 6 minutes; a Doc last written by an older version gets one extra update first). Don't open or edit your planner Doc while it runs. Using your own token, it:
   - fetches your Canvas assignments
   - creates or reuses your Doc in the folder, and holds your student row so no other update writes it meanwhile
   - types a test Status and Note, and a row in **Added by staff**, moves that assignment to another week and back with two updates, and checks both followed it, in both tables, in exactly one week tab, and that the staff row came through exactly
   - checks the layout after a full update, then puts the test assignment's Status and Note back and clears the staff row
   - with at least 2 CLC teachers set, moves your Doc between teacher folders (from the page and as a Drive drag-in), checks the folder lock, and puts your row back how it was
   - reads your Doc both ways (slim and full), times them, and checks they give the same Status, Notes, staff rows and widths

   Every line of the log should say `PASS` (a `SKIP` says why it skipped).

   Each update's line shows where its time went (Doc reads, writes, pauses, each week).

   **selfTestEveryday** (about 4 minutes) checks the everyday case on its own: a Status and Note changed in By Class survive a plain update, in both tables. It keeps `TEST_CANVAS_TOKEN`.
6. **Deploy → New deployment →** ⚙ **Web app**. Set **Execute as: Me** and **Who has access: Anyone within Pomfret School**, then click **Deploy**.

Other functions you can run from the editor (they only run for the owner):
- **checkSetup** logs the current setup.
- **scheduleTestRun** schedules one extra update about 5 minutes from now, to test the automatic updates. The daily triggers are not touched.
- **measureTimeLimit** finds this account's real Apps Script time limit. Run it once and leave it; it stops on its own (up to 31 minutes). Then run **checkSetup**, which saves the result in `RUNTIME_LIMIT_SECONDS`.

## Tests

```bash
node --test tests/*.test.js
```

- The tests load the real `.gs` files into Node with pretend Google services (`tests/helpers/`).
- They cover:
  - who can call what
  - tokens never reaching the page or the logs
  - Doc reuse
  - batching and triggers
  - the shared-folder rules and Status preservation in `Code.gs`
  - the "Added by staff" table and CLC teacher folders (against a pretend Docs API that enforces Google's rules)
  - the Canvas client
  - a week-grouping golden file: the original Python version's output, plus this week's past-due work
- CI runs them, plus a syntax check of every `.gs` file and of the script in `Index.html`, on every PR.

**Security rule for developers:** `google.script.run` can call **any** function whose name does not end in `_`. Every internal function must end in `_`. Every public function must start with:
- `requireAllowedUser_()` for functions the page calls
- `requireOwner_()` for editor-only functions
- `requireTrigger_(e)` for trigger handlers

A test fails if a new public function appears.

## Limits

Google Workspace limits that matter here:
- the per-run time limit (6 minutes by default, 30 minutes for the current owner; measure it with `measureTimeLimit`)
- 6 hours of trigger runtime per day
- 100,000 Canvas requests per day
- 20 triggers per user per script
- Script Properties: 9 KB per value and 500 KB in total, so one property per student means hundreds fit
- the Docs API's per-minute write limit (writes are batched, paced and retried)

Everything belongs to the owner's account: the script, its triggers, the stored tokens and the Docs. Anyone with edit access to the script project can read the tokens, so don't share the project. Before the owner graduates, move the project, the folder and the Docs to a CLC staff account: step by step in the [quick start's "Long-term care"](docs/handoff/CLC-quick-start.md#8-long-term-care), including running `setupTriggers` again as the new owner.

## Getting a Canvas API token (for each student)

1. Log into Canvas → profile picture → **Settings**.
2. Scroll to **Approved Integrations** → **+ New Access Token**.
3. Purpose: "AutoPlanner". Expiry: the latest date Canvas allows. Pomfret limits tokens to about 90 days; AutoPlanner shows each token's expiry date and warns three weeks ahead.
4. Copy the token immediately (Canvas will not show it again) and paste it into AutoPlanner's **Add a student** box.

The student-facing version is [`docs/handoff/student-token-guide.md`](docs/handoff/student-token-guide.md).

## Working on this repo

- Branch from `main` as `feature/<short-description>`, `fix/<short-description>`, or `chore/<short-description>` (lowercase, hyphens).
- Every change goes through a pull request with at least one approval. `main` cannot be pushed to directly.
- Never commit secrets, tokens, real student data, staff email lists, or `.clasp.json` / `.clasprc.json` (both are gitignored).
- Cursor rules for this project are committed in `.cursor/rules/`. You do not need to paste anything into your IDE settings.
- The full Git walkthrough for beginners is the club's **[Developer Onboarding Guide](https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md)**.

## History

- This repository was split out of the club monorepo (`CivicAIClub/Civic-AI-Github-Repository`, `projects/case-a-clc-workflow/`) on 2026-09-18 with full history preserved.
- Until October 2026, AutoPlanner was a Python/FastAPI backend plus a static page on GitHub Pages. It never got a hosted backend.
- In October 2026 it moved entirely into Apps Script. The Python code is in the git history before that change.
