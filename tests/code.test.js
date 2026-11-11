'use strict';
// Tests for apps_script/Code.gs (the Doc writer): the shared-folder rules and keeping Status.
// The Docs API is faked; all names are made up.
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, toPlain } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');
const {
  fakeDocs, withRendering, renderBlocks, copiesOf, rowsOf, staffTypes, richCell, tcell, chipCell, dayRowsOf, dayPlan, dayRow,
  staffAddsTodo, staffInsertsRow, weekendOf, staffPlansWeekend, oldLayoutContent, liveTab, tablesIn, kindOf, textOf, linkOf, chipOf, stylesOf, typed, numberTab, ADD_TODO,
} = require('./helpers/fake-docs');
const { parseMask, applyFieldMask } = require('./helpers/field-mask');
const fs = require('node:fs');
const path = require('node:path');

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

test('Status: a chosen value in either table survives; words typed before the dropdown become choices; the first choice never overwrites', () => {
  const t = setup();
  const URL = 'https://pomfret.instructure.com/courses/1/assignments/1';
  const read = (content) => toPlain(t.ctx.readExistingDataFromTab_({ documentTab: { body: { content } } }));

  // Week tabs from before November 2026: six columns, and Status was typed.
  const oldTable = (status, note) => ({ table: { columns: 6, tableRows: [{ tableCells: [tcell('Essay draft', URL), tcell('x'), tcell('x'), tcell('x'), tcell(status), tcell(note)] }] } });
  assert.strictEqual(read([oldTable('Complete', ''), oldTable('Not started', '')]).status[URL], 'Done/Submitted');
  assert.strictEqual(read([oldTable('Not started', ''), oldTable('In progress', '')]).status[URL], 'In progress');
  assert.strictEqual(read([oldTable('Not started', ''), oldTable('', '')]).status[URL], 'Need to Start');
  assert.strictEqual(read([oldTable('Not started', 'Needs extension'), oldTable('Not started', '')]).notes[URL], 'Needs extension');
  // Even older Docs had a symbol in front.
  assert.strictEqual(read([oldTable('✅ Complete', ''), oldTable('⬜ Not started', '')]).status[URL], 'Done/Submitted');
  assert.strictEqual(read([oldTable('⬜ Not started', ''), oldTable('🟡 In progress', '')]).status[URL], 'In progress');
  // Anything else staff typed isn't lost: it moves to the start of the note.
  const odd = read([oldTable('Waiting on teacher', 'Ask Friday'), oldTable('Not started', 'Ask Friday')]);
  assert.deepStrictEqual([odd.status[URL], odd.notes[URL]], ['Need to Start', 'Status was: Waiting on teacher. Ask Friday']);
  const oddAlone = read([oldTable('🟡 selfTest Oct 4 4:59 PM', ''), oldTable('⬜ Not started', '')]);
  assert.deepStrictEqual([oddAlone.status[URL], oddAlone.notes[URL]], ['Need to Start', 'Status was: selfTest Oct 4 4:59 PM.']);

  // This layout: four columns, and Status is a dropdown chip.
  const classTable = (statusCell, note) => ({ table: { columns: 4, tableRows: [
    { tableCells: [tcell('English'), tcell(''), tcell(''), tcell('')] },
    { tableCells: ['Assignment', 'Due', 'Status', 'Notes'].map((x) => tcell(x)) },
    { tableCells: [tcell('Essay draft', URL), tcell('Tue 11/17'), statusCell, tcell(note)] },
  ] } });
  const dayTable = (statusCell, note) => ({ table: { columns: 4, tableRows: [
    { tableCells: ['Assignment', 'Class', 'Status', 'Notes'].map((x) => tcell(x)) },
    { tableCells: [richCell({ text: 'Tuesday', runs: [] }, { bold: true }), tcell(''), tcell(''), tcell('')] },
    { tableCells: [tcell('Essay draft', URL), tcell('English'), statusCell, tcell(note)] },
  ] } });
  assert.strictEqual(read([dayTable(chipCell('Done/Submitted'), ''), classTable(chipCell('Need to Start'), '')]).status[URL], 'Done/Submitted');
  assert.strictEqual(read([dayTable(chipCell('Need to Start'), ''), classTable(chipCell('In progress'), 'Bring notes')]).status[URL], 'In progress');
  assert.strictEqual(read([dayTable(chipCell('Need to Start'), ''), classTable(chipCell('In progress'), 'Bring notes')]).notes[URL], 'Bring notes');
  // A chip is read by the choice's ID, so a renamed choice still reads.
  const renamed = chipCell('Done/Submitted');
  renamed.content[0].paragraph.elements[0].dropdown.dropdownProperties.displayValue = 'Handed in';
  assert.strictEqual(read([dayTable(renamed, ''), classTable(chipCell('Need to Start'), '')]).status[URL], 'Done/Submitted');
  // A Status cell with no chip (staff deleted it) says nothing: the other copy is used.
  assert.strictEqual(read([dayTable(tcell(''), ''), classTable(chipCell('In progress'), '')]).status[URL], 'In progress');
  assert.strictEqual(read([dayTable(tcell(''), ''), classTable(tcell(''), '')]).status[URL], undefined);
  // Text typed where the chip was is read like the old typed Status.
  assert.strictEqual(read([dayTable(tcell('done'), ''), classTable(chipCell('Need to Start'), '')]).status[URL], 'Done/Submitted');
});

// ---- The week-tab writer -------------------------------------------------------------------

const GOLDEN = require('./fixtures/week-tab-requests.json');
const url = (n) => 'https://pomfret.instructure.com/courses/1/assignments/' + n;
function goldenWeek() {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ day: d, assignments: [] }));
  days[0].assignments.push({
    day: 'Monday', assignment: 'Paper Outline Due: personality theories (bring two printed sources and your annotated bibliography)',
    course: 'Psychology', due_time: '10:25 AM', days_until_due: 1,
    due_date: '2026-10-05', week_start: '2026-10-05', url: url(2),
  });
  return { week_label: 'Oct 5 – Oct 11', days };
}

// What staff had typed in the golden week before the update: a to-do with a bold word and a red
// second paragraph, a to-do that is a link with no class, and a Sunday afternoon plan.
function goldenStaff(t) {
  const redText = { foregroundColor: { color: { rgbColor: { red: 0.8 } } } };
  const boldLabel = (label) => ({ text: label, runs: [{ s: 0, e: label.length, style: { bold: true } }] });
  const empty = () => ({ text: '', runs: [] });
  const staff = toPlain(t.ctx.readStaffWork_(null));
  staff.days.Tuesday.push({ status: 'In progress', cells: [
    { text: 'Vocab quiz (told in class)', runs: [{ s: 0, e: 10, style: { bold: true } }] },
    { text: 'Spanish', runs: [] },
    { text: 'Study list\nAsk for the review sheet', runs: [{ s: 11, e: 35, style: redText }] },
  ] });
  staff.days.Thursday.push({ status: 'Need to Start', cells: [
    { text: 'Field trip form', runs: [{ s: 0, e: 15, style: { link: { url: 'https://www.pomfret.org/' } } }] },
    empty(), empty(),
  ] });
  staff.weekend.Sunday = [
    [boldLabel('Morning'), empty(), empty()],
    [boldLabel('Afternoon'), { text: 'Finish lab report', runs: [{ s: 0, e: 6, style: { italic: true } }] }, { text: 'library, 2 to 4', runs: [] }],
    [boldLabel('Evening'), empty(), empty()],
  ];
  return staff;
}

test('week tab: the exact requests that were checked against the live Docs API (2026-11-10)', () => {
  // These requests built a tab correctly in a real Google Doc on 2026-11-10: By Day with every
  // school day, one Canvas row with its Status dropdown, two to-dos staff had added (bold, red, a
  // link) with their dropdowns and a "+ Add a to-do" row under each day; the Weekend plan with a
  // Sunday afternoon typed in; By Class with one class table and one line for the class with
  // nothing due. Read back from the Doc, the Status, the Note, the to-dos and the weekend plan
  // came out exactly as written (that read is fixtures/live-week-tab-read-2026-11.json). If you
  // change the layout, check it in a real Doc again, then regenerate this file.
  const t = setup();
  const courses = ['Calculus III', 'Psychology'];
  const saved = { status: { [url(2)]: 'In progress' }, notes: { [url(2)]: 'Ask about the lab report' } };
  const reqs = toPlain(t.ctx.buildWeekTabRequests_('t.kcu88lkds853', '2026-10-05', goldenWeek(), courses,
    t.ctx.buildCourseColorMap_(courses), saved, 468, goldenStaff(t)));
  assert.strictEqual(JSON.stringify(reqs), JSON.stringify(GOLDEN));
});

test('week tab: By Day (every school day, with a blank row), the Weekend plan, then a table per class with work and one line for the rest', () => {
  const t = setup();
  const week = goldenWeek();
  week.days[2].assignments.push({ day: 'Wednesday', assignment: 'HW 7', course: 'Statistics', due_time: '11:59 PM',
    days_until_due: 3, due_date: '2026-10-07', week_start: '2026-10-05', url: url(3) });
  const courses = ['Statistics', 'Calculus III', 'Psychology', 'Advisory'];
  const colors = t.ctx.buildCourseColorMap_(courses);
  const blocks = toPlain(t.ctx.weekTabBlocks_('2026-10-05', week, courses.slice().sort(), colors, { status: { [url(3)]: 'Done/Submitted' }, notes: {} }, 468));
  const shape = blocks.map((b) => b.table ? 'table: ' + b.table.rows[0].cells.map((c) => c.text).filter(Boolean).join(' | ') : b.look + ': ' + b.line);
  assert.deepStrictEqual(shape, [
    'h2: Week of Oct 5 – Oct 11',
    'count: Assignments in this week: 2',
    'h3: By Day',
    'help: To add your own to-do, type in the "+ Add a to-do" row under any day. Need more than one? Right-click a row and choose Insert row below. AutoPlanner keeps everything you add.',
    'table: Assignment | Class | Status | Notes',
    'h3: Weekend plan',
    'help: Plan Saturday and Sunday here. AutoPlanner never changes these two tables.',
    'table: Saturday | Assignment | Notes',
    'table: Sunday | Assignment | Notes',
    'h3: By Class',
    'table: Psychology',
    'table: Statistics',
    'muted: Nothing due this week: Advisory, Calculus III.',
  ]);
  const text = (table) => table.rows.map((r) => r.cells.map((c) => c.chip || c.text).join(' | '));
  const long = 'Paper Outline Due: personality theories (bring two printed sources and your annotated bibliography)';
  assert.deepStrictEqual(text(blocks[4].table), [
    'Assignment | Class | Status | Notes',
    'Monday |  |  | ',
    long + ' (due 10:25 am) | Psychology | dropdownItem.need | ',
    '+ Add a to-do |  |  | ',
    'Tuesday |  |  | ',
    '+ Add a to-do |  |  | ',
    'Wednesday |  |  | ',
    'HW 7 | Statistics | dropdownItem.done | ',
    '+ Add a to-do |  |  | ',
    'Thursday |  |  | ',
    '+ Add a to-do |  |  | ',
    'Friday |  |  | ',
    '+ Add a to-do |  |  | ',
  ], 'the time follows the title only when it is not 11:59 pm; no Saturday or Sunday without work');
  assert.deepStrictEqual(text(blocks[7].table), ['Saturday | Assignment | Notes', 'Morning |  | ', 'Afternoon |  | ', 'Evening |  | ']);
  assert.deepStrictEqual(text(blocks[10].table), ['Psychology |  |  | ', 'Assignment | Due | Status | Notes', long + ' | Mon 10/5, 10:25 am | dropdownItem.need | ']);
  assert.deepStrictEqual(text(blocks[11].table), ['Statistics |  |  | ', 'Assignment | Due | Status | Notes', 'HW 7 | Wed 10/7 | dropdownItem.done | ']);

  // Color: the column names are light gray, day rows gray, the class name row and the By Day Class
  // cell carry the class color, the Weekend plan headers their day's color. Nothing else.
  const colorsOf = (table) => table.rows.map((r) => [r.bg || ''].concat(r.cells.map((c) => c.bg || '')).filter(Boolean).join(' '));
  assert.deepStrictEqual(colorsOf(blocks[4].table).slice(0, 4), ['#EFEFEF', '#B7B7B7', colors.Psychology, '']);
  assert.deepStrictEqual(colorsOf(blocks[10].table), [colors.Psychology, '#EFEFEF', '']);
  assert.deepStrictEqual([colorsOf(blocks[7].table), colorsOf(blocks[8].table)], [['#C9DAF8', '', '', ''], ['#D9EAD3', '', '', '']]);

  // Every class empty: one line, no class tables.
  const none = toPlain(t.ctx.weekTabBlocks_('2026-10-05', { week_label: 'x', days: [] }, courses, colors, { status: {}, notes: {} }, 468));
  assert.deepStrictEqual(none.slice(-2).map((b) => b.line), ['By Class', 'No assignments due this week.']);
  assert.strictEqual(none.filter((b) => b.table).length, 3);
});

