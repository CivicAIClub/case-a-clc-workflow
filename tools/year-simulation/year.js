'use strict';
/**
 * AutoPlanner year simulation (pre-mortem). Runs the REAL apps_script/Code.gs, Canvas.gs and App.gs
 * (this repository's, or SIM_REPO's) in a Node vm, through the production path:
 *   trigger -> scheduledRun -> startRun_ -> processRunBatch_ -> updateOneStudent_ ->
 *   fetchStudentSchedule_ (real Canvas.gs, answered by a fake Canvas API) -> upsertPlannerDocument_
 *   -> continueRun executions when a batch runs out of time,
 * with a simulated clock (Date / Date.now() inside the sandbox) that moves by a time model:
 *   Docs read  = 0.5 s + 6.5 ms per KB of the read's JSON
 *   Docs write = 1.4 s per batchUpdate call
 *   Utilities.sleep(ms) = ms
 *   other (assumed, reported separately): Canvas fetch 0.4 s, fetchAll round 0.9 s, DriveApp lookup 0.15 s,
 *   DocumentApp.openById / setName 0.3 s, DocumentApp.create 1.5 s.
 * All data is made up. Usage: node year.js [students=30] [start=2026-09-08] [end=2027-06-11] [seed=7]
 *   [out=out/results.json] [exact=1] [scenario=main|yearcross] [sample7pm=1,4] [quiet=1] [schedule=school|prod]
 *   [weekends=1] [limit=1800] [rtprop=1800]. See README.md.
 */
const path = require('path');
const fs = require('fs');
// The code it runs: this repository (or SIM_REPO, for example an exported older commit).
const R = process.env.SIM_REPO || path.join(__dirname, '..', '..');
const { createSandbox, formatDate } = require(R + '/tests/helpers/gas-sandbox');
const { fakeServices } = require(R + '/tests/helpers/gas-services');
const W = require('./lib/world');
const real = require('./lib/realistic');
const { createSimDocs } = require('./lib/simdocs');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const OPT = {
  students: Number(args.students || 30),
  start: args.start || W.FIRST_DAY,
  end: args.end || W.LAST_DAY,
  seed: Number(args.seed || 7),
  out: args.out || path.join(__dirname, 'out', 'results.json'),
  exact: args.exact === '1',
  scenario: args.scenario || 'main',
  sample7pm: (args.sample7pm || '0,3').split(',').map(Number), // weekday index: 0 = Monday, 3 = Thursday
  quiet: args.quiet === '1',
  weekends: args.weekends === '1',
  limitSec: Number(args.limit || 1800), // when Apps Script really stops an execution
  rtprop: args.rtprop || '1800', // the RUNTIME_LIMIT_SECONDS Script Property ('unset' = not set)
  schedule: args.schedule || 'school', // 'school': midnight runs Mon-Fri, 7 pm on sample days; 'prod': both runs every day
};
if (OPT.schedule === 'prod') { OPT.weekends = true; OPT.sample7pm = [0, 1, 2, 3, 4, 5, 6]; }
const wallStart = Date.now();

// ---- clock -------------------------------------------------------------------------------------------
const clock = {
  T: W.nyToMs('2026-09-07', 18, 0), execStart: null, limitMs: OPT.limitSec * 1000, killed: false,
  advance(ms, kind) {
    if (this.killed) throw new Error('Exceeded maximum execution time');
    this.T += ms;
    if (cur) cur.time[kind] = (cur.time[kind] || 0) + ms;
    if (this.execStart !== null && this.T - this.execStart > this.limitMs) {
      this.killed = true;
      throw new Error('Exceeded maximum execution time');
    }
  },
};
const RealDate = Date;
class SimDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(clock.T); else super(...a); }
  static now() { return clock.T; }
}

// ---- world, Docs, services ---------------------------------------------------------------------------
const world = W.createWorld(OPT.seed, { students: OPT.students, heavyStudent: OPT.scenario === 'main' && OPT.students >= 2 });
world.setNow(() => clock.T);
if (OPT.scenario === 'yearcross') {
  // Two assignments due in the week that crosses the new year (Dec 28 – Jan 3), the rest as usual.
  const st = world.students[0];
  const c = st.s1[0];
  [['2026-12-30', 23, 59], ['2027-01-02', 10, 0]].forEach(([d, hh, mm], i) => {
    const id = 9900000 + i;
    const a = { id, courseId: c.id, name: 'Winter reading log, part ' + (i + 1) + ' (over the break)', date: d, hh, mm, dueMs: W.nyToMs(d, hh, mm), publishMs: W.nyToMs('2026-12-01', 8, 0), removed: false,
      html_url: 'https://pomfret.instructure.com/courses/' + c.id + '/assignments/' + id };
    c.assignments.push(a); world.byId.set(id, a); c.ver++;
  });
}
const anomalies = [];
const anomalyCounts = {};
const noteAnomaly = (a) => {
  anomalyCounts[a.kind] = (anomalyCounts[a.kind] || 0) + 1;
  if (anomalyCounts[a.kind] <= 25) anomalies.push(Object.assign({ date: W.nyParts(a.at || clock.T).date }, a));
};
const simdocs = createSimDocs({ clock, rng: world.rng, onAnomaly: noteAnomaly, exactReads: OPT.exact });
let cur = null; // the update being measured

