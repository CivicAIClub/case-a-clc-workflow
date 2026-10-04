'use strict';
// Tests for apps_script/Code.gs (the Doc writer): the shared-folder rules and keeping Status.
// The Docs API is faked; all names are made up.
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, toPlain } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');

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