test('week tab requests: one Status dropdown, a chip in every assignment row, widths that fill the page', () => {
  const t = setup();
  const week = goldenWeek();
  week.days[2].assignments.push({ day: 'Wednesday', assignment: 'HW 7', course: 'Statistics', due_time: '8:00 AM',
    days_until_due: 3, due_date: '2026-10-07', week_start: '2026-10-05', url: url(3) });
  const courses = ['Advisory', 'Calculus III', 'Psychology', 'Statistics'];
  const hex = (h) => toPlain(t.ctx.optionalColorFromHex_(h));
  for (const width of [468, 451.3]) {
    const reqs = toPlain(t.ctx.buildWeekTabRequests_('t.1', '2026-10-05', week, courses, t.ctx.buildCourseColorMap_(courses),
      { status: { [url(3)]: 'In progress' }, notes: {} }, width));
    // The dropdown comes first, so the chips in the same batch can use it.
    assert.deepStrictEqual(reqs[0], { createDropdownDefinition: { tabId: 't.1', dropdownDefinition: {
      dropdownDefinitionId: 'kix.clc_status',
      dropdownDefinitionProperties: { title: 'Status', options: [
        { optionId: 'dropdownItem.need', displayValue: 'Need to Start', textStyle: { backgroundColor: hex('#F4CCCC'), foregroundColor: hex('#990000') } },
        { optionId: 'dropdownItem.progress', displayValue: 'In progress', textStyle: { backgroundColor: hex('#FFF2CC'), foregroundColor: hex('#7F6000') } },
        { optionId: 'dropdownItem.done', displayValue: 'Done/Submitted', textStyle: { backgroundColor: hex('#D9EAD3'), foregroundColor: hex('#274E13') } },
      ] },
    } } });
    assert.strictEqual(reqs.filter((r) => r.createDropdownDefinition).length, 1);
    // Google's limits: IDs start with "kix." / "dropdownItem." and have 2 to 14 more characters.
    assert.match('kix.clc_status', /^kix\.[a-zA-Z0-9_-]{2,14}$/);
    reqs[0].createDropdownDefinition.dropdownDefinition.dropdownDefinitionProperties.options.forEach((o) => assert.match(o.optionId, /^dropdownItem\.[a-zA-Z0-9_-]{2,14}$/));
    const chips = reqs.filter((r) => r.insertDropdown).map((r) => r.insertDropdown);
    assert.strictEqual(chips.length, 4, 'two assignments, each in By Class and By Day');
    assert.ok(chips.every((c) => c.dropdownDefinitionId === 'kix.clc_status' && c.location.tabId === 't.1'));
    assert.deepStrictEqual(chips.map((c) => c.selectedOptionId).sort(), ['dropdownItem.need', 'dropdownItem.need', 'dropdownItem.progress', 'dropdownItem.progress']);
    assert.ok(!reqs.some((r) => r.insertText && /^(Need to Start|In progress|Done\/Submitted|Not started|Complete)$/.test(r.insertText.text)), 'Status is never typed as text');

    const tables = reqs.filter((r) => r.insertTable).map((r) => r.insertTable);
    assert.deepStrictEqual(tables.map((x) => x.columns), [4, 3, 3, 4, 4], 'By Day, Saturday, Sunday, then the two classes with work');
    const byTable = {};
    reqs.filter((r) => r.updateTableColumnProperties).forEach((r) => {
      const k = r.updateTableColumnProperties.tableStartLocation.index;
      (byTable[k] = byTable[k] || []).push(r.updateTableColumnProperties.tableColumnProperties.width.magnitude);
    });
    const sets = Object.values(byTable);
    assert.strictEqual(sets.length, 5);
    sets.forEach((w) => assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - width) < 0.01, `widths ${w} sum to ${width}`));
    assert.strictEqual(sets[1][0], 80, 'the Weekend plan label column is 80 pt');
    assert.ok(Math.abs(sets[1][1] - sets[1][2]) < 0.02, 'the other two split the rest evenly');
    assert.deepStrictEqual(sets[1], sets[2]);
    assert.deepStrictEqual(sets[3], sets[4], 'all By Class tables share one width set');
  }
});

test('cell text never contains line breaks or control characters (they would break the layout math)', () => {
  const t = setup();
  assert.strictEqual(t.ctx.cellText_('Line one\nLine\ttwo\u0007  end '), 'Line one Line two end');
  assert.strictEqual(t.ctx.cellText_(null), '');
});

test('status words: the three choices, the words typed before the dropdown, and anything else', () => {
  const t = setup();
  assert.deepStrictEqual(toPlain(t.ctx.STATUS_OPTIONS.map((o) => o.label)), ['Need to Start', 'In progress', 'Done/Submitted']);
  assert.strictEqual(t.ctx.STATUS_DEFAULT, 'Need to Start');
  assert.strictEqual(t.ctx.normalizeStatus_('  ✅  complete '), 'Done/Submitted');
  assert.strictEqual(t.ctx.normalizeStatus_('⬜ Not started'), 'Need to Start');
  assert.strictEqual(t.ctx.normalizeStatus_('IN PROGRESS'), 'In progress');
  assert.strictEqual(t.ctx.normalizeStatus_('done/submitted'), 'Done/Submitted');
  assert.strictEqual(t.ctx.normalizeStatus_('Waiting on teacher'), 'Waiting on teacher');
  assert.strictEqual(t.ctx.normalizeStatus_(''), '');
  // Anything that isn't a choice moves to the start of the note, once.
  assert.deepStrictEqual(toPlain(t.ctx.settleStatus_('Done/Submitted', 'ok')), { status: 'Done/Submitted', note: 'ok' });
  assert.deepStrictEqual(toPlain(t.ctx.settleStatus_('', 'ok')), { status: 'Need to Start', note: 'ok' });
  assert.deepStrictEqual(toPlain(t.ctx.settleStatus_('Waiting on teacher', '')), { status: 'Need to Start', note: 'Status was: Waiting on teacher.' });
  assert.deepStrictEqual(toPlain(t.ctx.settleStatus_('Waiting on teacher', 'Ask Friday')), { status: 'Need to Start', note: 'Status was: Waiting on teacher. Ask Friday' });
  assert.deepStrictEqual(toPlain(t.ctx.settleStatus_('Waiting on teacher', 'Status was: Waiting on teacher. Ask Friday')),
    { status: 'Need to Start', note: 'Status was: Waiting on teacher. Ask Friday' });
});

// ---- The CLC Planner home tab -------------------------------------------------------------

