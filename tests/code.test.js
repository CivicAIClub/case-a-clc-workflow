'use strict';
// Tests for apps_script/Code.gs (the Doc writer): the shared-folder rules and keeping Status.
// The Docs API is faked; all names are made up.
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, toPlain } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');
const { fakeDocs, withRendering, copiesOf, staffTypes } = require('./helpers/fake-docs');

function setup(props, opts) {
  const svc = fakeServices({ owner: 'owner@pomfret.org', props: props || {} });
  const calls = [];
  const emptyTab = () => ({
    tabs: [{
      tabProperties: { tabId: 't.0', title: 'Tab 1' },
      documentTab: { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } },
    }],
  });
  const globals = Object.assign({}, svc.globals, {
    DocumentApp: {
      create: (name) => {
        calls.push(['create', name]);
        svc.addFile('NEW_DOC', name, null);
        return { getId: () => 'NEW_DOC', getUrl: () => 'https://docs/NEW_DOC' };
      },
      openById: (id) => {
        calls.push(['openById', id]);
        return { setName: (n) => calls.push(['setName', n]), getUrl: () => 'https://docs/' + id };
      },
    },
    Docs: { Documents: { get: () => emptyTab(), batchUpdate: () => ({ replies: [] }) } },
  });
  if (opts && opts.badFolder) {
    globals.DriveApp = Object.assign({}, globals.DriveApp, {
      getFolderById: () => { throw new Error('No item with the given ID could be found'); },
    });
  }
  const sb = createSandbox({ files: ['apps_script/Code.gs', 'apps_script/Canvas.gs'], globals });
  return { svc, ctx: sb.context, calls, names: () => calls.map((c) => c[0]) };
}

const base = { weeks: {}, total_assignments: 0, generated_at: 'x', studentFullName: 'Test Student' };

test('no folder set: a new Doc stays in My Drive', () => {
  const t = setup();
  assert.deepStrictEqual(toPlain(t.ctx.upsertPlannerDocument_(base)), { docUrl: 'https://docs/NEW_DOC', documentId: 'NEW_DOC' });
  assert.strictEqual(t.svc.files.NEW_DOC.parent, null);
});

test('folder set (as a URL): the new Doc is created and moved into it', () => {
  const t = setup({ DOCS_FOLDER_ID: 'https://drive.google.com/drive/folders/FOLDER123?usp=sharing' });
  t.ctx.upsertPlannerDocument_(base);
  assert.strictEqual(t.svc.files.NEW_DOC.parent, 'FOLDER123');
  assert.deepStrictEqual(t.calls[0], ['create', 'Test Student - CLC Assignments']);
});

test('folder set: a Doc inside it is updated in place', () => {
  const t = setup({ DOCS_FOLDER_ID: 'FOLDER123' });
  t.svc.addFile('IN_DOC', 'Test Student - CLC Assignments', 'FOLDER123');
  assert.strictEqual(t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'IN_DOC' }, base)).documentId, 'IN_DOC');
  assert.ok(t.names().includes('openById') && !t.names().includes('create'));
});

test('folder set: a Doc outside it, or an unknown ID, is refused before it is opened', () => {
  const t = setup({ DOCS_FOLDER_ID: 'FOLDER123' });
  t.svc.addFile('OUT_DOC', 'Secret plans', 'OTHER');
  assert.throws(
    () => t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'OUT_DOC' }, base)),
    (err) => /only updates Docs in the "AutoPlanner – CLC Student Planners" folder/.test(err.message) &&
      !/Secret plans/.test(err.message)
  );
  assert.throws(() => t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'NOPE' }, base)), /Could not open the saved Google Doc/);
  assert.ok(!t.names().includes('openById') && !t.names().includes('setName'));
});

test('folder ID that cannot be opened: clear error, and no stray Doc is created', () => {
  const t = setup({ DOCS_FOLDER_ID: 'BAD' }, { badFolder: true });
  assert.throws(() => t.ctx.upsertPlannerDocument_(base), /DOCS_FOLDER_ID is set, but this account cannot open/);
  assert.ok(!t.names().includes('create'));
});

test('Status: a typed value in either table survives; old symbols are dropped; the default never overwrites', () => {
  const t = setup();
  const URL = 'https://pomfret.instructure.com/courses/1/assignments/1';
  const cell = (text, link) => ({ content: [{ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: link ? { link: { url: link } } : {} } }] } }] });
  const row = (status, note) => ({ tableCells: [cell('Essay draft', URL), cell('x'), cell('x'), cell('x'), cell(status), cell(note)] });
  const table = (status, note) => ({ table: { columns: 6, tableRows: [row(status, note)] } });
  const read = (content) => toPlain(t.ctx.readExistingDataFromTab_({ documentTab: { body: { content } } }));
  assert.strictEqual(read([table('Complete', ''), table('Not started', '')]).status[URL], 'Complete');
  assert.strictEqual(read([table('Not started', ''), table('In progress', '')]).status[URL], 'In progress');
  assert.strictEqual(read([table('Not started', 'Needs extension'), table('Not started', '')]).notes[URL], 'Needs extension');
  // Old Docs: "⬜ Not started" is still the default; "✅ Complete" / "🟡 In progress" keep their words.
  assert.strictEqual(read([table('✅ Complete', ''), table('⬜ Not started', '')]).status[URL], 'Complete');
  assert.strictEqual(read([table('⬜ Not started', ''), table('🟡 In progress', '')]).status[URL], 'In progress');
  assert.strictEqual(read([table('🟡 selfTest Oct 4 4:59 PM', ''), table('⬜ Not started', '')]).status[URL], 'selfTest Oct 4 4:59 PM');
});

// ---- The week-tab writer -------------------------------------------------------------------

const GOLDEN = require('./fixtures/week-tab-requests.json');
const url = (n) => 'https://pomfret.instructure.com/courses/1/assignments/' + n;
function goldenWeek() {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ day: d, assignments: [] }));
  days[0].assignments.push({
    day: 'Monday', assignment: 'Paper Outline Due: personality theories (bring two printed sources and your annotated bibliography)',
    course: 'Psychology', due_time: '10:25 AM', priority: 'Tomorrow', days_until_due: 1,
    due_date: '2026-10-05', week_start: '2026-10-05', url: url(2),
  });
  return { week_label: 'Oct 5 – Oct 11', days };
}

test('week tab: the exact requests that were checked against the live Docs API (2026-10-04)', () => {
  // These 107 requests built a tab correctly in a real Google Doc (one class with nothing due,
  // one class with an assignment, By Day). If you change the layout, check it in a real Doc
  // again, then regenerate this file.
  const t = setup();
  const courses = ['Calculus III', 'Psychology'];
  const saved = { status: { [url(2)]: 'In progress' }, notes: { [url(2)]: 'Ask about the lab report' } };
  const reqs = toPlain(t.ctx.buildWeekTabRequests_('t.kcu88lkds853', '2026-10-05', goldenWeek(), courses,
    t.ctx.buildCourseColorMap_(courses), saved, 468));
  assert.strictEqual(JSON.stringify(reqs), JSON.stringify(GOLDEN));
});

