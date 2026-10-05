'use strict';
// Tests for apps_script/App.gs: who may call what, the student list, runs and triggers.
// Canvas and the Doc writer are replaced by stubs; all names and tokens are made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, toPlain, REPO_ROOT } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');

const OWNER = 'owner@pomfret.org';
const STAFF = 'staff@pomfret.org';
const STRANGER = 'stranger@pomfret.org';
const TOKEN_A = 'TOKEN-AAAA-1111';
const TOKEN_B = 'TOKEN-BBBB-2222';
const TOKEN_C = 'TOKEN-CCCC-3333';

// Canvas users behind each fake token.
const CANVAS = {
  [TOKEN_A]: { id: 101, name: 'Avery Example' },
  [TOKEN_B]: { id: 102, name: 'Blake Sample' },
  [TOKEN_C]: { id: 103, name: 'Casey Test' },
};

function authError() {
  const e = new Error("Canvas didn't accept this student's token. It may have expired or been deleted. Ask the student for a new token.");
  e.canvasKind = 'auth';
  return e;
}

function setup(extraProps) {
  const svc = fakeServices({
    owner: OWNER,
    active: STAFF,
    props: Object.assign(
      { ALLOWED_USERS: `${OWNER}, ${STAFF.toUpperCase()}`, DOCS_FOLDER_ID: 'FOLDER123' },
      extraProps || {}
    ),
  });
  const sb = createSandbox({
    files: ['apps_script/Code.gs', 'apps_script/Canvas.gs', 'apps_script/App.gs'],
    globals: svc.globals,
  });
  const ctx = sb.context;
  const docWrites = [];
  const badTokens = new Set();
  ctx.fetchCanvasProfile_ = (token) => {
    if (badTokens.has(token) || !CANVAS[token]) throw authError();
    return CANVAS[token];
  };
  ctx.fetchStudentSchedule_ = (token, base, weeks, now, exclude) => {
    if (badTokens.has(token) || !CANVAS[token]) throw authError();
    ctx.lastExclude = exclude;
    return {
      weeks: {}, total_assignments: 3, generated_at: '2026-10-04T19:00:00', courses: ['Biology'],
      student_full_name: CANVAS[token].name, canvas_user_id: CANVAS[token].id,
    };
  };
  ctx.upsertPlannerDocument_ = (payload) => {
    docWrites.push(JSON.parse(JSON.stringify(payload)));
    return { docUrl: 'https://docs/x', documentId: payload.documentId || 'DOC-' + payload.studentFullName.split(' ')[0] };
  };
  return { svc, sb, ctx, docWrites, badTokens };
}

function addAs(t, email, token, label) {
  t.svc.setActive(email);
  return toPlain(t.ctx.addStudent(token, label));
}

test('only the intended functions are callable from the page (no trailing underscore)', () => {
  const publicNames = [];
  for (const f of ['Code.gs', 'Canvas.gs', 'App.gs']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'apps_script', f), 'utf8');
    for (const m of src.matchAll(/^function (\w+)\(/gm)) if (!m[1].endsWith('_')) publicNames.push(m[1]);
  }
  assert.deepStrictEqual(publicNames.sort(), [
    'addStudent', 'checkSetup', 'continueRun', 'doGet', 'editStudent', 'getAppState', 'getRunStatus',
    'removeStudent', 'scheduleTestRun', 'scheduledRun', 'selfTest', 'selfTestKeepToken', 'setupTriggers',
    'startUpdateAll', 'updateStudentNow',
  ].sort());
});