function homeData() {
  const C = { calc: 'ADV Calculus III-Smith-G', code: 'ADV Computer Coding-Jones-D', psy: 'ADV Psychology-Lee-A', stat: 'ADV Statistics-Patel-C', eng: 'Eng: Jane Austen-Garcia-B' };
  let n = 0;
  const A = (course, date, time, until, name) => ({ day: 'x', assignment: name, course, due_time: time, days_until_due: until,
    due_date: date, week_start: date < '2026-10-12' ? '2026-10-05' : date < '2026-10-19' ? '2026-10-12' : '2026-10-19', url: url(++n) });
  const list = [
    A(C.psy, '2026-10-05', '8:30 AM', 0, 'Paper Outline Due'), A(C.eng, '2026-10-05', '10:25 AM', 0, 'Read & Annotate (pp. 204-232)'),
    A(C.stat, '2026-10-06', '8:00 AM', 1, 'HW 7'), A(C.stat, '2026-10-06', '8:00 AM', 1, 'SQ 6 & 7'),
    A(C.eng, '2026-10-06', '2:30 PM', 1, 'Read & Annotate (pp. 235-259)'), A(C.code, '2026-10-07', '9:30 AM', 2, 'One-Page Project Spec'),
    A(C.eng, '2026-10-08', '10:35 AM', 3, 'Read & Annotate (pp. 260-291)'), A(C.psy, '2026-10-12', '8:30 AM', 7, 'Paper on Personality'),
    A(C.calc, '2026-10-14', '11:59 PM', 9, 'Problem Set 4'), A(C.eng, '2026-10-12', '10:25 AM', 7, 'Read & Annotate (pp. 292-331)'),
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

test('home tab: the exact requests that were checked against the live Docs API (2026-11-10)', () => {
  // These 60 requests clear an old home tab and build this one. The building requests were sent
  // to a real Google Doc on 2026-11-10 (after the Priority legend was taken out) and made the
  // tab correctly, including the "Open this week" tab link. If you change the home tab, check it
  // in a real Doc again, then regenerate this file.
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
    { assignment: 'Weekend reading', course: 'Eng: Jane Austen-Garcia-B', due_time: '11:59 PM',
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

test('work from earlier this week is counted in the week, but not as next due or due this weekend', () => {
  const t = setup();
  const data = homeData();
  data.weeks['2026-09-28'] = { week_label: 'x', days: [{ day: 'Saturday', assignments: [
    { assignment: 'Saturday quiz', course: 'Eng: Jane Austen-Garcia-B', due_time: '9:00 AM',
      days_until_due: -1, due_date: '2026-10-03', week_start: '2026-09-28', url: url(98) }] }] };
  const courses = t.ctx.plannerCourseList_(data);
  const s = toPlain(t.ctx.homeSummary_(data, courses, SUNDAY_8PM));
  assert.strictEqual(s.soonCount, 0, "Saturday's quiz is past, so nothing is due this weekend");
  const eng = s.rows.filter((r) => /Austen/.test(r.course))[0];
  assert.notStrictEqual(eng.next, 'Sat, Oct 3', 'next due skips work that is already past');
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

test("Doc reads ask only for what AutoPlanner uses (no Past weeks' content, no paragraph or cell styles); if Google refuses that, a full read is used", () => {
  const t = setup();
  const asked = [];
  let refuse = false;
  t.ctx.Docs = { Documents: { get: (id, opts) => {
    asked.push(toPlain(opts));
    if (opts.fields && refuse) throw new Error('Invalid field selection tabs');
    if (id === 'GONE') throw new Error('Requested entity was not found.');
    return { tabs: [] };
  } } };
  const mask = t.ctx.DOCS_GET_FIELDS;
  const tree = parseMask(mask);
  // Tab levels: CLC Planner and other tabs, the week tabs (and Past weeks), the weeks inside Past weeks.
  assert.deepStrictEqual(Object.keys(tree.tabs), ['tabProperties', 'documentTab', 'childTabs']);
  assert.deepStrictEqual(Object.keys(tree.tabs.childTabs), ['tabProperties', 'documentTab', 'childTabs']);
  assert.deepStrictEqual(tree.tabs.childTabs.childTabs, { tabProperties: true }, "past weeks: titles and IDs only");
  const doc = tree.tabs.documentTab;
  assert.deepStrictEqual(doc.documentStyle, { pageSize: true, marginLeft: true, marginRight: true }, 'what tabContentWidth_ uses');
  const el = doc.body.content;
  const textStyle = el.paragraph.elements.textRun.textStyle;
  for (const f of t.ctx.RICH_STYLE_FIELDS.concat(['link', 'foregroundColor', 'backgroundColor'])) assert.strictEqual(textStyle[f], true, f);
  assert.deepStrictEqual(el.table.tableRows.tableCells.content.paragraph, el.paragraph, 'cells: the same paragraph fields');
  // A Status chip: which one it is, which dropdown it belongs to and what is chosen.
  assert.deepStrictEqual(el.paragraph.elements.dropdown, {
    dropdownId: true,
    dropdownProperties: { dropdownDefinitionId: true, selectedOptionId: true, displayValue: true },
  });
  assert.strictEqual(doc.dropdownDefinitions, true, 'a tab that already has the Status dropdown is told apart');
  assert.ok(!/paragraphStyle|tableCellStyle|tableStyle|namedStyles/.test(mask), 'no styles AutoPlanner never reads');
  t.ctx.docsGet_('DOC');
  assert.deepStrictEqual(asked, [{ includeTabsContent: true, fields: mask }]);
  t.ctx.docsGet_('DOC', { includeTabsContent: true });
  assert.deepStrictEqual(asked[1], { includeTabsContent: true }, 'a full read when asked for one');
  // A missing Doc is still an error, and doesn't switch reads to full.
  assert.throws(() => t.ctx.docsGet_('GONE'), /not found/);
  assert.strictEqual(t.ctx.docsGetFieldsRejected_, false);
  // A passing error on the shorter read: asked again, and reads stay short.
  let hiccups = 1;
  t.ctx.Docs = { Documents: { get: (id, opts) => {
    asked.push(toPlain(opts));
    if (opts.fields && hiccups-- > 0) throw new Error('Internal error encountered.');
    return { tabs: [] };
  } } };
  asked.length = 0;
  t.ctx.docsGet_('DOC');
  t.ctx.docsGet_('DOC');
  assert.deepStrictEqual(asked, [{ includeTabsContent: true, fields: mask }, { includeTabsContent: true, fields: mask }, { includeTabsContent: true, fields: mask }]);
  assert.strictEqual(t.ctx.docsGetFieldsRejected_, false);
  // Google refuses the shorter read (twice): the update still works, with full reads from then on.
  t.ctx.Docs = { Documents: { get: (id, opts) => {
    asked.push(toPlain(opts));
    if (opts.fields) throw new Error('Invalid field selection tabs');
    return { tabs: [] };
  } } };
  asked.length = 0;
  t.ctx.docsGet_('DOC');
  t.ctx.docsGet_('DOC');
  assert.deepStrictEqual(asked, [{ includeTabsContent: true, fields: mask }, { includeTabsContent: true, fields: mask }, { includeTabsContent: true }, { includeTabsContent: true }]);
  assert.strictEqual(t.ctx.docsGetFieldsRejected_, true);
});

test('a slim read of a live Doc written before the dropdown gives the same answers as a full read, at a fifth of the size (Status, Notes, links, the "Added by staff" row and its formatting, widths)', () => {
  const t = setup();
  // A full read of a scratch Doc (made-up data) with a week tab in the layout used until November
  // 2026 (six columns, typed Status, an "Added by staff" table), and a staff row typed with bold,
  // red italic and a link (checked live 2026-10-06). It is kept as the Doc every student has when
  // the dropdown version first runs.
  const full = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live-week-tab-read.json'), 'utf8'));
  const slim = applyFieldMask(full, t.ctx.DOCS_GET_FIELDS);
  const size = (o) => JSON.stringify(o).length;
  assert.ok(size(slim) < size(full) / 4, 'slim ' + size(slim) + ' vs full ' + size(full));
  const week = (doc) => doc.tabs.find((x) => /^Week of/.test(x.tabProperties.title));
  const same = (name, fn) => {
    const a = JSON.stringify(toPlain(fn(full)));
    assert.strictEqual(JSON.stringify(toPlain(fn(slim))), a, name);
    return JSON.parse(a);
  };
  // The "Added by staff" row said Friday: it is now a to-do under Friday, with what was typed.
  const staff = same('staff work', (d) => t.ctx.readStaffWork_(week(d)));
  assert.deepStrictEqual(Object.keys(staff.days).filter((d) => staff.days[d].length), ['Friday']);
  const todo = staff.days.Friday[0];
  assert.deepStrictEqual(todo.cells.map((c) => c.text), ['Vocab quiz (announced in class)', 'Spanish', 'Bring flashcards']);
  assert.strictEqual(todo.status, 'Need to Start', '"Not started" is now the first choice');
  const runs = JSON.stringify(todo.cells);
  for (const bit of ['"bold":true', '"italic":true', '"red":0.8', 'https://www.example.org/flashcards']) assert.ok(runs.includes(bit), bit + ' kept: ' + runs);
  assert.deepStrictEqual(staff.weekend, { Saturday: null, Sunday: null }, 'no Weekend plan tables yet');
  assert.strictEqual(same('to-dos counted', (d) => t.ctx.countStaffWork_(t.ctx.readStaffWork_(week(d)))), 1);
  const saved = same('Status and Notes', (d) => t.ctx.readExistingDataFromTab_(week(d)));
  assert.deepStrictEqual(saved.status, { 'https://pomfret.instructure.com/courses/1/assignments/2': 'In progress' });
  assert.deepStrictEqual(saved.notes, { 'https://pomfret.instructure.com/courses/1/assignments/2': 'Ask about the lab report' });
  assert.strictEqual(same('page width', (d) => t.ctx.tabContentWidth_(week(d))), 468);
  assert.strictEqual(same('rebuild needed', (d) => t.ctx.tabBodyHasHeavyContent_(week(d))), true);
  same('home tab clear', (d) => t.ctx.homeClearRequests_(week(d), week(d).tabProperties.tabId));
  assert.deepStrictEqual(same('nothing changed', (d) => t.ctx.changedSince_(week(d), week(d))), { status: {}, notes: {} });
  assert.strictEqual(same('old staff table', (d) => t.ctx.findOldStaffTable_(week(d)).tableRows.length), 3);
});

test('the fake Docs API numbers a tab exactly like Google: every position of a saved live read comes out the same', () => {
  // Staff edits and selfTest's edits go by position, so the tests are only worth something if the
  // fake counts the way Google does. Take the positions off a real read, number it again, compare.
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live-week-tab-read-2026-11.json'), 'utf8')).tabs[0];
  const copy = JSON.parse(JSON.stringify(live));
  let removed = 0;
  const strip = (o) => {
    if (Array.isArray(o)) { o.forEach(strip); return; }
    if (!o || typeof o !== 'object' || o.sectionBreak) return;
    for (const k of ['startIndex', 'endIndex']) {
      if (k in o) { delete o[k]; removed++; }
    }
    Object.values(o).forEach(strip);
  };
  strip(copy.documentTab.body.content);
  assert.ok(removed > 600, 'positions taken off: ' + removed);
  numberTab(copy);
  assert.deepStrictEqual(copy, live);
});

test('a slim read of a live Doc in this layout gives the same answers as a full read: Status chips, to-dos and the Weekend plan with their formatting', () => {
  const t = setup();
  // A full read of one tab of a scratch Doc (made-up data), right after the week-tab requests in
  // fixtures/week-tab-requests.json built it through the live Docs API (2026-11-10).
  const full = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'live-week-tab-read-2026-11.json'), 'utf8'));
  const slim = applyFieldMask(full, t.ctx.DOCS_GET_FIELDS);
  const size = (o) => JSON.stringify(o).length;
  assert.ok(size(slim) < size(full) / 4, 'slim ' + size(slim) + ' vs full ' + size(full));
  const week = (doc) => doc.tabs[0];
  const same = (name, fn) => {
    const a = JSON.stringify(toPlain(fn(full)));
    assert.strictEqual(JSON.stringify(toPlain(fn(slim))), a, name);
    return JSON.parse(a);
  };
  const X = 'https://pomfret.instructure.com/courses/1/assignments/2';
  // Status comes from the chips (By Day and By Class), Notes from the text beside them.
  assert.deepStrictEqual(same('Status and Notes', (d) => t.ctx.readExistingDataFromTab_(week(d))),
    { notes: { [X]: 'Ask about the lab report' }, status: { [X]: 'In progress' } });
  const rows = same('assignment rows', (d) => { const out = []; t.ctx.eachAssignmentRow_(week(d), (r) => out.push([r.kind, r.day, r.status, r.note])); return out; });
  assert.deepStrictEqual(rows.sort(), [['class', 'Monday', 'In progress', 'Ask about the lab report'], ['day', 'Monday', 'In progress', 'Ask about the lab report']]);
  assert.deepStrictEqual(same('tables', (d) => t.ctx.weekTabTables_(week(d)).map((x) => x.layout.kind)), ['day', 'weekend', 'weekend', 'class']);

  // The two to-dos, with the chip each one has, and what was bold, red or a link.
  const staff = same('staff work', (d) => t.ctx.readStaffWork_(week(d)));
  assert.deepStrictEqual(Object.keys(staff.days).filter((d) => staff.days[d].length), ['Tuesday', 'Thursday']);
  assert.deepStrictEqual(staff.days.Tuesday.map((r) => [r.status].concat(r.cells.map((c) => c.text))),
    [['In progress', 'Vocab quiz (told in class)', 'Spanish', 'Study list\nAsk for the review sheet']]);
  assert.deepStrictEqual(staff.days.Thursday.map((r) => [r.status].concat(r.cells.map((c) => c.text))),
    [['Need to Start', 'Field trip form', '', '']], 'the gray "Added by staff" in the Class cell reads as empty');
  const runs = JSON.stringify(staff.days);
  for (const bit of ['"bold":true', '"red":0.8', 'https://www.pomfret.org/']) assert.ok(runs.includes(bit), bit + ' kept: ' + runs);
  // The Weekend plan: Saturday as AutoPlanner made it, Sunday with an afternoon typed in.
  assert.deepStrictEqual(staff.weekend.Saturday.map((r) => r.map((c) => c.text)), [['Morning', '', ''], ['Afternoon', '', ''], ['Evening', '', '']]);
  assert.deepStrictEqual(staff.weekend.Sunday.map((r) => r.map((c) => c.text)), [['Morning', '', ''], ['Afternoon', 'Finish lab report', 'library, 2 to 4'], ['Evening', '', '']]);
  assert.ok(JSON.stringify(staff.weekend.Sunday).includes('"italic":true'));
  assert.strictEqual(same('to-dos counted', (d) => t.ctx.countStaffWork_(t.ctx.readStaffWork_(week(d)))), 3);

  assert.strictEqual(same('page width', (d) => t.ctx.tabContentWidth_(week(d))), 468);
  assert.strictEqual(same('rebuild needed', (d) => t.ctx.tabBodyHasHeavyContent_(week(d))), true);
  assert.deepStrictEqual(Object.keys(week(slim).documentTab.dropdownDefinitions), ['kix.clc_status'], 'the tab says it has the Status dropdown');
  assert.deepStrictEqual(same('nothing changed', (d) => t.ctx.changedSince_(week(d), week(d))), { status: {}, notes: {} });
  assert.strictEqual(same('no old staff table', (d) => t.ctx.findOldStaffTable_(week(d))), null);

  // Written again from what was read, staff's rows come out exactly as they went in.
  const courses = ['Calculus III', 'Psychology'];
  const again = renderBlocks(toPlain(t.ctx.weekTabBlocks_('2026-10-05', goldenWeek(), courses, t.ctx.buildCourseColorMap_(courses),
    t.ctx.readExistingDataFromTab_(week(slim)), 468, t.ctx.readStaffWork_(week(slim)))));
  assert.deepStrictEqual(toPlain(t.ctx.readStaffWork_({ documentTab: { body: { content: again } } })), staff);
});

test('an update reads the Doc N+1 times for N weeks (each week reuses the last one\'s final read), and the home tab reuses the last', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false)); // makes both week tabs
  let reads = 0;
  const realGet = docs.service.Documents.get;
  t.ctx.Docs = { Documents: { get: (id, opts) => { reads++; return realGet(id, opts); }, batchUpdate: docs.service.Documents.batchUpdate } };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.strictEqual(reads, 3, 'one at the start, then each week\'s last look (was 5: a fresh read per week and for the home tab)');
  assert.deepStrictEqual(docs.titles('t.0'), [WB, WA]);
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
});

test('staff typing in the next week right after the last week\'s final read: still kept (that week\'s own last look catches it)', () => {
  const { t, docs, X } = liveStateBeforeRun1();
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const realSwap = t.ctx.swapInRead_;
  let typed = false;
  t.ctx.swapInRead_ = (...args) => {
    const r = realSwap(...args); // week B is done; week A will use this (older) read
    if (!typed) { typed = true; staffTypes(docs, WA, X, 'day', 'Done/Submitted', 'typed between weeks'); }
    return r;
  };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.ok(typed);
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Done/Submitted', 'typed between weeks'], ['Done/Submitted', 'typed between weeks']]);
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
});

test('the home tab changed after the last read: Docs refuses the stale edit, so it reads again and rebuilds', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  let refused = 0;
  let reads = 0;
  const real = docs.service.Documents;
  t.ctx.Docs = { Documents: {
    get: (id, opts) => { reads++; return real.get(id, opts); },
    batchUpdate: (body, id) => {
      const homeClear = body.requests.some((r) => r.deleteParagraphBullets && r.deleteParagraphBullets.range.tabId === 't.0');
      if (homeClear && !refused) { refused++; throw new Error('Invalid requests[0].deleteContentRange: Index 412 must be less than the end index of the referenced segment, 380.'); }
      return real.batchUpdate(body, id);
    },
  } };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.strictEqual(refused, 1);
  assert.strictEqual(reads, 4, 'the 3 reads, plus one fresh read for the home tab');
  // Google's per-minute limit is not a stale read: it isn't retried this way (the update reports it).
  t.ctx.Docs = { Documents: { get: real.get, batchUpdate: (body, id) => {
    if (body.requests.some((r) => r.deleteParagraphBullets)) throw new Error('Quota exceeded for quota metric Write requests');
    return real.batchUpdate(body, id);
  } } };
  t.ctx.sleepDocsChunkGap_ = () => {};
  assert.throws(() => t.ctx.rebuildHomeTab_('DOC1', 't.0', scheduleAB(false), ['Biology'], {}, new Date(), {}, real.get('DOC1', { includeTabsContent: true })), /Quota exceeded/);
});

test('Docs writes are paced to 40 a minute per execution (Google allows 60), waiting only as long as needed', () => {
  const t = setup();
  let now = 1000000;
  t.ctx.Date = class extends Date { static now() { return now; } };
  const sleeps = [];
  t.ctx.Utilities = Object.assign({}, t.ctx.Utilities, { sleep: (ms) => { sleeps.push(ms); now += ms; } });
  t.ctx.Docs = { Documents: { batchUpdate: () => ({ replies: [] }) } };
  t.ctx.docsWriteTimes_ = [];
  for (let i = 0; i < 40; i++) { t.ctx.docsBatchUpdate_('DOC', [{ deleteTab: { tabId: 't' } }]); now += 500; }
  assert.deepStrictEqual(sleeps, [], '40 writes in 20 s: no wait');
  t.ctx.docsBatchUpdate_('DOC', [{ deleteTab: { tabId: 't' } }]);
  assert.deepStrictEqual(sleeps, [40050], 'the 41st waits until the first is a minute old');
  now += 30000;
  t.ctx.docsBatchUpdate_('DOC', [{ deleteTab: { tabId: 't' } }]);
  assert.strictEqual(sleeps.length, 1, 'then on at the normal pace');
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
  { day: 'Monday', assignment: 'Essay', course: 'Biology', due_time: '8:30 AM', days_until_due: 9, due_date: '2099-01-05', week_start: '2099-01-05', url: url(1) }] }] } } });

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
  // That week's assignment left Canvas, but staff had typed a Status and Note on it: it stays, marked.
  const w2 = docs.written['t.n2'] || [];
  // (This Doc was written before the dropdown: its typed "Complete" is now the Done/Submitted chip.)
  assert.ok(w2.includes('later week') && w2.includes('Done/Submitted') && w2.some((x) => /\nNot on Canvas$/.test(x)), w2.join(' | '));
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
  const item = (n, name, week, date) => ({ day: 'Monday', assignment: name, course: 'Biology', due_time: '8:30 AM',
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
  round('Done/Submitted', 'note 2'); // the run that failed live: By Day still said "In progress" / "note 1"
  // selfTest's clean-up: the original values back in both tables, recorded as written.
  staffTypes(docs, WA, X, 'class', 'Need to Start', '');
  staffTypes(docs, WA, X, 'day', 'Need to Start', '');
  t.ctx.recordWritten_('DOC1', X, '2099-01-12', 'Need to Start', '');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Need to Start', ''], ['Need to Start', '']]);
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
  const original = /^selfTest note /.test(first.note) ? { status: 'Need to Start', note: '' } : { status: first.status, note: first.note };
  const testStatus = original.status === 'In progress' ? 'Done/Submitted' : 'In progress';
  staffTypes(docs, WA, X, 'class', testStatus, typed);
  t.ctx.upsertPlannerDocument_(scheduleAB(true)); // moved
  assert.deepStrictEqual(copies().map((c) => [c.week, c.status, c.note]), [[WB, testStatus, typed], [WB, testStatus, typed]], 'followed');
  t.ctx.upsertPlannerDocument_(scheduleAB(false)); // normal
  assert.deepStrictEqual(copies().map((c) => [c.week, c.status, c.note]), [[WA, testStatus, typed], [WA, testStatus, typed]], 'came back, one week tab');
  // everyday: a By Class edit survives a plain update
  const everyday = testStatus === 'Done/Submitted' ? 'In progress' : 'Done/Submitted';
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
  assert.deepStrictEqual(o1, { status: 'Need to Start', note: '' }, "the old test note isn't kept as the original");
  selfTestRound(t, docs, X, 'selfTest note Oct 5 1:40 PM');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Need to Start', ''], ['Need to Start', '']], 'clean after both runs');
});

