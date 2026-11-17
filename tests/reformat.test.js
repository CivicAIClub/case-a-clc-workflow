'use strict';
// Tests for reformatPastWeeks: weeks filed in Past weeks before November 2026 rewritten in the new
// layout, keeping every word. The old weeks in tests/fixtures/old-past-weeks were built by the code
// that wrote them at the time (see tools/old-week-fixtures). The fake Docs API carries out every
// request, so each rewritten tab is really laid out, read back and compared. All data is made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');
const { fakeDocs, para, textOf, chipOf, linkOf, stylesOf, kindOf, tablesIn } = require('./helpers/fake-docs');

const OWNER = 'owner@pomfret.org';
const FIXTURES = ['oct-2026-by-class-first', 'oct-2026-empty-week', 'oct-2026-empty-week-no-assignments-row', 'oct-2026-added-by-staff'];
const old = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'old-past-weeks', name + '.json'), 'utf8'));

// A Doc: CLC Planner, with Past weeks holding these week tabs (newest first, as Past weeks keeps them).
function docWith(weeks) {
  const past = weeks.map((tab, i) => Object.assign(JSON.parse(JSON.stringify(tab)), {
    tabProperties: { tabId: 't.old' + (i + 1), title: tab.tabProperties.title, parentTabId: 't.past' }, childTabs: [],
  }));
  return [{ tabProperties: { tabId: 't.home', title: 'CLC Planner' }, documentTab: { body: { content: [para('CLC Planner')] } }, childTabs: [
    { tabProperties: { tabId: 't.past', title: 'Past weeks', parentTabId: 't.home' },
      documentTab: { body: { content: [para('Every past week, with the Status and Notes typed during it. AutoPlanner never changes these.')] } }, childTabs: past },
  ] }];
}

function setup(weeks, opts) {
  const o = opts || {};
  const svc = fakeServices({ owner: OWNER, props: Object.assign({
    DOCS_FOLDER_ID: 'FOLDER123', ALLOWED_USERS: OWNER,
    'student.s1': JSON.stringify({ id: 's1', name: 'Avery Example', docId: 'DOC1' }),
  }, o.props || {}) });
  svc.addFile('DOC1', 'Avery Example - CLC Assignments', 'FOLDER123');
  const docs = fakeDocs(docWith(weeks), { execute: true });
  const sb = createSandbox({
    files: ['apps_script/Code.gs', 'apps_script/Canvas.gs', 'apps_script/App.gs'],
    globals: Object.assign({}, svc.globals, { Docs: docs.service }),
    fetchHandler: o.fetch || (() => ({ code: 403, body: 'no' })),
  });
  return { svc, docs, sb, ctx: sb.context };
}

const pastTabs = (docs) => docs.service.Documents.get().tabs[0].childTabs[0].childTabs;
const run = (t, dryRun) => t.ctx.reformatPastWeeksInDoc_('DOC1', { dryRun });
const plain = (x) => JSON.parse(JSON.stringify(x));

// The tab as lines a person can check: each paragraph, and each table row with its cells. A chip is
// [its choice]; a merged row says {span N}; a background other than white is {#RRGGBB}.
function outline(tab) {
  const hex = (c) => {
    const r = c && c.color && c.color.rgbColor;
    return r ? '#' + ['red', 'green', 'blue'].map((k) => Math.round((r[k] || 0) * 255).toString(16).padStart(2, '0')).join('').toUpperCase() : '';
  };
  const cell = (c) => {
    const words = c.content.map((p) => p.paragraph.elements.map((e) => (e.dropdown ? '[' + e.dropdown.dropdownProperties.displayValue + ']' : e.textRun.content)).join('')).join('').replace(/\n$/, '').replace(/\n/g, ' / ');
    const st = c.tableCellStyle || {};
    return words + (st.columnSpan > 1 ? ' {span ' + st.columnSpan + '}' : '') + (hex(st.backgroundColor) ? ' {' + hex(st.backgroundColor) + '}' : '');
  };
  const out = [];
  tab.documentTab.body.content.forEach((el) => {
    if (el.paragraph) {
      const t = el.paragraph.elements.map((e) => e.textRun.content).join('').replace(/\n$/, '');
      if (t) out.push(t);
    }
    if (el.table) el.table.tableRows.forEach((r) => out.push('| ' + r.tableCells.map(cell).join(' | ')));
  });
  return out;
}