test('doGet: allowed users get the page; everyone else gets "Not authorized"', () => {
  const t = setup();
  t.svc.setActive(STAFF);
  assert.strictEqual(t.ctx.doGet().value, 'Index');
  t.svc.setActive(STRANGER);
  const page = t.ctx.doGet();
  assert.strictEqual(page.kind, 'html');
  assert.match(page.value, /Not authorized/);
  assert.match(page.value, /stranger@pomfret\.org/);
  assert.match(page.value, /This page is only for CLC staff\. If you need access, contact Cayden Auyang or Luke Ryan\./);
  assert.match(page.value, /--ink:#0d0d0c;--paper:#f4f3ef/, 'same design tokens as the staff page');
  assert.match(page.value, /<span class="brand-name">AutoPlanner<\/span>/, 'same header');
  assert.doesNotMatch(page.value, /google\.script\.run|<script/, 'no data and no actions');
  t.svc.setActive('');
  assert.match(t.ctx.doGet().value, /did not tell AutoPlanner/);
  t.svc.setActive('<b>x</b>@pomfret.org');
  assert.doesNotMatch(t.ctx.doGet().value, /<b>x<\/b>/, 'email is escaped');
});

test('every page function refuses people who are not in ALLOWED_USERS', () => {
  const t = setup();
  t.svc.setActive(STRANGER);
  const calls = {
    getAppState: [], addStudent: [TOKEN_A, ''], editStudent: ['x', '', ''], removeStudent: ['x'],
    updateStudentNow: ['x'], startUpdateAll: [], getRunStatus: [],
  };
  for (const [fn, args] of Object.entries(calls)) {
    assert.throws(() => t.ctx[fn](...args), /Not authorized/, fn);
  }
  assert.strictEqual(Object.keys(t.svc.props).filter((k) => k.startsWith('student.')).length, 0);
});

test('editor-only functions refuse staff calling them from the page', () => {
  const t = setup();
  t.svc.setActive(STAFF);
  for (const fn of ['setupTriggers', 'scheduleTestRun', 'checkSetup', 'selfTest', 'selfTestKeepToken']) {
    assert.throws(() => t.ctx[fn](), /Only the script owner/, fn);
  }
});

test('trigger functions only run from a real trigger of this project', () => {
  const t = setup();
  t.svc.setActive(STAFF);
  for (const fn of ['scheduledRun', 'continueRun']) {
    assert.throws(() => t.ctx[fn](), /only runs from its own trigger/, fn);
    assert.throws(() => t.ctx[fn]({ triggerUid: 'made-up' }), /only runs from its own trigger/, fn);
  }
});

test('addStudent checks the token with Canvas, saves it, and never sends it back', () => {
  const t = setup();
  const res = addAs(t, STAFF, '  ' + TOKEN_A + '\n', ' Table 4 ');
  assert.strictEqual(res.student.name, 'Avery Example');
  assert.strictEqual(res.student.label, 'Table 4');
  assert.strictEqual(res.student.tokenEnd, '1111');
  assert.ok(!JSON.stringify(res).includes(TOKEN_A), 'token not returned');
  const state = toPlain(t.ctx.getAppState());
  assert.ok(!JSON.stringify(state).includes(TOKEN_A), 'token not in page state');
  assert.strictEqual(state.user, STAFF);
  const id = res.student.id;
  assert.strictEqual(t.svc.props['token.' + id], TOKEN_A);
  assert.ok(!t.svc.props['student.' + id].includes(TOKEN_A), 'token kept out of the student record');
});

test('addStudent refuses a bad token (nothing saved) and a student who is already on the list', () => {
  const t = setup();
  t.svc.setActive(STAFF);
  assert.throws(() => t.ctx.addStudent('NOT-A-TOKEN', ''), /didn't accept/);
  assert.throws(() => t.ctx.addStudent('   ', ''), /Paste the student's Canvas token/);
  assert.strictEqual(Object.keys(t.svc.props).filter((k) => k.startsWith('token.')).length, 0);
  addAs(t, STAFF, TOKEN_A, 'Table 4');
  assert.throws(() => t.ctx.addStudent(TOKEN_A, ''), /Avery Example is already on the list \(as "Table 4"\)/);
});

test('a re-added student gets their existing Doc from the shared folder, not a duplicate', () => {
  const t = setup();
  t.svc.addFile('OLD-DOC', 'Avery Example - CLC Assignments', 'FOLDER123', { updated: new Date(1000) });
  t.svc.addFile('NEWER-DOC', 'Avery Example - CLC Assignments', 'FOLDER123', { updated: new Date(2000) });
  t.svc.addFile('TRASHED', 'Avery Example - CLC Assignments', 'FOLDER123', { updated: new Date(3000), trashed: true });
  t.svc.addFile('ELSEWHERE', 'Avery Example - CLC Assignments', 'OTHER', { updated: new Date(4000) });
  const res = addAs(t, STAFF, TOKEN_A, '');
  assert.match(res.student.docUrl, /NEWER-DOC/);
  assert.match(res.message, /existing Doc/);
  t.ctx.updateStudentNow(res.student.id);
  assert.strictEqual(t.docWrites[0].documentId, 'NEWER-DOC');
  assert.strictEqual(t.docWrites[0].studentFullName, 'Avery Example');
});

test("a Doc that already belongs to another student on the list is not reused", () => {
  const t = setup();
  t.svc.addFile('SHARED-NAME', 'Avery Example - CLC Assignments', 'FOLDER123');
  addAs(t, STAFF, TOKEN_A, '');
  // A second Canvas user with the same full name must not grab the first one's Doc.
  CANVAS['TOKEN-TWIN-9999'] = { id: 999, name: 'Avery Example' };
  const twin = addAs(t, STAFF, 'TOKEN-TWIN-9999', 'twin');
  assert.strictEqual(twin.student.docUrl, '');
  delete CANVAS['TOKEN-TWIN-9999'];
});

test('editStudent changes the label, and only accepts a new token for the same Canvas user', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, 'old');
  assert.throws(() => t.ctx.editStudent(student.id, 'x', TOKEN_B), /belongs to Blake Sample, not Avery Example/);
  assert.strictEqual(t.svc.props['token.' + student.id], TOKEN_A);
  CANVAS['TOKEN-AAAA-NEW1'] = CANVAS[TOKEN_A];
  const edited = toPlain(t.ctx.editStudent(student.id, 'new label', 'TOKEN-AAAA-NEW1'));
  assert.strictEqual(edited.label, 'new label');
  assert.strictEqual(edited.tokenEnd, 'NEW1');
  assert.strictEqual(t.svc.props['token.' + student.id], 'TOKEN-AAAA-NEW1');
  const labelOnly = toPlain(t.ctx.editStudent(student.id, 'just label', ''));
  assert.strictEqual(labelOnly.tokenEnd, 'NEW1');
  delete CANVAS['TOKEN-AAAA-NEW1'];
});

test('removeStudent deletes the record and the token', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.removeStudent(student.id);
  assert.deepStrictEqual(Object.keys(t.svc.props).filter((k) => k.includes(student.id)), []);
});

