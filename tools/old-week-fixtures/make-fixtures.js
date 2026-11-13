'use strict';
// Makes tests/fixtures/old-past-weeks/*.json: week tabs in the layouts AutoPlanner wrote between
// Oct 4 and Nov 9, 2026 (before the November week tabs), built by the code of that time, taken from
// git history, then typed on the way staff would (Statuses typed by hand, notes with bold words and
// links, "Added by staff" rows). All data is made up. The fixtures are committed, so the tests don't
// need git history; run this again only to change them.
//
//   node tools/old-week-fixtures/make-fixtures.js
//
// Layouts (each was live for a while; Past weeks keep whichever layout filed them):
//   #6 to #12  (Oct 4-5):    By Class tables, then By Day. Code from e800dd3.
//   #13, #14   (Oct 5):      the same, and an empty week's By Day says "No assignments due this week."
//                            Code from 31b9083.
//   #15 to #18 (Oct 6-Nov 9): the same, and an "Added by staff" table at the end. #18 added kept
//                            rows ("Not on Canvas" in the Priority cell). Code from a65ad15.
// Weeks filed by #10 and later have gray Priority cells; that is done here too.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSandbox, REPO_ROOT } = require('../../tests/helpers/gas-sandbox');
const { fakeDocs, richCell } = require('../../tests/helpers/fake-docs');

const OUT = path.join(REPO_ROOT, 'tests', 'fixtures', 'old-past-weeks');
const u = (n) => 'https://pomfret.instructure.com/courses/1/assignments/' + n;
const BOLD = { bold: true };
const LINKED = (url) => ({ link: { url }, underline: true, foregroundColor: { color: { rgbColor: { red: 17 / 255, green: 85 / 255, blue: 204 / 255 } } } });

function oldCode(commit) {
  const sb = createSandbox({ files: [] });
  ['Canvas.gs', 'Code.gs'].forEach((f) => {
    vm.runInContext(execSync('git show ' + commit + ':apps_script/' + f, { cwd: REPO_ROOT, encoding: 'utf8' }), sb.context, { filename: commit + ':' + f });
  });
  return sb.context;
}

function item(day, date, title, course, time, url, priority) {
  return { day, due_date: date, assignment: title, course, due_time: time, url, priority, days_until_due: 0, week_start: '' };
}

function weekData(label, items) {
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return { week_label: label, days: names.map((day) => ({ day, assignments: items.filter((a) => a.day === day) })) };
}

// Builds one week tab with the old code, in a fake Doc that carries out every request.
function build(commit, title, label, items, courses, saved, staffRows) {
  const ctx = oldCode(commit);
  const docs = fakeDocs([{ tabProperties: { tabId: 't.week', title },
    documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: '\n', textStyle: {} } }] } }] } }, childTabs: [] }], { execute: true });
  const colors = ctx.buildCourseColorMap_(courses);
  const reqs = ctx.buildWeekTabRequests_('t.week', '2026-10-05', weekData(label, items), courses, colors,
    saved || { status: {}, notes: {} }, 468, staffRows || []);
  docs.service.Documents.batchUpdate({ requests: JSON.parse(JSON.stringify(reqs)) });
  // The week is filed: from #10 on, its Priority cells turned gray.
  if (ctx.pastPriorityGrayRequests_) {
    const read = docs.service.Documents.get().tabs[0];
    const gray = ctx.pastPriorityGrayRequests_(read);
    if (gray.length) docs.service.Documents.batchUpdate({ requests: JSON.parse(JSON.stringify(gray)) });
  }
  return docs.find('t.week');
}

// ---- Typing on a built tab, the way staff would ----
const textOf = (cell) => cell.content.map((p) => p.paragraph.elements.map((e) => (e.textRun ? e.textRun.content : '')).join('')).join('').replace(/\n$/, '');
const tables = (tab) => tab.documentTab.body.content.filter((e) => e.table).map((e) => e.table);
const classTable = (tab, name) => tables(tab).find((t) => textOf(t.tableRows[0].tableCells[0]) === name);
const dayTable = (tab) => tables(tab).find((t) => t.columns === 6 && textOf(t.tableRows[0].tableCells[1]) === 'Course');
const rowOf = (table, title) => {
  const row = table.tableRows.find((r) => textOf(r.tableCells[0]) === title);
  if (!row) throw new Error('no row ' + title);
  return row;
};
// Typed text takes the look of the cell it is typed in (its first run), without a link.
function type(cell, text, runs) {
  const first = cell.content[0].paragraph.elements.find((e) => e.textRun) || { textRun: { textStyle: {} } };
  const base = Object.assign({}, first.textRun.textStyle);
  delete base.link;
  cell.content = richCell({ text, runs: runs || [] }, base).content;
}
const STATUS = 4;
const NOTES = 5;

function strip(tab) {
  const json = JSON.parse(JSON.stringify(tab));
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    delete o.startIndex;
    delete o.endIndex;
    Object.values(o).forEach(walk);
  };
  walk(json);
  json.documentTab.documentStyle = { pageSize: { width: { magnitude: 612, unit: 'PT' }, height: { magnitude: 792, unit: 'PT' } },
    marginLeft: { magnitude: 72, unit: 'PT' }, marginRight: { magnitude: 72, unit: 'PT' } };
  delete json.childTabs;
  return json;
}

function save(name, tab) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(strip(tab)) + '\n');
  console.log('wrote tests/fixtures/old-past-weeks/' + name + '.json');
}