test('week tab: one table per class (A to Z, including empty ones) plus By Day; widths fill the page', () => {
  const t = setup();
  const week = goldenWeek();
  week.days[2].assignments.push({ day: 'Wednesday', assignment: 'HW 7', course: 'Statistics', due_time: '8:00 AM',
    priority: 'Due Soon', days_until_due: 3, due_date: '2026-10-07', week_start: '2026-10-05', url: url(3) });
  const courses = ['Statistics', 'Calculus III', 'Psychology', 'Advisory'];
  for (const width of [468, 451.3]) {
    const reqs = toPlain(t.ctx.buildWeekTabRequests_('t.1', '2026-10-05', week, courses.slice().sort(),
      t.ctx.buildCourseColorMap_(courses), { status: {}, notes: {} }, width));
    const tables = reqs.filter((r) => r.insertTable);
    assert.strictEqual(tables.length, courses.length + 1);
    const titles = reqs.filter((r) => r.insertText && ['Advisory', 'Calculus III', 'Psychology', 'Statistics'].includes(r.insertText.text)).map((r) => r.insertText.text);
    // The first four are the class tables' title rows (By Day's Course cells come later).
    assert.deepStrictEqual(titles.slice(0, 4), ['Advisory', 'Calculus III', 'Psychology', 'Statistics']);
    const empties = reqs.filter((r) => r.insertText && r.insertText.text === 'No assignments due this week.');
    assert.strictEqual(empties.length, 2, 'Advisory and Calculus III have nothing due');
    // Every table gets 6 fixed widths that add up to the full text width.
    const byTable = {};
    reqs.filter((r) => r.updateTableColumnProperties).forEach((r) => {
      const k = r.updateTableColumnProperties.tableStartLocation.index;
      (byTable[k] = byTable[k] || []).push(r.updateTableColumnProperties.tableColumnProperties.width.magnitude);
    });
    const sets = Object.values(byTable);
    assert.strictEqual(sets.length, courses.length + 1);
    sets.forEach((w) => assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - width) < 0.01, `widths ${w} sum to ${width}`));
    assert.strictEqual(new Set(sets.slice(0, -1).map(String)).size, 1, 'all By Class tables share one width set');
    // The default Status is plain text.
    const statuses = reqs.filter((r) => r.insertText && !r.insertText.text.includes('\n') && /started|progress|Complete/.test(r.insertText.text)).map((r) => r.insertText.text);
    assert.ok(statuses.length === 4 && statuses.every((s) => s === 'Not started'), statuses.join('|'));
  }
});

test('cell text never contains line breaks or control characters (they would break the layout math)', () => {
  const t = setup();
  assert.strictEqual(t.ctx.cellText_('Line one\nLine\ttwo\u0007  end '), 'Line one Line two end');
  assert.strictEqual(t.ctx.cellText_(null), '');
});

test('help line and status normalization', () => {
  const t = setup();
  assert.strictEqual(t.ctx.STATUS_HELP_LINE, 'Status: type Not started, In progress, or Complete. Notes: type anything you like. AutoPlanner never changes these two columns.');
  assert.strictEqual(t.ctx.normalizeStatus_('  ✅  complete '), 'Complete');
  assert.strictEqual(t.ctx.normalizeStatus_('⬜ Not started'), 'Not started');
  assert.strictEqual(t.ctx.normalizeStatus_('Waiting on teacher'), 'Waiting on teacher');
});

// ---- The CLC Planner home tab -------------------------------------------------------------

function homeData() {
  const C = { calc: 'ADV Calculus III-Smith-G', code: 'ADV Computer Coding-Jones-D', psy: 'ADV Psychology-Lee-A', stat: 'ADV Statistics-Patel-C', eng: 'Eng: Jane Austen-Garcia-B' };
  let n = 0;
  const A = (course, date, time, until, prio, name) => ({ day: 'x', assignment: name, course, due_time: time, priority: prio, days_until_due: until,
    due_date: date, week_start: date < '2026-10-12' ? '2026-10-05' : date < '2026-10-19' ? '2026-10-12' : '2026-10-19', url: url(++n) });
  const list = [
    A(C.psy, '2026-10-05', '8:30 AM', 0, 'Today', 'Paper Outline Due'), A(C.eng, '2026-10-05', '10:25 AM', 0, 'Today', 'Read & Annotate (pp. 204-232)'),
    A(C.stat, '2026-10-06', '8:00 AM', 1, 'Tomorrow', 'HW 7'), A(C.stat, '2026-10-06', '8:00 AM', 1, 'Tomorrow', 'SQ 6 & 7'),
    A(C.eng, '2026-10-06', '2:30 PM', 1, 'Tomorrow', 'Read & Annotate (pp. 235-259)'), A(C.code, '2026-10-07', '9:30 AM', 2, 'Due Soon', 'One-Page Project Spec'),
    A(C.eng, '2026-10-08', '10:35 AM', 3, 'Due Soon', 'Read & Annotate (pp. 260-291)'), A(C.psy, '2026-10-12', '8:30 AM', 7, 'This Week', 'Paper on Personality'),
    A(C.calc, '2026-10-14', '11:59 PM', 9, 'Upcoming', 'Problem Set 4'), A(C.eng, '2026-10-12', '10:25 AM', 7, 'This Week', 'Read & Annotate (pp. 292-331)'),
  ];
  const weeks = {};
  list.forEach((a) => { (weeks[a.week_start] = weeks[a.week_start] || { week_label: 'x', days: [{ day: 'Monday', assignments: [] }] }).days[0].assignments.push(a); });
  return { weeks, studentFullName: 'Avery Example', courses: Object.values(C).sort() };
}
const MONDAY_8AM = new Date('2026-10-05T12:00:00Z');
const round3 = (x) => typeof x === 'number' ? Math.round(x * 1000) / 1000 : Array.isArray(x) ? x.map(round3)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, round3(v)])) : x;

test('home tab: class names lose the teacher and section only when the pattern is clear', () => {
  const t = setup();
  assert.strictEqual(t.ctx.shortCourseName_('ADV Calculus III-Browne-G'), 'ADV Calculus III');
  assert.strictEqual(t.ctx.shortCourseName_('Eng: Jane Austen-Rosenberg-B'), 'Eng: Jane Austen');
  assert.strictEqual(t.ctx.shortCourseName_('Pre-Calculus-Smith-A'), 'Pre-Calculus');
  assert.strictEqual(t.ctx.shortCourseName_('Biology'), 'Biology');
  assert.strictEqual(t.ctx.shortCourseName_('Advisory - Smith'), 'Advisory - Smith');
  assert.strictEqual(t.ctx.shortCourseName_('Art-Lee-Studio'), 'Art-Lee-Studio');
});

