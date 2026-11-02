# Year simulation (pre-mortem)

Runs the real `apps_script/*.gs` for a whole school year, with 30 made-up students, a fake Canvas, a fake Docs API that returns what Google's reads really look like, and a simulated clock. It's how the numbers in [`docs/pre-mortem-2026-27.md`](../../docs/pre-mortem-2026-27.md) were made. It's a developer tool: nothing here is pasted into Apps Script.

```bash
cd tools/year-simulation
node year.js students=30 schedule=prod quiet=1 out=out/results-prod.json   # the real schedule: 7 pm and midnight, every day (about 6 min)
node year.js students=30 quiet=1                                          # school days only (about 3 min)
node year.js students=30 end=2026-09-25 limit=360 rtprop=1800 quiet=1 out=out/results-stress-stale.json
node year.js students=30 end=2026-09-25 limit=360 rtprop=360 quiet=1 out=out/results-stress-6min.json
node year.js students=1 start=2026-12-14 end=2027-01-12 scenario=yearcross sample7pm=0,1,2,3,4,5,6 weekends=1 schedule=prod quiet=1 out=out/results-yearcross.json
node calibrate.js && node targeted.js && node analyze.js   # the metric table: out/summary.md
```

- **What it runs:** the whole production path. A trigger calls `scheduledRun`, which runs batches, `updateOneStudent_`, the real Canvas.gs scheduling and `upsertPlannerDocument_`, then `continueRun` when a batch is cut off. Set `SIM_REPO` to run another copy of the code, for example an older commit exported with `git archive`.
- **The world:**
  - 30 students, each with 5 classes.
  - Winter and spring break, the semester change on Jan 25, and both DST changes.
  - Due-date moves, removals, late additions and extensions.
  - Staff typing Status, Notes and "Added by staff" rows.
- **The checks after every update:**
  - Each week tab holds exactly what Canvas has, apart from rows kept on purpose ("Not on Canvas" …).
  - Due days, times and priorities are right.
  - Everything staff typed is still there, or comes back with its assignment.
  - Past weeks are untouched.
- **The time model:** Google's real speed varies, so the times are a model, not a measurement.
  - A Docs read takes 0.5 s plus 6.5 ms per KB, and a write 1.4 s. These were calibrated on live runs in October 2026.
  - Sleeps take as long as the code asks.
  - Canvas and Drive calls get small assumed times.
- **Calibration:** `calibrate.js` checks the Doc size model against a live Google read (`tests/fixtures/live-week-tab-read.json`, made from `week-tab-requests-live.json`). It matched exactly.
- **Not modeled:**
  - Google's latency changing from day to day
  - quota errors
  - staff typing *during* an update (the unit tests cover that)
  - tokens expiring
- **Results:** they go to `out/`, which git ignores.