const rowWith = (table, words) => table.tableRows.find((r) => textOf(r.tableCells[0]).split('\n')[0].startsWith(words));

test('every old layout that shipped (Oct 4 to Nov 9): rewritten, read back and compared with no difference; same title and place', () => {
  const weeks = FIXTURES.map(old);
  const t = setup(weeks);
  const before = pastTabs(t.docs).map((x) => x.tabProperties.title);
  const res = plain(run(t));
  assert.deepStrictEqual(res.weeks.map((w) => [w.title, w.result, w.detail]), before.map((title) => [title, 'CONVERTED', '']));
  assert.deepStrictEqual(pastTabs(t.docs).map((x) => x.tabProperties.title), before, 'same titles, same order (newest first)');
  pastTabs(t.docs).forEach((tab) => {
    const kinds = tablesIn(tab).map(kindOf);
    assert.ok(kinds.length === 0 || kinds[0] === 'day', tab.tabProperties.title + ': By Day first (a week with nothing due has no tables)');
    assert.ok(kinds.slice(1).every((k) => k === 'class'), 'then By Class, and no Weekend plan');
    const words = outline(tab).join('\n');
    for (const gone of ['Priority', 'Due Time', 'Past due', 'Upcoming', 'Added by staff\n', '+ Add a to-do', 'Weekend plan', 'type Not started']) {
      assert.ok(!words.includes(gone), tab.tabProperties.title + ' still says ' + gone);
    }
  });
  assert.deepStrictEqual(t.docs.titleAnywhere(/\(updating\)$/), [], 'no copy left behind');
});

test('a week from #15 to #18, line by line: staff rows under their day, kept rows, Statuses typed by hand, due times, both copies', () => {
  const t = setup([old('oct-2026-added-by-staff')]);
  assert.strictEqual(plain(run(t)).weeks[0].result, 'CONVERTED');
  assert.deepStrictEqual(outline(pastTabs(t.docs)[0]), [
    'Week of Oct 26 – Nov 1',
    'Assignments in this week: 5',
    'By Day',
    '| Assignment {#EFEFEF} | Class {#EFEFEF} | Status {#EFEFEF} | Notes {#EFEFEF}',
    '| Monday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}',
    '| Unit test (due 8:00 AM) | Biology {#EAD1DC} | [Done/Submitted] | ',
    '| Return library book | Added by staff | [Done/Submitted] | ',
    '| Practice piano | Added by staff | [Need to Start] | Day was: every day. 20 minutes',
    '| Tuesday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}',
    '| Map quiz / Not on Canvas | US History {#FFAB91} | [In progress] | Teacher took it down; ask',
    '| Study for vocab quiz | Spanish | [In progress] | Use the flash cards',
    '| Wednesday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}',
    '| Essay draft / Now due Nov 30 | English 10 {#D9D2E9} | [Need to Start] | Extension granted',
    '| Email advisor | Added by staff | [Need to Start] | about the retake',
    '| Thursday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}',
    '| Lab report | Biology {#EAD1DC} | [In progress] | Bring the data sheet / Ask for feedback',
    '| Make a study guide | US History | [Need to Start] | ',
    '| Call home | Added by staff | [Done/Submitted] | Day was: Thu after lunch.',
    '| Friday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}',
    '| Extra credit puzzle / No due date | US History {#FFAB91} | [Done/Submitted] | ',
    '| Bring calculator | Math | [Need to Start] | Status was: waiting on parent. for the test',
    '| Saturday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}',
    '| Finish poster | Art | [In progress] | Photos are here',
    'By Class',
    '| Biology {span 4} {#EAD1DC} |  {#EAD1DC} |  {#EAD1DC} |  {#EAD1DC}',
    '| Assignment {#EFEFEF} | Due {#EFEFEF} | Status {#EFEFEF} | Notes {#EFEFEF}',
    '| Unit test | Monday, 8:00 AM | [Done/Submitted] | ',
    '| Lab report | Thursday | [In progress] | Bring the data sheet / Ask for feedback',
    '| English 10 {span 4} {#D9D2E9} |  {#D9D2E9} |  {#D9D2E9} |  {#D9D2E9}',
    '| Assignment {#EFEFEF} | Due {#EFEFEF} | Status {#EFEFEF} | Notes {#EFEFEF}',
    '| Essay draft / Now due Nov 30 | Wednesday | [Need to Start] | Extension granted',
    '| US History {span 4} {#FFAB91} |  {#FFAB91} |  {#FFAB91} |  {#FFAB91}',
    '| Assignment {#EFEFEF} | Due {#EFEFEF} | Status {#EFEFEF} | Notes {#EFEFEF}',
    '| Map quiz / Not on Canvas | Tuesday | [In progress] | Teacher took it down; ask',
    '| Extra credit puzzle / No due date | Friday | [Done/Submitted] | ',
    'Nothing due this week: Art, Chorus.',
  ]);
  const [day] = tablesIn(pastTabs(t.docs)[0]);
  // Links and the look staff gave their words are kept: a bold word, a link, the gray line.
  assert.strictEqual(linkOf(rowWith(day, 'Unit test').tableCells[0]), 'https://pomfret.instructure.com/courses/1/assignments/401');
  assert.strictEqual(linkOf(rowWith(day, 'Finish poster').tableCells[3]), 'https://example.org/photos');
  assert.deepStrictEqual(stylesOf(rowWith(day, 'Study for vocab quiz').tableCells[3]), ['fontSize,foregroundColor', 'bold,fontSize,foregroundColor']);
  assert.ok(stylesOf(rowWith(day, 'Map quiz').tableCells[0]).pop().includes('italic'), 'the kept-row line is gray italic');
});