test('home tab: the summary counts this week, today-or-tomorrow, and next due per class', () => {
  const t = setup();
  const data = homeData();
  const s = toPlain(t.ctx.homeSummary_(data, t.ctx.plannerCourseList_(data), MONDAY_8AM));
  assert.strictEqual(s.name, 'Avery Example');
  assert.strictEqual(s.updated, 'Monday, Oct 5 at 8:00 AM');
  assert.strictEqual(s.weekRange, 'Oct 5 – Oct 11');
  assert.strictEqual(s.weekCount, 7);
  assert.strictEqual(s.soonCount, 5);
  assert.deepStrictEqual(s.rows.map((r) => [r.name, r.count, r.next]), [
    ['ADV Calculus III', 0, 'Wed, Oct 14'], ['ADV Computer Coding', 1, 'Wed, Oct 7'], ['ADV Psychology', 1, 'Mon, Oct 5'],
    ['ADV Statistics', 2, 'Tue, Oct 6'], ['Eng: Jane Austen', 3, 'Mon, Oct 5'],
  ]);
  // Two sections of the same class would look identical when shortened: keep the full names.
  const twin = toPlain(t.ctx.homeSummary_({ weeks: {} }, ['Art-Lee-A', 'Art-Kim-B'], MONDAY_8AM));
  assert.deepStrictEqual(twin.rows.map((r) => [r.name, r.next]), [['Art-Lee-A', '—'], ['Art-Kim-B', '—']]);
});

test('home tab: the exact requests that were checked against the live Docs API (2026-10-04)', () => {
  // These 72 requests cleared an old home tab and built this one correctly in a real Google Doc,
  // including the "Open this week" tab link. If you change the home tab, check it in a real Doc
  // again, then regenerate this file.
  const t = setup();
  const data = homeData();
  const courses = t.ctx.plannerCourseList_(data);
  const summary = t.ctx.homeSummary_(data, courses, MONDAY_8AM);
  const tab = { documentTab: { body: { content: [{ endIndex: 1 }, { endIndex: 68 }] } } };
  const reqs = toPlain(t.ctx.homeClearRequests_(tab, 't.0').concat(
    t.ctx.buildHomeTabRequests_('t.0', summary, 't.v3p30v8op28s', 468, t.ctx.buildCourseColorMap_(courses))));
  assert.strictEqual(JSON.stringify(round3(reqs)), JSON.stringify(require('./fixtures/home-tab-requests.json')));
});

test('home tab: with no current-week tab there is no link, and with no classes there is no table', () => {
  const t = setup();
  const summary = toPlain(t.ctx.homeSummary_({ weeks: {}, studentFullName: 'Casey Test' }, [], MONDAY_8AM));
  const reqs = toPlain(t.ctx.buildHomeTabRequests_('t.0', summary, null, 468, {}));
  const texts = reqs.filter((r) => r.insertText).map((r) => r.insertText.text).join('\n');
  assert.match(texts, /Nothing is due this week\. 0 due today or tomorrow\./);
  assert.match(texts, /No current classes found in Canvas\./);
  assert.ok(!/Open this week/.test(texts));
  assert.strictEqual(reqs.filter((r) => r.insertTable).length, 0);
  assert.ok(!JSON.stringify(reqs).includes('"tabId":null'));
});

// ---- Weekends, past weeks, and notes that follow an assignment ----------------------------

const SUNDAY_8PM = new Date('2026-10-05T00:00:00Z'); // Sun Oct 4, 8:00 PM New York
const MONDAY_0005 = new Date('2026-10-05T04:05:00Z'); // Mon Oct 5, 12:05 AM
const SATURDAY_0010 = new Date('2026-10-10T04:10:00Z'); // Sat Oct 10, 12:10 AM
const FRIDAY_2355 = new Date('2026-10-10T03:55:00Z'); // Fri Oct 9, 11:55 PM

test('home tab on a weekend summarizes the coming week, with "due this weekend"', () => {
  const t = setup();
  const data = homeData();
  data.weeks['2026-09-28'] = { week_label: 'x', days: [{ day: 'Sunday', assignments: [
    { assignment: 'Weekend reading', course: 'Eng: Jane Austen-Garcia-B', due_time: '11:59 PM', priority: 'Today',
      days_until_due: 0, due_date: '2026-10-04', week_start: '2026-09-28', url: url(99) }] }] };
  const courses = t.ctx.plannerCourseList_(data);
  const s = toPlain(t.ctx.homeSummary_(data, courses, SUNDAY_8PM));
  assert.strictEqual(s.weekend, true);
  assert.strictEqual(s.weekKey, '2026-10-05');
  assert.strictEqual(s.heading, 'COMING WEEK · MON OCT 5 – SUN OCT 11');
  assert.strictEqual(s.weekCount, 7);
  assert.strictEqual(s.soonCount, 1, 'only the Sunday assignment is "this weekend"');
  assert.deepStrictEqual(s.rows.map((r) => r.count), [0, 1, 1, 2, 3], 'class column counts the coming week');
  const reqs = toPlain(t.ctx.buildHomeTabRequests_('t.0', s, 't.week', 468, t.ctx.buildCourseColorMap_(courses)));
  const texts = reqs.filter((r) => r.insertText).map((r) => r.insertText.text).join('\n');
  assert.match(texts, /COMING WEEK · MON OCT 5 – SUN OCT 11\n7 assignments in the coming week · 1 due this weekend\.\nOpen the coming week →/);
  assert.ok(reqs.some((r) => r.insertText && r.insertText.text === 'Coming week'), 'class table column header');
  assert.ok(!/today or tomorrow/.test(texts));
  // Nothing due this weekend, and no tab for the coming week: no link.
  const quiet = toPlain(t.ctx.homeSummary_(homeData(), courses, SUNDAY_8PM));
  const q = toPlain(t.ctx.buildHomeTabRequests_('t.0', quiet, null, 468, {}));
  const qt = q.filter((r) => r.insertText).map((r) => r.insertText.text).join('\n');
  assert.match(qt, /7 assignments in the coming week · Nothing due this weekend\./);
  assert.ok(!/Open the coming week/.test(qt));
});

test('work from earlier this week (Past due) is counted in the week, but not as next due or due this weekend', () => {
  const t = setup();
  const data = homeData();
  data.weeks['2026-09-28'] = { week_label: 'x', days: [{ day: 'Saturday', assignments: [
    { assignment: 'Saturday quiz', course: 'Eng: Jane Austen-Garcia-B', due_time: '9:00 AM', priority: 'Past due',
      days_until_due: -1, due_date: '2026-10-03', week_start: '2026-09-28', url: url(98) }] }] };
  const courses = t.ctx.plannerCourseList_(data);
  const s = toPlain(t.ctx.homeSummary_(data, courses, SUNDAY_8PM));
  assert.strictEqual(s.soonCount, 0, "Saturday's quiz is past, so nothing is due this weekend");
  const eng = s.rows.filter((r) => /Austen/.test(r.course))[0];
  assert.notStrictEqual(eng.next, 'Sat, Oct 3', 'next due skips past-due work');
  assert.strictEqual(t.ctx.PRIORITY_COLORS['Past due'], '#E0E0E0');
});