test('updateStudentNow: success is recorded; an expired token gives a plain message without the token', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  const ok = toPlain(t.ctx.updateStudentNow(student.id));
  assert.strictEqual(ok.last.ok, true);
  assert.match(ok.last.message, /3 assignments in the next 4 weeks/);
  assert.match(ok.docUrl, /DOC-Avery/);
  t.badTokens.add(TOKEN_A);
  const bad = toPlain(t.ctx.updateStudentNow(student.id));
  assert.strictEqual(bad.last.ok, false);
  assert.match(bad.last.message, /didn't accept this student's token/);
  assert.ok(!JSON.stringify(t.svc.props).replace(t.svc.props['token.' + student.id], '').includes(TOKEN_A));
});

test('a student whose Doc was trashed gets a fresh Doc and a plain message on their row for a week', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.updateStudentNow(student.id);
  const oldId = JSON.parse(t.svc.props['student.' + student.id]).docId;
  t.svc.addFile(oldId, 'Avery Example - CLC Assignments', 'FOLDER123', { trashed: true });
  // Like the real Doc writer: check the saved Doc first (the real check), then write.
  const writes = [];
  t.ctx.upsertPlannerDocument_ = (payload) => {
    if (payload.documentId) t.ctx.savedDocFile_(payload.documentId);
    writes.push(payload.documentId || 'new');
    if (!payload.documentId) t.svc.addFile('FRESH-DOC', 'Avery Example - CLC Assignments', 'FOLDER123');
    return { docUrl: 'u', documentId: payload.documentId || 'FRESH-DOC' };
  };
  const after = toPlain(t.ctx.updateStudentNow(student.id));
  assert.deepStrictEqual(writes, ['new'], 'nothing written to the trashed Doc');
  assert.strictEqual(after.last.ok, true);
  assert.match(after.docUrl, /FRESH-DOC/);
  assert.strictEqual(after.notice.message, 'Their Doc was deleted, so AutoPlanner made a new one.');
  // The next update writes the new Doc; the message stays for a week, then goes.
  t.ctx.updateStudentNow(student.id);
  assert.deepStrictEqual(writes, ['new', 'FRESH-DOC']);
  assert.ok(toPlain(t.ctx.getAppState()).students[0].notice);
  const rec = JSON.parse(t.svc.props['student.' + student.id]);
  rec.notice.at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  t.svc.props['student.' + student.id] = JSON.stringify(rec);
  assert.strictEqual(toPlain(t.ctx.getAppState()).students[0].notice, null);
});

test('a trashed Doc with another of their Docs in the folder: that one is used, and the row says so', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.updateStudentNow(student.id);
  const oldId = JSON.parse(t.svc.props['student.' + student.id]).docId;
  t.svc.addFile(oldId, 'Avery Example - CLC Assignments', 'FOLDER123', { trashed: true });
  t.svc.addFile('SPARE', 'Avery Example - CLC Assignments', 'FOLDER123');
  t.ctx.upsertPlannerDocument_ = (payload) => {
    if (payload.documentId) t.ctx.savedDocFile_(payload.documentId);
    return { docUrl: 'u', documentId: payload.documentId };
  };
  const after = toPlain(t.ctx.updateStudentNow(student.id));
  assert.match(after.docUrl, /SPARE/);
  assert.match(after.notice.message, /^Their Doc was deleted, so AutoPlanner switched to their other Doc/);
});