const OWNER = 'owner@pomfret.org';
const STAFF = 'staff@pomfret.org';
const svc = fakeServices({ owner: OWNER, active: STAFF, props: {
  ALLOWED_USERS: OWNER + ', ' + STAFF + ', clc-office@pomfret.org',
  DOCS_FOLDER_ID: 'FOLDER123',
  CLC_TEACHERS: world.teachers.map((t) => t.name + ' <' + t.email + '>').join(', '),
  RUNTIME_LIMIT_SECONDS: OPT.rtprop,
  COURSE_EXCLUDE: 'advisory',
} });
if (OPT.rtprop === 'unset') delete svc.props.RUNTIME_LIMIT_SECONDS;
const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(world.rng() * 16)]; return s; };
const uuid = () => hex(8) + '-' + hex(4) + '-4' + hex(3) + '-a' + hex(3) + '-' + hex(12);
const docIdChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const newDocId = () => { let s = '1'; for (let i = 0; i < 43; i++) s += docIdChars[Math.floor(world.rng() * docIdChars.length)]; return s; };
const Utilities = {
  formatDate,
  sleep: (ms) => { if (cur) cur.sleeps.push(ms); clock.advance(ms, 'sleep'); },
  getUuid: uuid,
};
// Count Properties calls and URL fetches per day (Apps Script quotas: 500,000 / 100,000 per day).
const quotaDay = {};
const qd = () => (quotaDay[W.nyParts(clock.T).date] = quotaDay[W.nyParts(clock.T).date] || { props: 0, fetches: 0 });
const realProps = svc.globals.PropertiesService;
const PropertiesService = { getScriptProperties: () => {
  const p = realProps.getScriptProperties();
  const c = (f) => (...a) => { qd().props++; return f(...a); };
  return { getProperty: c(p.getProperty), setProperty: c(p.setProperty), deleteProperty: c(p.deleteProperty), getProperties: c(p.getProperties) };
} };
const drive = svc.globals.DriveApp;
const DriveApp = {
  getFolderById: (id) => { clock.advance(150, 'other'); return drive.getFolderById(id); },
  getFileById: (id) => { clock.advance(150, 'other'); return drive.getFileById(id); },
};
const handle = (id) => ({ getId: () => id, getUrl: () => 'https://docs.google.com/document/d/' + id + '/edit',
  setName: (n) => { clock.advance(300, 'other'); simdocs.docs.get(id).title = n; } });
const DocumentApp = {
  create: (name) => { clock.advance(1500, 'other'); const id = newDocId(); simdocs.createDoc(id, name); svc.addFile(id, name, null); return handle(id); },
  openById: (id) => { clock.advance(300, 'other'); if (!simdocs.docs.has(id)) throw new Error('Document ' + id + ' is missing'); return handle(id); },
};
const ScriptApp = Object.assign({}, svc.globals.ScriptApp, {
  newTrigger: (h) => {
    const b = svc.globals.ScriptApp.newTrigger(h);
    const create = b.create;
    b.create = () => { const t = create(); t.createdAt = clock.T; return t; };
    return b;
  },
});
const warns = {};
const sbConsole = {
  log: () => {}, info: () => {},
  warn: (...m) => { const k = String(m.join(' ')).replace(/[0-9A-Za-z_-]{30,}/g, '<id>').slice(0, 160); warns[k] = (warns[k] || 0) + 1; },
  error: (...m) => { const k = 'ERROR ' + String(m.join(' ')).slice(0, 160); warns[k] = (warns[k] || 0) + 1; },
};
let canvasFetchAt = new Map(); // app student id -> time of the last courses fetch
const sb = createSandbox({
  files: ['apps_script/Code.gs', 'apps_script/Canvas.gs', 'apps_script/App.gs'],
  fetchHandler: (url, params) => {
    if (/\/api\/v1\/courses\?/.test(url)) canvasFetchAt.set(((params && params.headers) || {}).Authorization, clock.T);
    return world.canvasHandler(url, params);
  },
  globals: Object.assign({}, svc.globals, { Utilities, DriveApp, DocumentApp, ScriptApp, PropertiesService, Docs: simdocs.service, Date: SimDate, console: sbConsole }),
});
const ctx = sb.context;
const urlFetch = ctx.UrlFetchApp;
ctx.UrlFetchApp = {
  fetch: (u, p) => { qd().fetches++; clock.advance(400, 'canvas'); return urlFetch.fetch(u, p); },
  fetchAll: (reqs) => { qd().fetches += reqs.length; clock.advance(900, 'canvas'); return urlFetch.fetchAll(reqs); },
};
simdocs.installRendering(ctx);
sb.logs.length = 0;

// ---- students -------------------------------------------------------------------------------------
const byAppId = new Map();
for (const st of world.students) {
  const res = ctx.addStudent(st.token, st.label, st.teacher);
  st.appId = res.student.id;
  byAppId.set(st.appId, st);
}
// The two daily triggers, as setupTriggers makes them.
const trig = (hour, minute) => ScriptApp.newTrigger('scheduledRun').timeBased().atHour(hour).nearMinute(minute).everyDays(1).inTimezone(W.TZ).create();
const midnightTrigger = trig(0, 15);
const eveningTrigger = trig(19, 0);

// ---- measurement state ---------------------------------------------------------------------------------
const updates = []; // one per student update
const executions = [];
const runs = [];
const sizeTrack = world.students.map(() => ({ peakModel: 0, peakContent: 0, peakAt: null, finalModel: 0, finalContent: 0, tabsFinal: 0, monthly: {} }));
const propsTrack = { maxTotal: 0, maxTotalAt: null, maxTotalBreakdown: null, maxValue: { key: null, bytes: 0 }, writtenMonthlyMax: {}, writtenMaxParts: 0, samples: [] };
const ledger = world.students.map(() => new Map()); // url -> typed Status/Note
const staffLedger = world.students.map(() => new Map()); // week title -> typed staff row
const checks = { updatesChecked: 0, weekTabsChecked: 0, typedChecks: 0, typedOk: 0, filedOk: 0, filedChecked: 0, staffRowChecks: 0, staffRowOk: 0,
  staffRowsFiledOk: 0, staffRowsFiledChecked: 0, dueTimeChecks: 0 };
