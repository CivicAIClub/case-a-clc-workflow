'use strict';
// Builds the metric table (summary.json + summary.md) from the simulation's result files.
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, 'out');
const load = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const school = load('results.json');
const schoolU = load('results-updates.json');
const prod = fs.existsSync(path.join(D, 'results-prod.json')) ? load('results-prod.json') : null;
const prodU = prod ? load('results-prod-updates.json') : null;
const cal = load('calibration.json');

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const max = (a) => (a.length ? Math.max(...a) : null);
const r1 = (x) => Math.round(x * 10) / 10;
const pctOf = (v, lim) => r1((v / lim) * 100);
const flag = (p) => (p >= 70 ? '>=70%' : p >= 50 ? '>=50%' : '');

function perStudent(U, idx, filter) {
  const u = U.updates.filter((x) => x.s === idx && x.ok && !x.created && (!filter || filter(x)));
  const kb = [].concat(...u.map((x) => x.readKB));
  return {
    n: u.length,
    sec: { median: r1(med(u.map((x) => x.ms / 1000))), max: r1(max(u.map((x) => x.ms / 1000))) },
    reads: { median: med(u.map((x) => x.reads)), max: max(u.map((x) => x.reads)) },
    readKB: { median: r1(med(kb)), max: r1(max(kb)) },
    writes: { median: med(u.map((x) => x.writes)), max: max(u.map((x) => x.writes)) },
    requests: { median: med(u.map((x) => x.requests)), max: max(u.map((x) => x.requests)) },
    reqPerWrite: r1(u.reduce((n, x) => n + x.requests, 0) / Math.max(1, u.reduce((n, x) => n + x.writes, 0))),
    sleeps: { median: med(u.map((x) => x.sleeps)), sleepSec: r1(med(u.map((x) => x.sleepMs / 1000))) },
    split: { readS: r1(med(u.map((x) => x.readMs / 1000))), writeS: r1(med(u.map((x) => x.writeMs / 1000))), sleepS: r1(med(u.map((x) => x.sleepMs / 1000))), otherS: r1(med(u.map((x) => x.otherMs / 1000))) },
    docsOnlySec: { median: r1(med(u.map((x) => (x.ms - x.otherMs) / 1000))), max: r1(max(u.map((x) => (x.ms - x.otherMs) / 1000))) },
  };
}