test('staff never see raw Google errors, and a Canvas 429 is not called a Docs problem', () => {
  const t = setup();
  const plain = /^Google Docs or Drive had a temporary problem\. This student will be tried again at the next update\. If it keeps happening, contact Cayden Auyang or Luke Ryan/;
  for (const raw of [
    'GoogleJsonResponseException: API call to docs.documents.batchUpdate failed with error: Internal error encountered.',
    'Exception: Service error: Drive',
    "We're sorry, a server error occurred. Please wait a bit and try again.",
    'Could not open the saved Google Doc (abc): Exception: Unexpected error while getting the method or property getFileById',
    'addDocumentTab failed — check Docs API service is enabled. Raw: {}',
    'Exception: Service invoked too many times for one day: urlfetch.',
  ]) assert.match(t.ctx.friendlyError_(new Error(raw)), plain, raw);
  const canvasBusy = Object.assign(new Error('Canvas is busy or down right now (HTTP 429). Try again later.'), { canvasKind: 'unavailable' });
  assert.strictEqual(t.ctx.friendlyError_(canvasBusy), 'Canvas is busy or down right now (HTTP 429). Try again later.');
  assert.match(t.ctx.friendlyError_(new Error('Quota exceeded for quota metric write requests (429)')), /limiting how fast Docs/);
  // Plain messages pass through untouched.
  assert.strictEqual(t.ctx.friendlyError_(new Error("Canvas didn't accept this student's token.")), "Canvas didn't accept this student's token.");
});

test("a Drive hiccup on a Doc that isn't gone: no new Doc, and a plain message", () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.updateStudentNow(student.id);
  const docId = JSON.parse(t.svc.props['student.' + student.id]).docId;
  t.svc.addFile(docId, 'Avery Example - CLC Assignments', 'FOLDER123');
  const writes = [];
  t.ctx.upsertPlannerDocument_ = (payload) => {
    writes.push(payload.documentId || 'new');
    if (payload.documentId) throw new Error(t.ctx.DOC_GONE_PREFIX + ' (' + docId + '): Exception: Service error: Drive');
    return { documentId: 'SHOULD-NOT-HAPPEN' };
  };
  const after = toPlain(t.ctx.updateStudentNow(student.id));
  assert.deepStrictEqual(writes, [docId], 'no second Doc');
  assert.strictEqual(after.last.ok, false);
  assert.match(after.last.message, /Google Drive didn't answer about this student's Doc/);
  assert.match(after.docUrl, new RegExp(docId));
});

test('run summaries stay small (20 problems kept, the rest counted), and removed students leave the total', () => {
  const t = setup();
  t.svc.setActive(OWNER);
  for (let i = 0; i < 25; i++) {
    t.svc.props['student.s' + i] = JSON.stringify({ id: 's' + i, name: 'Student ' + i, label: '', canvasUserId: 900 + i });
    t.svc.props['token.s' + i] = 'TOKEN-BAD-' + i;
  }
  t.ctx.startUpdateAll();
  const last = JSON.parse(t.svc.props['run.last']);
  assert.strictEqual(last.failed.length, 20);
  assert.strictEqual(last.moreFailed, 5);
  assert.ok(t.svc.props['run.last'].length < 9000, 'fits in one Script Property');
  // A student removed while queued doesn't count as "not updated".
  const run = { id: 'r1', queue: [], total: 3, updated: 0, failed: [], inProgress: 'x' };
  t.svc.props['run.current'] = JSON.stringify(run);
  t.ctx.recordResult_('r1', { ok: false, skipped: true, message: 'That student was removed.' });
  assert.strictEqual(JSON.parse(t.svc.props['run.current']).total, 2);
});

test('the page warns when no update has finished for over a day', () => {
  const t = setup();
  t.svc.setActive(OWNER);
  t.ctx.setupTriggers();
  t.svc.setActive(STAFF);
  assert.strictEqual(toPlain(t.ctx.getAppState()).updatesStaleSince, null, 'no update yet: nothing to warn about');
  const old = new Date(Date.now() - 27 * 3600 * 1000).toISOString();
  t.svc.props['run.last'] = JSON.stringify({ finishedAt: old, total: 1, updated: 1, failed: [] });
  assert.strictEqual(toPlain(t.ctx.getAppState()).updatesStaleSince, old);
  t.svc.props['run.last'] = JSON.stringify({ finishedAt: new Date().toISOString(), total: 1, updated: 1, failed: [] });
  assert.strictEqual(toPlain(t.ctx.getAppState()).updatesStaleSince, null);
});

