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
3. AutoPlanner checks the token with Canvas, then makes the student's Doc. This takes about 2 minutes, and you'll see a ✅ on their row when it's done.

After that you only ever see the token's **last 4 characters**. If a student was on the list before, AutoPlanner finds and reuses their existing Doc.

## 3. Updates

- **Automatic:** every day at about **7 pm** and about **midnight**. They run on Google's servers, so no computer needs to be on.
- **Right now:** click **Update all students now** (about 2 minutes per student). You can close the page; it keeps going. To refresh just one student, click **Update** on their row.
- **Last update** shows when the last update ran and any student who had a problem, with the reason. A ⚠️ on a student's row means the same thing.

## 4. Where the Docs live

Every Doc is in the Google Drive folder **AutoPlanner – CLC Student Planners**, under **Shared with me** in Drive. Click **Open their Doc ↗** on a student's row to jump straight to it.

- Each Doc is called "*Student Name* - CLC Assignments".
- Open the **Document tabs** sidebar on the left to see one tab per week under **CLC Planner**.
- Each week tab has a **By Class** section with a table for **every class** the student takes. A class with nothing due that week says "No assignments due this week."
- Under that, **By Day** lists the same assignments by day.
- **Keep the Docs in this folder.** AutoPlanner only updates Docs that are inside it. If one gets moved out, move it back.

## 5. Status and Notes

Type in the white **Status** and **Notes** cells, in either table:

- **Status:** type **Not started**, **In progress**, or **Complete**, as plain words. New assignments start as Not started.
- **Notes:** type anything you like.

AutoPlanner never changes these two columns, so what you type survives every update. The same reminder is at the top of every week tab.

**Everything else in a week tab is rewritten on each update.** For notes about the student in general, write on the **CLC Planner** tab at the top, which AutoPlanner never changes.

## 6. Change or remove a student

- **New token** (for example after the old one expired): click **Edit** on their row, paste the new token, and click **Save**. Then click **Update**.
- **Remove:** click **Remove**. Their Doc stays in the shared folder. If you add them again later, AutoPlanner reuses it.

## 7. Who to contact

Civic AI Club, by school email:

- **Cayden Auyang**
- **Luke Ryan**

Tell us the student's name and the exact message you see (a screenshot is perfect). Never send tokens by email.