const typedEvents = { typed: 0, lostAfterLeavingWindow: [], keptAfterLeavingWindow: 0, leftWindow: 0, extensionAfterFiling: [], gone: 0, mismatches: [] };
let runLabel = 'setup';
let today = null;

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');
function propsSnapshot() {
  const by = {};
  let total = 0;
  let maxV = { key: null, bytes: 0 };
  for (const [k, v] of Object.entries(svc.props)) {
    const b = bytes(k) + bytes(v);
    total += b;
    const prefix = /^(student|token|written|busy|run|trigger|probe)\./.exec(k) ? k.split('.')[0] + '.' : (k === 'teacherFolders' ? 'teacherFolders' : 'others');
    by[prefix] = (by[prefix] || 0) + b;
    if (bytes(v) > maxV.bytes) maxV = { key: k.replace(/[0-9A-Za-z_-]{30,}/, '<id>'), bytes: bytes(v) };
  }
  return { total, by, maxV };
}
function trackProps() {
  const s = propsSnapshot();
  if (s.total > propsTrack.maxTotal) { propsTrack.maxTotal = s.total; propsTrack.maxTotalAt = W.nyParts(clock.T).date + ' ' + runLabel; propsTrack.maxTotalBreakdown = s.by; }
  if (s.maxV.bytes > propsTrack.maxValue.bytes) propsTrack.maxValue = Object.assign({ at: W.nyParts(clock.T).date }, s.maxV);
}

const titleFor = (key) => ctx.buildWeekTabTitle_(key, ctx.scheduleShortDate_(key) + ' – ' + ctx.scheduleShortDate_(W.addDays(key, 6)));
const homeOf = (doc) => doc.tabs.find((t) => t.tabProperties.title === 'CLC Planner');
const docOf = (st) => { const rec = JSON.parse(svc.props['student.' + st.appId] || '{}'); return rec.docId ? simdocs.docs.get(rec.docId) : null; };
const urlId = (u) => Number(/\/assignments\/(\d+)/.exec(u)[1]);
const priorityFor = (todayText, date) => {
  const d = Math.round((Date.UTC(...date.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) - Date.UTC(...todayText.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)))) / 86400000);
  return d < 0 ? 'Past due' : d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d <= 3 ? 'Due Soon' : d <= 7 ? 'This Week' : 'Upcoming';
};