test('home tab flips at the midnight runs: Saturday 12:10 AM is weekend, Monday 12:05 AM is a weekday', () => {
  const t = setup();
  const data = homeData();
  const courses = t.ctx.plannerCourseList_(data);
  const sat = toPlain(t.ctx.homeSummary_(data, courses, SATURDAY_0010));
  assert.deepStrictEqual([sat.weekend, sat.heading], [true, 'COMING WEEK · MON OCT 12 – SUN OCT 18']);
  const mon = toPlain(t.ctx.homeSummary_(data, courses, MONDAY_0005));
  assert.deepStrictEqual([mon.weekend, mon.heading], [false, 'THIS WEEK · OCT 5 – OCT 11']);
  // A run at 11:55 PM Friday would still be a weekday, which is why midnight's trigger runs 12:00–12:30 AM.
  assert.strictEqual(toPlain(t.ctx.homeSummary_(data, courses, FRIDAY_2355)).weekend, false);
});

// Fake Docs tabs for the past-weeks and notes tests.
const tcell = (text, link) => ({ content: [{ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: link ? { link: { url: link } } : {} } }] } }] });
const trow = (u, status, note) => ({ tableCells: [tcell('Essay', u), tcell('x'), tcell('x'), tcell('x'), tcell(status), tcell(note)] });
const weekTab = (id, title, rows) => ({
  tabProperties: { tabId: id, title },
  documentTab: { body: { content: rows ? [{ table: { columns: 6, tableRows: rows } }] : [] } },
});

test('week rollover: ended weeks move into "Past weeks" (created once, newest first), content untouched', () => {
  const t = setup();
  const parent = { tabProperties: { tabId: 't.0', title: 'CLC Planner' }, childTabs: [
    weekTab('t.sep28', 'Week of Sep 28 – Oct 4, 2026', [trow(url(1), 'In progress', 'kept forever')]),
    weekTab('t.oct5', 'Week of Oct 5 – Oct 11, 2026', [trow(url(2), 'Complete', 'also kept')]),
    weekTab('t.oct12', 'Week of Oct 12 – Oct 18, 2026', [trow(url(3), 'Not started', '')]),
  ] };
  const doc = { tabs: [parent] };
  const sent = [];
  t.ctx.docsGet_ = () => doc;
  t.ctx.docsBatchUpdate_ = (id, reqs) => { sent.push(...toPlain(reqs)); return { replies: [] }; };
  t.ctx.addWeekChildTab_ = (id, parentId, title, index) => { sent.push({ addTab: { parentId, title, index } }); return 't.past'; };
  // Monday Oct 12: the weeks of Sep 28 and Oct 5 have ended.
  assert.strictEqual(t.ctx.archivePastWeeks_('DOC', 't.0', '2026-10-12'), 2);
  assert.deepStrictEqual(sent, [
    { addTab: { parentId: 't.0', title: 'Past weeks', index: 3 } },
    { insertText: { text: 'Every past week, with the Status and Notes typed during it. AutoPlanner never changes these.', location: { tabId: 't.past', index: 1 } } },
    { updateDocumentTabProperties: { tabProperties: { tabId: 't.sep28', parentTabId: 't.past', index: 0 }, fields: 'parentTabId,index' } },
    { updateDocumentTabProperties: { tabProperties: { tabId: 't.oct5', parentTabId: 't.past', index: 0 }, fields: 'parentTabId,index' } },
  ], 'only the folder is written to; the moved tabs only change parent (oldest moved first, so the newest ends on top)');
  // The current week is not moved, and on a Sunday nothing has ended yet.
  sent.length = 0;
  assert.strictEqual(t.ctx.archivePastWeeks_('DOC', 't.0', '2026-10-11'), 1);
  assert.deepStrictEqual(sent.map((r) => Object.keys(r)[0]), ['addTab', 'insertText', 'updateDocumentTabProperties']);
  // With "Past weeks" already there, it isn't created again, and new week tabs go just above it.
  const withPast = { tabProperties: parent.tabProperties, childTabs: [parent.childTabs[2], weekTab('t.past', 'Past weeks')] };
  doc.tabs = [withPast];
  sent.length = 0;
  assert.strictEqual(t.ctx.archivePastWeeks_('DOC', 't.0', '2026-10-19'), 1);
  assert.deepStrictEqual(sent, [{ updateDocumentTabProperties: { tabProperties: { tabId: 't.oct12', parentTabId: 't.past', index: 0 }, fields: 'parentTabId,index' } }]);
  assert.strictEqual(t.ctx.nextChildTabInsertIndex_(withPast), 1);
  assert.strictEqual(t.ctx.nextChildTabInsertIndex_(parent), 3);
});