// 1. #6 to #12: a full week, filed (gray Priority). Statuses typed by hand, one unusual; the two
//    copies of one assignment disagree; a note with a bold word and a link; an 8:00 AM due time.
{
  const items = [
    item('Monday', '2026-10-05', 'Cell diagram', 'Biology', '11:59 PM', u(301), 'Past due'),
    item('Tuesday', '2026-10-06', 'Poetry reflection', 'English 10', '8:00 AM', u(302), 'Today'),
    item('Wednesday', '2026-10-07', 'Map quiz', 'US History', '11:59 PM', u(303), 'Tomorrow'),
    item('Thursday', '2026-10-08', 'Lab report', 'Biology', '11:59 PM', u(304), 'Due Soon'),
    item('Friday', '2026-10-09', 'Vocab list 4', 'English 10', '11:59 PM', u(305), 'This Week'),
    item('Sunday', '2026-10-11', 'Reading notes, ch. 5', 'US History', '11:59 PM', u(306), 'Upcoming'),
  ];
  const saved = {
    status: { [u(301)]: 'Complete', [u(302)]: 'In progress', [u(303)]: 'Not started', [u(305)]: 'In progress', [u(306)]: 'Waiting on teacher' },
    notes: { [u(301)]: 'Turned in on paper', [u(306)]: 'Asked on Friday' },
  };
  const tab = build('e800dd3', 'Week of Oct 5 – Oct 11, 2026', 'Oct 5 – Oct 11', items,
    ['Art', 'Biology', 'English 10', 'US History'], saved);
  const note = 'Ask about extra credit. Rubric is here';
  const runs = [{ s: 10, e: 22, style: BOLD }, { s: 33, e: 37, style: LINKED('https://example.org/rubric') }];
  [classTable(tab, 'English 10'), dayTable(tab)].forEach((t) => type(rowOf(t, 'Poetry reflection').tableCells[NOTES], note, runs));
  type(rowOf(classTable(tab, 'Biology'), 'Lab report').tableCells[STATUS], '  COMPLETE ');
  type(rowOf(dayTable(tab), 'Lab report').tableCells[STATUS], 'complete');
  type(rowOf(dayTable(tab), 'Vocab list 4').tableCells[STATUS], 'Complete');
  type(rowOf(dayTable(tab), 'Map quiz').tableCells[STATUS], '');
  type(rowOf(classTable(tab, 'Biology'), 'Cell diagram').tableCells[NOTES], 'Turned in on paper\nGot it back Thursday');
  save('oct-2026-by-class-first', tab);
}

// 2. #6 to #12 and 3. #13, #14: a week with nothing due at all.
save('oct-2026-empty-week', build('e800dd3', 'Week of Oct 12 – Oct 18, 2026', 'Oct 12 – Oct 18', [], ['Art', 'Biology']));
save('oct-2026-empty-week-no-assignments-row', build('31b9083', 'Week of Oct 19 – Oct 25, 2026', 'Oct 19 – Oct 25', [], ['Art', 'Biology']));

// 4. #15 to #18: "Added by staff" rows for every school day, Saturday and one with no day; kept rows
//    with each reason; two classes with nothing due.
{
  const items = [
    item('Monday', '2026-10-26', 'Unit test', 'Biology', '8:00 AM', u(401), 'Past due'),
    item('Tuesday', '2026-10-27', 'Map quiz', 'US History', '11:59 PM', u(402), 'Not on Canvas'),
    item('Wednesday', '2026-10-28', 'Essay draft', 'English 10', '11:59 PM', u(403), 'Now due Nov 30'),
    item('Thursday', '2026-10-29', 'Lab report', 'Biology', '11:59 PM', u(404), 'Today'),
    item('Friday', '2026-10-30', 'Extra credit puzzle', 'US History', '', u(405), 'No due date'),
  ];
  const saved = {
    status: { [u(401)]: 'Complete', [u(402)]: 'In progress', [u(403)]: 'Not started', [u(404)]: 'In progress', [u(405)]: 'Complete' },
    notes: { [u(402)]: 'Teacher took it down; ask', [u(403)]: 'Extension granted' },
  };
  const cell = (text, runs) => ({ text, runs: runs || [] });
  const staff = [
    [cell('Return library book'), cell(''), cell('Mon'), cell('Complete'), cell('')],
    [cell('Study for vocab quiz'), cell('Spanish'), cell('tuesday'), cell('In progress'), cell('Use the flash cards', [{ s: 8, e: 19, style: BOLD }])],
    [cell('Email advisor'), cell(''), cell('WED'), cell(''), cell('about the retake')],
    [cell('Make a study guide'), cell('US History'), cell('Thurs.'), cell('Not started'), cell('')],
    [cell('Bring calculator'), cell('Math'), cell('fri'), cell('waiting on parent'), cell('for the test')],
    [cell('Finish poster'), cell('Art'), cell('Saturday'), cell('In progress'), cell('Photos are here', [{ s: 11, e: 15, style: LINKED('https://example.org/photos') }])],
    [cell('Practice piano'), cell(''), cell('every day'), cell(''), cell('20 minutes')],
    [cell('Call home'), cell(''), cell('Thu after lunch'), cell('Complete'), cell('')],
  ];
  const tab = build('a65ad15', 'Week of Oct 26 – Nov 1, 2026', 'Oct 26 – Nov 1', items,
    ['Art', 'Biology', 'Chorus', 'English 10', 'US History'], saved, staff);
  type(rowOf(classTable(tab, 'Biology'), 'Lab report').tableCells[NOTES], 'Bring the data sheet\nAsk for feedback',
    [{ s: 9, e: 19, style: BOLD }]);
  type(rowOf(dayTable(tab), 'Lab report').tableCells[NOTES], 'Bring the data sheet\nAsk for feedback',
    [{ s: 9, e: 19, style: BOLD }]);
  save('oct-2026-added-by-staff', tab);
}