test('an update that read the Doc just before staff typed keeps the typed value (the race that failed the first #13 selfTest)', () => {
  const { t, docs, X } = liveStateBeforeRun1();
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  // Staff (or selfTest) type right after the update has read the Doc, before it rebuilds the tab.
  const realCollect = t.ctx.collectSavedData_;
  let typed = false;
  t.ctx.collectSavedData_ = (parent, written) => {
    const result = realCollect(parent, written);
    if (!typed) { typed = true; staffTypes(docs, WA, X, 'class', 'Done/Submitted', 'typed mid-update'); }
    return result;
  };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Done/Submitted', 'typed mid-update'], ['Done/Submitted', 'typed mid-update']]);
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

// scheduleAB without some assignments (by url number), and with Canvas's list of where the others went.
function scheduleWithout(nums, elsewhere, courses) {
  const s = scheduleAB(false);
  Object.values(s.weeks).forEach((w) => w.days.forEach((d) => { d.assignments = d.assignments.filter((a) => !nums.includes(Number(a.url.split('/').pop()))); }));
  if (elsewhere) s.elsewhere = elsewhere;
  if (courses) s.courses = courses;
  return s;
}

test('scenario (b): an assignment that leaves Canvas keeps its typed Status and Note in its week, marked with why, and comes back with them', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1), Y = url(2);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', 'extension to Friday');
  // Removed or unpublished: not in Canvas's list at all.
  t.ctx.upsertPlannerDocument_(scheduleWithout([1, 2], {}));
  // The reason is a second line in the Assignment cell (it used to be the Priority cell).
  const kept = (reason) => [
    { week: WA, table: 'class', title: 'X', reason, klass: 'Biology', due: 'Mon 1/12, 8:30 am', status: 'In progress', note: 'extension to Friday' },
    { week: WA, table: 'day', title: 'X (due 8:30 am)', reason, klass: 'Biology', due: '', status: 'In progress', note: 'extension to Friday' },
  ];
  assert.deepStrictEqual(rowsOf(docs, X), kept('Not on Canvas'));
  assert.deepStrictEqual(rowsOf(docs, Y), [], 'nothing was typed on Y, so it just goes');
  // Still in Canvas, without a due date, or due outside these weeks.
  t.ctx.upsertPlannerDocument_(scheduleWithout([1], { [X]: '' }));
  assert.deepStrictEqual(rowsOf(docs, X), kept('No due date'));
  t.ctx.upsertPlannerDocument_(scheduleWithout([1], { [X]: '2099-03-02' }));
  assert.deepStrictEqual(rowsOf(docs, X), kept('Now due Mar 2'));
  // An edit on a kept row counts like any other.
  staffTypes(docs, WA, X, 'day', 'Done/Submitted', 'handed in on paper');
  t.ctx.upsertPlannerDocument_(scheduleWithout([1], { [X]: '2099-03-02' }));
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.status, r.note]), [['Done/Submitted', 'handed in on paper'], ['Done/Submitted', 'handed in on paper']]);
  // Back on Canvas in the other week: there, with its Status and Note, and only there.
  t.ctx.upsertPlannerDocument_(scheduleAB(true));
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.week, r.reason, r.status, r.note]),
    [[WB, '', 'Done/Submitted', 'handed in on paper'], [WB, '', 'Done/Submitted', 'handed in on paper']]);
  // Gone again, then staff clear its Status and Note: the row goes at the next update.
  t.ctx.upsertPlannerDocument_(scheduleWithout([1], {}));
  assert.strictEqual(rowsOf(docs, X).length, 2);
  staffTypes(docs, WB, X, 'class', 'Need to Start', '');
  staffTypes(docs, WB, X, 'day', 'Need to Start', '');
  t.ctx.upsertPlannerDocument_(scheduleWithout([1], {}));
  assert.deepStrictEqual(rowsOf(docs, X), []);
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
});

test('scenario (c): an assignment renamed, or its class renamed, keeps its Status and Note (they go by the Canvas link)', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', 'draft 1 done');
  const renamed = scheduleAB(false);
  renamed.courses = ['Biology (Semester 2)'];
  Object.values(renamed.weeks).forEach((w) => w.days.forEach((d) => d.assignments.forEach((a) => {
    a.course = 'Biology (Semester 2)';
    if (a.url === X) a.assignment = 'X (revised)';
  })));
  t.ctx.upsertPlannerDocument_(renamed);
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.week, r.title, r.klass, r.reason, r.status, r.note]), [
    [WA, 'X (revised)', 'Biology (Semester 2)', '', 'In progress', 'draft 1 done'], [WA, 'X (revised) (due 8:30 am)', 'Biology (Semester 2)', '', 'In progress', 'draft 1 done']]);
  assert.ok(docs.written[docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === WA).tabProperties.tabId].includes('X (revised)'));
});

test('scenario (h): a renamed week tab gets its title back (found from its heading) and keeps its Status and Notes; nothing is duplicated', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', 'keep me');
  const tabA = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === WA);
  docs.service.Documents.batchUpdate({ requests: [{ updateDocumentTabProperties: { tabProperties: { tabId: tabA.tabProperties.tabId, title: 'Mid-January (Avery)' }, fields: 'title' } }] });
  // The fake lays out tables only, so give the renamed tab the heading the real writer puts first.
  docs.find(tabA.tabProperties.tabId).documentTab.body.content.unshift({ paragraph: { elements: [{ textRun: { content: 'Week of Jan 12 – Jan 18\n' } }] } });
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(docs.titles('t.0'), [WB, WA]);
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.week, r.status, r.note]), [[WA, 'In progress', 'keep me'], [WA, 'In progress', 'keep me']]);
  // The heading's year is the one nearest today: the Dec 28 – Jan 3 week, from either side of New Year.
  assert.strictEqual(t.ctx.weekKeyFromHeading_('Week of Dec 28 – Jan 3', '2027-01-02'), '2026-12-28');
  assert.strictEqual(t.ctx.weekKeyFromHeading_('Week of Dec 28 – Jan 3', '2026-12-20'), '2026-12-28');
  assert.strictEqual(t.ctx.weekKeyFromHeading_('Week of Oct 7 – Oct 13', '2026-10-06'), null, 'Oct 7 is not a Monday in 2025, 2026 or 2027');
  assert.strictEqual(t.ctx.weekKeyFromHeading_('My notes', '2026-10-06'), null);
});

test('scenario (h): a deleted week tab comes back with its Statuses (not its Notes); a deleted By Class table loses nothing', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1), Y = url(2);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', 'gone with the tab');
  staffTypes(docs, WA, Y, 'day', 'Done/Submitted', 'in By Day too');
  t.ctx.upsertPlannerDocument_(scheduleAB(false)); // written down: X In progress, Y Complete
  // Staff delete the By Class table that has X and Y: the By Day copies still hold everything.
  const live = () => docs.find(docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === WA).tabProperties.tabId);
  const content = live().documentTab.body.content;
  live().documentTab.body.content = content.filter((e) => !(e.table && e.table.tableRows[0].tableCells.length === 1 && /Biology/.test(e.table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content)));
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.table, r.status, r.note]), [['class', 'In progress', 'gone with the tab'], ['day', 'In progress', 'gone with the tab']]);
  // Staff delete the whole week tab.
  docs.service.Documents.batchUpdate({ requests: [{ deleteTab: { tabId: live().tabProperties.tabId } }] });
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(docs.titles('t.0'), [WB, WA]);
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.status, r.note]), [['In progress', ''], ['In progress', '']]);
  assert.deepStrictEqual(rowsOf(docs, Y).map((r) => [r.status, r.note]), [['Done/Submitted', ''], ['Done/Submitted', '']]);
});

test("a new Doc replacing a deleted one gets the old Doc's Statuses back (not Notes), and the old record is removed", () => {
  const { t, docs } = rebuildSetup([]);
  const realBuild = t.ctx.buildWeekTabRequests_;
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'class', 'In progress', 'lost with the Doc');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.ok(t.svc.props['written.DOC1']);
  // The Doc is deleted; AutoPlanner writes a new, empty one.
  const fresh = fakeDocs([homeTab([])]);
  t.ctx.Docs = fresh.service;
  t.ctx.buildWeekTabRequests_ = realBuild;
  withRendering(t, fresh);
  t.svc.addFile('DOC2', 'Test Student - CLC Assignments', null);
  t.ctx.upsertPlannerDocument_(Object.assign(scheduleAB(false), { documentId: 'DOC2', previousDocId: 'DOC1' }));
  assert.deepStrictEqual(rowsOf(fresh, X).map((r) => [r.status, r.note]), [['In progress', ''], ['In progress', '']]);
  assert.ok(t.svc.props['written.DOC2'] && !('written.DOC1' in t.svc.props), Object.keys(t.svc.props).join(' '));
});

// A simulated clock and the real Canvas.gs scheduling: `canvas` lists [id, name, due_at (UTC) or null].
function clockSetup() {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  let now = new Date('2026-11-04T15:00:00Z').getTime();
  const RealDate = Date;
  t.ctx.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now); }
    static now() { return now; }
  };
  const at = (iso) => { now = new RealDate(iso).getTime(); };
  const u = (id) => 'https://pomfret.instructure.com/courses/1/assignments/' + id;
  const update = (canvas) => {
    const pairs = canvas.map(([id, name, due]) => [{ name, due_at: due, html_url: u(id) }, 'Biology']);
    const sched = toPlain(t.ctx.buildWeeklySchedule_(pairs, 'America/New_York', 4, new t.ctx.Date()));
    sched.elsewhere = toPlain(t.ctx.canvasElsewhere_(pairs, sched));
    // noDeadline: the simulated clock is weeks ahead of when this "execution" started.
    t.ctx.upsertPlannerDocument_(Object.assign({}, base, sched, { documentId: 'DOC1', courses: ['Biology'], noDeadline: true }));
  };
  const weekTitle = (label) => docs.service.Documents.get().tabs[0].childTabs.map((x) => x.tabProperties.title).find((x) => x.startsWith('Week of ' + label));
  return { t, docs, at, u, update, weekTitle };
}

test('simulation bug 1: overdue work given a new date after its week was filed comes back with its Status and Note (from Past weeks)', () => {
  const { t, docs, at, u, update, weekTitle } = clockSetup();
  update([[1, 'Lab report', '2026-11-06T20:00:00Z'], [2, 'Quiz', '2026-11-10T20:00:00Z']]);
  staffTypes(docs, weekTitle('Nov 2'), u(1), 'class', 'In progress', 'missing the graph');
  update([[1, 'Lab report', '2026-11-06T20:00:00Z'], [2, 'Quiz', '2026-11-10T20:00:00Z']]);
  // Monday just after midnight: last week is filed; the lab report is overdue (not on the planner).
  at('2026-11-09T05:20:00Z');
  update([[1, 'Lab report', '2026-11-06T20:00:00Z'], [2, 'Quiz', '2026-11-10T20:00:00Z']]);
  assert.ok(!weekTitle('Nov 2'), 'filed');
  // Remembered: the ID, its week and what was last written (a note's fingerprint, never the note).
  assert.deepStrictEqual(toPlain(t.ctx.readFiled_('DOC1')), { 1: { w: '2026-11-02', s: 'In progress', n: t.ctx.noteFingerprint_('missing the graph') } });
  assert.ok(!t.svc.props['filed.DOC1'].includes('graph'));
  // Tuesday: the teacher extends it to Wednesday.
  at('2026-11-10T23:00:00Z');
  let reads = 0;
  const realGet = docs.service.Documents.get;
  t.ctx.Docs = { Documents: { get: (id, o) => { if (o && o.fields === t.ctx.DOCS_GET_FIELDS_WITH_PAST) reads++; return realGet(id, o); }, batchUpdate: docs.service.Documents.batchUpdate } };
  update([[1, 'Lab report', '2026-11-12T04:59:00Z'], [2, 'Quiz', '2026-11-10T20:00:00Z']]);
  assert.deepStrictEqual(rowsOf(docs, u(1)).map((r) => [r.week, r.status, r.note]), [
    ['Week of Nov 9 – Nov 15, 2026', 'In progress', 'missing the graph'], ['Week of Nov 9 – Nov 15, 2026', 'In progress', 'missing the graph']]);
  assert.strictEqual(reads, 1, 'one read with Past weeks');
  update([[1, 'Lab report', '2026-11-12T04:59:00Z'], [2, 'Quiz', '2026-11-10T20:00:00Z']]);
  assert.strictEqual(reads, 1, 'and only that once: now it has rows of its own');
});

