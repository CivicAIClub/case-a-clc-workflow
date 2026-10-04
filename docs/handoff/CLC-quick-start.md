# AutoPlanner: quick start for CLC staff

AutoPlanner reads each student's assignments from Canvas and writes them into one Google Doc per student, with a tab for each week.

## 1. Bookmark this link

**https://civicaiclub.github.io/case-a-clc-workflow/**

There's nothing to set up: **AutoPlanner API URL** and **Canvas base URL** fill themselves in. Leave them as they are.

## 2. Add a student

1. Ask the student for their Canvas access token. Hand them the [student token guide](student-token-guide.md) if they don't have one.
2. Click **+ Add student**, then paste the token into **Canvas API token**. The **Label** box is optional, just for you (for example "Table 4").

## 3. Fetch and update

1. Click **Fetch all students**. Each student gets a tab with their next four weeks of assignments.
2. Click **Create Google Doc** on a student's tab (it says **Update Google Doc** once the Doc exists), or **Update all students' Docs** to do everyone. Each Doc takes about 20 seconds to a minute.

If you see **"Waking up the server, this can take up to a minute…"**, just wait. The server naps when nobody has used it for 15 minutes. A red tab means that one student had a problem; the message on the tab says what.

## 4. Where the Docs live

Every Doc is in the Google Drive folder **AutoPlanner – CLC Student Planners**. Find it in Drive under **Shared with me** (add a shortcut to My Drive to keep it handy). Each Doc is called "*Student Name* - CLC Assignments". Open the **Document tabs** sidebar on the left to see one tab per week under **CLC Planner**.

Keep the Docs in this folder. AutoPlanner only updates Docs that are inside it; if one gets moved out, move it back.

## 5. Status and Notes

Type in the white **Status** and **Notes** cells, in either table. Status starts as "⬜ Not started"; change it to anything, for example "🟡 In progress" or "✅ Complete". These are kept every time the Doc updates.

**Everything else in a week tab is rewritten on each update.** For notes about the student in general, write on the **CLC Planner** tab at the top, which AutoPlanner never changes.

## 6. Use one computer

AutoPlanner remembers the student list, tokens and Doc links **in this browser on this computer only**. Pick one CLC computer and always use the same browser on it.

- On another computer, AutoPlanner doesn't know which Docs already exist and would make second copies.
- Clearing the browser's history or site data makes AutoPlanner forget everything, with the same result.
- Tokens work like passwords to the students' Canvas accounts. Use a computer only CLC staff use, and keep it locked.

## 7. What "Run at these times" really does

The **Auto-update schedule** only runs while the AutoPlanner page is **open in a browser tab** and the computer is **awake**. If the tab is closed or the computer is asleep, the run is skipped; nothing runs on its own in the background. When in doubt, click **Update all students' Docs**.

## 8. Who to contact

Civic AI Club, by school email:

- **Cayden Auyang**, Club President
- **Luke Ryan** and **Jack Weinberg**, the AutoPlanner developers

Tell us the student's tab name and the exact message you see (a screenshot is perfect). Please don't send tokens.