// ---- checks after each update -----------------------------------------------------------------------
function checkAfterUpdate(st, res, m) {
  const doc = docOf(st);
  if (!doc) return;
  checks.updatesChecked++;
  const nowDate = W.nyParts(m.start).date;
  const mon = W.monday(nowDate);
  const home = homeOf(doc);
  const bad = (kind, detail) => noteAnomaly({ doc: doc.id, kind, detail: Object.assign({ student: st.idx, run: runLabel }, detail), at: clock.T });
  if (!home) return bad('no-home-tab', {});
  // Structure.
  const allTitles = simdocs.all(doc).map((t) => t.tabProperties.title);
  if (new Set(allTitles).size !== allTitles.length) bad('duplicate-titles', { titles: allTitles });
  if (allTitles.some((t) => /\(updating\)$/.test(t))) bad('updating-leftover', { titles: allTitles.filter((t) => /updating/.test(t)) });
  const kids = home.childTabs || [];
  const weekKids = kids.filter((t) => ctx.weekKeyFromTabTitle_(t.tabProperties.title));
  const pastIdx = kids.findIndex((t) => t.tabProperties.title === 'Past weeks');
  if (pastIdx !== -1 && pastIdx !== kids.length - 1) bad('past-weeks-not-last', { titles: kids.map((t) => t.tabProperties.title) });
  const others = kids.filter((t) => !ctx.weekKeyFromTabTitle_(t.tabProperties.title) && t.tabProperties.title !== 'Past weeks');
  if (others.length) bad('unexpected-tab', { titles: others.map((t) => t.tabProperties.title) });
  const keys = weekKids.map((t) => ctx.weekKeyFromTabTitle_(t.tabProperties.title));
  if (keys.join() !== keys.slice().sort().join()) bad('week-tabs-out-of-order', { keys });
  if (keys.some((k) => k < mon) && res.ok) bad('ended-week-not-filed', { keys, mon });
  if (pastIdx !== -1) {
    const pk = (kids[pastIdx].childTabs || []).map((t) => ctx.weekKeyFromTabTitle_(t.tabProperties.title));
    if (pk.join() !== pk.slice().sort().reverse().join()) bad('past-weeks-out-of-order', { pk });
    if (pk.some((k) => !k || k >= mon)) bad('past-weeks-has-current', { pk, mon });
  }
  const partial = res.ok && /^Updated \d+ of \d+ weeks/.test(String(res.message));
  if (!res.ok || partial) return;
  // Content: every week of the next 4 has exactly the assignments Canvas had, once, with the right day/time.
  const fetchAt = canvasFetchAt.get('Bearer ' + st.token) || m.start;
  const exp = world.expectedWeeks(st, fetchAt);
  const seen = new Map();
  for (const t of weekKids) {
    const key = ctx.weekKeyFromTabTitle_(t.tabProperties.title);
    const allRows = real.assignmentRows(t.documentTab.body.content);
    const want = (exp[key] || []).map((a) => a.html_url).sort();
    // Rows AutoPlanner keeps on purpose (typed on, then left Canvas or these weeks): never one Canvas lists in this week.
    const isKept = (r) => /^(Not on Canvas|No due date|Now due )/.test(r.priority || '');
    allRows.filter(isKept).forEach((r) => { checks.keptRows = (checks.keptRows || 0) + 1; if (want.includes(r.url)) bad('kept-but-on-canvas', { week: key, url: r.url, shown: r.priority }); });
    const rows = allRows.filter((r) => !isKept(r));
    const cls = rows.filter((r) => r.kind === 'class').map((r) => r.url).sort();
    const day = rows.filter((r) => r.kind === 'day').map((r) => r.url).sort();
    checks.weekTabsChecked++;
    if (cls.join() !== want.join() || day.join() !== want.join()) {
      const extraUrls = cls.filter((u) => !want.includes(u));
      bad('week-content-mismatch', { week: key, missing: want.filter((u) => !cls.includes(u)).length, extra: extraUrls.length,
        extraRows: allRows.filter((r) => extraUrls.includes(r.url)).map((r) => [r.kind, r.priority, r.status, r.note, r.middle]),
        world: extraUrls.map((u) => { const a = world.byId.get(urlId(u)); return a ? { date: a.date, published: a.published, removed: a.removed, history: (a.history || []).map((h) => [h.kind, h.from, h.to, W.nyParts(h.t).date + ' ' + W.nyParts(h.t).time]) } : null; }),
        fetchAt: W.nyParts(fetchAt).date + ' ' + W.nyParts(fetchAt).time, weekFound: Object.keys(exp).find((k) => (exp[k] || []).some((a) => extraUrls.includes(a.html_url))) });
    }
    rows.forEach((r) => {
      if (seen.has(r.url) && seen.get(r.url) !== key) bad('assignment-in-two-weeks', { url: r.url, weeks: [seen.get(r.url), key] });
      seen.set(r.url, key);
      if (r.kind !== 'class') return;
      const a = world.byId.get(urlId(r.url));
      if (!a) return;
      checks.dueTimeChecks++;
      const dueCell = r.row.tableCells[2] ? real.cellText(r.row.tableCells[2]) : '';
      if (r.middle !== W.WEEKDAYS[W.weekday(a.date)] || dueCell !== W.hmText(a.hh, a.mm)) bad('due-day-or-time-wrong', { url: r.url, shown: [r.middle, dueCell], want: [W.WEEKDAYS[W.weekday(a.date)], W.hmText(a.hh, a.mm), a.date] });
      const pr = priorityFor(W.nyParts(fetchAt).date, a.date);
      if (r.priority !== pr) bad('priority-wrong', { url: r.url, shown: r.priority, want: pr, date: a.date });
    });
  }
  Object.keys(exp).forEach((k) => { if (!keys.includes(k)) bad('week-tab-missing', { week: k, n: exp[k].length }); });
  // Typed Status and Notes.
  const archived = pastIdx === -1 ? [] : kids[pastIdx].childTabs || [];
  const currentCourses = new Set(world.coursesOf(st, nowDate).map((c) => c.id));
  const copiesIn = (tabs, url) => {
    const out = [];
    tabs.forEach((t) => real.assignmentRows(t.documentTab.body.content).forEach((r) => { if (r.url === url) out.push({ week: ctx.weekKeyFromTabTitle_(t.tabProperties.title), kind: r.kind, status: r.status, note: r.note }); }));
    return out;
  };
  for (const [url, L] of ledger[st.idx]) {
    if (L.state === 'gone' || L.state === 'done') continue;
    const sawEdit = L.synced;
    if (L.typedAt < m.start) L.synced = true; // this update read the Doc after the edit
    const a = world.byId.get(urlId(url));
    const visible = a && !a.removed && a.publishMs <= fetchAt && currentCourses.has(a.courseId);
    const inWindow = visible && a.date >= mon && a.date <= W.addDays(mon, 27);
    if (L.state === 'filed') {
      if (inWindow) {
        const c = copiesIn(weekKids, url);
        const ok = c.length === 2 && c.every((x) => x.status === L.status && x.note === L.note);
        if (!ok) typedEvents.extensionAfterFiling.push({ student: st.idx, url, typed: [L.status, L.note], now: c.map((x) => [x.week, x.status, x.note]), date: nowDate });
        L.state = 'done';
      }
      continue;
    }
    if (!visible) { L.state = 'gone'; typedEvents.gone++; continue; }
    if (a.date < mon) {
      const t = archived.find((x) => ctx.weekKeyFromTabTitle_(x.tabProperties.title) === W.monday(a.date));
      checks.filedChecked++;
      const c = t ? copiesIn([t], url) : [];
      const typedCopy = c.find((x) => x.kind === L.kind);
      if (c.length === 2 && c.every((x) => x.status === L.status && x.note === L.note)) checks.filedOk++;
      else if (!sawEdit && typedCopy && typedCopy.status === L.status && typedCopy.note === L.note) {
        checks.filedTablesDisagree = (checks.filedTablesDisagree || 0) + 1; // typed after the week's last update
      } else typedEvents.mismatches.push({ kind: 'filed-copy-differs', history: (a.history || []).map((h) => [h.kind, h.from, h.to, W.nyParts(h.t).date]), student: st.idx, url, typed: [L.status, L.note, L.kind, L.typedOn], filed: c.map((x) => [x.kind, x.status, x.note]), date: nowDate });
      L.state = 'filed';
      continue;
    }
    if (!inWindow) { if (L.state !== 'left') { typedEvents.leftWindow++; L.state = 'left'; } continue; }
    const c = copiesIn(weekKids, url);
    const ok = c.length === 2 && c.every((x) => x.status === L.status && x.note === L.note && x.week === W.monday(a.date));
    if (L.state === 'left') {
      if (ok) typedEvents.keptAfterLeavingWindow++;
      else typedEvents.lostAfterLeavingWindow.push({ student: st.idx, url, typed: [L.status, L.note], now: c.map((x) => [x.week, x.status, x.note]), date: nowDate });
      L.state = ok ? 'active' : 'done';
      continue;
    }
    checks.typedChecks++;
    // An overdue assignment extended into a new week after its own week was filed into Past weeks.
    // Moved (or extended) out of a week that has since been filed into Past weeks, into a current week.
    const extended = (a.history || []).find((h) => h.t > L.typedAt && W.monday(h.from) < mon && W.monday(h.to) >= mon);
    if (ok) checks.typedOk++;
    else if (extended) {
      typedEvents.extensionAfterFiling.push({ student: st.idx, url, typed: [L.status, L.note, L.typedOn], move: { kind: extended.kind, from: extended.from, to: extended.to, on: W.nyParts(extended.t).date }, now: c.map((x) => [x.week, x.kind, x.status, x.note]), date: nowDate });
      typedEvents.byMoveKind = typedEvents.byMoveKind || {};
      typedEvents.byMoveKind[extended.kind] = (typedEvents.byMoveKind[extended.kind] || 0) + 1;
      L.state = 'done';
    } else if ((L.state = 'done')) typedEvents.mismatches.push({ kind: 'current-copy-differs', student: st.idx, url, typed: [L.status, L.note, L.typedOn], now: c.map((x) => [x.week, x.kind, x.status, x.note]), due: a.date, date: nowDate });
  }
  // "Added by staff" rows.
  for (const [title, S] of staffLedger[st.idx]) {
    if (S.state === 'filed') continue;
    const inCur = weekKids.find((t) => t.tabProperties.title === title);
    const inPast = archived.find((t) => t.tabProperties.title === title);
    const t = inCur || inPast;
    const rows = t ? real.staffRowTexts(t.documentTab.body.content) : null;
    const ok = rows && rows[0] && rows[0].join('\u0001') === S.texts.join('\u0001');
    if (inPast) { checks.staffRowsFiledChecked++; if (ok) checks.staffRowsFiledOk++; S.state = 'filed'; }
    else { checks.staffRowChecks++; if (ok) checks.staffRowOk++; }
    if (!ok) bad('staff-row-differs', { title, want: S.texts, got: rows && rows[0], where: inCur ? 'current' : inPast ? 'past' : 'missing' });
  }
  // The home tab links to this week's tab when there is one.
  const link = (() => { for (const se of home.documentTab.body.content) { for (const e of (se.paragraph ? se.paragraph.elements : [])) { if (e.textRun.textStyle.link && e.textRun.textStyle.link.tabId) return e.textRun.textStyle.link.tabId; } } return null; })();
  // Weekdays link this week; Saturday and Sunday link the coming week (homeSummary_).
  const linkWeek = W.weekday(nowDate) >= 5 ? W.addDays(mon, 7) : mon;
  const thisWeekTab = weekKids.find((t) => ctx.weekKeyFromTabTitle_(t.tabProperties.title) === linkWeek);
  if (link && !simdocs.find(doc, link)) bad('home-link-to-missing-tab', {});
  if (thisWeekTab && link !== thisWeekTab.tabProperties.tabId) bad('home-link-not-this-week', { link, want: thisWeekTab.tabProperties.tabId });
  // written.<docId>: only current and upcoming weeks.
  const rec = toPlainWritten(doc.id);
  const ws = Object.values(rec).map((r) => r.w);
  if (ws.some((w) => w < mon)) bad('written-has-past-weeks', { weeks: [...new Set(ws)].sort() });
}
const toPlainWritten = (docId) => JSON.parse(JSON.stringify(ctx.readWritten_(docId)));