test('simulation bug 1, edited late: an edit typed after the last update before filing (one table only) is the one that comes back', () => {
  const { docs, at, u, update, weekTitle } = clockSetup();
  update([[1, 'Lab report', '2026-11-06T20:00:00Z']]);
  staffTypes(docs, weekTitle('Nov 2'), u(1), 'class', 'In progress', 'first note');
  update([[1, 'Lab report', '2026-11-06T20:00:00Z']]); // written down: In progress, "first note"
  staffTypes(docs, weekTitle('Nov 2'), u(1), 'day', 'Done/Submitted', 'typed Sunday night'); // By Day only
  at('2026-11-09T05:20:00Z');
  update([[1, 'Lab report', '2026-11-06T20:00:00Z']]); // filed, with the two tables disagreeing
  at('2026-11-10T23:00:00Z');
  update([[1, 'Lab report', '2026-11-12T04:59:00Z']]);
  assert.deepStrictEqual(rowsOf(docs, u(1)).map((r) => [r.status, r.note]), [['Done/Submitted', 'typed Sunday night'], ['Done/Submitted', 'typed Sunday night']]);
});

test('simulation bug 2: work pushed past these 4 weeks, then back in, keeps its Status and Note (kept row, then Past weeks)', () => {
  const { docs, at, u, update, weekTitle } = clockSetup();
  update([[3, 'Essay', '2026-11-13T20:00:00Z']]);
  staffTypes(docs, weekTitle('Nov 9'), u(3), 'class', 'In progress', 'outline approved');
  // Postponed to Dec 21: outside the 4 weeks. Its row stays in its week, marked.
  update([[3, 'Essay', '2026-12-21T20:00:00Z']]);
  assert.deepStrictEqual(rowsOf(docs, u(3)).map((r) => [r.week, r.reason, r.note]), [
    ['Week of Nov 9 – Nov 15, 2026', 'Now due Dec 21', 'outline approved'], ['Week of Nov 9 – Nov 15, 2026', 'Now due Dec 21', 'outline approved']]);
  for (const day of ['2026-11-16', '2026-11-23']) { at(day + 'T05:20:00Z'); update([[3, 'Essay', '2026-12-21T20:00:00Z']]); }
  assert.deepStrictEqual(rowsOf(docs, u(3)), [], 'its week was filed');
  at('2026-11-30T05:20:00Z'); // Dec 21 is now within the 4 weeks
  update([[3, 'Essay', '2026-12-21T20:00:00Z']]);
  assert.deepStrictEqual(rowsOf(docs, u(3)).map((r) => [r.week, r.reason, r.status, r.note]), [
    ['Week of Dec 21 – Dec 27, 2026', '', 'In progress', 'outline approved'], ['Week of Dec 21 – Dec 27, 2026', '', 'In progress', 'outline approved']]);
});

test('simulation bug 5: a Doc near Google\'s 100-tab limit: a clear message instead of a "temporary problem", and nothing is written', () => {
  const pastKids = Array.from({ length: 97 }, (_, i) => ({ tabProperties: { tabId: 't.p' + i, title: 'Old week ' + i }, childTabs: [] }));
  const past = { tabProperties: { tabId: 't.past', title: 'Past weeks' }, documentTab: { body: { content: [] } }, childTabs: pastKids };
  const { t, docs } = rebuildSetup([past]);
  withRendering(t, docs);
  assert.strictEqual(t.ctx.countTabs_(docs.service.Documents.get()), 99, '98 would still fit: an update adds at most 2');
  assert.throws(() => t.ctx.upsertPlannerDocument_(scheduleAB(false)),
    /^Error: This student's Doc has 99 tabs, and Google allows 100\. Start a new Doc for them: add the year to this Doc's name, then Remove the student and add them again/);
  assert.deepStrictEqual(docs.batches, [], 'nothing written');
  // With room, an update says how many tabs the Doc has (the weekly email warns from 80).
  const ok = rebuildSetup([]);
  withRendering(ok.t, ok.docs);
  assert.strictEqual(toPlain(ok.t.ctx.upsertPlannerDocument_(scheduleAB(false))).tabs, 1);
  assert.strictEqual(toPlain(ok.t.ctx.upsertPlannerDocument_(scheduleAB(false))).tabs, 3);
});

test('simulation bug 6: a class keeps its color when the class list changes (the semester change)', () => {
  const t = setup();
  const fall = toPlain(t.ctx.buildCourseColorMap_(['Biology', 'French II', 'History', 'Math', 'English']));
  const spring = toPlain(t.ctx.buildCourseColorMap_(['Biology', 'French II', 'Chemistry', 'Art', 'English'], fall));
  for (const c of ['Biology', 'French II', 'English']) assert.strictEqual(spring[c], fall[c], c);
  assert.strictEqual(new Set(Object.values(spring)).size, 5, 'still five different colors');
  // Without the earlier colors, French II would change here (what the simulation saw).
  const fresh = toPlain(t.ctx.buildCourseColorMap_(['Biology', 'French II', 'Chemistry', 'Art', 'English']));
  assert.ok(['Biology', 'French II', 'English'].some((c) => fresh[c] !== fall[c]), 'this example does change without them');
  // An update remembers the Doc's colors.
  const { t: u, docs } = rebuildSetup([]);
  withRendering(u, docs);
  u.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(Object.keys(JSON.parse(u.svc.props['colors.DOC1'])), ['Biology']);
});

test('simulation bug 7: the week that crosses New Year shows both years, reads back, and an older title is brought up to date', () => {
  const t = setup();
  assert.strictEqual(t.ctx.buildWeekTabTitle_('2026-12-28', 'Dec 28 – Jan 3'), 'Week of Dec 28, 2026 – Jan 3, 2027');
  assert.strictEqual(t.ctx.buildWeekTabTitle_('2026-12-21', 'Dec 21 – Dec 27'), 'Week of Dec 21 – Dec 27, 2026');
  assert.strictEqual(t.ctx.weekKeyFromTabTitle_('Week of Dec 28, 2026 – Jan 3, 2027'), '2026-12-28');
  assert.strictEqual(t.ctx.weekKeyFromTabTitle_('Week of Dec 28 – Jan 3, 2026'), '2026-12-28', 'the older form still reads');
  const { docs, at, u, update } = clockSetup();
  at('2026-12-15T15:00:00Z');
  update([[7, 'Winter reading', '2026-12-31T16:00:00Z']]);
  const titles = () => docs.service.Documents.get().tabs[0].childTabs.map((x) => x.tabProperties.title);
  assert.ok(titles().includes('Week of Dec 28, 2026 – Jan 3, 2027'), titles().join(' | '));
  // A Doc that got the older title: renamed at the next update, with its rows.
  const tab = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === 'Week of Dec 28, 2026 – Jan 3, 2027');
  docs.service.Documents.batchUpdate({ requests: [{ updateDocumentTabProperties: { tabProperties: { tabId: tab.tabProperties.tabId, title: 'Week of Dec 28 – Jan 3, 2026' }, fields: 'title' } }] });
  staffTypes(docs, 'Week of Dec 28 – Jan 3, 2026', u(7), 'class', 'In progress', 'over break');
  update([[7, 'Winter reading', '2026-12-31T16:00:00Z']]);
  assert.deepStrictEqual(rowsOf(docs, u(7)).map((r) => [r.week, r.note]), [['Week of Dec 28, 2026 – Jan 3, 2027', 'over break'], ['Week of Dec 28, 2026 – Jan 3, 2027', 'over break']]);
  // Filed on Monday Jan 4, under its title.
  at('2027-01-04T05:20:00Z');
  update([]);
  const pastWeeks = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === 'Past weeks');
  assert.ok(pastWeeks.childTabs.some((x) => x.tabProperties.title === 'Week of Dec 28, 2026 – Jan 3, 2027'));
});

test('scenario (d): a dropped class keeps a table only in the week where a typed row stays; the home tab only counts what Canvas has', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  const withChem = scheduleAB(false);
  withChem.courses = ['Biology', 'Chemistry'];
  withChem.weeks['2099-01-12'].days[0].assignments.find((a) => a.url === X).course = 'Chemistry';
  t.ctx.upsertPlannerDocument_(withChem);
  staffTypes(docs, WA, X, 'class', 'In progress', 'lab makeup');
  // The student drops Chemistry: Canvas no longer lists the class or its assignments.
  t.ctx.upsertPlannerDocument_(scheduleWithout([1], {}, ['Biology']));
  assert.deepStrictEqual(rowsOf(docs, X).map((r) => [r.week, r.klass, r.reason, r.note]),
    [[WA, 'Chemistry', 'Not on Canvas', 'lab makeup'], [WA, 'Chemistry', 'Not on Canvas', 'lab makeup']]);
  const classTables = (title) => tablesIn(liveTab(docs, title), 'class').map((table) => textOf(table.tableRows[0].tableCells[0]));
  assert.deepStrictEqual(classTables(WA), ['Biology', 'Chemistry']);
  assert.deepStrictEqual(classTables(WB), ['Biology'], 'no empty Chemistry table in other weeks');
  const summary = toPlain(t.ctx.homeSummary_(scheduleWithout([1], {}, ['Biology']), ['Biology'], new Date('2099-01-13T15:00:00Z')));
  assert.ok(!JSON.stringify(summary).includes('Chemistry'), 'the home tab is about what Canvas has');
});

test('"last written" records are compact, split over more properties when big, and the first format still reads', () => {
  const t = setup();
  const map = {};
  for (let i = 0; i < 320; i++) map[String(1000000 + i)] = { w: '2026-10-05', s: ['Need to Start', 'In progress', 'Done/Submitted'][i % 3], n: t.ctx.noteFingerprint_(i % 2 ? 'a note ' + i : '') };
  t.ctx.saveWritten_('DOCX', map);
  const parts = Object.keys(t.svc.props).filter((k) => k.indexOf('written.DOCX') === 0);
  assert.deepStrictEqual(parts.sort(), ['written.DOCX', 'written.DOCX.1'], '320 assignments: two parts');
  parts.forEach((k) => assert.ok(t.svc.props[k].length < 8500, k + ' fits in one property'));
  assert.deepStrictEqual(toPlain(t.ctx.readWritten_('DOCX')), map);
  // Fewer assignments later: the extra part is removed.
  t.ctx.saveWritten_('DOCX', { 1: { w: '2026-10-12', s: 'Done/Submitted', n: '' } });
  assert.deepStrictEqual(Object.keys(t.svc.props).filter((k) => k.indexOf('written.DOCX') === 0), ['written.DOCX']);
  assert.strictEqual(t.svc.props['written.DOCX'], '{"1":"20261012D"}', 'about 28 characters per assignment with a note');
  t.svc.props['written.OLD'] = JSON.stringify({ 5: { w: '2026-10-05', s: 'In progress', n: 'abc' } });
  assert.deepStrictEqual(toPlain(t.ctx.readWritten_('OLD')), { 5: { w: '2026-10-05', s: 'In progress', n: 'abc' } });
  // Records saved before the dropdown (N, I, C, or the words staff typed) read as today's choices.
  t.svc.props['written.BEFORE'] = JSON.stringify({ 1: '20261005N', 2: '20261005Iab12', 3: '20261005C', 4: '20261005|Waiting on teacher|cd34', 5: '20261005|done|', 6: { w: '2026-10-05', s: 'Complete', n: '' } });
  assert.deepStrictEqual(Object.values(toPlain(t.ctx.readWritten_('BEFORE'))).map((r) => [r.s, r.n]), [
    ['Need to Start', ''], ['In progress', 'ab12'], ['Done/Submitted', ''], ['Waiting on teacher', 'cd34'], ['Done/Submitted', ''], ['Done/Submitted', ''],
  ]);
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
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['In progress', 'typed before'], ['Need to Start', '']]);
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

test('an edit in either table wins: By Day only, or changing back to "Need to Start" or an empty note', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  const X = url(1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffTypes(docs, WA, X, 'day', 'Done/Submitted', 'typed in By Day');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.table, c.status, c.note]), [['class', 'Done/Submitted', 'typed in By Day'], ['day', 'Done/Submitted', 'typed in By Day']]);
  staffTypes(docs, WA, X, 'class', 'Need to Start', '');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Need to Start', ''], ['Need to Start', '']]);
  // Staff delete a chip and type over it: one of the choices is read as that choice, anything else
  // goes to the front of the Note and the chip comes back on Need to Start.
  staffTypes(docs, WA, X, 'day', 'done', '');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Done/Submitted', ''], ['Done/Submitted', '']]);
  staffTypes(docs, WA, X, 'class', 'Ask Ms. Rivera', 'after class');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const moved = ['Need to Start', 'Status was: Ask Ms. Rivera. after class'];
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [moved, moved]);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [moved, moved], 'and it is not added twice');
});