test('token dates: "Token expires …" on the row, a warning 14 days ahead, and the date in the expired message', () => {
  const t = setup();
  const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const later = '2099-01-02T05:00:00Z';
  t.ctx.fetchCanvasTokenExpiry_ = (token) => (token === TOKEN_A ? { expiresAt: later, createdAt: '2026-10-04T20:54:53Z' } : token === TOKEN_B ? { expiresAt: soon, createdAt: null } : null);
  const a = addAs(t, STAFF, TOKEN_A, '').student;
  const b = addAs(t, STAFF, TOKEN_B, '').student;
  const c = addAs(t, STAFF, TOKEN_C, '').student;
  assert.strictEqual(a.tokenDate, 'Token expires Jan 2, 2099');
  assert.match(c.tokenDate, /^Token added [A-Z][a-z]{2} \d{1,2}, \d{4}$/, "Canvas didn't say: the date it was added");
  const state = toPlain(t.ctx.getAppState());
  assert.deepStrictEqual(state.tokensExpiring.map((x) => [x.name, x.expired]), [['Blake Sample', false]]);
  // Expired: the next update says so, with the date.
  const rec = JSON.parse(t.svc.props['student.' + b.id]);
  rec.tokenExpiresAt = '2026-01-02T05:00:00Z';
  t.svc.props['student.' + b.id] = JSON.stringify(rec);
  t.badTokens.add(TOKEN_B);
  const after = toPlain(t.ctx.updateStudentNow(b.id));
  assert.strictEqual(after.last.message, "This student's Canvas token expired on Jan 2, 2026. Ask the student for a new token, then click Edit on their row, paste it and click Save.");
  assert.strictEqual(after.tokenDate, 'Token expired Jan 2, 2026');
  assert.ok(toPlain(t.ctx.getAppState()).tokensExpiring.some((x) => x.name === 'Blake Sample' && x.expired));
});

test('students added before expiry dates existed are checked with Canvas once, at their next update', () => {
  const t = setup();
  t.ctx.fetchCanvasTokenExpiry_ = () => null;
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  const rec = JSON.parse(t.svc.props['student.' + student.id]);
  delete rec.tokenChecked; delete rec.tokenExpiresAt; delete rec.tokenAddedAt;
  t.svc.props['student.' + student.id] = JSON.stringify(rec);
  let asked = 0;
  t.ctx.fetchCanvasTokenExpiry_ = () => { asked++; return { expiresAt: '2099-01-02T05:00:00Z', createdAt: '2026-09-01T12:00:00Z' }; };
  const once = toPlain(t.ctx.updateStudentNow(student.id));
  assert.strictEqual(once.tokenDate, 'Token expires Jan 2, 2099');
  t.ctx.updateStudentNow(student.id);
  assert.strictEqual(asked, 1);
  assert.strictEqual(JSON.parse(t.svc.props['student.' + student.id]).tokenAddedAt, '2026-09-01T12:00:00Z');
});

test('friendlyError_ scrubs the token and translates Docs quota errors', () => {
  const t = setup();
  assert.strictEqual(t.ctx.friendlyError_(new Error('Error: bad ' + TOKEN_A), TOKEN_A), 'bad [token]');
  assert.match(t.ctx.friendlyError_(new Error('Quota exceeded for quota metric'), ''), /limiting how fast/);
});