// ---- staff edits -----------------------------------------------------------------------------------------
function staffSession(st, dateText) {
  const doc = docOf(st);
  if (!doc) return;
  const home = homeOf(doc);
  const mon = W.monday(dateText);
  const title = titleFor(mon);
  const tab = (home.childTabs || []).find((t) => t.tabProperties.title === title);
  if (!tab) return;
  const rows = real.assignmentRows(tab.documentTab.body.content).filter((r) => r.kind === 'class');
  rows.forEach((r) => {
    if (world.rng() >= 0.3) return;
    const status = world.rng() < 0.05 ? 'Not started' : world.pick(['In progress', 'Complete']);
    const note = status === 'Not started' && world.rng() < 0.5 ? '' : world.noteText();
    const kind = world.rng() < 0.75 ? 'class' : 'day';
    const n = simdocs.editTab(doc, tab, (c) => real.typeStatusNote(c, r.url, kind, status, note));
    if (!n) return;
    typedEvents.typed++;
    ledger[st.idx].set(r.url, { status, note, typedOn: dateText, typedAt: clock.T, kind, week: mon, state: 'active', synced: false });
  });
  if (!staffLedger[st.idx].has(title)) {
    const texts = world.staffRowTexts(st, dateText);
    simdocs.editTab(doc, tab, (c) => real.typeStaffRow(c, 0, texts));
    staffLedger[st.idx].set(title, { texts, state: 'active' });
  }
}