test('a staff row with only a note keeps an empty Assignment cell (no "+ Add a to-do" in a past week)', () => {
  const tab = old('oct-2026-added-by-staff');
  const staff = tablesIn(tab).find((x) => kindOf(x) === 'old staff');
  rowWith(staff, 'Email advisor').tableCells[0].content = [para('')];
  const t = setup([tab]);
  assert.strictEqual(plain(run(t)).weeks[0].result, 'CONVERTED');
  const lines = outline(pastTabs(t.docs)[0]);
  assert.ok(lines.includes('|  | Added by staff | [Need to Start] | about the retake'), lines.join('\n'));
});

test('a week from #6 to #12: the two copies of an assignment keep their own Status and note; typed Statuses become chips', () => {
  const t = setup([old('oct-2026-by-class-first')]);
  assert.strictEqual(plain(run(t)).weeks[0].result, 'CONVERTED');
  const tab = pastTabs(t.docs)[0];
  const [day, ...classes] = tablesIn(tab);
  const inClass = (words) => classes.map((c) => rowWith(c, words)).find((r) => r);
  const status = (row) => chipOf(row.tableCells[2]);
  assert.strictEqual(status(inClass('Vocab list 4')), 'In progress');
  assert.strictEqual(status(rowWith(day, 'Vocab list 4')), 'Done/Submitted', 'By Day had Complete, By Class In progress: both kept');
  assert.strictEqual(status(inClass('Lab report')), 'Done/Submitted', '"  COMPLETE " (any case, extra spaces)');
  assert.strictEqual(status(rowWith(day, 'Map quiz')), 'Need to Start', 'an empty Status');
  assert.strictEqual(status(inClass('Reading notes')), 'Need to Start');
  assert.strictEqual(textOf(inClass('Reading notes').tableCells[3]), 'Status was: Waiting on teacher. Asked on Friday');
  assert.strictEqual(textOf(rowWith(day, 'Poetry reflection').tableCells[0]), 'Poetry reflection (due 8:00 AM)');
  assert.strictEqual(textOf(inClass('Poetry reflection').tableCells[1]), 'Tuesday, 8:00 AM');
  assert.strictEqual(textOf(inClass('Cell diagram').tableCells[3]), 'Turned in on paper\nGot it back Thursday');
  for (const row of [rowWith(day, 'Poetry reflection'), inClass('Poetry reflection')]) {
    assert.strictEqual(textOf(row.tableCells[3]), 'Ask about extra credit. Rubric is here');
    assert.strictEqual(linkOf(row.tableCells[3]), 'https://example.org/rubric');
    assert.ok(stylesOf(row.tableCells[3]).some((s) => s.includes('bold')));
  }
  assert.ok(outline(tab).includes('Nothing due this week: Art.'));
  assert.ok(outline(tab).includes('| Sunday {span 4} {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7} |  {#B7B7B7}'), 'Sunday work stays under Sunday');
});

