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
2. Paste it into **Canvas access token** under **Add a student**. **Label** is optional, just for you (for example "Table 4"). **CLC teacher** is optional too (see [CLC teachers](#5-clc-teachers)). Click **Add student**.
3. AutoPlanner checks the token with Canvas, then makes the student's Doc. This takes about 2 minutes. When it's done, their row's **Last update** says "Updated:" and how many assignments it found. The row also shows when their token expires.

After that you only ever see the token's **last 4 characters**. If a student was on the list before, AutoPlanner finds and reuses their existing Doc.

## 3. Updates

- **Automatic:** every day at about **7 pm** and about **midnight**. They run on Google's servers, so no computer needs to be on.
- **Right now:** click **Update all students now** (about 2 minutes per student). You can close the page; it keeps going. To refresh just one student, click **Update** on their row.
- **Last update** shows when the last update ran and any student who had a problem, with the reason. That student's row has a black **Needs attention** tag with the same reason.

## 4. Where the Docs live

Every Doc is in the Google Drive folder **AutoPlanner – CLC Student Planners**, under **Shared with me** in Drive. Click **Open Doc ↗** on a student's row to jump straight to it.

- Each Doc is called "*Student Name* - CLC Assignments".
- Inside the folder, each CLC teacher has their own folder, named with their full name. A student's Doc is in their CLC teacher's folder, or loose in the main folder if they don't have one (**Unassigned**).
- The **CLC Planner** tab at the top is a one-page summary: how many assignments each class has this week, when each is next due, and a link to this week's tab. On **Saturday and Sunday** it shows the **coming week** instead, and how many assignments are due that weekend.
- Open the **Document tabs** sidebar on the left to see one tab per week under **CLC Planner**.
- Work due earlier in the week stays in its week, marked **Past due** in gray, until the week ends.
- When a week ends, its tab moves into **Past weeks** (newest first), with the Status and Notes typed during it. Its Priority column turns gray, since those colors no longer apply. After that, AutoPlanner never changes it again.
- Each week tab has a **By Class** section with a table for **every class** the student takes. A class with nothing due that week says "No assignments due this week."
- Under that, **By Day** lists the same assignments by day.
- At the bottom, **Added by staff** is a table for you (see [Status and Notes](#6-status-and-notes)).
- **Keep the Docs in this folder or a teacher's folder inside it.** AutoPlanner only updates Docs that are there. If one gets moved out, move it back.

## 5. CLC teachers

Each student can have a CLC teacher. The **CLC teacher** column on the page has a dropdown on every row.

- **To pick or change a student's teacher**, choose a name in their dropdown. AutoPlanner moves the student's Doc into that teacher's folder straight away and says so on the row. It's the same Doc and the same link, with all its Status and Notes. Choose **Unassigned** to move it back to the main folder.
- **You can also do it in Drive.** Drag a Doc into a teacher's folder, or back to the main folder, and AutoPlanner picks up the change the next time anyone opens the page or the student is updated.
- **Show**, above the list, chooses whose students you see: **All students**, one teacher's, or **Unassigned**. If you're one of the CLC teachers, the page starts on your own students. Choose **All students** to see everyone. **Add a student** starts on the teacher that Show is set to, so a student you add while looking at your own students is yours; you can pick someone else there.
- After the next update, the student's **CLC Planner** tab says "CLC teacher:" with the teacher's name.
- **Renaming a teacher's folder is fine.** Don't delete it or move it out of the main folder, because their students' Docs are inside it. If that happens by mistake, the next update makes a new folder for that teacher and moves the Docs into it, unless the folder was also emptied from the trash.

## 6. Status and Notes

Type in the white **Status** and **Notes** cells, in either table:

- **Status:** type **Not started**, **In progress**, or **Complete**, as plain words. New assignments start as Not started.
- **Notes:** type anything you like.

Use the Notes column, not comments, for anything you want to keep. Comments on week tabs can be lost when AutoPlanner updates.

AutoPlanner never changes these two columns, so what you type survives every update. The same reminder is at the top of every week tab. If a teacher moves an assignment's due date to another week, its Status and Notes move with it, even if its old week has already gone into Past weeks (for example, overdue work given a new date). That works for up to 10 weeks.

**If an assignment disappears from Canvas after you typed on it**, it stays in its week with your Status and Note, and its **Priority** cell says why:

- **Not on Canvas:** the teacher removed or unpublished it, or the student dropped the class.
- **No due date:** it's still on Canvas, without a due date.
- **Now due Nov 30** (for example): its due date moved outside the next 4 weeks.

If it comes back, your Status and Note go with it. It stays until its week ends, or until you clear its Status (back to Not started) and its Notes. Rows with nothing typed in them just disappear.

Assignments that have no due date in Canvas aren't listed at all. If one matters, add it to **Added by staff**.

**Everything else is rewritten on each update, including the CLC Planner tab** (except the Added by staff table below). For notes about the student in general, add your own tab with **+** at the top of the **Document tabs** sidebar. AutoPlanner leaves tabs it didn't make alone.

- **Renamed a week tab?** AutoPlanner puts its name back at the next update, with everything in it.
- **Deleted a week tab by mistake?** The next update makes it again, with its Statuses but not its Notes. To get the Notes back, open **File → Version history → See version history** and pick a version from before the tab was deleted. Then copy the Notes you need back into the Doc. **Restore this version** also works, but it undoes every change made to the whole Doc since then, so only use it right after the mistake.

### Added by staff

At the bottom of every week tab, **Added by staff** is a table for work that isn't on Canvas, such as a quiz a teacher announced in class. It has the columns Assignment, Class, Day, Status and Notes, and starts with 2 empty rows. For more rows, click in the last cell and press **Tab**.

AutoPlanner never changes this table. It's kept exactly as you typed it, formatting included, on every update, and it moves into **Past weeks** with its week. The CLC Planner tab counts its rows, for example "· 2 added by staff".

## 7. Change or remove a student

- **New token** (for example after the old one expired): click **Edit** on their row, paste the new token, and click **Save**. Then click **Update**. It's the same student and the same Doc, so their Status and Notes are kept.
- **Remove:** click **Remove**. Their Doc stays where it is, in the main folder or their teacher's folder. If you add them again later, AutoPlanner finds it there and reuses it.

## 8. Long-term care

AutoPlanner is meant to run all year without anyone touching the code. A few things need a person. A weekly email tells the club when something does (see the end of this section).

### The owner and the backup admin

- **The owner** (right now Cayden) owns the Apps Script project, the shared folder and the Docs. Only the owner can run AutoPlanner's functions in the editor (setupTriggers, checkSetup, selfTest, pauseAutomaticUpdates, and so on).
- **The backup admin** is a Pomfret faculty member with editor access to the Apps Script project, in case the owner can't be reached. The backup admin can:
  - change the settings in **Project Settings** (gear icon) → **Script Properties**, such as `ALLOWED_USERS`, `CLC_TEACHERS` and `HEALTH_EMAILS`;
  - pause and resume the automatic updates by hand (see "Summer, and a new school year").

  The backup admin can't run the owner's functions; those refuse anyone but the owner. The backup admin also gets the weekly health email, and is a natural new owner when Cayden graduates (see "Moving AutoPlanner to a new owner").
- Anyone with edit access to the project can read the students' tokens, so keep it to these two people.

### Tokens expire, so renew them

Pomfret's Canvas limits tokens to about 90 days (a token made on Oct 4, 2026 expires on Jan 2, 2027), so expect to renew every student's token about once a term.

- Each student's row shows **Token expires** and the date.
- Three weeks before any token expires, the page lists who needs a new one, under **Update all students now**.
- **Tokens made in early October expire around Jan 2, during winter break.** Renew them in the first half of December, while students are still here.
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
| "AutoPlanner only updates Docs in the … folder" | Someone moved the Doc. Move it back into **AutoPlanner – CLC Student Planners** (or its CLC teacher's folder there), then click **Update**. |
| "That CLC teacher's folder isn't available" or "That CLC teacher is no longer on the list" | Reload the page and try again. If it keeps happening, contact us. |
| "This student's Doc has … tabs, and Google allows 100" | Start a new Doc for that student, as in step 1 of "Summer, and a new school year" below (rename the Doc, then **Remove** and add the student again). |
| "Updated 2 of 4 weeks: Google Docs was slow…" | Nothing. The other weeks (with their Status and Notes) are updated at the next update. |
| "Was stopped partway by Apps Script's time limit" | Nothing; it's tried again at the next update. Contact us if it keeps happening. |
| "Not tried: Canvas wasn't answering…" (in **Last update**) | Nothing. Canvas was down, so AutoPlanner stopped asking. The next update tries everyone again, and their Docs keep the last update until then. |
| "Was already being updated at the same time" (in **Last update**) | Nothing. That student was being updated another way (the **Update** button on their row, or selfTest); that update counts. |
| "…shared folder … is in the Drive trash" or "cannot open that Drive folder" | The shared folder was deleted or unshared. Its owner can restore it from the Drive trash; otherwise contact us. |

Two more messages can appear on the page:

- **"Their Doc was deleted, so AutoPlanner made a new one."** on a row: someone deleted the student's Doc, so AutoPlanner started a fresh one in the shared folder. Status and Notes typed in the old Doc stay in the owner's Drive trash for 30 days. This message goes away after a week.
- If a student's Doc is deleted and their row says "Google Drive didn't answer", contact Cayden Auyang or Luke Ryan.
- **"Automatic updates haven't finished since …"** near **Update all students now**: the automatic updates have stopped. This usually means the account that owns AutoPlanner was closed or lost its permissions. Contact us, or follow "Moving AutoPlanner to a new owner" below.

### Adding or removing a CLC teacher

The list of CLC teachers is a setting that AutoPlanner's owner or backup admin can change (contact us):

1. Open the Apps Script project → **Project Settings** (gear icon) → **Script Properties**.
2. Edit `CLC_TEACHERS`: each teacher as `Full Name <email>`, with commas between teachers. Click **Save script properties**.
3. Reload AutoPlanner. A new teacher's folder appears inside the main folder, and their name appears in the dropdowns.

- **Removing a teacher:** the next time the page is opened, their students become **Unassigned** and their Docs move back to the main folder. Nothing is deleted. Their empty folder stays, and you can delete it by hand.
- **Changing a teacher's name** doesn't rename their folder; rename it in Drive. Changing their **email** counts as removing them and adding a new teacher, so their students become Unassigned.
- A teacher who will use the page also needs to be in `ALLOWED_USERS`.

### Summer, and a new school year

AutoPlanner's owner does these steps in the Apps Script editor: open **App.gs**, pick the function in the menu at the top, and click **Run**.

- **In June, when classes end:** run **pauseAutomaticUpdates**. The 7 pm and midnight updates and the weekly email stop; the page says "Automatic updates are paused", and everything else still works. (Otherwise every student's token expires over the summer, and each nightly update just fails.)
- **If the owner can't, the backup admin pauses by hand:** **Project Settings** → **Script Properties** → **Add script property**, name `PAUSED_SINCE`, value today's date (for example `2027-06-12`), then **Save script properties**. To turn the updates back on, delete that property (the trash can icon next to it) and save. It works exactly like the two functions.
- **In September:**
  1. **Start each year with fresh Docs** (recommended). A Doc keeps every past week, so it grows all year. On the page, click **Remove** on every student; their Docs stay. In the shared folder (and each teacher's folder), add the year to each Doc's name, for example "Avery Example - CLC Assignments (2026–27)". AutoPlanner then makes a new Doc when a student is added again, and last year's Docs stay where they are.
  2. Add each student with a new token (and their CLC teacher).
  3. Run **resumeAutomaticUpdates**.

### The weekly health email

Every Monday at about 7 AM, AutoPlanner emails the club, but only if something needs attention. It reports:

- the automatic updates not set up or not finishing
- students whose updates have failed for over a day, with the same message as on their row
- Canvas tokens running out in the next 3 weeks
- AutoPlanner's saved data getting close to Google's limit

When all is well, it sends nothing. The email goes to the addresses in the `HEALTH_EMAILS` Script Property (commas between them), or to AutoPlanner's owner if that's empty; include the backup admin. The new owner should change it when AutoPlanner moves. To see the check right away, the owner can run **healthCheckNow**.

### Moving AutoPlanner to a new owner (before Cayden's account closes)

Everything runs as one Google account: right now Cayden Auyang's Pomfret account. That includes the Apps Script project, its automatic updates, the saved tokens, the shared folder and every student's Doc. When that account closes, everything it owns stops or is deleted. So before Cayden graduates, move it all to a CLC staff member or the Civic AI Club's faculty advisor (the **new owner**). It takes about 20 minutes, with Cayden and the new owner both signed in.

1. **Add the new owner to the list.** Cayden: open the Apps Script project → **Project Settings** (gear icon) → **Script Properties**. Check that the new owner's email is in `ALLOWED_USERS`; if not, add it (commas between emails) and click **Save script properties**.
2. **Give them the project.** Cayden: in Google Drive, find the **AutoPlanner** Apps Script project. Click **Share**, add the new owner as **Editor**, and click **Send**. Open **Share** again, click the dropdown next to their name, and choose **Transfer ownership**. The new owner accepts from the email Google sends them.
3. **Give them the folder and the Docs.** Cayden: open the folder **AutoPlanner – CLC Student Planners**, select everything in it (Cmd+A on a Mac, Ctrl+A on Windows), click **Share**, and transfer ownership to the new owner the same way. Then open each CLC teacher's folder inside it and do the same for the Docs there. Last, do the same for the folder itself (right-click it → **Share**). The new owner accepts again.
   - If **Transfer ownership** isn't offered (Pomfret may block it for student accounts), ask Pomfret's Google Workspace admin to transfer the AutoPlanner project, the folder and the Docs in it from Cayden's account to the new owner.
4. **New owner: publish the web page as yourself.** Open the project at [script.google.com](https://script.google.com). Click **Deploy → Manage deployments**, click the pencil icon, and check that **Execute as** says **Me** with *your* email. Set **Version** to **New version** and click **Deploy**. Allow the permissions Google asks for. The web address stays the same, so bookmarks keep working.
5. **New owner: turn on the automatic updates as yourself.** In the editor, pick **setupTriggers** in the function menu at the top and click **Run**. Allow the permissions again if asked. Then run **checkSetup**: every line should start with **OK**. In **Script Properties**, set `HEALTH_EMAILS` to the people who should get the weekly email. Last, run **measureTimeLimit** and leave it: your account's time limit may differ from Cayden's. It stops on its own within 31 minutes; then run **checkSetup** once more.
6. **Cayden: turn off your own automatic updates.** In the project, click **Triggers** (the clock icon) and delete the triggers that list Cayden as the owner. Until you do, both accounts start an update at 7 pm and midnight. That's harmless (the second one sees an update is already running and stops), but it's tidier to have one.
7. **Check it the next morning.** Open AutoPlanner: **Last update** should show the midnight update, with no warning above it.

The saved tokens, the student list and the settings move with the project, so nobody has to add students again. Anyone with edit access to the project can read the tokens, so after the move keep edit access to the new owner and one backup admin. If the backup admin becomes the new owner, choose a new backup.

## 9. Who to contact

Civic AI Club, by school email:

- **Cayden Auyang**
- **Luke Ryan**

Tell us the student's name and the exact message you see (a screenshot is perfect). Never send tokens by email.