test('two weeks disagree: the copy from the week the assignment was in last time wins', () => {
  const t = setup();
  const X = url(1);
  const weekA = weekTab('t.a', 'Week of Jan 12 – Jan 18, 2099', [trow(X, 'Complete', 'new')]);
  const weekB = weekTab('t.b', 'Week of Jan 5 – Jan 11, 2099', [trow(X, 'Not started', 'stale')]);
  const written = { '1': { w: '2099-01-12', s: 'In progress', n: t.ctx.noteFingerprint_('old') } };
  assert.deepStrictEqual(toPlain(t.ctx.collectSavedData_({ childTabs: [weekB, weekA] }, written)),
    { notes: { [X]: 'new' }, status: { [X]: 'Done/Submitted' } }); // typed "Complete" before the dropdown
});

// ---- Status dropdowns when the Advanced Docs service doesn't know them ---------------------------

// A Docs service that refuses any batch with a dropdown request while `refusing` is true, and a
// Docs REST API that answers `restReply()`. `sent` lists which of the two got each batch.
function dropdownTransport(restReply) {
  const t = setup();
  const state = { t, sent: [], fetches: [], refusing: true, serviceError: null };
  const kinds = (requests) => requests.map((r) => Object.keys(r)[0]).join();
  t.ctx.Docs = { Documents: { batchUpdate: (body) => {
    if (state.serviceError) { const e = state.serviceError; state.serviceError = null; throw e; }
    if (state.refusing && /Dropdown/.test(kinds(body.requests))) {
      throw new Error('GoogleJsonResponseException: API call to docs.documents.batchUpdate failed with error: Invalid JSON payload received. Unknown name "createDropdownDefinition"');
    }
    state.sent.push('service ' + kinds(body.requests));
    return { replies: [] };
  } } };
  t.ctx.UrlFetchApp = { fetch: (u, params) => {
    state.fetches.push({ url: u, params });
    const reply = restReply(state.fetches.length);
    if (reply.code === 200) state.sent.push('rest ' + kinds(JSON.parse(params.payload).requests));
    return { getResponseCode: () => reply.code, getContentText: () => JSON.stringify(reply.body) };
  } };
  return state;
}
const someText = { insertText: { location: { index: 1, tabId: 't.1' }, text: 'x' } };
const aChip = { insertDropdown: { location: { index: 5, tabId: 't.1' }, dropdownDefinitionId: 'kix.clc_status', selectedOptionId: 'dropdownItem.need' } };

test('Status dropdowns: if the Advanced Docs service refuses them, those batches go to the Docs REST API and every other batch stays on the service', () => {
  const s = dropdownTransport(() => ({ code: 200, body: { documentId: 'DOC1', replies: [{}, {}] } }));
  const ctx = s.t.ctx;
  ctx.docsBatchUpdate_('DOC1', [someText]);
  const reply = toPlain(ctx.docsBatchUpdate_('DOC1', [ctx.statusDropdownRequest_('t.1'), someText]));
  ctx.docsBatchUpdate_('DOC1', [aChip]);
  ctx.docsBatchUpdate_('DOC1', [someText]);
  ctx.docsBatchUpdate_('DOC1', [{ updateDropdownProperties: { dropdownId: 'kix.abc', tabId: 't.1', dropdownProperties: { selectedOptionId: 'dropdownItem.done' }, fields: 'selectedOptionId' } }]);
  assert.deepStrictEqual(s.sent, ['service insertText', 'rest createDropdownDefinition,insertText', 'rest insertDropdown', 'service insertText', 'rest updateDropdownProperties']);
  assert.deepStrictEqual(reply, { documentId: 'DOC1', replies: [{}, {}] }, "the REST reply is handed back like the service's");
  const first = s.fetches[0];
  assert.strictEqual(first.url, 'https://docs.googleapis.com/v1/documents/DOC1:batchUpdate');
  assert.deepStrictEqual([first.params.method, first.params.contentType, first.params.muteHttpExceptions, toPlain(first.params.headers)],
    ['post', 'application/json', true, { Authorization: 'Bearer fake-oauth-token' }]);
  assert.deepStrictEqual(Object.keys(JSON.parse(first.params.payload)), ['requests']);
});

test('Status dropdowns: a batch both the service and the REST API refuse reports the first error; a quota error is retried, never rerouted', () => {
  // Both refuse: the batch was wrong for another reason. The service's error is the one staff see.
  const both = dropdownTransport(() => ({ code: 400, body: { error: { message: 'Invalid requests[1].insertText: Index 99 must be less than the end index of the referenced segment, 3.' } } }));
  assert.throws(() => both.t.ctx.docsBatchUpdate_('DOC1', [both.t.ctx.statusDropdownRequest_('t.1'), someText]), /Unknown name "createDropdownDefinition"/);
  assert.strictEqual(both.fetches.length, 1, 'sent to the REST API once, not seven times');
  assert.strictEqual(both.t.ctx.docsDropdownsViaRest_, false, 'and the REST API is not used from then on');
  // A dropdown batch that isn't the one that makes the dropdown is never rerouted on its own.
  assert.throws(() => both.t.ctx.docsBatchUpdate_('DOC1', [aChip]), /Unknown name/);
  assert.strictEqual(both.fetches.length, 1);

  // "Quota exceeded" from the service: wait and send it to the service again.
  const quota = dropdownTransport(() => ({ code: 200, body: { replies: [] } }));
  quota.refusing = false;
  quota.serviceError = new Error('Quota exceeded for quota metric \'Write requests\'');
  quota.t.ctx.docsBatchUpdate_('DOC1', [quota.t.ctx.statusDropdownRequest_('t.1'), someText]);
  assert.deepStrictEqual(quota.sent, ['service createDropdownDefinition,insertText']);
  assert.strictEqual(quota.fetches.length, 0);
  assert.deepStrictEqual(quota.t.svc.sleepCalls, [2500]);

  // A 429 from the REST API is a quota error too: the same batch is tried again and goes through.
  const busy = dropdownTransport((n) => (n === 1 ? { code: 429, body: { error: { message: 'Quota exceeded' } } } : { code: 200, body: { replies: [] } }));
  busy.t.ctx.docsBatchUpdate_('DOC1', [busy.t.ctx.statusDropdownRequest_('t.1'), someText]);
  assert.deepStrictEqual(busy.sent, ['rest createDropdownDefinition,insertText']);
  assert.strictEqual(busy.fetches.length, 2);
  assert.strictEqual(busy.t.ctx.docsDropdownsViaRest_, true);
});

// ---- Staff's own to-dos (By Day) and the Weekend plan ------------------------------------------

const bold = { bold: true };
const red = { foregroundColor: { color: { rgbColor: { red: 0.8, green: 0, blue: 0 } } } };
const pomfretLink = { link: { url: 'https://www.pomfret.org/' } };
// What staff type in the tests below: [assignment, class, notes], with bold, a color, a link and a
// second paragraph, to check that all of it comes back.
const quizTodo = () => [
  { text: 'Vocab quiz (told in class)', runs: [{ s: 0, e: 10, style: bold }] },
  { text: 'Spanish', runs: [] },
  { text: 'Study list\nAsk for the review sheet', runs: [{ s: 11, e: 35, style: red }] },
];
const formTodo = () => [{ text: 'Field trip form', runs: [{ s: 0, e: 15, style: pomfretLink }] }, { text: '', runs: [] }, { text: '', runs: [] }];
// A week's to-dos as readStaffWork_ reads them, without the days that have none.
const todosIn = (docs, t, title) => {
  const days = toPlain(t.ctx.readStaffWork_(liveTab(docs, title))).days;
  Object.keys(days).forEach((d) => { if (!days[d].length) delete days[d]; });
  return days;
};
// Cells the way they read once they are in a table: its text color (#212121) is on every run.
const asRead = (t, cells) => cells.map((c) => toPlain(t.ctx.readRichCell_(typed(c))));
const SCHOOL_DAYS_BLANK = { Tuesday: ['blank'], Wednesday: ['blank'], Thursday: ['blank'], Friday: ['blank'] };

test('to-dos: every school day ends with one "+ Add a to-do" row; what staff type or insert comes back exactly, below the Canvas rows, each with a chip', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  // Monday has Canvas work (X and Y); the other school days have none and are still listed.
  assert.deepStrictEqual(dayPlan(docs, WA), Object.assign({ Monday: ['canvas X (due 8:30 am)', 'canvas Y (due 8:30 am)', 'blank'] }, SCHOOL_DAYS_BLANK));
  assert.deepStrictEqual(todosIn(docs, t, WA), {}, 'the blank rows are not to-dos');

  staffAddsTodo(docs, WA, 'Monday', quizTodo()); // typed over the gray words of the blank row
  staffInsertsRow(docs, WA, 'Monday', 1, formTodo()); // "Insert row below" between the two Canvas rows
  staffAddsTodo(docs, WA, 'Wednesday', ['Pack gym bag'], { beside: true }); // typed next to the gray words
  staffAddsTodo(docs, WA, 'Thursday', ['', '', 'only a note']); // a note in the blank row, nothing else
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const plan = {
    Monday: ['canvas X (due 8:30 am)', 'canvas Y (due 8:30 am)', 'todo Field trip form', 'todo Vocab quiz (told in class)', 'blank'],
    Tuesday: ['blank'],
    Wednesday: ['todo Pack gym bag', 'blank'],
    Thursday: ['todo + Add a to-do', 'blank'],
    Friday: ['blank'],
  };
  assert.deepStrictEqual(dayPlan(docs, WA), plan, 'to-dos sit below the Canvas rows, in staff order, and each school day ends with one blank row');
  const todos = () => dayRowsOf(docs, WA).filter((r) => r.kind === 'todo').map((r) => [r.assignment, r.klass, r.status, r.chip, r.notes]);
  assert.deepStrictEqual(todos(), [
    ['Field trip form', 'Added by staff', 'Need to Start', true, ''],
    ['Vocab quiz (told in class)', 'Spanish', 'Need to Start', true, 'Study list\nAsk for the review sheet'],
    ['Pack gym bag', 'Added by staff', 'Need to Start', true, ''],
    ['+ Add a to-do', 'Added by staff', 'Need to Start', true, 'only a note'],
  ], 'each has a chip on Need to Start, and an empty Class says "Added by staff"');
  const exact = {
    Monday: [{ cells: asRead(t, formTodo()), status: 'Need to Start' }, { cells: asRead(t, quizTodo()), status: 'Need to Start' }],
    Wednesday: [{ cells: asRead(t, ['Pack gym bag', '', '']), status: 'Need to Start' }],
    Thursday: [{ cells: asRead(t, ['', '', 'only a note']), status: 'Need to Start' }],
  };
  assert.deepStrictEqual(todosIn(docs, t, WA), exact, 'text, paragraphs, link and styles as typed; the gray words are never read as theirs');
  assert.deepStrictEqual(exact.Monday[1].cells[0].runs.map((r) => [r.s, r.e, Object.keys(r.style).join()]), [[0, 10, 'bold,foregroundColor'], [10, 26, 'foregroundColor']]);

  // Staff pick In progress on one of them. Updates after that change nothing, also when a Canvas
  // assignment moves to another week and back.
  dayRow(docs, WA, 'Field trip form').tableCells[2] = chipCell('In progress');
  exact.Monday[0].status = 'In progress';
  for (let n = 0; n < 3; n++) {
    t.ctx.upsertPlannerDocument_(scheduleAB(n === 1));
    assert.deepStrictEqual(todosIn(docs, t, WA), exact, 'update ' + (n + 1));
  }
  assert.deepStrictEqual(dayPlan(docs, WA), plan);
  assert.deepStrictEqual(todosIn(docs, t, WB), {}, "the other week's to-dos are its own");
  assert.deepStrictEqual(dayPlan(docs, WB), Object.assign({ Monday: ['canvas Z (due 8:30 am)', 'blank'] }, SCHOOL_DAYS_BLANK));
  // To-dos are not Canvas work: not in By Class, and the Status and Notes rules never read them.
  const read = toPlain(t.ctx.readExistingDataFromTab_(liveTab(docs, WA)));
  assert.deepStrictEqual(Object.keys(read.status).sort(), [url(1), url(2)]);
  assert.ok(!tablesIn(liveTab(docs, WA), 'class').some((table) => table.tableRows.some((r) => /Field trip|Vocab quiz|gym bag/.test(textOf(r.tableCells[0])))));
});

test('to-dos: a row inserted below an assignment starts with the look of its link and its own chip; the to-do comes back in the usual look and a real link is kept', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  // Seen in a real Doc (2026-11-10): "Insert row below" under an assignment gives a row whose
  // Assignment text is blue and underlined like the link above it, with a chip on Need to Start.
  const labTodo = () => [{ text: 'Ask about the lab', runs: [{ s: 0, e: 3, style: bold }] }, '', 'before class'];
  staffInsertsRow(docs, WA, 'Monday', 1, labTodo(), { copied: true });
  staffInsertsRow(docs, WA, 'Monday', 1, formTodo(), { copied: true });
  const looks = (text) => stylesOf(dayRow(docs, WA, text).tableCells[0]);
  assert.deepStrictEqual(looks('Ask about the lab'), ['bold,foregroundColor,underline', 'foregroundColor,underline'], 'typed in the blue underlined look');
  dayRow(docs, WA, 'Ask about the lab').tableCells[2] = chipCell('In progress');
  for (let n = 0; n < 2; n++) {
    t.ctx.upsertPlannerDocument_(scheduleAB(false));
    assert.deepStrictEqual(dayPlan(docs, WA).Monday, ['canvas X (due 8:30 am)', 'canvas Y (due 8:30 am)', 'todo Field trip form', 'todo Ask about the lab', 'blank']);
    assert.deepStrictEqual(looks('Ask about the lab'), ['bold,foregroundColor', 'foregroundColor'], 'the borrowed blue and underline are gone, the bold word stays');
    assert.deepStrictEqual(looks('Field trip form'), ['foregroundColor,link,underline'], 'a real link keeps its look');
    const todos = todosIn(docs, t, WA).Monday;
    assert.deepStrictEqual(todos.map((r) => [r.cells[0].text, r.status, r.cells[2].text]), [['Field trip form', 'Need to Start', ''], ['Ask about the lab', 'In progress', 'before class']]);
    assert.deepStrictEqual(todos[1].cells, asRead(t, labTodo()), 'the same as if it had been typed in the usual look');
    assert.strictEqual(linkOf(dayRow(docs, WA, 'Field trip form').tableCells[0]), 'https://www.pomfret.org/');
  }
});