function summarize(R, U, label) {
  const p = R.picks;
  const T = p.typicalStudent, H = p.heaviestStudent, HW = p.heavyWeekStudent;
  const ds = (i) => R.docSize[i];
  const monday = (x) => x.dow === 0 && x.run === 'midnight';
  const runs = U.runs;
  const mid = runs.filter((r) => r.run === 'midnight');
  const perDay = {};
  U.executions.forEach((e) => { perDay[e.date] = (perDay[e.date] || 0) + e.ms; });
  const out = {
    label,
    students: { typical: T, heaviest: H, heavyWeek: HW },
    docChars: {
      typical: { yearEnd: ds(T).finalModel, peak: ds(T).peakModel },
      heaviest: { yearEnd: ds(H).finalModel, peak: ds(H).peakModel },
      heavyWeek: { yearEnd: ds(HW).finalModel, peak: ds(HW).peakModel },
      allPeakMax: Math.max(...R.docSize.map((d) => d.peakModel)),
      limit: 1020000,
    },
    tabs: { typicalPeak: ds(T).peakTabs, heaviestPeak: ds(H).peakTabs, maxPeak: Math.max(...R.docSize.map((d) => d.peakTabs || d.tabsFinal)), yearEnd: Math.max(...R.docSize.map((d) => d.tabsFinal)), limit: 100 },
    props: {
      peakTotal: R.props.peak.maxTotal, peakAt: R.props.peak.maxTotalAt, peakBreakdown: R.props.peak.maxTotalBreakdown,
      finalTotal: R.props.final.total, finalBreakdown: R.props.final.by,
      largestValue: R.props.peak.maxValue, writtenPerDocMonthlyMax: R.props.peak.writtenMonthlyMax, writtenParts: R.props.peak.writtenMaxParts,
      limitTotal: 500 * 1024, limitValue: 9 * 1024,
    },
    perUpdate: {
      typical: perStudent(U, T), heaviest: perStudent(U, H), heavyWeekStudentInHeavyWindow: perStudent(U, HW, (x) => x.date >= '2026-12-21' && x.date <= '2027-01-15'),
      typicalMondays: perStudent(U, T, monday), heaviestMondays: perStudent(U, H, monday),
      typicalOtherDays: perStudent(U, T, (x) => !monday(x)),
      allStudents: R.updates.all, mondaysAll: R.updates.mondays, otherDaysAll: R.updates.otherDays, created: R.updates.created,
      heavyWeekWorst: R.updates.heavyWeekDetail,
    },
    runs: {
      midnightMinutes: { median: r1(med(mid.map((r) => r.ms / 60000))), max: r1(max(mid.map((r) => r.ms / 60000))) },
      midnightFirstRunMinutes: r1(mid[0].ms / 60000),
      executionsPerRun: { median: med(mid.map((r) => r.executions)), max: max(mid.map((r) => r.executions)) },
      longestExecutionMin: r1(max(U.executions.map((e) => e.ms / 60000))),
      writesPerMinMax: max(runs.map((r) => r.maxWritesPerMin)), writesPerMinMedianOfRunMax: med(runs.map((r) => r.maxWritesPerMin)),
      writesPerMinAvg: r1(med(runs.map((r) => r.writes / (r.ms / 60000)))),
      readsPerMinMax: max(runs.map((r) => r.maxReadsPerMin)),
      triggerRuntimePerDayMin: { median: r1(med(Object.values(perDay).map((x) => x / 60000))), max: r1(max(Object.values(perDay).map((x) => x / 60000))) },
      failedUpdates: R.updates.failedCount, partialUpdates: R.updates.partialCount, executionErrors: R.runs.executionErrors.length,
    },
    quotaPerDay: R.quotaPerDay,
    sevenPmVsMidnight: R.updates.sevenPmVsMidnight,
    checks: R.checks,
    typed: {
      typed: R.typedEvents.typed, mismatches: R.typedEvents.mismatchesCount, mismatchSamples: R.typedEvents.mismatches.slice(0, 5),
      movedOutOfFiledWeekLost: R.typedEvents.extensionAfterFilingCount, byMoveKind: R.typedEvents.byMoveKind, movedSamples: R.typedEvents.extensionAfterFiling.slice(0, 3),
      leftWindow: R.typedEvents.leftWindow, lostAfterLeavingWindow: R.typedEvents.lostAfterLeavingWindowCount, keptAfterLeavingWindow: R.typedEvents.keptAfterLeavingWindow,
      lostSamples: R.typedEvents.lostAfterLeavingWindow.slice(0, 2), gone: R.typedEvents.gone,
    },
    anomalyCounts: R.anomalyCounts, warnings: R.warnings, world: R.world, wallSeconds: R.wallSeconds,
  };
  return out;
}

const S = summarize(school, schoolU, 'school days (midnight Mon-Fri, 7 pm Mon+Thu)');
const P = prod ? summarize(prod, prodU, 'production (midnight + 7 pm every day)') : null;
const extra = {};
for (const f of ['results-stress-stale.json', 'results-stress-6min.json', 'results-yearcross.json', 'targeted.json']) {
  if (fs.existsSync(path.join(D, f))) extra[f] = load(f);
}
const stress = (f) => {
  const r = extra[f];
  if (!r) return null;
  return { runsMinutes: r.runs.midnight.minutes, executions: r.runs.midnight.executions, longestExecMin: r.runs.midnight.longestExecMin, failedPerRun: r.runs.midnight.failed, failedTotal: r.updates.failedCount, anomalies: r.anomalyCounts };
};
const summary = {
  calibration: cal, school: S, prod: P,
  stressRealLimit6minPropertyStale1800: stress('results-stress-stale.json'),
  stressRealLimit6minProperty360: stress('results-stress-6min.json'),
  yearcross: extra['results-yearcross.json'] ? { tabs: extra['results-yearcross.json'].yearcross.tabs, anomalies: extra['results-yearcross.json'].anomalyCounts, checks: extra['results-yearcross.json'].checks } : null,
  targeted: extra['targeted.json'],
};
fs.writeFileSync(path.join(D, 'summary.json'), JSON.stringify(summary, null, 2));