test('a week with nothing due: By Day says so, and By Class names the classes in their old order', () => {
  const weeks = { 'oct-2026-empty-week': 'Week of Oct 12 – Oct 18', 'oct-2026-empty-week-no-assignments-row': 'Week of Oct 19 – Oct 25' };
  for (const [name, heading] of Object.entries(weeks)) {
    const t = setup([old(name)]);
    assert.strictEqual(plain(run(t)).weeks[0].result, 'CONVERTED', name);
    assert.deepStrictEqual(outline(pastTabs(t.docs)[0]), [
      heading, 'Assignments in this week: 0', 'By Day', 'No assignments due this week.', 'By Class',
      'Nothing due this week: Art, Biology.',
    ], name);
  }
});

test('a build that comes out wrong fails the check: the copy is deleted, the old tab stays exactly as it was', () => {
  const t = setup([old('oct-2026-added-by-staff')]);
  const before = JSON.stringify(t.docs.find('t.old1'));
  const real = t.ctx.weekTabRequestsFromBlocks_;
  // Drop the request that links the first title: the copy would lose a link.
  t.ctx.weekTabRequestsFromBlocks_ = (tabId, blocks) => {
    const reqs = real(tabId, blocks);
    const i = reqs.findIndex((r) => r.updateTextStyle && r.updateTextStyle.textStyle.link);
    return reqs.slice(0, i).concat(reqs.slice(i + 1));
  };
  const w = plain(run(t)).weeks[0];
  assert.strictEqual(w.result, 'FAILED');
  // Without its link the row can't be told from a staff row, so Monday is one Canvas row short.
  assert.strictEqual(w.detail, 'By Day, Monday, number of rows: "1" became "0"');
  assert.strictEqual(JSON.stringify(t.docs.find('t.old1')), before, 'untouched');
  assert.deepStrictEqual(pastTabs(t.docs).map((x) => x.tabProperties.title), ['Week of Oct 26 – Nov 1, 2026']);
  assert.deepStrictEqual(t.docs.titleAnywhere(/\(updating\)$/), []);
});

test('staff typing in the old week while its copy is built: the copy is thrown away and the week is left for the next run', () => {
  const t = setup([old('oct-2026-by-class-first')]);
  const realBatch = t.docs.service.Documents.batchUpdate;
  let typedOnce = false;
  t.docs.service.Documents.batchUpdate = (body) => {
    const out = realBatch(body);
    if (!typedOnce && body.requests.some((r) => r.insertDropdown)) {
      typedOnce = true;
      const row = rowWith(tablesIn(t.docs.find('t.old1'))[1], 'Cell diagram');
      row.tableCells[5].content[0].paragraph.elements[0].textRun.content = 'Typed just now\n';
    }
    return out;
  };
  const w = plain(run(t)).weeks[0];
  assert.strictEqual(w.result, 'FAILED');
  assert.match(w.detail, /changed while it was being rewritten/);
  assert.ok(JSON.stringify(t.docs.find('t.old1')).includes('Typed just now'), 'the old tab, with what was typed');
  assert.deepStrictEqual(t.docs.titleAnywhere(/\(updating\)$/), []);
});

