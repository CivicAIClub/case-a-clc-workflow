# AutoPlanner pre-mortem: the 2026–27 school year

Written in October 2026, right after the handoff, by imagining the year has gone badly and asking why. For club developers and whoever looks after AutoPlanner next. Each scenario says what AutoPlanner does now, and what changed because of it.

## 1. A simulated year

Every update of a full school year was run, with the real code, for **30 made-up students with 5 classes each**: Sept 8 to June 11, with winter and spring break, the semester change on Jan 25, both DST changes and the Dec 28 – Jan 3 week. Teachers move due dates, unpublish, extend and add late work; staff type Status, Notes and "Added by staff" rows. Both runs, every day, as in production: 16,620 updates. The tool is [`tools/year-simulation`](../tools/year-simulation/), and its Doc size model matched a live Google read exactly.

Times are a **model** (Google's speed varies from day to day): a Docs read is 0.5 s plus 6.5 ms per KB, a write 1.4 s, calibrated on live runs in October 2026.

| | Typical student | Heaviest | Google's limit | Use |
|---|---|---|---|---|
| Doc size at year end (characters) | 181,000 | 208,000 | 1,020,000 | 20% |
| Tabs in a Doc at the year's peak | 39 | 39 | 100 | 39% (about 37 more each year: see Risks) |
| Saved data (Script Properties), all 30 students | 133 KB | | 500 KB | 27% |
| Largest single saved value | | 3.3 KB | 9 KB | 37% |
| Docs reads per update | 5 (8 on Mondays) | 9 | | |
| Size of a read | 347 KB | 576 KB; 3.9 MB for the rare read with Past weeks | | |
| Docs writes per update | 18 | 24 | | |
| One student's update (model) | 49 s | 80 s; a 45-assignment week 64 s | | |
| The midnight run, 30 students | 26 min | 34 min (the first run, making 30 Docs) | | |
| Longest single execution | | 19 min | 30 min | 63% (batches stop starting students at 18 minutes) |
| Docs writes per minute | 24 | 26 | 60 | 43% (now paced at 40 at most) |
| Docs reads per minute | | 17 | 300 | 6% |
| Automatic update time per day | 50 min | 58 min | 6 h | 16% |

Nothing is near Google's limits within a year. The simulation also found these, all fixed:

1. **Overdue work extended after its week was filed came back blank** (329 typed Status and Notes lost in the year). Past weeks aren't read on a normal update. Now, when a week is filed, the IDs of its assignments with a Status or Note are remembered for 10 weeks (never the notes), and if one comes back, that update reads Past weeks once and copies them back: the copy staff edited last. Now 0 lost.
2. **Work pushed past the 4 weeks, then back, came back blank** (50 of 59 cases). Fixed by the kept rows (scenario b) and (1). Now 0 lost.
3. **One passing error on a read switched the rest of a run to full reads**, about 5 times bigger. A read is now tried again first.
4. **If Apps Script's time limit dropped back to 6 minutes** while AutoPlanner still planned for 30, every batch was cut off and a run took 101–160 minutes with 3–5 students failing. Now the first cut-off batch shows it: AutoPlanner plans for 6 minutes (runs take about 34 minutes, with no failures) and the weekly email asks the owner to measure again.
5. **Google allows 100 tabs in a Doc**, and a Doc kept from year to year passes that in its third year. Updates now stop with a clear message at the limit, and the weekly email warns from 80 tabs. The quick start says to start fresh Docs each September.
6. **Class colors could change** when the class list did (5 of 105 at the semester change). Each Doc now keeps its colors.
7. **The New Year week was titled "Week of Dec 28 – Jan 3, 2026"**, which reads like Jan 3, 2026. It's now "Week of Dec 28, 2026 – Jan 3, 2027".

Not changed: if staff type in one table on Sunday evening, after the last update of a week, Past weeks shows the two tables disagreeing for that row (rare: 0 times on the real schedule; by design, AutoPlanner never edits a filed week).

## 2. Scenarios

| | Scenario | What happens now | Changed |
|---|---|---|---|
| a | An assignment has no due date in Canvas | It isn't listed (a day-by-day planner can't place it). If staff had typed on it before its due date was removed, its row stays in its week, marked "No due date". | Kept rows (b); quick start says to use "Added by staff" for undated work |
| b | An assignment is deleted or unpublished in Canvas | If staff typed a Status or Note on it, its row stays in its week with them, and Priority says "Not on Canvas" (or "Now due Nov 30" if it moved outside the 4 weeks). If it comes back, they follow it. Untouched rows just go. | **Fixed.** Before, the Status and Notes vanished silently at the next update, even if a teacher unpublished an assignment for an hour. |
| c | An assignment is renamed, or its class is renamed | Status and Notes go by the Canvas link, which doesn't change, so they stay. Moving work between classes in Canvas makes a new assignment (new link); the old one is handled as in (b). | Tests added |
| d | A student drops or adds a class mid-term; the semester changes | A new class gets a table every week. A dropped class's typed rows stay in their week as in (b), in a table for that class in that week only. Every class keeps its color through the change (simulation finding 6). | Kept rows (b); stable colors |
| e | Every token expires the same week (all tokens made Oct 4 expire Jan 2, during winter break) | Each of those students' updates fails with "This student's Canvas token expired on Jan 2…" until renewed; their Docs keep the last update. The page now warns **three weeks** ahead (was two), so the list shows up around Dec 12, before break. The weekly email lists them too. | **Fixed** (warning window, health email, quick start: renew in early December) |
| f | Two updates at once; an update during a scheduled run; a teacher change during a run | A student's row is held while it updates, so two updates never write one Doc. A run that reaches a student being updated from the page now tries them again at the end. A teacher changed while a new student's first Doc is being made now moves that Doc to the new teacher's folder. | **Fixed** (the last two) |
| g | The same student added twice with two tokens | Refused: students are matched by Canvas user, not by token. | Test added |
| h | Staff delete a table, rename or delete a week tab, delete or rename the staff table, type outside Status/Notes | A deleted By Class or By Day table: the other copy keeps everything. A **renamed** week tab gets its name back (found from its heading), with everything in it; before, a second copy was made and the renamed tab stayed forever. A **deleted** week tab comes back with its Statuses (from AutoPlanner's record), not its Notes (only their fingerprints are kept outside the Doc); Version history can bring them back. The staff table survives a renamed or deleted heading. Text typed outside Status/Notes is rewritten, as documented. | **Fixed** (renamed tab, deleted tab's Statuses, and a replaced Doc's Statuses) |
| i | Summer: tokens expired and the schedule still on | Every nightly update would fail. The owner now runs **pauseAutomaticUpdates** in June and **resumeAutomaticUpdates** in September; the page and the health email know. The quick start describes starting each year with fresh Docs. | **Fixed** (pause/resume, documented) |
| j | A teacher's folder is renamed, trashed or deleted | Renamed: fine (kept by ID). Trashed or moved out of the shared folder: a new folder is made and every file in the old one moves into it, out of the trash, so nothing is lost. Before, the Docs in a trashed folder counted as deleted and new, empty ones were made. Deleted for good (emptied from the trash): those Docs are gone; new ones are made, with their Statuses (h). | **Fixed** (trashed or moved) |
| k | Canvas is down or rate-limiting for a whole run | Each student fails quickly with "Canvas is busy…", and their Docs keep the last update. A run now stops after 5 students in a row find Canvas down, rather than keep asking, and says who wasn't tried. | **Fixed** (stop early) |
| l | A very heavy week (40+ assignments for one student) | About 1,000 requests for that week: 5 writes instead of 1–2. In the simulation a 45-assignment week took 64 s to update (model) and stayed far from every limit. | Writes paced (below) |
| | Comments on week tabs | A rebuild deletes the old tab, so its comments lose their place (Google keeps them in the comment list, unanchored; checked live). The Docs API can't move a comment. The quick start says to use Notes for anything to keep. | Documented |
| | Docs writes per minute | Google allows 60 Docs writes a minute per account. With faster reads, back-to-back updates could get close. Each execution now keeps to 40 a minute. | **Fixed** (pacing) |

## 3. Risks

Likely and harmful risks were fixed (section 2). These remain, and are in the quick start's "Long-term care":

| Risk | Likelihood | Harm | What covers it |
|---|---|---|---|
| The owner's account closes (graduation) before ownership moves | Certain by June 2027 if nobody acts | Everything stops; Docs owned by that account are deleted | Quick start: "Moving AutoPlanner to a new owner"; the weekly email warns when updates stop |
| Tokens expire for many students at once | Every ~90 days | Planners go stale until renewed | 3-week warning on the page, the weekly email, quick start |
| A Doc keeps every past week, so it grows | Every year | Slower reads in year 2+; Google's size limit eventually | Quick start: fresh Docs each September. In the simulation a year added about 200,000 characters (20% of Google's limit) and 37 tabs (of 100); the weekly email warns at 80 tabs and updates stop with a clear message near 100 |
| A teacher's folder or a Doc is deleted *and* emptied from the trash | Rare | Notes in it are gone (Statuses come back) | Only the owner can trash or delete files; Version history can't help once a Doc is gone |
| Staff use comments for important notes | Possible | Comments lose their place after an update | Quick start: use Notes |
| Google slows down (as on Oct 5) | Occasional | Updates take longer | Updates stop cleanly between weeks before the time limit; batches plan by each student's last time |
| Canvas changes its API or Pomfret changes token rules | Rare | Updates fail | The weekly email; the "Needs attention" messages say what Canvas said |
