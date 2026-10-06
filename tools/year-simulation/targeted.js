'use strict';
// Targeted checks of behaviours spotted while reading the code (real .gs code, made-up data).
const path = require('path');
const R = process.env.SIM_REPO || path.join(__dirname, '..', '..');
const { createSandbox } = require(R + '/tests/helpers/gas-sandbox');
const { fakeServices } = require(R + '/tests/helpers/gas-services');
const W = require('./lib/world');

const out = {};
const svc = fakeServices({ owner: 'owner@pomfret.org' });
const sb = createSandbox({ files: ['apps_script/Code.gs', 'apps_script/Canvas.gs'], globals: svc.globals });
const ctx = sb.context;

// 1. One transient (non-quota) Docs error on a slim read switches every later read in the same
//    execution to full reads (about 4.7 times bigger).
const calls = [];
let failNext = true;
ctx.Docs = { Documents: { get: (id, opts) => {
  calls.push(opts && opts.fields ? 'slim' : 'full');
  if (failNext && opts && opts.fields) { failNext = false; throw new Error('GoogleJsonResponseException: API call to docs.documents.get failed with error: Internal error encountered.'); }
  return { tabs: [] };
} } };
ctx.docsGet_('DOC');
ctx.docsGet_('DOC');
ctx.docsGet_('DOC');
out.transientErrorFallback = { underlyingReads: calls, docsGetFieldsRejectedAfter: ctx.docsGetFieldsRejected_ };

// 2. Class colors before and after the semester change, for classes a student keeps.
const world = W.createWorld(7, { students: 30, heavyStudent: true });
let changed = 0, kept = 0;
const examples = [];
world.students.forEach((st) => {
  const a = ctx.buildCourseColorMap_(st.s1.map((c) => c.name));
  const b = ctx.buildCourseColorMap_(st.s2.map((c) => c.name));
  st.s1.filter((c) => st.s2.includes(c)).forEach((c) => {
    kept++;
    if (a[c.name] !== b[c.name]) { changed++; if (examples.length < 3) examples.push({ student: st.idx, cls: c.name, before: a[c.name], after: b[c.name] }); }
  });
});
out.colorsAcrossSemesterChange = { keptClasses: kept, colorChanged: changed, examples };

// 3. The week that crosses the new year: its title carries the Monday's year.
out.yearCrossTitle = ctx.buildWeekTabTitle_('2026-12-28', 'Dec 28 – Jan 3');
out.yearCrossParsed = ctx.weekKeyFromTabTitle_(out.yearCrossTitle);

// 4. Script Property for the run queue: run.current holds every student ID; it must stay under 9 KB.
const perId = JSON.stringify('xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx').length + 1;
out.runCurrentCapacity = { bytesPerStudentInQueue: perId, studentsBefore9KB: Math.floor((9 * 1024 - 300) / perId) };

console.log(JSON.stringify(out, null, 2));
require('fs').mkdirSync(path.join(__dirname, 'out'), { recursive: true });
require('fs').writeFileSync(path.join(__dirname, 'out', 'targeted.json'), JSON.stringify(out, null, 2));