test('weeks AutoPlanner cannot read with confidence are skipped, untouched, with the reason', () => {
  const variants = {
    'text outside the tables': (tab) => tab.documentTab.body.content.splice(3, 0, para('Call home about the field trip')),
    'a table AutoPlanner doesn\'t know (first rows: "Art" / "Assignment | Day | Due Time | Urgency | Status | Notes")': (tab) => {
      tablesIn(tab)[0].tableRows[1].tableCells[3].content = [para('Urgency')];
    },
    'a Priority cell says "ASAP"': (tab) => { rowWith(tablesIn(tab)[1], 'Cell diagram').tableCells[3].content = [para('ASAP')]; },
    'something other than text': (tab) => { rowWith(tablesIn(tab)[1], 'Cell diagram').tableCells[5].content[0].paragraph.elements.unshift({ person: { personProperties: { name: 'A Person' } } }); },
    'it has a list or checklist': (tab) => { rowWith(tablesIn(tab)[1], 'Cell diagram').tableCells[5].content[0].paragraph.bullet = { listId: 'kix.list1' }; },
    'it has a link to a heading or bookmark': (tab) => {
      rowWith(tablesIn(tab)[1], 'Cell diagram').tableCells[5].content[0].paragraph.elements[0].textRun.textStyle.link = { headingId: 'h.abc' };
    },
    'don\'t list the same assignments': (tab) => { const d = tablesIn(tab).find((x) => kindOf(x) === 'old day'); d.tableRows.splice(d.tableRows.indexOf(rowWith(d, 'Lab report')), 1); },
  };
  for (const [reason, change] of Object.entries(variants)) {
    const tab = old('oct-2026-by-class-first');
    change(tab);
    const t = setup([tab]);
    const before = JSON.stringify(t.docs.find('t.old1'));
    const w = plain(run(t)).weeks[0];
    assert.strictEqual(w.result, 'SKIP', reason);
    assert.ok(w.detail.includes(reason), reason + ': ' + w.detail);
    assert.strictEqual(JSON.stringify(t.docs.find('t.old1')), before, reason + ': untouched');
    assert.strictEqual(t.docs.batches.length, 0, reason + ': nothing written');
  }
  // The very old 5-column format (notes only, from before October) is never guessed at.
  const veryOld = { tabProperties: { title: 'Week of Sep 7 – Sep 13, 2026' }, documentTab: { body: { content: [para('Week of Sep 7 – Sep 13'),
    { table: { rows: 1, columns: 5, tableRows: [{ tableCells: ['Assignment', 'Day', 'Due Time', 'Priority', 'Notes'].map((x) => ({ content: [para(x)] })) }] } }, para('')] } } };
  const t = setup([veryOld]);
  const w = plain(run(t)).weeks[0];
  assert.deepStrictEqual([w.result, w.detail], ['SKIP', 'it has a table AutoPlanner doesn\'t know (first rows: "Assignment | Day | Due Time | Priority | Notes")']);
});

test('a week already in the new layout is left alone, and a second run changes nothing', () => {
  const t = setup(FIXTURES.map(old));
  run(t);
  const after = JSON.stringify(t.docs.service.Documents.get());
  const writes = t.docs.batches.length;
  const again = plain(run(t));
  assert.deepStrictEqual(again.weeks.map((w) => w.result), ['ALREADY NEW', 'ALREADY NEW', 'ALREADY NEW', 'ALREADY NEW']);
  assert.strictEqual(t.docs.batches.length, writes, 'nothing written');
  assert.strictEqual(JSON.stringify(t.docs.service.Documents.get()), after);
});