test('past weeks: Priority cells turn gray just before the move; nothing else is touched', () => {
  const t = setup();
  const blank = () => tcell('');
  const head = (second) => ({ tableCells: ['Assignment', second, 'Due Time', 'Priority', 'Status', 'Notes'].map((x) => tcell(x)) });
  const item = (n, second, prio, status, note) => ({ tableCells: [tcell('Essay ' + n, url(n)), tcell(second), tcell('8:30 AM'), tcell(prio), tcell(status), tcell(note)] });
  const merged = (text) => ({ tableCells: [tcell(text), blank(), blank(), blank(), blank(), blank()] });
  const ended = {
    tabProperties: { tabId: 't.oct5', title: 'Week of Oct 5 – Oct 11, 2026' },
    documentTab: { body: { content: [
      { startIndex: 1, paragraph: { elements: [] } },
      { startIndex: 100, table: { columns: 6, tableRows: [merged('Psychology'), head('Day'), item(1, 'Monday', 'Today', 'In progress', 'kept'), item(2, 'Tuesday', 'Tomorrow', 'Not started', '')] } },
      { startIndex: 200, table: { columns: 6, tableRows: [merged('Calculus III'), head('Day'), merged('No assignments due this week.')] } },
      { startIndex: 300, table: { columns: 6, tableRows: [head('Course'), merged('Monday'), item(1, 'Psychology', 'Today', 'In progress', 'kept'), merged('Tuesday'), item(2, 'Psychology', 'Tomorrow', '', ''), item(3, 'Psychology', 'Due Soon', 'Complete', 'done')] } },
    ] } },
  };
  const gray = { backgroundColor: { color: { rgbColor: { red: 224 / 255, green: 224 / 255, blue: 224 / 255 } } } };
  const cellReq = (start, row, rowSpan) => ({ updateTableCellStyle: {
    tableRange: { tableCellLocation: { tableStartLocation: { tabId: 't.oct5', index: start }, rowIndex: row, columnIndex: 3 }, rowSpan, columnSpan: 1 },
    tableCellStyle: gray, fields: 'backgroundColor',
  } });
  const expected = [cellReq(100, 2, 2), cellReq(300, 2, 1), cellReq(300, 4, 2)];
  assert.deepStrictEqual(toPlain(t.ctx.pastPriorityGrayRequests_(ended)), expected,
    'only Priority cells that hold a priority: no class names, day rows, "No assignments" rows, Status or Notes');

  const parent = { tabProperties: { tabId: 't.0', title: 'CLC Planner' }, childTabs: [ended, weekTab('t.past', 'Past weeks')] };
  const sent = [];
  t.ctx.docsGet_ = () => ({ tabs: [parent] });
  t.ctx.docsBatchUpdate_ = (id, reqs) => { sent.push(toPlain(reqs)); return { replies: [] }; };
  assert.strictEqual(t.ctx.archivePastWeeks_('DOC', 't.0', '2026-10-12'), 1);
  const move = { updateDocumentTabProperties: { tabProperties: { tabId: 't.oct5', parentTabId: 't.past', index: 0 }, fields: 'parentTabId,index' } };
  assert.deepStrictEqual(sent, [expected, [move]], 'gray first, then the move');
  // If Google refuses the gray, the week still moves (the gray is only a look).
  sent.length = 0;
  t.ctx.docsBatchUpdate_ = (id, reqs) => {
    if (reqs[0].updateTableCellStyle) throw new Error('Invalid requests[0].updateTableCellStyle');
    sent.push(toPlain(reqs));
    return { replies: [] };
  };
  assert.strictEqual(t.ctx.archivePastWeeks_('DOC', 't.0', '2026-10-12'), 1);
  assert.deepStrictEqual(sent, [[move]]);
  t.ctx.docsBatchUpdate_ = (id, reqs) => { sent.push(toPlain(reqs)); return { replies: [] }; };
  // Once it's in Past weeks it is never looked at again.
  parent.childTabs = [weekTab('t.past', 'Past weeks')];
  parent.childTabs[0].childTabs = [ended];
  sent.length = 0;
  assert.strictEqual(t.ctx.archivePastWeeks_('DOC', 't.0', '2026-10-19'), 0);
  assert.deepStrictEqual(sent, []);
});

test("Doc reads leave out Past weeks' content; if Google refuses that, a full read is used instead", () => {
  const t = setup();
  const asked = [];
  let refuse = false;
  t.ctx.Docs = { Documents: { get: (id, opts) => {
    asked.push(toPlain(opts));
    if (opts.fields && refuse) throw new Error('Invalid field selection tabs');
    if (id === 'GONE') throw new Error('Requested entity was not found.');
    return { tabs: [] };
  } } };
  const mask = 'tabs(tabProperties,documentTab,childTabs(tabProperties,documentTab,childTabs(tabProperties)))';
  t.ctx.docsGet_('DOC');
  assert.deepStrictEqual(asked, [{ includeTabsContent: true, fields: mask }]);
  t.ctx.docsGet_('DOC', { includeTabsContent: true });
  assert.deepStrictEqual(asked[1], { includeTabsContent: true }, 'a full read when asked for one');
  // A missing Doc is still an error, and doesn't switch reads to full.
  assert.throws(() => t.ctx.docsGet_('GONE'), /not found/);
  assert.strictEqual(t.ctx.docsGetFieldsRejected_, false);
  // Google refuses the shorter read: the update still works, with full reads from then on.
  refuse = true;
  asked.length = 0;
  t.ctx.docsGet_('DOC');
  t.ctx.docsGet_('DOC');
  assert.deepStrictEqual(asked, [{ includeTabsContent: true, fields: mask }, { includeTabsContent: true }, { includeTabsContent: true }]);
  assert.strictEqual(t.ctx.docsGetFieldsRejected_, true);
});

test('the shared folder deleted, unshared or in the trash: a plain message, and nothing is written', () => {
  const gone = setup({ DOCS_FOLDER_ID: 'BAD' }, { badFolder: true });
  assert.throws(() => gone.ctx.upsertPlannerDocument_(base), (e) =>
    /cannot open that Drive folder\. It may have been deleted, or AutoPlanner's owner lost access to it\. Contact Cayden Auyang or Luke Ryan\.$/.test(e.message) &&
    !/Exception|No item/.test(e.message));
  const binned = setup({ DOCS_FOLDER_ID: 'FOLDER123' });
  binned.svc.folderState.trashed = true;
  assert.throws(() => binned.ctx.upsertPlannerDocument_(base), /shared folder "AutoPlanner – CLC Student Planners" is in the Drive trash/);
  assert.deepStrictEqual(binned.calls, []);
});

test('a Doc in the trash, or gone, is never written: refused before it is opened (with or without a folder)', () => {
  for (const props of [{ DOCS_FOLDER_ID: 'FOLDER123' }, {}]) {
    const t = setup(props);
    t.svc.addFile('BINNED', 'Test Student - CLC Assignments', 'FOLDER123', { trashed: true });
    assert.throws(() => t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'BINNED' }, base)),
      /^Error: Could not open the saved Google Doc \(BINNED\): it is in the trash\.$/);
    assert.throws(() => t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'GONE' }, base)), /Could not open the saved Google Doc \(GONE\)/);
    assert.deepStrictEqual(t.calls, [], 'never opened, renamed or written');
    assert.deepStrictEqual(t.svc.sleepCalls, [2000], 'a missing Doc is looked up twice, 2 s apart, in case Drive had a hiccup');
  }
});

const W = 'Week of Jan 5 – Jan 11, 2099';
const W2 = 'Week of Jan 12 – Jan 18, 2099';
const homeTab = (kids) => ({ tabProperties: { tabId: 't.0', title: 'CLC Planner' },
  documentTab: { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } }, childTabs: kids });
const typedWeek = (id, title, status, note, n) => ({ tabProperties: { tabId: id, title, parentTabId: 't.0' }, childTabs: [],
  documentTab: { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [] } },
    { startIndex: 2, endIndex: 90, table: { columns: 6, tableRows: [trow(url(n || 1), status, note)] } }] } } });
const scheduleFor = () => Object.assign({}, base, { documentId: 'DOC1', courses: ['Biology'], weeks: { '2099-01-05': { week_label: 'Jan 5 – Jan 11', days: [{ day: 'Monday', assignments: [
  { day: 'Monday', assignment: 'Essay', course: 'Biology', due_time: '8:30 AM', priority: 'Upcoming', days_until_due: 9, due_date: '2099-01-05', week_start: '2099-01-05', url: url(1) }] }] } } });

function rebuildSetup(kids, extraRoots) {
  const t = setup();
  t.svc.addFile('DOC1', 'Test Student - CLC Assignments', null);
  const docs = fakeDocs([homeTab(kids)].concat(extraRoots || []));
  t.ctx.Docs = docs.service;
  t.ctx.sleepDocsChunkGap_ = () => {};
  return { t, docs };
}

