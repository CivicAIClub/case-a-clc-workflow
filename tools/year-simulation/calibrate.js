'use strict';
// Calibration of the two size models against the live fixture (made-up data):
//   1. index model: a week tab's end index from its request list (insertText lengths + tables);
//   2. read-size model: the realistic renderer's JSON vs the real masked read of the same tab.
const path = require('path');
const assert = require('assert');
const R = process.env.SIM_REPO || path.join(__dirname, '..', '..');
const { createSandbox } = require(R + '/tests/helpers/gas-sandbox');
const { applyFieldMask } = require(R + '/tests/helpers/field-mask');
const real = require('./lib/realistic');

const sb = createSandbox({ files: ['apps_script/Code.gs', 'apps_script/Canvas.gs'], globals: { PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } } });
const ctx = sb.context;
const wk = require(path.join(__dirname, 'week-tab-requests-live.json'));
const fx = require(R + '/tests/fixtures/live-week-tab-read.json');

function indexModel(reqs) {
  let L = 2;
  reqs.forEach((r) => {
    if (r.insertText) L += r.insertText.text.length;
    if (r.insertTable) L += 3 + r.insertTable.rows * (2 * r.insertTable.columns + 1);
    if (r.deleteContentRange) L -= r.deleteContentRange.range.endIndex - r.deleteContentRange.range.startIndex;
  });
  return L;
}

const tabId = wk[0].insertText.location.tabId;
const url = 'https://pomfret.instructure.com/courses/1/assignments/2';
const weekData = { week_label: 'Oct 5 – Oct 11', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => ({ day: d, assignments: d !== 'Monday' ? [] : [{
  day: 'Monday', assignment: 'Paper Outline Due: personality theories (bring two printed sources and your annotated bibliography)',
  course: 'Psychology', due_time: '10:25 AM', priority: 'Tomorrow', days_until_due: 1, due_date: '2026-10-05', week_start: '2026-10-05', url }] })) };
const courses = ['Calculus III', 'Psychology'];
const saved = { status: { [url]: 'In progress' }, notes: { [url]: 'Ask about the lab report' } };
const colorMap = ctx.buildCourseColorMap_(courses);
const reqs = JSON.parse(JSON.stringify(ctx.buildWeekTabRequests_(tabId, '2026-10-05', weekData, courses, colorMap, saved, 468, null)));
const sameAsLive = JSON.stringify(reqs) === JSON.stringify(wk);

const staffRow = [
  { text: 'Vocab quiz (announced in class)', runs: [{ s: 0, e: 10, style: { bold: true } }, { s: 11, e: 31, style: { italic: true, foregroundColor: { color: { rgbColor: { red: 0.8 } } } } }] },
  { text: 'Spanish', runs: [] }, { text: 'Friday', runs: [] }, { text: 'Not started', runs: [] },
  { text: 'Bring flashcards', runs: [{ s: 0, e: 16, style: { underline: true, link: { url: 'https://www.example.org/flashcards' }, foregroundColor: { color: { rgbColor: { blue: 0.8, green: 0.33333334, red: 0.06666667 } } } } }] },
];
const staffText = staffRow.reduce((n, c) => n + c.text.length, 0);
const modelEnd = indexModel(wk) + staffText;

// Realistic render, with the staff row as typed.
const content = real.renderWeekTab(ctx, '2026-10-05', weekData, courses, saved, [staffRow, [0, 1, 2, 3, 4].map(() => ({ text: '', runs: [] }))]);
const nested = { tabs: [Object.assign({}, fx.tabs[0], { childTabs: [fx.tabs[1]] })] };
const masked = applyFieldMask(nested, ctx.DOCS_GET_FIELDS).tabs[0].childTabs[0];
const liveContent = masked.documentTab.body.content;
const liveEnd = liveContent[liveContent.length - 1].endIndex;

// Element-by-element comparison (the staff row's styled runs are compared by size only).
const diffs = [];
liveContent.forEach((se, i) => {
  const a = JSON.stringify(se);
  const b = JSON.stringify(content[i]);
  if (a !== b) diffs.push({ i, liveBytes: a.length, simBytes: b.length });
});
const liveBytes = JSON.stringify(liveContent).length;
const simBytes = JSON.stringify(content).length;

const out = {
  requestsIdenticalToLiveRequestList: sameAsLive,
  indexModel: { requestModelEndIndex: indexModel(wk), plusStaffRowText: modelEnd, liveEndIndex: liveEnd, errorChars: modelEnd - liveEnd, errorPct: (modelEnd - liveEnd) / liveEnd * 100 },
  renderer: { endIndex: real.endIndexOf(content), liveEndIndex: liveEnd },
  readSize: { liveMaskedContentChars: liveBytes, simContentChars: simBytes, errorPct: (simBytes - liveBytes) / liveBytes * 100,
    liveMaskedTabChars: JSON.stringify(masked).length, liveFullTabChars: JSON.stringify(fx.tabs[1]).length,
    fullToMaskedRatio: JSON.stringify(fx.tabs[1]).length / JSON.stringify(masked).length },
  elementDiffs: diffs,
};
console.log(JSON.stringify(out, null, 2));
if (diffs.length) {
  const i = diffs[0].i;
  console.log('first differing element', i);
  console.log('LIVE', JSON.stringify(liveContent[i]).slice(0, 3000));
  console.log('SIM ', JSON.stringify(content[i]).slice(0, 3000));
}
require('fs').mkdirSync(path.join(__dirname, 'out'), { recursive: true });
require('fs').writeFileSync(path.join(__dirname, 'out', 'calibration.json'), JSON.stringify(out, null, 2));
assert.ok(sameAsLive);