// ---- the update wrapper (measures one student's update; the real function does the work) ------------
const realUpdate = ctx.updateOneStudent_;
ctx.updateOneStudent_ = function (id) {
  const st = byAppId.get(id);
  const dow = W.weekday(today);
  cur = { student: st.idx, run: runLabel, date: today, dow, start: clock.T, reads: [], writes: [], sleeps: [], time: {} };
  simdocs.setMetrics(cur);
  const docBefore = docOf(st);
  const pastBefore = docBefore ? countPast(docBefore) : 0;
  let res;
  try {
    res = realUpdate(id);
  } finally {
    simdocs.setMetrics(null);
  }
  const m = cur;
  cur = null;
  m.end = clock.T;
  const doc = docOf(st);
  if (doc) simdocs.flushPending(doc);
  const filed = doc ? countPast(doc) - pastBefore : 0;
  const u = {
    s: m.student, run: m.run, date: m.date, dow: m.dow, ok: !!(res && res.ok), msg: res && !res.ok ? String(res.message).slice(0, 160) : undefined,
    partial: !!(res && res.ok && /^Updated \d+ of \d+ weeks/.test(String(res.message))),
    ms: m.end - m.start, readMs: m.time.read || 0, writeMs: m.time.write || 0, sleepMs: m.time.sleep || 0, otherMs: (m.time.other || 0) + (m.time.canvas || 0),
    reads: m.reads.length, readKB: m.reads.map((r) => Math.round(r.chars / 102.4) / 10), writes: m.writes.length,
    requests: m.writes.reduce((n, w) => n + w.n, 0), maxReq: Math.max(0, ...m.writes.map((w) => w.n)), sleeps: m.sleeps.length,
    filed, created: !docBefore && !!doc,
  };
  updates.push(u);
  if (doc && !clock.killed) {
    checkAfterUpdate(st, res, m);
    const sz = simdocs.docSize(doc);
    const T = sizeTrack[st.idx];
    if (sz.model > T.peakModel) { T.peakModel = sz.model; T.peakAt = today; }
    if (doc.peakModel && doc.peakModel > T.peakModel) { T.peakModel = doc.peakModel; T.peakAt = today + ' (during an update)'; }
    T.peakContent = Math.max(T.peakContent, sz.content);
    T.peakTabs = Math.max(T.peakTabs || 0, doc.peakTabs || 0, sz.tabs);
    T.finalModel = sz.model; T.finalContent = sz.content; T.tabsFinal = sz.tabs;
    T.monthly[today.slice(0, 7)] = sz.model;
    const wr = Object.entries(svc.props).filter(([k]) => k.indexOf('written.' + doc.id) === 0);
    const wb = wr.reduce((n, [k, v]) => n + bytes(k) + bytes(v), 0);
    const mo = today.slice(0, 7);
    propsTrack.writtenMonthlyMax[mo] = Math.max(propsTrack.writtenMonthlyMax[mo] || 0, wb);
    propsTrack.writtenMaxParts = Math.max(propsTrack.writtenMaxParts, wr.length);
  }
  trackProps();
  if (clock.killed) throw new Error('Exceeded maximum execution time');
  return res;
};
const countPast = (doc) => { const h = homeOf(doc); const p = h && (h.childTabs || []).find((t) => t.tabProperties.title === 'Past weeks'); return p ? (p.childTabs || []).length : 0; };