test('rebuilding an EXISTING week tab: same title and place, Status and Notes kept, no "(updating)" left (unique titles enforced)', () => {
  const { t, docs } = rebuildSetup([typedWeek('t.old', W, 'In progress', 'keep me'), typedWeek('t.next', W2, 'Complete', 'later week', 2)]);
  t.ctx.upsertPlannerDocument_(scheduleFor());
  assert.deepStrictEqual(docs.titles('t.0'), [W, W2], 'same titles, same order');
  const rebuilt = docs.find('t.n1');
  assert.strictEqual(rebuilt.tabProperties.title, W);
  assert.ok(!docs.find('t.old'), 'the old tab is gone');
  assert.ok(!docs.find('t.next') && docs.titles('t.0')[1] === W2, 'a week with nothing due now is rebuilt too (same title, same place)');
  assert.ok(!(docs.written['t.n2'] || []).includes('later week'), "an assignment no longer due that week doesn't stay in it");
  assert.ok((docs.written['t.n2'] || []).includes('No assignments due this week.'));
  assert.ok(docs.written['t.n1'].includes('In progress') && docs.written['t.n1'].includes('keep me'), 'Status and Notes written into the new tab');
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
  assert.ok(docs.batches.some((b) => b.join() === 'deleteTab,updateDocumentTabProperties'), 'delete and rename in one batch');
});

test('an update cut off mid-rebuild leaves the old tab untouched; the next one removes the "(updating)" tab and keeps Status and Notes', () => {
  const { t, docs } = rebuildSetup([typedWeek('t.old', W, 'In progress', 'keep me')]);
  docs.failOnFill = true;
  assert.throws(() => t.ctx.upsertPlannerDocument_(scheduleFor()), /Exceeded maximum execution time/);
  assert.deepStrictEqual(docs.titles('t.0'), [W, W + ' (updating)'], 'old tab still first, half-written copy below it');
  assert.ok(docs.find('t.old'), 'the old tab, with its Status and Notes, is still there');
  // The next update: the leftover goes first, and the week is rebuilt from the old tab.
  docs.failOnFill = false;
  t.ctx.upsertPlannerDocument_(scheduleFor());
  assert.deepStrictEqual(docs.titles('t.0'), [W]);
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
  const finalId = docs.service.Documents.get().tabs[0].childTabs[0].tabProperties.tabId;
  assert.ok(docs.written[finalId].includes('In progress') && docs.written[finalId].includes('keep me'));
  // A leftover "(updating)" copy with other values is never trusted.
  const again = rebuildSetup([typedWeek('t.old', W, 'In progress', 'keep me'), typedWeek('t.half', W + ' (updating)', 'Complete', 'half-written')]);
  again.t.ctx.upsertPlannerDocument_(scheduleFor());
  const id = again.docs.service.Documents.get().tabs[0].childTabs[0].tabProperties.tabId;
  assert.deepStrictEqual(again.docs.titles('t.0'), [W]);
  assert.ok(again.docs.written[id].includes('In progress') && !again.docs.written[id].includes('half-written'));
});

const WA = 'Week of Jan 12 – Jan 18, 2099';
const WB = 'Week of Jan 5 – Jan 11, 2099';
// The selfTest scenario: X (url 1) is due in week A with Y; week B has Z. "Moved" puts X in week B.
function scheduleAB(xInB) {
  const item = (n, name, week, date) => ({ day: 'Monday', assignment: name, course: 'Biology', due_time: '8:30 AM', priority: 'Upcoming',
    days_until_due: 9, due_date: date, week_start: week, url: url(n) });
  const a = [item(2, 'Y', '2099-01-12', '2099-01-12')];
  const b = [item(3, 'Z', '2099-01-05', '2099-01-05')];
  (xInB ? b : a).push(item(1, 'X', xInB ? '2099-01-05' : '2099-01-12', xInB ? '2099-01-05' : '2099-01-12'));
  return Object.assign({}, base, { documentId: 'DOC1', courses: ['Biology'], weeks: {
    '2099-01-05': { week_label: 'Jan 5 – Jan 11', days: [{ day: 'Monday', assignments: b }] },
    '2099-01-12': { week_label: 'Jan 12 – Jan 18', days: [{ day: 'Monday', assignments: a }] },
  } });
}
test('notes follow assignments: the selfTest sequence twice in a row (no clean-up between), and with clean-up', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const round = (status, note) => {
    staffTypes(docs, WA, X, 'class', status, note); // selfTest types into the By Class row only
    t.ctx.upsertPlannerDocument_(scheduleAB(true));
    assert.deepStrictEqual(copiesOf(docs, X), [
      { week: WB, table: 'class', status, note }, { week: WB, table: 'day', status, note },
    ], 'followed the assignment to week B, and only there');
    t.ctx.upsertPlannerDocument_(scheduleAB(false));
    assert.deepStrictEqual(copiesOf(docs, X), [
      { week: WA, table: 'class', status, note }, { week: WA, table: 'day', status, note },
    ], 'came back to week A, and only there');
  };
  round('In progress', 'note 1');
  round('Complete', 'note 2'); // the run that failed live: By Day still said "In progress" / "note 1"
  // selfTest's clean-up: the original values back in both tables, recorded as written.
  staffTypes(docs, WA, X, 'class', 'Not started', '');
  staffTypes(docs, WA, X, 'day', 'Not started', '');
  t.ctx.recordWritten_('DOC1', X, '2099-01-12', 'Not started', '');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Not started', ''], ['Not started', '']]);
  round('In progress', 'note 3');
  round('In progress', 'note 3 edited'); // same Status, new Note
});

// The Doc exactly as the first selfTest on #13 found it: both tables of week A still had the 10:58 PM
// run's "In progress" and note, and there was no "last written" record yet.
function liveStateBeforeRun1() {
  const X = url(1);
  const stale = 'selfTest note Oct 4 10:58 PM';
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', stale);
  staffTypes(docs, WA, X, 'day', 'In progress', stale);
  delete t.svc.props['written.DOC1'];
  return { t, docs, X, stale };
}