test('Update all: one bad token does not stop the others; the summary has no assignment data', () => {
  const t = setup();
  addAs(t, STAFF, TOKEN_A, '');
  addAs(t, STAFF, TOKEN_B, '');
  addAs(t, STAFF, TOKEN_C, '');
  t.badTokens.add(TOKEN_B);
  const res = toPlain(t.ctx.startUpdateAll());
  assert.strictEqual(res.alreadyRunning, false);
  assert.strictEqual(res.run, null, 'finished in one batch');
  const last = res.lastRun;
  assert.strictEqual(last.total, 3);
  assert.strictEqual(last.updated, 2);
  assert.strictEqual(last.reason, 'manual');
  assert.strictEqual(last.startedBy, STAFF);
  assert.deepStrictEqual(last.failed.map((f) => f.name), ['Blake Sample']);
  assert.match(last.failed[0].message, /didn't accept/);
  assert.strictEqual(t.docWrites.length, 2);
  assert.strictEqual(t.svc.props['run.current'], undefined);
  assert.deepStrictEqual(t.svc.triggers.filter((x) => x.handler === 'continueRun'), [], 'safety trigger removed');
});

test('long runs stop at the time budget, chain continueRun, and finish in the next batch', () => {
  const t = setup();
  addAs(t, STAFF, TOKEN_A, '');
  addAs(t, STAFF, TOKEN_B, '');
  addAs(t, STAFF, TOKEN_C, '');
  t.ctx.APP_BATCH_BUDGET_MS = -1; // every student "uses up" the budget
  const res = toPlain(t.ctx.startUpdateAll());
  assert.strictEqual(res.run.done, 1);
  assert.strictEqual(res.run.total, 3);
  const cont = t.svc.triggers.filter((x) => x.handler === 'continueRun');
  assert.strictEqual(cont.length, 1);
  assert.strictEqual(cont[0].config.after, 60 * 1000);
  // While a run is going, a second run or a single update is refused.
  assert.strictEqual(toPlain(t.ctx.startUpdateAll()).alreadyRunning, true);
  assert.throws(() => t.ctx.updateStudentNow(res.students[0].id), /is running/);
  t.ctx.APP_BATCH_BUDGET_MS = 2 * 60 * 1000;
  t.ctx.continueRun({ triggerUid: cont[0].uid });
  const last = JSON.parse(t.svc.props['run.last']);
  assert.strictEqual(last.updated, 3);
  assert.strictEqual(t.svc.props['run.current'], undefined);
  assert.strictEqual(t.svc.triggers.length, 0);
});

test('if a batch is cut off mid-student, the safety trigger records it and carries on', () => {
  const t = setup();
  addAs(t, STAFF, TOKEN_A, '');
  addAs(t, STAFF, TOKEN_B, '');
  // Simulate a batch that died after taking the first student.
  t.ctx.APP_BATCH_BUDGET_MS = -1;
  const realUpdate = t.ctx.updateOneStudent_;
  t.ctx.updateOneStudent_ = () => { throw new Error('Exceeded maximum execution time'); };
  assert.throws(() => t.ctx.startUpdateAll(), /Exceeded maximum execution time/);
  t.ctx.updateOneStudent_ = realUpdate;
  t.ctx.APP_BATCH_BUDGET_MS = 2 * 60 * 1000;
  const safety = t.svc.triggers.find((x) => x.handler === 'continueRun');
  assert.strictEqual(safety.config.after, 8 * 60 * 1000);
  t.ctx.continueRun({ triggerUid: safety.uid });
  const last = JSON.parse(t.svc.props['run.last']);
  assert.strictEqual(last.total, 2);
  assert.strictEqual(last.updated, 1);
  assert.match(last.failed[0].message, /longer than Apps Script allows/);
});

test('setupTriggers installs 7 pm and midnight New York triggers, idempotently, and removes the old secret', () => {
  const t = setup({ APPS_SCRIPT_SECRET: 'old-secret' });
  t.svc.setActive(OWNER);
  t.ctx.setupTriggers();
  t.ctx.setupTriggers();
  const daily = t.svc.triggers.filter((x) => x.handler === 'scheduledRun');
  assert.deepStrictEqual(daily.map((x) => toPlain(x.config)), [
    { atHour: 19, nearMinute: 0, everyDays: 1, timeZone: 'America/New_York' },
    { atHour: 0, nearMinute: 15, everyDays: 1, timeZone: 'America/New_York' }, // 12:00–12:30 AM, never before midnight
  ]);
  assert.strictEqual(t.svc.props.APPS_SCRIPT_SECRET, undefined);
  assert.ok(t.sb.logs.some((l) => /OK {3}Daily updates/.test(l)));
  t.svc.setActive(STAFF);
  assert.strictEqual(toPlain(t.ctx.getAppState()).automaticUpdatesOn, true);
});

test('scheduleTestRun adds a one-off run that removes itself; the daily triggers stay', () => {
  const t = setup();
  addAs(t, STAFF, TOKEN_A, '');
  t.svc.setActive(OWNER);
  t.ctx.setupTriggers();
  t.ctx.scheduleTestRun();
  const oneOff = t.svc.triggers.find((x) => x.config.at);
  assert.ok(oneOff.config.at.getTime() - Date.now() > 4 * 60 * 1000);
  t.svc.setActive(''); // triggers have no signed-in visitor
  t.ctx.scheduledRun({ triggerUid: oneOff.uid });
  assert.strictEqual(JSON.parse(t.svc.props['run.last']).reason, 'test');
  assert.strictEqual(t.svc.triggers.filter((x) => x.handler === 'scheduledRun').length, 2);
  const daily = t.svc.triggers.find((x) => x.config.atHour === 19);
  t.ctx.scheduledRun({ triggerUid: daily.uid });
  assert.strictEqual(JSON.parse(t.svc.props['run.last']).reason, 'scheduled');
  assert.strictEqual(t.svc.triggers.filter((x) => x.handler === 'scheduledRun').length, 2, 'daily triggers kept');
});

test('checkSetup and selfTest never log a token; selfTest deletes TEST_CANVAS_TOKEN unless asked to keep it', () => {
  const t = setup({ TEST_CANVAS_TOKEN: TOKEN_A, COURSE_EXCLUDE: 'advisory, dorm' });
  t.svc.setActive(OWNER);
  t.ctx.checkSetup();
  // Skip the Doc steps: pretend the Doc has no week tabs yet.
  t.ctx.writeDocWithRecovery_ = () => 'DOC-SELF';
  t.ctx.assertDocIsInFolder_ = () => {};
  t.ctx.docsGet_ = () => ({ tabs: [{ tabProperties: { tabId: 't.0', title: 'CLC Planner' }, childTabs: [] }] });
  t.ctx.selfTestKeepToken();
  assert.strictEqual(t.svc.props.TEST_CANVAS_TOKEN, TOKEN_A);
  t.ctx.selfTest();
  assert.strictEqual(t.svc.props.TEST_CANVAS_TOKEN, undefined);
  const logText = t.sb.logs.join('\n');
  assert.ok(!logText.includes(TOKEN_A), 'token never logged');
  assert.match(logText, /COURSE_EXCLUDE: advisory, dorm/);
  assert.match(logText, /PASS Canvas: fetch your assignments and classes: Avery Example, 3 assignments/);
  assert.match(logText, /FAIL Every class has its own By Class table in every week: (No week tabs found|Found 0 week tabs)/);
  assert.match(logText, /selfTest: FAILED/);
  t.svc.props.TEST_CANVAS_TOKEN = 'NOT-A-TOKEN';
  t.ctx.selfTest();
  assert.match(t.sb.logs.join('\n'), /FAIL Canvas: fetch your assignments and classes: Canvas didn't accept TEST_CANVAS_TOKEN/);
});

test('writeStatusAndNote_ edits the Notes cell before the Status cell and keeps the cell newline', () => {
  const t = setup();
  const cell = (start, text) => ({
    content: [{ startIndex: start, paragraph: { elements: [{ startIndex: start, endIndex: start + text.length + 1, textRun: { content: text + '\n' } }] } }],
  });
  const sent = [];
  t.ctx.docsBatchUpdate_ = (docId, requests) => sent.push(...toPlain(requests));
  t.ctx.writeStatusAndNote_('DOC', { tabId: 't.1', status: cell(100, '⬜ Not started'), note: cell(120, '') }, 'S', 'N');
  assert.deepStrictEqual(sent, [
    { insertText: { text: 'N', location: { tabId: 't.1', index: 120 } } },
    { deleteContentRange: { range: { tabId: 't.1', startIndex: 100, endIndex: 100 + '⬜ Not started'.length } } },
    { insertText: { text: 'S', location: { tabId: 't.1', index: 100 } } },
  ]);
});

test("selfTest uses your student row's Doc when you're on the list (no second copy in the folder)", () => {
  const t = setup({ TEST_CANVAS_TOKEN: TOKEN_A });
  t.svc.addFile('MY-DOC', 'Avery Example - CLC Assignments', 'FOLDER123');
  const { student } = addAs(t, STAFF, TOKEN_A, 'Demo'); // reuses MY-DOC
  assert.match(student.docUrl, /MY-DOC/);
  t.svc.setActive(OWNER);
  const calls = [];
  t.ctx.writeDocWithRecovery_ = (s) => { calls.push(toPlain(s)); return s.docId || 'NEW-DOC'; };
  t.ctx.assertDocIsInFolder_ = () => {};
  t.ctx.docsGet_ = () => ({ tabs: [{ tabProperties: { tabId: 't.0', title: 'CLC Planner' }, childTabs: [] }] });
  t.ctx.selfTestKeepToken();
  assert.deepStrictEqual(calls[0], { id: student.id, docId: 'MY-DOC' });
  assert.match(t.sb.logs.join('\n'), /PASS Doc: create or update yours in the shared folder: used your student row's Doc/);
  assert.match(t.sb.logs.join('\n'), /PASS Not authorized page: the CLC-staff message, and no data or actions/);
});

test('selfTest runs every check after a failure (unless it needs the failed one), and shows Drive\'s own words for a deleted Doc', () => {
  const t = setup({ TEST_CANVAS_TOKEN: TOKEN_A });
  t.svc.setActive(OWNER);
  t.ctx.writeDocWithRecovery_ = () => 'DOC-SELF';
  t.ctx.assertDocIsInFolder_ = () => {};
  // A Doc with no week tabs: the table checks fail, the later independent checks still run.
  t.ctx.docsGet_ = () => ({ tabs: [{ tabProperties: { tabId: 't.0', title: 'CLC Planner' }, childTabs: [] }] });
  t.ctx.selfTestKeepToken();
  const log = t.sb.logs.join('\n');
  assert.match(log, /FAIL Every class has its own By Class table in every week/);
  assert.match(log, /PASS A Doc deleted for good: Drive's message \(shown as is\): recognized as deleted: "No item with the given ID could be found"/);
  assert.match(log, /(PASS|FAIL) Doc reads skip Past weeks' content/, 'a check after the failures still ran');
  assert.match(log, /selfTest: FAILED \(\d+ failed, \d+ passed/);
  assert.doesNotMatch(log, /later checks skipped/);
  // Drive's words not recognized: shown, as a SKIP, not a FAIL.
  const u = setup({ TEST_CANVAS_TOKEN: TOKEN_A });
  u.svc.setActive(OWNER);
  u.ctx.DriveApp.getFileById = () => { throw new Error('Invalid argument: id'); };
  u.ctx.selfTestKeepToken();
  assert.match(u.sb.logs.join('\n'), /SKIP A Doc deleted for good: Drive's message \(shown as is\): Drive said "Invalid argument: id"/);
});

test("selfTest holds your row: updates skip it meanwhile, and selfTest stops early if an update is already running on it", () => {
  const t = setup({ TEST_CANVAS_TOKEN: TOKEN_A });
  const { student } = addAs(t, STAFF, TOKEN_A, 'Demo');
  t.svc.setActive(OWNER);
  let skippedDuring = null;
  t.ctx.writeDocWithRecovery_ = () => {
    if (skippedDuring === null) skippedDuring = toPlain(t.ctx.updateOneStudent_(student.id));
    return 'DOC-SELF';
  };
  t.ctx.assertDocIsInFolder_ = () => {};
  t.ctx.docsGet_ = () => ({ tabs: [{ tabProperties: { tabId: 't.0', title: 'CLC Planner' }, childTabs: [] }] });
  t.ctx.selfTestKeepToken();
  assert.match(t.sb.logs.join('\n'), /PASS Your row is held for selfTest/);
  assert.strictEqual(skippedDuring.skipped, true, 'an update during selfTest skips the row');
  assert.ok(!t.svc.props['busy.' + student.id], 'released at the end');
  // An update is already running on the row: selfTest stops before touching the Doc.
  t.svc.props['busy.' + student.id] = String(Date.now());
  const u = setup({ TEST_CANVAS_TOKEN: TOKEN_A });
  t.sb.logs.length = 0;
  let wrote = false;
  t.ctx.writeDocWithRecovery_ = () => { wrote = true; return 'DOC-SELF'; };
  t.ctx.selfTestKeepToken();
  assert.match(t.sb.logs.join('\n'), /FAIL Your row is held for selfTest[^\n]*: Your row is being updated right now\. Run selfTest again in a few minutes\./);
  assert.strictEqual(wrote, false);
  void u;
});

test("selfTest's gray check: passes when a past week's Priority cells are gray, fails when one isn't", () => {
  const t = setup();
  const cell = (text, bg) => ({
    content: [{ paragraph: { elements: [{ textRun: { content: text + '\n' } }] } }],
    tableCellStyle: bg ? { backgroundColor: { color: { rgbColor: bg } } } : {},
  });
  const gray = { red: 224 / 255, green: 224 / 255, blue: 224 / 255 };
  const orange = { red: 1, green: 0.702, blue: 0.278 };
  const tab = (bg) => ({
    tabProperties: { tabId: 't.x', title: 'Week of Oct 5 – Oct 11, 2026' },
    documentTab: { body: { content: [{ startIndex: 5, table: { tableRows: [
      { tableCells: ['Assignment', 'Day', 'Due Time', 'Priority', 'Status', 'Notes'].map((x) => cell(x)) },
      { tableCells: [cell('Essay'), cell('Monday'), cell('8:30 AM'), cell('Today', bg), cell('Complete'), cell('')] },
    ] } }] } },
  });
  assert.strictEqual(t.ctx.assertPriorityGray_(tab(gray)), 1);
  assert.throws(() => t.ctx.assertPriorityGray_(tab(orange)), /a Priority cell in "Week of Oct 5 – Oct 11, 2026" is not gray/);
});