test('reformatPastWeeksDryRun changes nothing and says what would happen to each week, with counts', () => {
  const t = setup([old('oct-2026-added-by-staff'), old('oct-2026-by-class-first')], {
    fetch: (url) => (url.includes('/comments?') ? { body: { comments: [{ quotedFileContent: { value: 'Extension granted' } }, { quotedFileContent: { value: 'Not in any tab' } }] } } : { code: 404 }),
  });
  const before = JSON.stringify(t.docs.service.Documents.get());
  const log = t.ctx.reformatPastWeeksDryRun();
  assert.strictEqual(t.docs.batches.length, 0);
  assert.strictEqual(JSON.stringify(t.docs.service.Documents.get()), before);
  assert.strictEqual(t.svc.props['busy.s1'], undefined, 'a dry run doesn\'t hold the row');
  const lines = log.split('\n');
  assert.strictEqual(lines[0], 'Dry run: nothing is changed. 1 student Doc.');
  assert.strictEqual(lines[1], 'Avery Example: 2 week(s) in Past weeks');
  assert.strictEqual(lines[2], '  WOULD CONVERT  Week of Oct 26 – Nov 1, 2026 · 5 assignments · Status chips: 6 Done/Submitted, 6 In progress, 6 Need to Start · ' +
    '12 rows with a note · 8 staff rows · kept rows: 1 Now due Nov 30, 1 Not on Canvas, 1 No due date · 4 Priority labels dropped · 1 "Status was" note · ' +
    '2 "Day was" notes · comments: 1');
  assert.match(lines[3], /^ {2}WOULD CONVERT {2}Week of Oct 5 – Oct 11, 2026 · 6 assignments .* 12 Priority labels dropped · 2 "Status was" notes · comments: 0$/);
  assert.strictEqual(lines[4], 'Dry run done: 2 week(s) would be converted, 0 already new, 0 skipped; 0 Doc(s) skipped.');
});

test('reformatPastWeeks holds the student\'s row while it works, and skips a Doc that is busy, outside the folder or in the trash', () => {
  const t = setup([old('oct-2026-empty-week')]);
  const held = [];
  const realBatch = t.docs.service.Documents.batchUpdate;
  t.docs.service.Documents.batchUpdate = (body) => { held.push(!!t.svc.props['busy.s1']); return realBatch(body); };
  const log = t.ctx.reformatPastWeeks();
  assert.ok(held.length && held.every((h) => h), 'every write happens while the row is held');
  assert.strictEqual(t.svc.props['busy.s1'], undefined, 'and it is let go after');
  assert.match(log, /\n {2}CONVERTED {6}Week of Oct 12 – Oct 18, 2026 · 0 assignments .*comments: unknown \(Drive did not list them\)\n/);
  assert.match(log, /Done: 1 week\(s\) converted, 0 already new, 0 skipped, 0 failed; 0 Doc\(s\) skipped\.$/);

  const busy = setup([old('oct-2026-empty-week')]);
  busy.svc.props['busy.s1'] = String(Date.now());
  assert.match(busy.ctx.reformatPastWeeks(), /SKIP {11}Avery Example: being updated right now/);
  assert.strictEqual(busy.docs.batches.length, 0);

  const outside = setup([old('oct-2026-empty-week')]);
  outside.svc.files.DOC1.parent = 'SOMEWHERE-ELSE';
  assert.match(outside.ctx.reformatPastWeeks(), /SKIP {11}Avery Example: AutoPlanner only updates Docs in the/);
  const trashed = setup([old('oct-2026-empty-week')]);
  trashed.svc.files.DOC1.trashed = true;
  assert.match(trashed.ctx.reformatPastWeeks(), /SKIP {11}Avery Example: Could not open the saved Google Doc .*in the trash/);
  assert.strictEqual(outside.docs.batches.length + trashed.docs.batches.length, 0);
  assert.throws(() => setup([], { props: { DOCS_FOLDER_ID: '' } }).ctx.reformatPastWeeks(), /DOCS_FOLDER_ID is not set/);
});

