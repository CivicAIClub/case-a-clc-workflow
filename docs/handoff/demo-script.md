# AutoPlanner handoff demo (6 minutes)

For the Civic AI Club team presenting AutoPlanner to the CLC staff. Two roles: the **Presenter** talks, the **Driver** clicks. Use only a club member's own Canvas student; no real CLC student data on screen.

A Doc update takes about 2 minutes, so the script starts one early and talks while it runs.

## Morning checklist

- [ ] **Chrome profile signed in only to the presenter's Pomfret account.** Other Google accounts in the same window can stop the page from loading.
- [ ] Open AutoPlanner in that profile. "Signed in as …" shows the right email, and "Automatic updates run every day at about 7 pm and about midnight" is shown.
- [ ] The demo student (your own Canvas account) is on the list, and **Last update** shows last night's automatic run. That's your proof the schedule works.
- [ ] In the demo student's Doc, type a Status ("In progress") and a Note on one assignment in **this week's** tab **before** the meeting.
- [ ] In the same Doc, check for **Past weeks** in the sidebar. If the Doc had a tab for last week, the midnight run moved it there. If there's no Past weeks tab yet, skip the Past weeks line in the script.
- [ ] Open tabs, in order: AutoPlanner, the Drive folder **AutoPlanner – CLC Student Planners**, the demo Doc.
- [ ] Print the [quick start](CLC-quick-start.md) for each staff member and a stack of [student token guides](student-token-guide.md).
- [ ] Notifications off, browser zoomed to 125%, no other tabs. Never paste a token while the projector is on.

## The script

**0:00–0:40 The problem** (Presenter)
"Today you log in to each student's Canvas and copy assignments into a Google Doc by hand. AutoPlanner does that copying for you: one Doc per student, kept up to date every evening."

**0:40–1:20 One link, your Pomfret account** (Driver shows the page, then clicks **Update** on the demo student's row)
"This is the only link you need. You sign in with your Pomfret account; it says who you are at the top. It works on any staff computer, because everything is saved in AutoPlanner, not the browser. I've just started an update for one student; it takes about two minutes, so let's keep going."

**1:20–2:30 Adding a student** (Driver points at **Add a student**; don't paste a real token)
"Each student makes a token in Canvas Settings; this sheet shows them how. You paste it here once. AutoPlanner checks it with Canvas and makes their Doc. After that, even you only see the last four characters."

**2:30–3:30 Automatic updates** (Presenter, pointing at the **Update** card)
"Every day at about 7 pm and midnight, AutoPlanner updates every Doc on Google's servers, so no computer needs to be on. Here's last night's run. If a student's token stops working, it says so here and on their row, in plain English. The other students still update."

**3:30–4:45 The Doc** (once the row shows ✅, Driver clicks **Open their Doc ↗**)
The **CLC Planner** tab opens first: "One page per student: this week by class, and a link straight to this week's tab. On weekends it looks ahead to the coming week." Open the **Document tabs** sidebar: one tab per week. "Every class gets its own table, even when nothing is due, and By Day shows the same work day by day." Point at the reminder line at the top, then at the Status and Note typed before the meeting: "You type Not started, In progress, or Complete, and any notes you like. That update just refreshed everything from Canvas, and your Status and Notes are still here. If a teacher moves the due date, they move with the assignment." If it's there, point at **Past weeks**: "When a week ends, it's filed here with everything you typed, and it never changes."

**4:45–5:30 Three things to know** (Presenter)
1. "The Docs live in this Drive folder, already shared with all of you. Keep them in it."
2. "If you're signed in to several Google accounts, use a window with only your Pomfret account."
3. "Need it now instead of tonight? Click Update all students now."

**5:30–6:00 Hand over** (Presenter)
Hand out the quick start and token guides. "If anything looks wrong, email Cayden or Luke a screenshot of the message." Take questions.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| "Not authorized" with **your** email | Your address isn't on AutoPlanner's list. | Ask the club to add you to `ALLOWED_USERS`. |
| "Not authorized" with a **different** email, or a Google error page | You're signed in to several Google accounts. | Use a browser window or Chrome profile signed in only to your Pomfret account. |
| ⚠️ "Canvas didn't accept this student's token…" | The token expired, was deleted, or was pasted incompletely. | Get a new token from the student, click **Edit**, paste it, click **Save**, then **Update**. |
| "That token belongs to …" / "now belongs to a different Canvas user" | Someone else's token was pasted on this row. | Paste this student's own token, or use **Add student** for the other one. |
| "Google is limiting how fast Docs can be edited" | Google's per-minute limit on Doc edits. | Nothing; it's retried at the next update. Don't click Update repeatedly. |
| "Took longer than Apps Script allows" | A very large planner ran past Google's 6-minute limit. | It's retried at the next update; tell the club if it keeps happening. |
| "AutoPlanner only updates Docs in the … folder" | The student's Doc was moved out of the shared folder. | Move it back into **AutoPlanner – CLC Student Planners**, then click **Update**. |
| A week's tab is gone from under **CLC Planner** | The week ended. | Open **Past weeks**: it's there, with its Status and Notes (and a gray Priority column). |
| "Their Doc was deleted, so AutoPlanner made a new one." | Someone deleted the student's Doc. | Nothing; the new Doc is in the shared folder. The old one is in the owner's Drive trash for 30 days. |
| "Automatic updates haven't finished since …" | The automatic updates stopped, usually because the owner's account changed. | Club: see "Long-term care" in the quick start. |
| "An update for all students is running" | An update is already going (yours or the automatic one). | Wait; the progress shows under **Update**. |
| "Automatic updates are not turned on yet" | The daily triggers aren't installed. | Club: run `setupTriggers` in the Apps Script editor. |
| Club only: "Script function not found: doGet" | The deployment still points at an old version. | **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** |