test('to-dos: clearing the Assignment cell or deleting the row removes one; a Status typed instead of chosen goes into the note; a to-do with a Canvas link stays a to-do', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const X = url(1);
  const xLink = (text) => ({ text, runs: [{ s: 0, e: text.length, style: { link: { url: X } } }] });
  staffAddsTodo(docs, WA, 'Tuesday', ['Email coach', 'Advisory', 'about Friday']);
  staffInsertsRow(docs, WA, 'Tuesday', 1, ['Book the van', '', '']);
  staffAddsTodo(docs, WA, 'Friday', ['Monday']); // a to-do that is only a weekday's name
  staffInsertsRow(docs, WA, 'Monday', 0, [xLink('Redo X on paper'), '', 'see rubric']); // X's Canvas link, above X's own row
  staffAddsTodo(docs, WA, 'Wednesday', [xLink('X')]); // X's link and title, under another day
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const rows = () => dayRowsOf(docs, WA).filter((r) => r.kind !== 'blank').map((r) => [r.day, r.assignment, r.klass, r.status, r.notes]);
  assert.deepStrictEqual(rows(), [
    ['Monday', 'X (due 8:30 am)', 'Biology', 'Need to Start', ''],
    ['Monday', 'Y (due 8:30 am)', 'Biology', 'Need to Start', ''],
    ['Monday', 'Redo X on paper', 'Added by staff', 'Need to Start', 'see rubric'],
    ['Tuesday', 'Email coach', 'Advisory', 'Need to Start', 'about Friday'],
    ['Tuesday', 'Book the van', 'Added by staff', 'Need to Start', ''],
    ['Wednesday', 'X', 'Added by staff', 'Need to Start', ''],
    ['Friday', 'Monday', 'Added by staff', 'Need to Start', ''],
  ]);
  assert.deepStrictEqual(Object.keys(dayPlan(docs, WA)), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], '"Monday" under Friday is a to-do, not a day');
  // The to-dos with X's link never take part in X's Status and Note, whichever way staff set them.
  dayRow(docs, WA, 'Redo X on paper').tableCells[2] = chipCell('Done/Submitted');
  dayRow(docs, WA, 'X').tableCells[2] = chipCell('In progress');
  staffTypes(docs, WA, url(2), 'day', 'In progress', 'Y note');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(copiesOf(docs, url(2)).map((c) => [c.status, c.note]), [['In progress', 'Y note'], ['In progress', 'Y note']]);
  assert.deepStrictEqual(rows().filter((r) => /X/.test(r[1])).map((r) => [r[1], r[3]]),
    [['X (due 8:30 am)', 'Need to Start'], ['Redo X on paper', 'Done/Submitted'], ['X', 'In progress']]);
  assert.strictEqual(tablesIn(liveTab(docs, WA), 'class')[0].tableRows.filter((r) => textOf(r.tableCells[0]) === 'X').map((r) => chipOf(r.tableCells[2])).join(), 'Need to Start');
  // X moves to the other week: its row leaves this tab, the two to-dos stay where staff put them.
  t.ctx.upsertPlannerDocument_(scheduleAB(true));
  assert.deepStrictEqual(rows().filter((r) => /X/.test(r[1])).map((r) => [r[0], r[1], r[3]]),
    [['Monday', 'Redo X on paper', 'Done/Submitted'], ['Wednesday', 'X', 'In progress']]);
  assert.deepStrictEqual(todosIn(docs, t, WB), {}, 'and they did not follow X');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));

  // Staff type a Status instead of choosing one: a choice is taken as that choice, anything else
  // goes to the front of the note. Then they remove two to-dos: one by clearing its Assignment cell,
  // one by deleting its row.
  dayRow(docs, WA, 'Email coach').tableCells[2] = typed('waiting on coach');
  dayRow(docs, WA, 'Monday').tableCells[2] = typed('done');
  dayRow(docs, WA, 'Book the van').tableCells[0] = typed('');
  const table = tablesIn(liveTab(docs, WA), 'day')[0];
  table.tableRows.splice(table.tableRows.indexOf(dayRow(docs, WA, 'Redo X on paper')), 1);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(rows().filter((r) => r[2] !== 'Biology'), [
    ['Tuesday', 'Email coach', 'Advisory', 'Need to Start', 'Status was: waiting on coach. about Friday'],
    ['Wednesday', 'X', 'Added by staff', 'In progress', ''],
    ['Friday', 'Monday', 'Added by staff', 'Done/Submitted', ''],
  ]);
  assert.deepStrictEqual(dayPlan(docs, WA).Tuesday, ['todo Email coach', 'blank'], 'still exactly one blank row');
});

test('a Canvas assignment that came without a link is not taken for a to-do: it is written once per update, never twice', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  // Y has no link, and is due at 8:30 am, so By Day says "Y (due 8:30 am)".
  const noLink = () => {
    const s = scheduleAB(false);
    s.weeks['2099-01-12'].days[0].assignments.forEach((a) => { if (a.assignment === 'Y') a.url = ''; });
    return s;
  };
  for (let n = 0; n < 3; n++) {
    t.ctx.upsertPlannerDocument_(noLink());
    assert.deepStrictEqual(dayRowsOf(docs, WA).filter((r) => r.day === 'Monday').map((r) => r.assignment),
      ['X (due 8:30 am)', 'Y (due 8:30 am)', ADD_TODO], 'update ' + (n + 1));
    assert.deepStrictEqual(todosIn(docs, t, WA), {}, 'no to-do');
  }
  // A to-do staff add under the same day is still kept, below both.
  staffAddsTodo(docs, WA, 'Monday', ['Bring calculator', '', '']);
  t.ctx.upsertPlannerDocument_(noLink());
  assert.deepStrictEqual(dayRowsOf(docs, WA).filter((r) => r.day === 'Monday').map((r) => r.assignment),
    ['X (due 8:30 am)', 'Y (due 8:30 am)', 'Bring calculator', ADD_TODO]);
});

// scheduleAB(false) with one more assignment in week A, due on Saturday at 11:59 pm.
function scheduleWithSaturdayWork() {
  const s = scheduleAB(false);
  s.weeks['2099-01-12'].days.push({ day: 'Saturday', assignments: [{ day: 'Saturday', assignment: 'Reading', course: 'Biology',
    due_time: '11:59 PM', days_until_due: 14, due_date: '2099-01-17', week_start: '2099-01-12', url: url(4) }] });
  return s;
}
const saturdayTable = (docs, title) => tablesIn(liveTab(docs, title)).find((table) => textOf(table.tableRows[0].tableCells[0]) === 'Saturday');
const weekendIn = (docs, t, title) => toPlain(t.ctx.readStaffWork_(liveTab(docs, title))).weekend;

test('Weekend plan: a Saturday and a Sunday table with Morning, Afternoon, Evening; what staff type there comes back exactly after every update', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const empty = [['Morning', '', ''], ['Afternoon', '', ''], ['Evening', '', '']];
  assert.deepStrictEqual(weekendOf(docs, WA), { Saturday: empty, Sunday: empty });
  assert.deepStrictEqual(tablesIn(liveTab(docs, WA), 'weekend').map((table) => table.tableRows[0].tableCells.map(textOf)),
    [['Saturday', 'Assignment', 'Notes'], ['Sunday', 'Assignment', 'Notes']]);
  assert.strictEqual(t.ctx.countStaffWork_(t.ctx.readStaffWork_(liveTab(docs, WA))), 0, 'empty tables are not staff work yet');

  const plan = { text: 'Finish lab report\nStart essay outline', runs: [{ s: 0, e: 6, style: bold }, { s: 18, e: 37, style: pomfretLink }] };
  staffPlansWeekend(docs, WA, 'Sunday', 'Afternoon', 1, plan);
  staffPlansWeekend(docs, WA, 'Sunday', 'Afternoon', 2, 'library, 2 to 4');
  staffPlansWeekend(docs, WA, 'Saturday', 'Morning', 0, 'Morning (after practice)'); // staff may reword a label
  saturdayTable(docs, WA).tableRows.push({ tableCells: [typed('Night'), typed('Read 20 pages'), typed('')] }); // and add a row
  for (let n = 0; n < 3; n++) t.ctx.upsertPlannerDocument_(scheduleAB(n === 1));
  assert.deepStrictEqual(weekendOf(docs, WA), {
    Saturday: [['Morning (after practice)', '', ''], ['Afternoon', '', ''], ['Evening', '', ''], ['Night', 'Read 20 pages', '']],
    Sunday: [['Morning', '', ''], ['Afternoon', 'Finish lab report\nStart essay outline', 'library, 2 to 4'], ['Evening', '', '']],
  });
  assert.deepStrictEqual(weekendIn(docs, t, WA).Sunday[1], asRead(t, [{ text: 'Afternoon', runs: [{ s: 0, e: 9, style: bold }] }, plan, 'library, 2 to 4']),
    'paragraphs, bold and the link as typed (AutoPlanner writes the three labels in bold)');
  assert.deepStrictEqual(weekendOf(docs, WB), { Saturday: empty, Sunday: empty }, "the other week's plan is its own");
  assert.strictEqual(t.ctx.countStaffWork_(t.ctx.readStaffWork_(liveTab(docs, WA))), 2, 'rows with something in Assignment or Notes');
  assert.deepStrictEqual(todosIn(docs, t, WA), {}, 'the Weekend plan is not in By Day');

  // Staff delete a row: it stays deleted. They delete a whole table: the next update adds an empty one.
  saturdayTable(docs, WA).tableRows.splice(3, 1); // Evening
  const tab = liveTab(docs, WA);
  tab.documentTab.body.content = tab.documentTab.body.content.filter((e) => !(e.table && kindOf(e.table) === 'weekend' && textOf(e.table.tableRows[0].tableCells[0]) === 'Sunday'));
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(weekendOf(docs, WA), {
    Saturday: [['Morning (after practice)', '', ''], ['Afternoon', '', ''], ['Night', 'Read 20 pages', '']],
    Sunday: empty,
  });
  // A column staff added on the right doesn't stop the table being read (what's in it isn't kept).
  saturdayTable(docs, WA).tableRows.forEach((r) => r.tableCells.push(typed('extra')));
  saturdayTable(docs, WA).columns = 4;
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(weekendOf(docs, WA).Saturday, [['Morning (after practice)', '', ''], ['Afternoon', '', ''], ['Night', 'Read 20 pages', '']]);
});

test('Canvas work due on a Saturday or Sunday stays in By Day under that day, with no blank row; a to-do staff add there is kept', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleWithSaturdayWork());
  const monday = ['canvas X (due 8:30 am)', 'canvas Y (due 8:30 am)', 'blank'];
  assert.deepStrictEqual(dayPlan(docs, WA), Object.assign({ Monday: monday }, SCHOOL_DAYS_BLANK, { Saturday: ['canvas Reading'] }),
    'no time after the title when it is due at 11:59 pm');
  assert.deepStrictEqual(rowsOf(docs, url(4)).map((r) => [r.table, r.title, r.due]), [['class', 'Reading', 'Sat 1/17'], ['day', 'Reading', '']]);
  assert.deepStrictEqual(weekendOf(docs, WA).Saturday, [['Morning', '', ''], ['Afternoon', '', ''], ['Evening', '', '']], 'AutoPlanner never fills the Weekend plan');
  staffInsertsRow(docs, WA, 'Saturday', 1, ['Call home', '', '']);
  t.ctx.upsertPlannerDocument_(scheduleWithSaturdayWork());
  assert.deepStrictEqual(dayPlan(docs, WA).Saturday, ['canvas Reading', 'todo Call home']);
  // The reading leaves Canvas untouched: its row goes, and Saturday stays for the to-do.
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(dayPlan(docs, WA), Object.assign({ Monday: monday }, SCHOOL_DAYS_BLANK, { Saturday: ['todo Call home'] }));
  dayRow(docs, WA, 'Call home').tableCells[0] = typed('');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(dayPlan(docs, WA), Object.assign({ Monday: monday }, SCHOOL_DAYS_BLANK), 'and Saturday goes when nothing is left in it');
});