// One selfTest, step by step, as App.gs runs it (typing goes into the By Class row).
function selfTestRound(t, docs, X, typed) {
  const copies = () => copiesOf(docs, X);
  t.ctx.upsertPlannerDocument_(scheduleAB(false)); // "Doc: create or update yours"
  const first = copies()[0];
  const original = /^selfTest note /.test(first.note) ? { status: 'Not started', note: '' } : { status: first.status, note: first.note };
  const testStatus = original.status === 'In progress' ? 'Complete' : 'In progress';
  staffTypes(docs, WA, X, 'class', testStatus, typed);
  t.ctx.upsertPlannerDocument_(scheduleAB(true)); // moved
  assert.deepStrictEqual(copies().map((c) => [c.week, c.status, c.note]), [[WB, testStatus, typed], [WB, testStatus, typed]], 'followed');
  t.ctx.upsertPlannerDocument_(scheduleAB(false)); // normal
  assert.deepStrictEqual(copies().map((c) => [c.week, c.status, c.note]), [[WA, testStatus, typed], [WA, testStatus, typed]], 'came back, one week tab');
  // everyday: a By Class edit survives a plain update
  const everyday = testStatus === 'Complete' ? 'In progress' : 'Complete';
  staffTypes(docs, WA, X, 'class', everyday, typed + ' (edited)');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copies().map((c) => [c.status, c.note]), [[everyday, typed + ' (edited)'], [everyday, typed + ' (edited)']], 'everyday');
  // clean-up: original values back in both tables, recorded as written
  staffTypes(docs, WA, X, 'class', original.status, original.note);
  staffTypes(docs, WA, X, 'day', original.status, original.note);
  t.ctx.recordWritten_('DOC1', X, '2099-01-12', original.status, original.note);
  return original;
}

test('selfTest from the exact live state (stale values in both tables, no record): two runs in a row pass', () => {
  const { t, docs, X } = liveStateBeforeRun1();
  const o1 = selfTestRound(t, docs, X, 'selfTest note Oct 5 1:30 PM');
  assert.deepStrictEqual(o1, { status: 'Not started', note: '' }, "the old test note isn't kept as the original");
  selfTestRound(t, docs, X, 'selfTest note Oct 5 1:40 PM');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Not started', ''], ['Not started', '']], 'clean after both runs');
});

test('an update that read the Doc just before staff typed keeps the typed value (the race that failed the first #13 selfTest)', () => {
  const { t, docs, X } = liveStateBeforeRun1();
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  // Staff (or selfTest) type right after the update has read the Doc, before it rebuilds the tab.
  const realCollect = t.ctx.collectSavedData_;
  let typed = false;
  t.ctx.collectSavedData_ = (parent, written) => {
    const result = realCollect(parent, written);
    if (!typed) { typed = true; staffTypes(docs, WA, X, 'class', 'Complete', 'typed mid-update'); }
    return result;
  };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Complete', 'typed mid-update'], ['Complete', 'typed mid-update']]);
  t.ctx.collectSavedData_ = realCollect;
  // ... and while the new tab is being written (the last look before the old tab is deleted).
  const realChunked = t.ctx.batchUpdateChunked_;
  let once = false;
  t.ctx.batchUpdateChunked_ = (docId, reqs) => {
    realChunked(docId, reqs);
    if (!once) { once = true; staffTypes(docs, WA, X, 'class', 'In progress', 'typed during the write'); }
  };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['In progress', 'typed during the write'], ['In progress', 'typed during the write']]);
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
});

test('"last written" records are compact, split over more properties when big, and the first format still reads', () => {
  const t = setup();
  const map = {};
  for (let i = 0; i < 320; i++) map[String(1000000 + i)] = { w: '2026-10-05', s: ['Not started', 'In progress', 'Complete', 'Waiting on teacher'][i % 4], n: t.ctx.noteFingerprint_(i % 2 ? 'a note ' + i : '') };
  t.ctx.saveWritten_('DOCX', map);
  const parts = Object.keys(t.svc.props).filter((k) => k.indexOf('written.DOCX') === 0);
  assert.deepStrictEqual(parts.sort(), ['written.DOCX', 'written.DOCX.1'], '320 assignments: two parts');
  parts.forEach((k) => assert.ok(t.svc.props[k].length < 8500, k + ' fits in one property'));
  assert.deepStrictEqual(toPlain(t.ctx.readWritten_('DOCX')), map);
  // Fewer assignments later: the extra part is removed.
  t.ctx.saveWritten_('DOCX', { 1: { w: '2026-10-12', s: 'Complete', n: '' } });
  assert.deepStrictEqual(Object.keys(t.svc.props).filter((k) => k.indexOf('written.DOCX') === 0), ['written.DOCX']);
  assert.ok(t.svc.props['written.DOCX'].length < 40, 'about 28 characters per assignment: ' + t.svc.props['written.DOCX']);
  t.svc.props['written.OLD'] = JSON.stringify({ 5: { w: '2026-10-05', s: 'In progress', n: 'abc' } });
  assert.deepStrictEqual(toPlain(t.ctx.readWritten_('OLD')), { 5: { w: '2026-10-05', s: 'In progress', n: 'abc' } });
});

test('an empty insertText is never sent (clearing a cell only deletes), and Drive\'s "Invalid file or folder ID" means deleted', () => {
  const t = setup();
  const sent = [];
  t.ctx.Docs = { Documents: { batchUpdate: (body) => { sent.push(toPlain(body.requests)); return { replies: [] }; } } };
  t.ctx.docsBatchUpdate_('D', [{ insertText: { text: '', location: { index: 5 } } }, { deleteContentRange: { range: { startIndex: 1, endIndex: 3 } } }]);
  t.ctx.docsBatchUpdate_('D', [{ insertText: { text: '', location: { index: 5 } } }]);
  assert.deepStrictEqual(sent, [[{ deleteContentRange: { range: { startIndex: 1, endIndex: 3 } } }]], 'only the delete; nothing at all for an empty-only batch');
  assert.ok(t.ctx.DRIVE_NOT_FOUND.test('Exception: Invalid file or folder ID: 1abc'));
  t.ctx.DriveApp.getFileById = () => { throw new Error('Exception: Invalid file or folder ID: 1abc'); };
  assert.throws(() => t.ctx.savedDocFile_('1abc'), /^Error: Could not open the saved Google Doc \(1abc\)/);
});

test('an update short on time stops cleanly between weeks: no week half-done, and the weeks it skipped keep their record', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', 'typed before');
  const recordBefore = toPlain(t.ctx.readWritten_('DOC1'));
  let calls = 0;
  t.ctx.msLeftInExecution_ = () => (++calls === 1 ? 300 * 1000 : 80 * 1000); // time for the first week only
  const res = toPlain(t.ctx.upsertPlannerDocument_(scheduleAB(false)));
  assert.deepStrictEqual([res.weeksDone, res.weeksTotal], [1, 2]);
  // Week A (the second week) wasn't touched: still the typed values, and its record is kept.
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['In progress', 'typed before'], ['Not started', '']]);
  const after = toPlain(t.ctx.readWritten_('DOC1'));
  assert.deepStrictEqual(after['1'], recordBefore['1'], "the skipped week's record is kept");
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
  // The next update (with time) finishes it and keeps the edit.
  t.ctx.msLeftInExecution_ = () => 300 * 1000;
  const res2 = toPlain(t.ctx.upsertPlannerDocument_(scheduleAB(false)));
  assert.deepStrictEqual([res2.weeksDone, res2.weeksTotal], [2, 2]);
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['In progress', 'typed before'], ['In progress', 'typed before']]);
});

