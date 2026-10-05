# AutoPlanner: quick start for CLC staff

AutoPlanner reads each student's assignments from Canvas and keeps them in one Google Doc per student, with a tab for each week. It updates every Doc automatically each evening.

## 1. Open it and bookmark it

**https://script.google.com/a/macros/pomfret.org/s/AKfycby1FSQahq5fzxF9XHWZ5drKXFrfyF9e-y1o8cfwnGYY_uXVYKIZ6dFKk3muEGEKG3HA/exec**

That's long, so you can also go to **civicaiclub.github.io/case-a-clc-workflow** and click **Open AutoPlanner**.

- Sign in with your **Pomfret Google account**. The page shows "Signed in as …" at the top.
- **Any staff computer works.** Everything is saved in AutoPlanner, not in the browser.
- If you're signed in to more than one Google account, use a browser window (or Chrome profile) signed in **only** to your Pomfret account. Otherwise the page may not load.

## 2. Add a student

1. Ask the student for their Canvas access token. Give them the [student token guide](student-token-guide.md) if they don't have one.
2. Paste it into **Canvas access token** under **Add a student**. **Label** is optional, just for you (for example "Table 4"). Click **Add student**.
3. AutoPlanner checks the token with Canvas, then makes the student's Doc. This takes about 2 minutes. When it's done, their row's **Last update** says "Updated:" and how many assignments it found. The row also shows when their token expires.

After that you only ever see the token's **last 4 characters**. If a student was on the list before, AutoPlanner finds and reuses their existing Doc.

## 3. Updates

- **Automatic:** every day at about **7 pm** and about **midnight**. They run on Google's servers, so no computer needs to be on.
- **Right now:** click **Update all students now** (about 2 minutes per student). You can close the page; it keeps going. To refresh just one student, click **Update** on their row.
- **Last update** shows when the last update ran and any student who had a problem, with the reason. That student's row has a black **Needs attention** tag with the same reason.

## 4. Where the Docs live

Every Doc is in the Google Drive folder **AutoPlanner – CLC Student Planners**, under **Shared with me** in Drive. Click **Open Doc ↗** on a student's row to jump straight to it.

- Each Doc is called "*Student Name* - CLC Assignments".
- The **CLC Planner** tab at the top is a one-page summary: how many assignments each class has this week, when each is next due, and a link to this week's tab. On **Saturday and Sunday** it shows the **coming week** instead, and how many assignments are due that weekend.
- Open the **Document tabs** sidebar on the left to see one tab per week under **CLC Planner**.
- Work due earlier in the week stays in its week, marked **Past due** in gray, until the week ends.
- When a week ends, its tab moves into **Past weeks** (newest first), with the Status and Notes typed during it. Its Priority column turns gray, since those colors no longer apply. After that, AutoPlanner never changes it again.
- Each week tab has a **By Class** section with a table for **every class** the student takes. A class with nothing due that week says "No assignments due this week."
- Under that, **By Day** lists the same assignments by day.
- **Keep the Docs in this folder.** AutoPlanner only updates Docs that are inside it. If one gets moved out, move it back.

## 5. Status and Notes

Type in the white **Status** and **Notes** cells, in either table:

- **Status:** type **Not started**, **In progress**, or **Complete**, as plain words. New assignments start as Not started.
- **Notes:** type anything you like.

Use the Notes column, not comments, for anything you want to keep. Comments on week tabs can be lost when AutoPlanner updates.

AutoPlanner never changes these two columns, so what you type survives every update. The same reminder is at the top of every week tab. If a teacher moves an assignment's due date to another week, its Status and Notes move with it.

**Everything else is rewritten on each update, including the CLC Planner tab.** For notes about the student in general, add your own tab with **+** at the top of the **Document tabs** sidebar. AutoPlanner leaves tabs it didn't make alone.

## 6. Change or remove a student

- **New token** (for example after the old one expired): click **Edit** on their row, paste the new token, and click **Save**. Then click **Update**. It's the same student and the same Doc, so their Status and Notes are kept.
- **Remove:** click **Remove**. Their Doc stays in the shared folder. If you add them again later, AutoPlanner reuses it.

## 7. Long-term care

AutoPlanner is meant to run all year without anyone touching the code. Three things need a person.

### Tokens expire, so renew them

Pomfret's Canvas limits tokens to about 90 days (a token made on Oct 4, 2026 expires on Jan 2, 2027), so expect to renew every student's token about once a term.

- Each student's row shows **Token expires** and the date.
- Two weeks before any token expires, the page lists who needs a new one, under **Update all students now**.
- Once a token has expired, the row says **Needs attention** with "This student's Canvas token expired on" and the date.

To renew a token:

1. Ask the student to make a new token with the [student token guide](student-token-guide.md), picking the latest expiration date Canvas allows.
2. Click **Edit** on their row, paste the new token, and click **Save**.
3. Click **Update**.

It's the same student and the same Doc, so their Status and Notes are kept. A student who deletes their token, or whose Canvas account changes, needs the same steps.