test('reformatPastWeeks stops cleanly between weeks before the time limit, and the next run picks up where it stopped', () => {
  const t = setup([old('oct-2026-added-by-staff'), old('oct-2026-by-class-first'), old('oct-2026-empty-week')]);
  let weeksStarted = 0;
  const realBefore = t.ctx.reformatPastWeeksInDoc_;
  t.ctx.reformatPastWeeksInDoc_ = (docId, opts) => realBefore(docId, Object.assign({}, opts, {
    msLeft: () => (weeksStarted < 1 ? 10 * 60 * 1000 : 30 * 1000),
    beforeWeek: () => { weeksStarted++; opts.beforeWeek(); },
  }));
  const first = t.ctx.reformatPastWeeks();
  assert.match(first, /CONVERTED {6}Week of Oct 26/);
  assert.doesNotMatch(first, /Week of Oct 5 /, 'the second week is not started');
  assert.match(first, /Stopped before the time limit, at Avery Example\. Run reformatPastWeeks again to pick up where it stopped\.$/);
  assert.strictEqual(t.svc.props['busy.s1'], undefined);
  t.ctx.reformatPastWeeksInDoc_ = realBefore;
  const second = t.ctx.reformatPastWeeks();
  assert.match(second, /ALREADY NEW {4}Week of Oct 26/);
  assert.match(second, /CONVERTED {6}Week of Oct 5 /);
  assert.match(second, /CONVERTED {6}Week of Oct 12 /);
  assert.match(second, /Done: 2 week\(s\) converted, 1 already new/);
});

test('a copy left by a run that was cut off is deleted first; its week is still there and is rewritten', () => {
  const t = setup([old('oct-2026-empty-week')]);
  const leftover = JSON.parse(JSON.stringify(t.docs.find('t.old1')));
  leftover.tabProperties = { tabId: 't.left', title: 'Week of Oct 12 – Oct 18, 2026 (updating)', parentTabId: 't.past' };
  t.docs.find('t.past').childTabs.push(leftover);
  assert.match(t.ctx.reformatPastWeeksDryRun(), /1 copy\(ies\) left by a cut-off run would be deleted/);
  const res = plain(run(t));
  assert.strictEqual(res.leftovers, 1);
  assert.deepStrictEqual(res.weeks.map((w) => w.result), ['CONVERTED']);
  assert.deepStrictEqual(pastTabs(t.docs).map((x) => x.tabProperties.title), ['Week of Oct 12 – Oct 18, 2026']);
});

test('the old weeks are rewritten in 1 or 2 writes each, within the write pacing', () => {
  const t = setup(FIXTURES.map(old));
  const realBatch = t.docs.service.Documents.batchUpdate;
  const sizes = [];
  t.docs.service.Documents.batchUpdate = (body) => { sizes.push(body.requests.length); return realBatch(body); };
  run(t);
  assert.ok(sizes.every((n) => n <= t.ctx.BATCH_CHUNK), 'no batch over BATCH_CHUNK');
  const fills = sizes.filter((n) => n > 2);
  assert.deepStrictEqual(fills, [198, 11, 11, 200, 51], 'the busiest week (251 requests) takes 2 writes');
});

test('an assignment that comes back after its week was rewritten still gets its Status and note from Past weeks', () => {
  const t = setup([old('oct-2026-by-class-first')], { props: { 'filed.DOC1': JSON.stringify({ 301: '2026-10-05', 306: '2026-10-05' }) } });
  assert.strictEqual(plain(run(t)).weeks[0].result, 'CONVERTED');
  const u = (n) => 'https://pomfret.instructure.com/courses/1/assignments/' + n;
  const weeks = { '2026-11-16': { days: [{ day: 'Monday', assignments: [{ url: u(301) }, { url: u(306) }] }] } };
  const saved = { status: {}, notes: {} };
  assert.strictEqual(t.ctx.restoreFromPastWeeks_('DOC1', 't.home', weeks, saved), 2);
  assert.deepStrictEqual(plain(saved), {
    status: { [u(301)]: 'Done/Submitted', [u(306)]: 'Need to Start' },
    // By Class had the two-line note (By Day only the first line); its copy wins, as for current weeks.
    notes: { [u(301)]: 'Turned in on paper\nGot it back Thursday', [u(306)]: 'Status was: Waiting on teacher. Asked on Friday' },
  });
});
