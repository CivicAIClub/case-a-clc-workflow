# Case A: AutoPlanner

AutoPlanner helps Pomfret's Supported Study Hall staff at the Center for Learning and Collaboration (CLC). It keeps one Google Doc per student updated from Canvas so staff do not have to copy assignments by hand.

## Club workflow

- This is the standalone `CivicAIClub/case-a-clc-workflow` repo. Paths start at its root. There is no `projects/` folder. The old `Civic-AI-Github-Repository` is archived; do not edit it.
- Our developers are high school students learning to code together. Prefer clear code over clever code. If a developer cannot explain generated code, say so and explain it in plain English.
- Never push to `main`. Work on a branch and open a pull request (PR). A merge needs one approving review.
- Use `feature/<short-description>`, `fix/<short-description>`, or `chore/<short-description>`, all lowercase with hyphens and no spaces. The old `case-a/` prefix is retired.
- Make small, frequent commits with plain English messages that say what changed, such as "Add Status column", rather than "stuff".
- Never commit API keys, tokens, `.env` files, real student data, staff email lists, `.clasp.json`, or `.clasprc.json`. The clasp files are gitignored. Canvas tokens belong only in the Apps Script project's Script Properties. If a real credential is pasted into a file, stop and tell the developer.
- Use `.github/pull_request_template.md`: explain what changed, how it was tested, and include screenshots for UI changes.
- Never add `Co-authored-by`, `Generated with`, `Made-with`, `Claude-Session`, or any other AI attribution line to commit messages or PR descriptions. When squash merging, delete any such lines GitHub adds to the merge message.
- For Git, branching, PR, or merge conflict questions, use the [Developer Onboarding Guide](https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md), which also covers common fixes and the club repo list. Do not guess.

## Project rules

- Developers: Luke Ryan and Jack Weinberg. Club lead: Cayden Auyang. The app and staff docs list Cayden and Luke as staff contacts.
- Use Google Apps Script only. There is no other server. Keep the number of script files small because every file must be pasted by hand.
- `apps_script/` is the whole app. Its web app runs as the deploying owner (`USER_DEPLOYING`) and is restricted to the Pomfret domain (`DOMAIN`) in `appsscript.json`.
- `App.gs` handles `doGet`, `ALLOWED_USERS` checks, students, tokens, run summaries, batches, triggers, and setup/test helpers. Store one student per Script Property and use `LockService` around writes.
- Keep batches under the 6-minute limit, using `continueRun` to continue later. Daily updates run at about 7 pm and midnight in `America/New_York`.
- `Canvas.gs` uses `UrlFetchApp`, `fetchAll`, and Link-header paging to read Canvas and group assignments by week and day. Keep its output compatible with `Code.gs`.
- `Code.gs` uses the Docs API for nested week tabs under "CLC Planner" and stacked "By Class" and "By Day" tables. Preserve Status and Notes across updates, keyed by each Canvas assignment URL.
- Only update Docs inside `DOCS_FOLDER_ID`. Batch Docs API writes using `BATCH_CHUNK` and reuse the existing `documentId` instead of creating extra Docs.
- Never write to a deleted or trashed student Doc. Create a fresh Doc in the shared folder or the student's teacher folder and report this on the student's row.
- Preserve staff-added work and its formatting. Do not edit, rebuild, or delete archived Past weeks.
- `Index.html` holds the staff page's HTML, CSS, and JavaScript. It talks to the server only through `google.script.run`. `frontend/index.html` is only the GitHub Pages "moved" page.
- Apps Script pages can call any function without a final `_`. Every internal function must end in `_`. Every public function must start with `requireAllowedUser_()` for page calls, `requireOwner_()` for editor calls, or `requireTrigger_(e)` for trigger handlers.
- `tests/app.test.js` lists allowed public functions. Update that list deliberately when changing public functions.
- Never send tokens to the page except their last four characters. Never log them or put them in error messages. Never store student data in a Sheet or Doc other than the planner Docs.
- Run `node --test tests/*.test.js` before every PR. Add or update tests for any `apps_script/` change. Tests use fake data only. CI also checks script syntax.
- Done means staff can sign in with Pomfret accounts and add students, Docs update at about 7 pm and midnight, Status and Notes survive, and `selfTest` passes in the live project.

## Setup and run

The app runs in the Apps Script editor. Local tests use Node:

```sh
node --test tests/*.test.js
scripts/copy-to-apps-script.sh
# Or copy only changed files:
scripts/copy-to-apps-script.sh App.gs Index.html
```

- For a new project, create a shared Drive folder with Editor access for CLC staff. Create an Apps Script project, show the manifest in Project Settings, and paste all five `apps_script/` files.
- Set required Script Properties `ALLOWED_USERS` and `DOCS_FOLDER_ID`. Optional properties are `CLC_TEACHERS` (`Full Name <email>` entries separated by commas), `CANVAS_BASE_URL` (default `https://pomfret.instructure.com`), and `COURSE_EXCLUDE` (comma-separated keywords).
- For the owner-only live test, put your own token in `TEST_CANVAS_TOKEN`. Open `App.gs`, run `setupTriggers`, approve permissions, then run `selfTest`. Do not open or edit the planner Doc while it runs. Logs should say `PASS`, or explain a `SKIP`. `selfTest` deletes the test token; `selfTestKeepToken` and `selfTestEveryday` keep it.
- Do not edit app-managed properties by hand: `student.*`, `token.*`, `busy.*`, `run.*`, `trigger.*`, `written.*`, `probe.*`, `teacherFolders`, and `RUNTIME_LIMIT_SECONDS`.
- clasp is blocked for the owner's under-18 school account. Paste using the copy script. For a first deployment choose Web app, Execute as Me, and Anyone within Pomfret School.
- For updates, merge the PR, paste the files, save, then use Deploy > Manage deployments > Edit > New version. Pasting alone does not change the live app. The URL stays the same. Use Deploy > Test deployments for the private `/dev` preview.
- Script editors can read stored tokens, so do not share the script project. Before the owner graduates, follow `docs/handoff/CLC-quick-start.md` to move the project, folder, and Docs to a CLC staff account and run `setupTriggers` as the new owner.

## Beginner quick start

Full guide: https://github.com/CivicAIClub/docs/blob/main/developer-onboarding.md

1. First time: check Git with `git --version`, set your Git name and GitHub email, accept the club invite, and sign in with GitHub Desktop or `gh auth login`. Clone only your project's repo, open its folder, and read its README setup steps.
2. Start each work session from the latest main, then make a branch:

```sh
git checkout main
git pull origin main
git checkout -b feature/short-description
# Make and check your changes before continuing.
git status
git add .
git commit -m "Describe your change"
git push --set-upstream origin feature/short-description
```

Use `feature/`, `fix/`, or `chore/` as appropriate, with lowercase names and hyphens. Commit small working pieces; do not edit or push main directly.
3. Open a PR on GitHub, fill in the template, and get someone else's approval and passing checks where CI exists. Push review fixes to the same branch. After it is merged, pull main again before starting another branch.
4. If stuck, ask in the case chat, then Keke, then Luke or Cayden. Ask before doing anything drastic.

## Sources

- `README.md`: project context, architecture, setup, tests, and staff handoff.
- `.cursor/rules/civic-ai-workflow.mdc`: club workflow and where to find help.
- `.cursor/rules/commit-messages.mdc`: commit, PR, and squash merge message rules.
- `.cursor/rules/case-a-autoplanner.mdc`: project architecture, constraints, and definition of done.
- Beginner quick start: `developer-onboarding.md` in the `CivicAIClub/docs` repository, linked above.