### When a row says "Needs attention"

The message next to it says what happened. Most fix themselves:

| The message says | What to do |
|---|---|
| "This student's Canvas token expired on …", "Canvas didn't accept this student's token" or "Canvas refused this student's token" | Renew the token (see above). |
| "This token now belongs to a different Canvas user" | Click **Edit** and paste this student's own token. |
| "Canvas is busy", "Canvas is getting too many requests", "Google is limiting how fast Docs can be edited", "Google Docs or Drive had a temporary problem", or "Google Drive didn't answer" | Nothing. AutoPlanner tries again at the next update (7 pm or midnight). If the same message is still there after two days, contact us. |
| "Google Drive couldn't find this student's Doc just now" | Nothing. If the Doc is really gone, the next scheduled update makes a new one and says so on the row. |
| "AutoPlanner only updates Docs in the … folder" | Someone moved the Doc. Move it back into **AutoPlanner – CLC Student Planners**, then click **Update**. |
| "Updated 2 of 4 weeks: Google Docs was slow…" | Nothing. The other weeks (with their Status and Notes) are updated at the next update. |
| "Was stopped partway by Apps Script's time limit" | Nothing; it's tried again at the next update. Contact us if it keeps happening. |
| "…shared folder … is in the Drive trash" or "cannot open that Drive folder" | The shared folder was deleted or unshared. Its owner can restore it from the Drive trash; otherwise contact us. |

Two more messages can appear on the page:

- **"Their Doc was deleted, so AutoPlanner made a new one."** on a row: someone deleted the student's Doc, so AutoPlanner started a fresh one in the shared folder. Status and Notes typed in the old Doc stay in the owner's Drive trash for 30 days. This message goes away after a week.
- If a student's Doc is deleted and their row says "Google Drive didn't answer", contact Cayden Auyang or Luke Ryan.
- **"Automatic updates haven't finished since …"** near **Update all students now**: the automatic updates have stopped. This usually means the account that owns AutoPlanner was closed or lost its permissions. Contact us, or follow "Moving AutoPlanner to a new owner" below.

### Moving AutoPlanner to a new owner (before Cayden's account closes)

Everything runs as one Google account: right now Cayden Auyang's Pomfret account. That includes the Apps Script project, its automatic updates, the saved tokens, the shared folder and every student's Doc. When that account closes, everything it owns stops or is deleted. So before Cayden graduates, move it all to a CLC staff member or the Civic AI Club's faculty advisor (the **new owner**). It takes about 20 minutes, with Cayden and the new owner both signed in.

1. **Add the new owner to the list.** Cayden: open the Apps Script project → **Project Settings** (gear icon) → **Script Properties**. Check that the new owner's email is in `ALLOWED_USERS`; if not, add it (commas between emails) and click **Save script properties**.
2. **Give them the project.** Cayden: in Google Drive, find the **AutoPlanner** Apps Script project. Click **Share**, add the new owner as **Editor**, and click **Send**. Open **Share** again, click the dropdown next to their name, and choose **Transfer ownership**. The new owner accepts from the email Google sends them.
3. **Give them the folder and the Docs.** Cayden: open the folder **AutoPlanner – CLC Student Planners**, select everything in it (Cmd+A on a Mac, Ctrl+A on Windows), click **Share**, and transfer ownership to the new owner the same way. Then do the same for the folder itself (right-click it → **Share**). The new owner accepts again.
   - If **Transfer ownership** isn't offered (Pomfret may block it for student accounts), ask Pomfret's Google Workspace admin to transfer the AutoPlanner project, the folder and the Docs in it from Cayden's account to the new owner.
4. **New owner: publish the web page as yourself.** Open the project at [script.google.com](https://script.google.com). Click **Deploy → Manage deployments**, click the pencil icon, and check that **Execute as** says **Me** with *your* email. Set **Version** to **New version** and click **Deploy**. Allow the permissions Google asks for. The web address stays the same, so bookmarks keep working.
5. **New owner: turn on the automatic updates as yourself.** In the editor, pick **setupTriggers** in the function menu at the top and click **Run**. Allow the permissions again if asked. Then run **checkSetup**: every line should start with **OK**.
6. **Cayden: turn off your own automatic updates.** In the project, click **Triggers** (the clock icon) and delete the triggers that list Cayden as the owner. Until you do, both accounts start an update at 7 pm and midnight. That's harmless (the second one sees an update is already running and stops), but it's tidier to have one.
7. **Check it the next morning.** Open AutoPlanner: **Last update** should show the midnight update, with no warning above it.

The saved tokens, the student list and the settings move with the project, so nobody has to add students again. Anyone with edit access to the project can read the tokens, so only the owner should have it.

## 8. Who to contact

Civic AI Club, by school email:

- **Cayden Auyang**
- **Luke Ryan**

Tell us the student's name and the exact message you see (a screenshot is perfect). Never send tokens by email.