// ---- executions and runs ---------------------------------------------------------------------------------
function execution(handler, uid) {
  clock.execStart = clock.T;
  clock.killed = false;
  ctx.EXECUTION_STARTED_AT_ = clock.T;
  ctx.teacherFolderCache_ = null;
  ctx.docsGetFieldsRejected_ = false;
  ctx.updateStats_ = null;
  const start = clock.T;
  const before = updates.length;
  let error = null;
  try {
    ctx[handler]({ triggerUid: uid });
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const ex = { run: runLabel, date: today, handler, start, end: clock.T, ms: clock.T - start, students: updates.length - before, error, killed: clock.killed };
  clock.execStart = null;
  clock.killed = false;
  executions.push(ex);
  if (error) noteAnomaly({ kind: 'execution-error', detail: { handler, error, killed: ex.killed }, at: clock.T });
  return ex;
}
function runTrigger(trigger) {
  const start = clock.T;
  const w0 = simdocs.writeTimes.length;
  const r0 = simdocs.readTimes.length;
  const u0 = updates.length;
  const execs = [execution('scheduledRun', trigger.uid)];
  for (let guard = 0; guard < 60; guard++) {
    const t = svc.triggers.find((x) => x.handler === 'continueRun');
    if (!t) break;
    clock.T = Math.max(clock.T, t.createdAt + t.config.after);
    execs.push(execution('continueRun', t.uid));
  }
  const last = JSON.parse(svc.props['run.last'] || 'null');
  const win = (times) => { let best = 0; let j = 0; for (let i = 0; i < times.length; i++) { while (times[i] - times[j] >= 60000) j++; best = Math.max(best, i - j + 1); } return best; };
  const wt = simdocs.writeTimes.slice(w0);
  const rt = simdocs.readTimes.slice(r0);
  const run = { run: runLabel, date: today, start, end: clock.T, ms: clock.T - start, executions: execs.length, execMs: execs.map((e) => e.ms),
    students: updates.length - u0, failed: updates.slice(u0).filter((u) => !u.ok).length, partial: updates.slice(u0).filter((u) => u.partial).length,
    writes: wt.length, reads: rt.length, maxWritesPerMin: win(wt), maxReadsPerMin: win(rt), lastFailed: last ? last.failed.length : null,
    runtimeMs: execs.reduce((n, e) => n + e.ms, 0) };
  runs.push(run);
  return run;
}

// ---- the year ------------------------------------------------------------------------------------------------
const days = [];
for (let d = OPT.start; d <= OPT.end; d = W.addDays(d, 1)) days.push(d);
let lastLog = Date.now();
for (const d of days) {
  today = d;
  const dow = W.weekday(d);
  // Canvas changes overnight (every day, less at weekends), whether or not a run follows.
  clock.T = Math.max(clock.T, W.nyToMs(d, 0, 5));
  world.churn(clock.T, d, dow >= 5 ? 0.3 : 1);
  if (dow >= 5 && !OPT.weekends) continue;
  // The midnight run (the trigger fires near 12:15 AM).
  clock.T = Math.max(clock.T, W.nyToMs(d, 0, 15));
  runLabel = 'midnight';
  runTrigger(midnightTrigger);
  if (dow <= 4) {
    for (const st of world.students) {
      sizeTrack[st.idx].lastDay = d;
    }
  }
  // Staff work in the Docs during the school day.
  if (!W.isBreak(d) && dow <= 4) {
    clock.T = Math.max(clock.T, W.nyToMs(d, 13, 0));
    for (const st of world.students) if (world.rng() < 0.6) staffSession(st, d);
  }
  // Canvas changes during the school day, then the 7 pm run on sample days.
  if (dow <= 4) {
    clock.T = Math.max(clock.T, W.nyToMs(d, 18, 55));
    world.churn(clock.T, d, 0.5);
  }
  if (OPT.sample7pm.includes(dow)) {
    clock.T = Math.max(clock.T, W.nyToMs(d, 19, 0));
    runLabel = '7pm';
    runTrigger(eveningTrigger);
  }
  if (!OPT.quiet && Date.now() - lastLog > 15000) {
    lastLog = Date.now();
    const r = runs[runs.length - 1];
    process.stderr.write(`${d} wall ${Math.round((Date.now() - wallStart) / 1000)}s updates ${updates.length} last run ${Math.round(r.ms / 60000)} min anomalies ${Object.keys(anomalyCounts).join(',')}\n`);
  }
}

// ---- results --------------------------------------------------------------------------------------------------
const pct = (a, n) => (n ? Math.round((a / n) * 1000) / 10 : null);
const stat = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length * 10) / 10 };
};
const normal = world.students.filter((s) => !s.heavy).map((s) => s.idx);
const heavyIdx = world.students.findIndex((s) => s.heavy);
const ok = updates.filter((u) => u.ok && !u.created);
const typicalStudent = (() => {
  const peaks = normal.map((i) => [i, sizeTrack[i].peakModel]).sort((a, b) => a[1] - b[1]);
  return peaks.length ? peaks[Math.floor(peaks.length / 2)][0] : 0;
})();
const heaviestStudent = normal.slice().sort((a, b) => sizeTrack[b].peakModel - sizeTrack[a].peakModel)[0];
const perStudentUpdate = (i, filter) => stat(ok.filter((u) => u.s === i && (!filter || filter(u))).map((u) => u.ms / 1000));
const meanBy = (i) => { const xs = ok.filter((u) => u.s === i).map((u) => u.ms); return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); };
const slowestNormal = normal.slice().sort((a, b) => meanBy(b) - meanBy(a))[0];
const heavyWeekUpdates = heavyIdx >= 0 ? ok.filter((u) => u.s === heavyIdx && u.date >= '2026-12-21' && u.date <= '2027-01-15') : [];
const midnightRuns = runs.filter((r) => r.run === 'midnight');
const eveningRuns = runs.filter((r) => r.run === '7pm');
const runtimePerDay = {};
executions.forEach((e) => { runtimePerDay[e.date] = (runtimePerDay[e.date] || 0) + e.ms; });
// 7 pm vs midnight, same student and day.
const pairDiff = [];
eveningRuns.forEach((r) => {
  ok.filter((u) => u.run === '7pm' && u.date === r.date).forEach((u) => {
    const m = ok.find((x) => x.run === 'midnight' && x.date === u.date && x.s === u.s);
    if (m) pairDiff.push({ dReads: u.reads - m.reads, dWrites: u.writes - m.writes, dReq: u.requests - m.requests, dMs: u.ms - m.ms, monday: u.dow === 0 });
  });
});
const finalProps = propsSnapshot();
const results = {
  options: OPT,
  wallSeconds: Math.round((Date.now() - wallStart) / 1000),
  timeModel: { readMs: '500 + 6.5 per KB of JSON', writeMs: 1400, sleeps: 'as called', other: 'Canvas fetch 400 ms, fetchAll 900 ms, DriveApp lookup 150 ms, openById/setName 300 ms, create 1500 ms' },
  world: { students: world.students.length, courses: world.courses.size, assignments: world.byId.size, churn: Object.assign({}, world.events, { log: undefined }) },
  picks: { typicalStudent, heaviestStudent, slowestNormal, heavyWeekStudent: heavyIdx },
  docSize: world.students.map((s, i) => Object.assign({ idx: i, name: s.name, heavy: s.heavy }, sizeTrack[i], { monthly: undefined })),
  docSizeMonthly: { typical: sizeTrack[typicalStudent].monthly, heaviest: sizeTrack[heaviestStudent] && sizeTrack[heaviestStudent].monthly, heavyWeek: heavyIdx >= 0 ? sizeTrack[heavyIdx].monthly : null },
  props: { final: finalProps, peak: propsTrack, perStudentTokenBytes: world.students.length ? bytes('token.' + world.students[0].appId) + bytes(world.students[0].token) : 0 },
  updates: {
    all: { n: ok.length, ms: stat(ok.map((u) => u.ms / 1000)), reads: stat(ok.map((u) => u.reads)), writes: stat(ok.map((u) => u.writes)), requests: stat(ok.map((u) => u.requests)), maxReqPerWrite: stat(ok.map((u) => u.maxReq)), sleeps: stat(ok.map((u) => u.sleeps)), readKB: stat([].concat(...ok.map((u) => u.readKB))) },
    mondays: { n: ok.filter((u) => u.dow === 0 && u.run === 'midnight').length, ms: stat(ok.filter((u) => u.dow === 0 && u.run === 'midnight').map((u) => u.ms / 1000)), reads: stat(ok.filter((u) => u.dow === 0 && u.run === 'midnight').map((u) => u.reads)), writes: stat(ok.filter((u) => u.dow === 0 && u.run === 'midnight').map((u) => u.writes)), requests: stat(ok.filter((u) => u.dow === 0 && u.run === 'midnight').map((u) => u.requests)), filed: stat(ok.filter((u) => u.dow === 0 && u.run === 'midnight').map((u) => u.filed)) },
    otherDays: { n: ok.filter((u) => u.dow !== 0).length, ms: stat(ok.filter((u) => u.dow !== 0).map((u) => u.ms / 1000)), reads: stat(ok.filter((u) => u.dow !== 0).map((u) => u.reads)), writes: stat(ok.filter((u) => u.dow !== 0).map((u) => u.writes)), requests: stat(ok.filter((u) => u.dow !== 0).map((u) => u.requests)) },
    created: stat(updates.filter((u) => u.created).map((u) => u.ms / 1000)),
    typical: perStudentUpdate(typicalStudent), heaviest: perStudentUpdate(heaviestStudent), slowestNormal: perStudentUpdate(slowestNormal),
    heavyWeek: stat(heavyWeekUpdates.map((u) => u.ms / 1000)),
    heavyWeekDetail: heavyWeekUpdates.length ? heavyWeekUpdates.sort((a, b) => b.ms - a.ms)[0] : null,
    breakdownMean: { readS: Math.round(ok.reduce((n, u) => n + u.readMs, 0) / ok.length / 100) / 10, writeS: Math.round(ok.reduce((n, u) => n + u.writeMs, 0) / ok.length / 100) / 10, sleepS: Math.round(ok.reduce((n, u) => n + u.sleepMs, 0) / ok.length / 100) / 10, otherS: Math.round(ok.reduce((n, u) => n + u.otherMs, 0) / ok.length / 100) / 10 },
    failed: updates.filter((u) => !u.ok).slice(0, 30), failedCount: updates.filter((u) => !u.ok).length, partialCount: updates.filter((u) => u.partial).length,
    sevenPmVsMidnight: { pairs: pairDiff.length, nonMonday: { dReads: stat(pairDiff.filter((p) => !p.monday).map((p) => p.dReads)), dWrites: stat(pairDiff.filter((p) => !p.monday).map((p) => p.dWrites)), dReq: stat(pairDiff.filter((p) => !p.monday).map((p) => p.dReq)), dSec: stat(pairDiff.filter((p) => !p.monday).map((p) => p.dMs / 1000)) }, monday: { dReads: stat(pairDiff.filter((p) => p.monday).map((p) => p.dReads)), dWrites: stat(pairDiff.filter((p) => p.monday).map((p) => p.dWrites)), dSec: stat(pairDiff.filter((p) => p.monday).map((p) => p.dMs / 1000)) } },
  },
  runs: {
    midnight: { n: midnightRuns.length, minutes: stat(midnightRuns.map((r) => Math.round(r.ms / 600) / 100)), executions: stat(midnightRuns.map((r) => r.executions)), longestExecMin: Math.max(...executions.map((e) => e.ms)) / 60000, maxWritesPerMin: stat(midnightRuns.map((r) => r.maxWritesPerMin)), avgWritesPerMin: stat(midnightRuns.map((r) => Math.round(r.writes / (r.ms / 60000) * 10) / 10)), maxReadsPerMin: stat(midnightRuns.map((r) => r.maxReadsPerMin)), failed: stat(midnightRuns.map((r) => r.failed)) },
    evening: { n: eveningRuns.length, minutes: stat(eveningRuns.map((r) => Math.round(r.ms / 600) / 100)), executions: stat(eveningRuns.map((r) => r.executions)), maxWritesPerMin: stat(eveningRuns.map((r) => r.maxWritesPerMin)) },
    longestMidnight: midnightRuns.slice().sort((a, b) => b.ms - a.ms)[0],
    runtimePerDayMin: stat(Object.values(runtimePerDay).map((ms) => Math.round(ms / 600) / 100)),
    executionErrors: executions.filter((e) => e.error).slice(0, 20),
  },
  quotaPerDay: { props: stat(Object.values(quotaDay).map((q) => q.props)), fetches: stat(Object.values(quotaDay).map((q) => q.fetches)) },
  checks, typedEvents: Object.assign({}, typedEvents, { mismatchesCount: typedEvents.mismatches.length, mismatches: typedEvents.mismatches.slice(0, 40), lostAfterLeavingWindowCount: typedEvents.lostAfterLeavingWindow.length, lostAfterLeavingWindow: typedEvents.lostAfterLeavingWindow.slice(0, 10), extensionAfterFilingCount: typedEvents.extensionAfterFiling.length, extensionAfterFiling: typedEvents.extensionAfterFiling.slice(0, 10) }),
  anomalyCounts, anomalies, warnings: warns,
};
if (OPT.scenario === 'yearcross') {
  const st = world.students[0];
  const doc = docOf(st);
  const home = homeOf(doc);
  results.yearcross = {
    tabs: (home.childTabs || []).map((t) => ({ title: t.tabProperties.title, children: (t.childTabs || []).map((c) => c.tabProperties.title) })),
    titleFor20261228: titleFor('2026-12-28'),
    parsedBack: ctx.weekKeyFromTabTitle_(titleFor('2026-12-28')),
    weekTabSeenOn: results.updates ? updates.filter((u) => u.s === 0).map((u) => u.date) : [],
  };
}
fs.mkdirSync(path.dirname(OPT.out), { recursive: true });
fs.writeFileSync(OPT.out, JSON.stringify(results, null, 2));
fs.writeFileSync(OPT.out.replace(/\.json$/, '-updates.json'), JSON.stringify({ updates, runs, executions }, null, 0));
console.log(JSON.stringify({ wallSeconds: results.wallSeconds, updates: updates.length, anomalyCounts, checks, typed: typedEvents.typed, mismatches: typedEvents.mismatches.length }, null, 1));