test('to-dos and the Weekend plan survive a cut-off rebuild, and what staff add or change while a tab is being rewritten is kept', () => {
  const { t, docs } = rebuildSetup([]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  staffAddsTodo(docs, WA, 'Monday', quizTodo());
  staffPlansWeekend(docs, WA, 'Sunday', 'Afternoon', 1, 'Finish lab report');
  docs.failOnFill = true;
  assert.throws(() => t.ctx.upsertPlannerDocument_(scheduleAB(false)));
  docs.failOnFill = false;
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(todosIn(docs, t, WA), { Monday: [{ cells: asRead(t, quizTodo()), status: 'Need to Start' }] });
  assert.deepStrictEqual(weekendOf(docs, WA).Sunday[1], ['Afternoon', 'Finish lab report', '']);
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);

  // Staff work in the old tab while the new one is being written: it is written again with all of it.
  const realChunked = t.ctx.batchUpdateChunked_;
  let fills = 0;
  t.ctx.batchUpdateChunked_ = (docId, reqs) => {
    realChunked(docId, reqs);
    if (!reqs.some((r) => r.insertText && r.insertText.location.tabId !== 't.0')) return;
    if (++fills !== 1) return;
    staffAddsTodo(docs, WA, 'Tuesday', ['Typed during the update', 'Biology', '']);
    dayRow(docs, WA, 'Vocab quiz (told in class)').tableCells[2] = chipCell('Done/Submitted');
    staffPlansWeekend(docs, WA, 'Saturday', 'Evening', 2, 'typed during the update too');
    staffTypes(docs, WA, url(1), 'day', 'In progress', 'changed during the update');
  };
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  t.ctx.batchUpdateChunked_ = realChunked;
  const check = (when) => {
    assert.deepStrictEqual(todosIn(docs, t, WA), {
      Monday: [{ cells: asRead(t, quizTodo()), status: 'Done/Submitted' }],
      Tuesday: [{ cells: asRead(t, ['Typed during the update', 'Biology', '']), status: 'Need to Start' }],
    }, when);
    assert.deepStrictEqual(weekendOf(docs, WA).Saturday[2], ['Evening', '', 'typed during the update too'], when);
    assert.deepStrictEqual(copiesOf(docs, url(1)).map((c) => [c.status, c.note]),
      [['In progress', 'changed during the update'], ['In progress', 'changed during the update']], when);
    assert.deepStrictEqual(dayPlan(docs, WA).Tuesday, ['todo Typed during the update', 'blank'], when);
  };
  check('right after that update');
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  check('and after the next one');
  assert.deepStrictEqual(docs.titleAnywhere(/\(updating\)/), []);
});

// ---- Week tabs from before November 2026 --------------------------------------------------------

// Week A the way AutoPlanner wrote it then: X and Y in six-column tables with a typed Status, and an
// "Added by staff" table with `staffRows` (five cells each: Assignment, Class, Day, Status, Notes).
const oldWeekTab = (id, title, staffRows, saved) => ({
  tabProperties: { tabId: id, title, parentTabId: 't.0' }, childTabs: [],
  documentTab: { body: { content: oldLayoutContent([{ course: 'Biology', assignments: [
    { assignment: 'X', url: url(1), day: 'Monday', due_time: '8:30 AM', course: 'Biology' },
    { assignment: 'Y', url: url(2), day: 'Monday', due_time: '8:30 AM', course: 'Biology' },
  ] }], saved, staffRows) } },
});
const oldStaffRows = () => [
  [quizTodo()[0], 'Spanish', 'Thursday', 'In progress', quizTodo()[2]],
  ['', '', '', '', ''],
  ['Field trip form', 'Advisory', 'FRI', 'Complete', ''],
  ['Pack for the game', '', 'tues.', '', 'cleats'],
  ['Lab makeup', 'Chemistry', 'w', 'ask Mr. Lee', 'room 12'],
  ['Flashcards', '', '', 'Not started', ''],
  ['Read chapter 4', 'English', 'over break', '', 'ch. 4 only'],
  ['Essay draft', 'English', 'sat', 'In progress', 'two pages'],
  ['Laundry', '', 'Sunday', '', ''],
];

test('a week tab from before November 2026: every "Added by staff" row moves under its day in By Day or into the Weekend plan, typed Statuses become chips, nothing typed is lost', () => {
  const X = url(1);
  const Y = url(2);
  const old = oldWeekTab('t.old', WA, oldStaffRows(), { status: { [X]: 'Complete', [Y]: 'waiting on Ms. Rivera' }, notes: { [X]: 'handed in', [Y]: 'see email' } });
  const { t, docs } = rebuildSetup([old]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const picture = () => ({
    days: dayRowsOf(docs, WA).filter((r) => r.kind === 'todo').map((r) => [r.day, r.assignment, r.klass, r.status, r.notes]),
    weekend: weekendOf(docs, WA),
    canvas: [X, Y].map((u) => copiesOf(docs, u).map((c) => [c.table, c.status, c.note])),
  });
  const after = picture();
  assert.deepStrictEqual(after.canvas, [
    [['class', 'Done/Submitted', 'handed in'], ['day', 'Done/Submitted', 'handed in']], // "Complete" is Done/Submitted now
    [['class', 'Need to Start', 'Status was: waiting on Ms. Rivera. see email'], ['day', 'Need to Start', 'Status was: waiting on Ms. Rivera. see email']],
  ]);
  assert.deepStrictEqual(after.days, [
    ['Monday', 'Flashcards', 'Added by staff', 'Need to Start', ''], // no day: Monday
    ['Monday', 'Read chapter 4', 'English', 'Need to Start', 'Day was: over break. ch. 4 only'], // a day AutoPlanner can't read: Monday, words kept
    ['Tuesday', 'Pack for the game', 'Added by staff', 'Need to Start', 'cleats'],
    ['Wednesday', 'Lab makeup', 'Chemistry', 'Need to Start', 'Status was: ask Mr. Lee. room 12'],
    ['Thursday', 'Vocab quiz (told in class)', 'Spanish', 'In progress', 'Study list\nAsk for the review sheet'],
    ['Friday', 'Field trip form', 'Advisory', 'Done/Submitted', ''],
  ]);
  assert.deepStrictEqual(after.weekend, {
    Saturday: [['Morning', 'Essay draft (English)', 'Status was: In progress. two pages'], ['Afternoon', '', ''], ['Evening', '', '']],
    Sunday: [['Morning', 'Laundry', ''], ['Afternoon', '', ''], ['Evening', '', '']],
  });
  assert.ok(dayRowsOf(docs, WA).every((r) => r.kind === 'blank' || r.chip), 'every Canvas row and to-do has a chip');
  assert.deepStrictEqual(todosIn(docs, t, WA).Thursday, [{ cells: asRead(t, [quizTodo()[0], 'Spanish', quizTodo()[2]]), status: 'In progress' }], 'bold, color and paragraphs came along');
  // The table itself is gone, and so is its heading.
  const tab = liveTab(docs, WA);
  assert.deepStrictEqual(tablesIn(tab).map(kindOf), ['day', 'weekend', 'weekend', 'class']);
  assert.strictEqual(t.ctx.findOldStaffTable_(tab), null);
  assert.ok(!JSON.stringify(tab.documentTab.body.content.filter((e) => e.paragraph)).includes('Added by staff'));
  // The next updates move nothing a second time.
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(picture(), after);

  // A weekend row is added under what the Morning cell already says.
  staffPlansWeekend(docs, WA, 'Sunday', 'Morning', 2, 'before lunch');
  liveTab(docs, WA).documentTab.body.content.push(...oldLayoutContent([], null, [['Call grandma', '', 'sun', '', 'around 10']]).slice(-5));
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  assert.deepStrictEqual(weekendOf(docs, WA).Sunday[0], ['Morning', 'Laundry\nCall grandma', 'before lunch\naround 10']);
});

test('a week goes into Past weeks with its to-dos and Weekend plan, untouched: this layout and the one before it', () => {
  // A week that ended, in this layout, with a to-do and a weekend plan.
  const blocks = (() => {
    const t = setup();
    const week = { week_label: 'Jan 6 – Jan 12', days: [{ day: 'Monday', assignments: [{ day: 'Monday', assignment: 'Old essay', course: 'Biology',
      due_time: '8:30 AM', days_until_due: -30, due_date: '2020-01-06', week_start: '2020-01-06', url: url(3) }] }] };
    const staff = { days: { Monday: [{ cells: quizTodo(), status: 'In progress' }] },
      weekend: { Saturday: null, Sunday: [[{ text: 'Morning', runs: [] }, { text: 'Laundry', runs: [] }, { text: '', runs: [] }]] } };
    const saved = { status: { [url(3)]: 'Done/Submitted' }, notes: { [url(3)]: 'old' } };
    return toPlain(t.ctx.weekTabBlocks_('2020-01-06', week, ['Biology'], { Biology: '#D9EAD3' }, saved, 468, staff));
  })();
  const ended = { tabProperties: { tabId: 't.ended', title: 'Week of Jan 6 – Jan 12, 2020', parentTabId: 't.0' }, childTabs: [],
    documentTab: { body: { content: renderBlocks(blocks) } } };
  // And one from December 2019, in the layout before it, with an "Added by staff" row.
  const older = oldWeekTab('t.older', 'Week of Dec 9 – Dec 15, 2019', oldStaffRows().slice(0, 1), { status: { [url(1)]: 'Complete' }, notes: { [url(1)]: 'older' } });
  const before = [JSON.stringify(ended.documentTab), JSON.stringify(older.documentTab)];
  const { t, docs } = rebuildSetup([older, ended]);
  withRendering(t, docs);
  t.ctx.upsertPlannerDocument_(scheduleAB(false));
  const past = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === 'Past weeks');
  assert.deepStrictEqual(past.childTabs.map((x) => x.tabProperties.title).sort(), ['Week of Dec 9 – Dec 15, 2019', 'Week of Jan 6 – Jan 12, 2020']);
  const filed = (title) => past.childTabs.find((x) => x.tabProperties.title === title);
  // The tab as it is stored (a read adds positions), compared with what it held before the update.
  const stored = (title) => JSON.stringify(docs.find(filed(title).tabProperties.tabId).documentTab);
  assert.strictEqual(stored('Week of Jan 6 – Jan 12, 2020'), before[0], 'content untouched');
  assert.strictEqual(stored('Week of Dec 9 – Dec 15, 2019'), before[1], 'an old-layout week is filed as it is: its "Added by staff" table stays');
  const work = toPlain(t.ctx.readStaffWork_(filed('Week of Jan 6 – Jan 12, 2020')));
  assert.deepStrictEqual(work.days.Monday, [{ cells: asRead(t, quizTodo()), status: 'In progress' }], 'the to-do went with its week');
  assert.deepStrictEqual(work.weekend.Sunday.map((r) => r.map((c) => c.text)), [['Morning', 'Laundry', '']]);
  // Nothing from a filed week shows up in the weeks that are still open.
  assert.deepStrictEqual([todosIn(docs, t, WA), todosIn(docs, t, WB)], [{}, {}]);
  // Later updates still leave both alone.
  t.ctx.upsertPlannerDocument_(scheduleAB(true));
  const pastAgain = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === 'Past weeks');
  assert.deepStrictEqual(pastAgain.childTabs.map((x) => JSON.stringify(docs.find(x.tabProperties.tabId).documentTab)).sort(), before.slice().sort());
});

test('home tab: "· N added by staff" on the summary line, and "CLC teacher: …" under the subtitle (nothing for Unassigned)', () => {
  const t = setup();
  const data = homeData();
  const courses = t.ctx.plannerCourseList_(data);
  const s = toPlain(t.ctx.homeSummary_(Object.assign({}, data, { teacherName: 'Pat Teacher' }), courses, MONDAY_8AM));
  s.staffCount = 2;
  const texts = toPlain(t.ctx.buildHomeTabRequests_('t.0', s, 't.week', 468, t.ctx.buildCourseColorMap_(courses)))
    .filter((r) => r.insertText).map((r) => r.insertText.text).join('\n');
  assert.match(texts, /CLC PLANNER · SUPPORTED STUDY HALL\nCLC teacher: Pat Teacher\nLast updated /);
  assert.match(texts, / this week · \d+ due today or tomorrow · 2 added by staff\.\n/);
  const plain = toPlain(t.ctx.homeSummary_(data, courses, MONDAY_8AM));
  const plainTexts = toPlain(t.ctx.buildHomeTabRequests_('t.0', plain, 't.week', 468, t.ctx.buildCourseColorMap_(courses)))
    .filter((r) => r.insertText).map((r) => r.insertText.text).join('\n');
  assert.doesNotMatch(plainTexts, /CLC teacher|added by staff/);
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
  assert.deepStrictEqual(saved, { notes: { [X]: 'Turned in late' }, status: { [X]: 'Done/Submitted' } }, 'typed "Complete" before the dropdown');
  // The rebuilt week that now holds the assignment gets its Status and Note.
  const week = { week_label: 'Oct 12 – Oct 18', days: [{ day: 'Monday', assignments: [{ day: 'Monday', assignment: 'Essay', course: 'Biology',
    due_time: '9:00 AM', days_until_due: 7, due_date: '2026-10-12', week_start: '2026-10-12', url: X }] }] };
  const reqs = toPlain(t.ctx.buildWeekTabRequests_('t.b', '2026-10-12', week, ['Biology'], { Biology: '#D9EAD3' }, saved, 468));
  const texts = reqs.filter((r) => r.insertText).map((r) => r.insertText.text);
  assert.deepStrictEqual(reqs.filter((r) => r.insertDropdown).map((r) => r.insertDropdown.selectedOptionId),
    ['dropdownItem.done', 'dropdownItem.done'], 'a chip in By Class and one in By Day');
  assert.strictEqual(texts.filter((x) => x === 'Turned in late').length, 2);
  assert.ok(!texts.includes('Complete') && !texts.includes('Done/Submitted'), 'the Status is the chip, not text');
});