// Table
const rows = [];
const row = (metric, typ, hvy, limit, pct, note) => rows.push({ metric, typ, hvy, limit, pct, flag: flag(pct || 0), note: note || '' });
const X = S;
row('Doc size, year end (index units ~ chars)', X.docChars.typical.yearEnd, X.docChars.heaviest.yearEnd, 1020000, pctOf(X.docChars.heaviest.yearEnd, 1020000));
row('Doc size, peak (during an update)', X.docChars.typical.peak, X.docChars.heaviest.peak, 1020000, pctOf(X.docChars.heaviest.peak, 1020000), 'heavy-week student ' + X.docChars.heavyWeek.peak);
row('Tabs in the Doc, peak', X.tabs.typicalPeak, X.tabs.heaviestPeak, 100, pctOf(X.tabs.maxPeak, 100), 'all students same; +~37/yr');
row('Script Properties total, peak (30 students)', X.props.peakTotal, '', 512000, pctOf(X.props.peakTotal, 512000));
row('Largest single property value', X.props.largestValue.bytes, X.props.largestValue.key, 9216, pctOf(X.props.largestValue.bytes, 9216));
row('Docs reads per update (median/max)', X.perUpdate.typical.reads.median + '/' + X.perUpdate.typical.reads.max, X.perUpdate.heaviest.reads.median + '/' + X.perUpdate.heaviest.reads.max, '', null);
row('Read JSON KB (median/max)', X.perUpdate.typical.readKB.median + '/' + X.perUpdate.typical.readKB.max, X.perUpdate.heaviest.readKB.median + '/' + X.perUpdate.heaviest.readKB.max, '', null);
row('Docs writes per update (median/max)', X.perUpdate.typical.writes.median + '/' + X.perUpdate.typical.writes.max, X.perUpdate.heaviest.writes.median + '/' + X.perUpdate.heaviest.writes.max, '', null);
row('Requests per update (median/max)', X.perUpdate.typical.requests.median + '/' + X.perUpdate.typical.requests.max, X.perUpdate.heaviest.requests.median + '/' + X.perUpdate.heaviest.requests.max, '500/call', null, 'BATCH_CHUNK 200 per call');
row('Update time s (median/max)', X.perUpdate.typical.sec.median + '/' + X.perUpdate.typical.sec.max, X.perUpdate.heaviest.sec.median + '/' + X.perUpdate.heaviest.sec.max, '', null, 'heavy week max ' + X.perUpdate.heavyWeekStudentInHeavyWindow.sec.max);
row('Midnight run, 30 students (min, median/max)', X.runs.midnightMinutes.median, X.runs.midnightMinutes.max, '', null);
row('Longest single execution (min)', X.runs.longestExecutionMin, '', 30, pctOf(X.runs.longestExecutionMin, 30));
row('Docs write calls per minute (max)', X.runs.writesPerMinMedianOfRunMax, X.runs.writesPerMinMax, 60, pctOf(X.runs.writesPerMinMax, 60));
row('Docs read calls per minute (max)', '', X.runs.readsPerMinMax, 300, pctOf(X.runs.readsPerMinMax, 300));
if (P) row('Trigger runtime per day (min), production schedule', P.runs.triggerRuntimePerDayMin.median, P.runs.triggerRuntimePerDayMin.max, 360, pctOf(P.runs.triggerRuntimePerDayMin.max, 360));
if (P) row('Properties calls per day, production schedule', P.quotaPerDay.props.median, P.quotaPerDay.props.max, 500000, pctOf(P.quotaPerDay.props.max, 500000));
if (P) row('URL Fetch calls per day, production schedule', P.quotaPerDay.fetches.median, P.quotaPerDay.fetches.max, 100000, pctOf(P.quotaPerDay.fetches.max, 100000));
const md = ['| Metric | Typical | Heaviest | Limit | % of limit (heaviest) | Flag | Note |', '|---|---|---|---|---|---|---|']
  .concat(rows.map((r) => `| ${r.metric} | ${r.typ} | ${r.hvy} | ${r.limit} | ${r.pct === null ? '' : r.pct + '%'} | ${r.flag} | ${r.note} |`)).join('\n');
fs.writeFileSync(path.join(D, 'summary.md'), md + '\n');
console.log(md);