test('update timing (selfTest): reads, writes, pauses and each week are counted', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.startUpdateStats_();
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const text = t.ctx.updateStatsText_();
  assert.match(text, /^took \d+ s: \d+ Doc reads \d+ s \(about \d+ KB each\), \d+ Doc writes \(\d+ requests\) \d+ s, pauses \d+ s, other \d+ s; by week: Jan 5 \d+ s, Jan 12 \d+ s$/);
  t.ctx.updateStats_ = null;
});

test('an edit in either table wins: By Day only, or changing back to "Not started" or an empty note', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'day', 'Complete', 'typed in By Day');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.table, c.status, c.note]), [['class', 'Complete', 'typed in By Day'], ['day', 'Complete', 'typed in By Day']]);
  staffTypes(docs, WA, X, 'class', 'Not started', '');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Not started', ''], ['Not started', '']]);
});

test('two weeks disagree: the copy from the week the assignment was in last time wins', () => {
  const t = setup();
  const X = url(1);
  const weekA = weekTab('t.a', 'Week of Jan 12 – Jan 18, 2099', [trow(X, 'Complete', 'new')]);
  const weekB = weekTab('t.b', 'Week of Jan 5 – Jan 11, 2099', [trow(X, 'Not started', 'stale')]);
  const written = { '1': { w: '2099-01-12', s: 'In progress', n: t.ctx.noteFingerprint_('old') } };
  assert.deepStrictEqual(toPlain(t.ctx.collectSavedData_({ childTabs: [weekB, weekA] }, written)),
    { notes: { [X]: 'new' }, status: { [X]: 'Complete' } });
});

test('titles that already exist elsewhere in the Doc: a dragged-out week is moved back, and an existing "Past weeks" is reused', () => {
  const ended = typedWeek('t.ended', 'Week of Jan 6 – Jan 12, 2020', 'Complete', 'old', 3);
  const dragged = Object.assign(typedWeek('t.dragged', W, 'In progress', 'keep me'), {});
  dragged.tabProperties.parentTabId = undefined;
  const past = { tabProperties: { tabId: 't.mypast', title: 'Past weeks' }, documentTab: { body: { content: [] } }, childTabs: [] };
  const { t, docs } = rebuildSetup([ended], [dragged, past]);
  t.ctx.upsertPlannerDocument_(scheduleFor());
  assert.deepStrictEqual(docs.titles('t.0'), [W], 'the week is back under CLC Planner (and rebuilt)');
  assert.deepStrictEqual(docs.titles('t.mypast'), ['Week of Jan 6 – Jan 12, 2020'], 'the ended week went into the existing Past weeks');
  assert.deepStrictEqual(docs.titleAnywhere(/^Past weeks$/), ['Past weeks'], 'no second "Past weeks"');
  const id = docs.service.Documents.get().tabs[0].childTabs[0].tabProperties.tabId;
  assert.ok(docs.written[id].includes('keep me'));
});

test('an update that runs across Sunday midnight never writes the week it just filed', () => {
  const t = setup();
  const filled = [];
  t.ctx.fillWeekTabDocsApi_ = (d, p, title) => filled.push(title);
  t.ctx.addWeekChildTab_ = () => 't.new';
  t.ctx.sleepDocsChunkGap_ = () => {};
  t.ctx.rebuildHomeTab_ = () => {};
  const week = (label) => ({ week_label: label, days: [] });
  // The schedule still has last week (fetched before midnight); "today" is now later.
  t.ctx.upsertPlannerDocument_(Object.assign({}, base, { weeks: { '2020-01-06': week('Jan 6 – Jan 12'), '2099-01-05': week('Jan 5 – Jan 11') } }));
  assert.deepStrictEqual(filled, ['Week of Jan 5 – Jan 11, 2099']);
});

test('a Drive hiccup is never mistaken for a deleted Doc or folder', () => {
  const t = setup({ DOCS_FOLDER_ID: 'FOLDER123' });
  t.svc.addFile('DOC1', 'Test Student - CLC Assignments', 'FOLDER123');
  const realGet = t.ctx.DriveApp.getFileById;
  t.ctx.DriveApp.getFileById = () => { throw new Error('Exception: Service error: Drive'); };
  assert.throws(() => t.ctx.savedDocFile_('DOC1'), (e) =>
    e.message === "Google Drive didn't answer about this student's Doc. They'll be tried again at the next update." && e.message.indexOf(t.ctx.DOC_GONE_PREFIX) === -1);
  t.ctx.DriveApp.getFileById = realGet;
  assert.throws(() => t.ctx.savedDocFile_('NOPE'), /^Error: Could not open the saved Google Doc \(NOPE\): Error: No item with the given ID/);
  t.ctx.DriveApp.getFolderById = () => { throw new Error('Exception: Service error: Drive'); };
  assert.throws(() => t.ctx.getDocsFolder_(), (e) => /Service error: Drive/.test(e.message) && !/deleted/.test(e.message));
});

test('notes follow an assignment to its new week; the typed value wins; past weeks are never read', () => {
  const t = setup();
  const X = url(7);
  const parent = { childTabs: [
    weekTab('t.a', 'Week of Oct 5 – Oct 11, 2026', [trow(X, 'In progress', 'Ask about the lab')]),
    weekTab('t.b', 'Week of Oct 12 – Oct 18, 2026', [trow(X, 'Not started', '')]),
    Object.assign(weekTab('t.past', 'Past weeks'), { childTabs: [weekTab('t.old', 'Week of Sep 28 – Oct 4, 2026', [trow(url(8), 'Complete', 'old')])] }),
  ] };
  let saved = toPlain(t.ctx.collectSavedData_(parent));
  assert.deepStrictEqual(saved, { notes: { [X]: 'Ask about the lab' }, status: { [X]: 'In progress' } }, 'past week (url 8) not read');
  // Both weeks edited: the most recent week's values win.
  parent.childTabs[1] = weekTab('t.b', 'Week of Oct 12 – Oct 18, 2026', [trow(X, 'Complete', 'Turned in late')]);
  saved = toPlain(t.ctx.collectSavedData_(parent));
  assert.deepStrictEqual(saved, { notes: { [X]: 'Turned in late' }, status: { [X]: 'Complete' } });
  // The rebuilt week that now holds the assignment gets its Status and Note.
  const week = { week_label: 'Oct 12 – Oct 18', days: [{ day: 'Monday', assignments: [{ day: 'Monday', assignment: 'Essay', course: 'Biology',
    due_time: '9:00 AM', priority: 'This Week', days_until_due: 7, due_date: '2026-10-12', week_start: '2026-10-12', url: X }] }] };
  const reqs = toPlain(t.ctx.buildWeekTabRequests_('t.b', '2026-10-12', week, ['Biology'], { Biology: '#D9EAD3' }, saved, 468));
  const texts = reqs.filter((r) => r.insertText).map((r) => r.insertText.text);
  assert.strictEqual(texts.filter((x) => x === 'Complete').length, 2, 'By Class and By Day');
  assert.strictEqual(texts.filter((x) => x === 'Turned in late').length, 2);
});
