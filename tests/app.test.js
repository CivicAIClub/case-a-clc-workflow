'use strict';
// Tests for apps_script/App.gs: who may call what, the student list, runs and triggers.
// Canvas and the Doc writer are replaced by stubs; all names and tokens are made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, toPlain, REPO_ROOT } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');
const { fakeDocs, withRendering, copiesOf, staffTypes, staffWrites } = require('./helpers/fake-docs');

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
    'addStudent', 'checkSetup', 'continueRun', 'doGet', 'editStudent', 'getAppState', 'getRunStatus', 'healthCheckNow', 'measureTimeLimit',
    'pauseAutomaticUpdates', 'removeStudent', 'resumeAutomaticUpdates', 'scheduleTestRun', 'scheduledRun', 'selfTest', 'selfTestEveryday',
    'selfTestKeepToken', 'setStudentTeacher', 'setupTriggers', 'startUpdateAll', 'updateStudentNow', 'weeklyHealthCheck',
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
  for (const fn of ['setupTriggers', 'scheduleTestRun', 'checkSetup', 'selfTest', 'selfTestKeepToken', 'healthCheckNow', 'pauseAutomaticUpdates', 'resumeAutomaticUpdates']) {
    assert.throws(() => t.ctx[fn](), /Only the script owner/, fn);
  }
});

test('trigger functions only run from a real trigger of this project', () => {
  const t = setup();
  t.svc.setActive(STAFF);
  for (const fn of ['scheduledRun', 'continueRun', 'weeklyHealthCheck']) {
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
  // Scenario (g): the same student again with a second token of their own (the same Canvas user).
  const realProfile = t.ctx.fetchCanvasProfile_;
  t.ctx.fetchCanvasProfile_ = (token) => (token === 'TOKEN-AAAA-SECOND' ? realProfile(TOKEN_A) : realProfile(token));
  assert.throws(() => t.ctx.addStudent('TOKEN-AAAA-SECOND', 'Desk 2'), /Avery Example is already on the list \(as "Table 4"\)\. To give them a new token, click Edit on their row\./);
  assert.strictEqual(Object.keys(t.svc.props).filter((k) => k.startsWith('student.')).length, 1);
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

test('scenario (f): a student being updated from the page when the run reaches them is tried again at the end of the run', () => {
  for (const releasedMeanwhile of [true, false]) {
    const t = setup();
    const a = addAs(t, STAFF, TOKEN_A, '').student;
    addAs(t, STAFF, TOKEN_B, '');
    t.svc.props['busy.' + a.id] = String(Date.now()); // Avery's Update button was just clicked
    const realWrite = t.ctx.upsertPlannerDocument_;
    t.ctx.upsertPlannerDocument_ = (p) => {
      if (releasedMeanwhile && p.studentFullName === 'Blake Sample') delete t.svc.props['busy.' + a.id]; // that update finished
      return realWrite(p);
    };
    t.ctx.startUpdateAll();
    const last = JSON.parse(t.svc.props['run.last']);
    if (releasedMeanwhile) {
      assert.deepStrictEqual([last.updated, last.total, last.failed], [2, 2, []]);
    } else {
      assert.deepStrictEqual([last.updated, last.total], [1, 2]);
      assert.deepStrictEqual(last.failed, [{ name: 'Avery Example', message: 'Was already being updated at the same time; see their row.' }]);
    }
  }
});

test('scenario (i): pausing the automatic updates for the summer, and turning them back on', () => {
  const t = setup();
  t.svc.setActive(OWNER);
  t.ctx.setupTriggers();
  const daily = t.svc.triggers.filter((x) => x.handler === 'scheduledRun');
  assert.strictEqual(daily.length, 2);
  const weekly = t.svc.triggers.filter((x) => x.handler === 'weeklyHealthCheck');
  assert.deepStrictEqual(weekly.map((x) => x.config), [{ weekDay: 'MONDAY', atHour: 7, nearMinute: 0, timeZone: 'America/New_York' }]);
  addAs(t, STAFF, TOKEN_A, '');
  t.svc.setActive(OWNER);
  t.ctx.pauseAutomaticUpdates();
  assert.ok(t.svc.props.PAUSED_SINCE);
  t.ctx.scheduledRun({ triggerUid: daily[0].uid });
  assert.strictEqual(t.docWrites.length, 0, 'no automatic update while paused');
  assert.match(t.sb.logs.join('\n'), /Automatic updates are paused \(since [A-Z][a-z]{2} \d{1,2}, \d{4}\), so this one was skipped\./);
  t.svc.setActive(STAFF);
  t.svc.props['run.last'] = JSON.stringify({ finishedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(), total: 1, updated: 1, failed: [] });
  const state = toPlain(t.ctx.getAppState());
  assert.ok(state.pausedSince);
  assert.strictEqual(state.updatesStaleSince, null, 'no "updates stopped" warning while paused');
  t.ctx.startUpdateAll(); // still works by hand
  assert.strictEqual(t.docWrites.length, 1);
  // Resume: the triggers were removed meanwhile, so they're put back.
  t.svc.setActive(OWNER);
  t.svc.triggers.length = 0;
  t.ctx.resumeAutomaticUpdates();
  assert.ok(!('PAUSED_SINCE' in t.svc.props));
  assert.strictEqual(t.svc.triggers.filter((x) => x.handler === 'scheduledRun').length, 2);
  assert.strictEqual(t.svc.triggers.filter((x) => x.handler === 'weeklyHealthCheck').length, 1);
  t.ctx.scheduledRun({ triggerUid: t.svc.triggers.find((x) => x.handler === 'scheduledRun').uid });
  assert.strictEqual(t.docWrites.length, 2);
});

test('a backup admin (editor access, not the owner) pauses by adding PAUSED_SINCE by hand, and resumes by deleting it', () => {
  const t = setup();
  t.svc.setActive(OWNER);
  t.ctx.setupTriggers();
  addAs(t, STAFF, TOKEN_A, '');
  const daily = t.svc.triggers.find((x) => x.handler === 'scheduledRun');
  t.svc.props.PAUSED_SINCE = '2027-06-12';
  t.ctx.scheduledRun({ triggerUid: daily.uid });
  assert.strictEqual(t.docWrites.length, 0);
  assert.match(t.sb.logs.join('\n'), /paused \(since Jun 12, 2027\), so this one was skipped/, 'a typed date means that day');
  t.svc.setActive(STAFF);
  assert.strictEqual(toPlain(t.ctx.getAppState()).pausedSince, '2027-06-12T12:00:00.000Z');
  t.svc.props.PAUSED_SINCE = 'yes';
  assert.ok(toPlain(t.ctx.getAppState()).pausedSince, 'anything else pauses too');
  assert.ok(!isNaN(new Date(t.svc.props.PAUSED_SINCE).getTime()), 'and is remembered as a real time');
  delete t.svc.props.PAUSED_SINCE;
  t.ctx.scheduledRun({ triggerUid: daily.uid });
  assert.strictEqual(t.docWrites.length, 1, 'deleted: back on');
});

test('weekly health check: an email only when something needs attention, to HEALTH_EMAILS or else the owner; never a token', () => {
  const t = setup();
  t.svc.setActive(OWNER);
  t.ctx.setupTriggers();
  const weekly = () => t.ctx.weeklyHealthCheck({ triggerUid: t.svc.triggers.find((x) => x.handler === 'weeklyHealthCheck').uid });
  weekly();
  t.ctx.healthCheckNow();
  assert.strictEqual(t.svc.mail.length, 0);
  assert.match(t.sb.logs.join('\n'), /Nothing needs attention, so no email was sent\./);
  const a = addAs(t, STAFF, TOKEN_A, '').student;
  const b = addAs(t, STAFF, TOKEN_B, '').student;
  const c = addAs(t, STAFF, TOKEN_C, '').student;
  // A student whose updates fail: once is not enough to email about; over a day is.
  t.badTokens.add(TOKEN_A);
  t.ctx.updateStudentNow(a.id);
  const rec = (id) => JSON.parse(t.svc.props['student.' + id]);
  assert.ok(rec(a.id).failingSince);
  t.svc.setActive(OWNER);
  t.ctx.healthCheckNow();
  assert.strictEqual(t.svc.mail.length, 0, 'failing for minutes only');
  const old = rec(a.id);
  old.failingSince = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  t.svc.props['student.' + a.id] = JSON.stringify(old);
  const soon = rec(b.id);
  soon.tokenExpiresAt = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  t.svc.props['student.' + b.id] = JSON.stringify(soon);
  weekly();
  assert.strictEqual(t.svc.mail.length, 1);
  const m = t.svc.mail[0];
  assert.strictEqual(m.to, OWNER, 'HEALTH_EMAILS not set: the owner');
  assert.strictEqual(m.subject, 'AutoPlanner: 2 things need attention');
  assert.match(m.body, /1\. 1 student's Doc hasn't updated for over a day:\n   - Avery Example: Canvas didn't accept this student's token/);
  assert.match(m.body, /2\. Canvas tokens running out in the next 3 weeks:\n   - Blake Sample: [A-Z][a-z]{2} \d{1,2}, \d{4}\n   What to do: Ask each student for a new token/);
  assert.match(m.body, /Open AutoPlanner: https:\/\/script\.google\.com\//);
  assert.ok(!m.body.includes('Casey'), 'nothing wrong with Casey');
  for (const tok of [TOKEN_A, TOKEN_B, TOKEN_C]) assert.ok(!m.body.includes(tok), 'no token in the email');
  // HEALTH_EMAILS: commas between; anything that isn't an email is left out.
  t.svc.props.HEALTH_EMAILS = ' club-one@pomfret.org, club-two@pomfret.org ,not an email';
  weekly();
  assert.strictEqual(t.svc.mail[1].to, 'club-one@pomfret.org,club-two@pomfret.org');
  // Fixed: no more email about it. A success clears the "failing since".
  t.badTokens.delete(TOKEN_A);
  t.svc.setActive(STAFF);
  t.ctx.updateStudentNow(a.id);
  assert.ok(!rec(a.id).failingSince);
  // A Doc near Google's 100-tab limit is reported too.
  const full = rec(c.id);
  full.docTabs = 86;
  t.svc.props['student.' + c.id] = JSON.stringify(full);
  t.svc.setActive(OWNER);
  weekly();
  assert.match(t.svc.mail[t.svc.mail.length - 1].body, /Docs getting close to Google's limit of 100 tabs:\n   - Casey Test: 86 tabs/);
  delete full.docTabs;
  t.svc.props['student.' + c.id] = JSON.stringify(full);
  // Triggers gone and saved data near Google's limit: both reported.
  t.svc.setActive(OWNER);
  t.svc.triggers.splice(0, t.svc.triggers.length, ...t.svc.triggers.filter((x) => x.handler === 'weeklyHealthCheck'));
  t.svc.props['probe.big'] = 'x'.repeat(380 * 1024);
  weekly();
  const last = t.svc.mail[t.svc.mail.length - 1];
  assert.match(last.body, /The 7 pm and midnight updates aren't set up\./);
  assert.match(last.body, /saved data is \d+ KB, close to Google's limit of 500 KB/);
  t.ctx.checkSetup();
  assert.match(t.sb.logs.join('\n'), /OK   Weekly health check: Mondays at about 7 AM, emailed only when something needs attention, to HEALTH_EMAILS: club-one@pomfret\.org, club-two@pomfret\.org/);
  // Paused: no email at all.
  t.ctx.pauseAutomaticUpdates();
  const before = t.svc.mail.length;
  weekly();
  assert.strictEqual(t.svc.mail.length, before);
});

test('scenario (k): Canvas down for a whole run: after 5 students in a row it stops asking, and the summary says who was not tried', () => {
  const t = setup();
  for (let i = 0; i < 9; i++) {
    t.svc.props['student.s' + i] = JSON.stringify({ id: 's' + i, name: 'Student ' + i, label: '', canvasUserId: 900 + i, last: { at: '2026-10-05T04:00:00Z', ok: true, message: 'Updated: 3 assignments in the next 4 weeks.' } });
    t.svc.props['token.s' + i] = 'TOKEN-S-' + i;
  }
  let asked = 0;
  t.ctx.fetchStudentSchedule_ = () => {
    asked++;
    const err = new Error('Canvas is busy or down right now (HTTP 503). AutoPlanner will try again at the next update.');
    err.canvasKind = 'unavailable';
    throw err;
  };
  t.svc.setActive(OWNER);
  t.ctx.startUpdateAll();
  const last = JSON.parse(t.svc.props['run.last']);
  assert.strictEqual(asked, 5);
  assert.deepStrictEqual(last.failed.map((f) => f.name), ['Student 0', 'Student 1', 'Student 2', 'Student 3', 'Student 4', '4 more students']);
  assert.match(last.failed[5].message, /^Not tried: Canvas wasn't answering for 5 students in a row\. The next update tries again\.$/);
  assert.strictEqual(JSON.parse(t.svc.props['student.s8']).last.ok, true, 'their row still shows their last good update');
  // A token problem isn't Canvas being down: those don't stop the run.
  const u = setup();
  for (let i = 0; i < 7; i++) {
    u.svc.props['student.s' + i] = JSON.stringify({ id: 's' + i, name: 'Student ' + i, label: '', canvasUserId: 900 + i });
    u.svc.props['token.s' + i] = 'TOKEN-BAD-' + i;
  }
  u.svc.setActive(OWNER);
  u.ctx.startUpdateAll();
  assert.strictEqual(JSON.parse(u.svc.props['run.last']).failed.length, 7);
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

test('token dates: "Token expires …" on the row, a warning 21 days ahead, and the date in the expired message', () => {
  const t = setup();
  const soon = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString(); // inside the 3 weeks
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
  assert.match(last.failed[0].message, /^Was stopped partway by Apps Script's time limit\. It will be tried again at the next update\.$/);
});

test('simulation bug 4: batches cut off long before the measured limit mean it dropped: plan for 6 minutes, and say so in the weekly email', () => {
  for (const survivedMin of [5, 22]) {
    const t = setup({ RUNTIME_LIMIT_SECONDS: '1800' });
    t.svc.setActive(OWNER);
    t.ctx.setupTriggers();
    addAs(t, STAFF, TOKEN_A, '');
    const now = Date.now();
    t.svc.props['run.current'] = JSON.stringify({ id: 'r1', reason: 'scheduled', startedBy: 'automatic', startedAt: now - 40 * 60000, queue: [], total: 2, updated: 1,
      failed: [], inProgress: 'gone', batchStartedAt: now - 40 * 60000, heartbeatAt: now - (40 - survivedMin) * 60000 });
    t.ctx.replaceContinueTrigger_(1000);
    t.ctx.continueRun({ triggerUid: t.svc.triggers.find((x) => x.handler === 'continueRun').uid });
    if (survivedMin === 5) {
      assert.strictEqual(t.svc.props.RUNTIME_LIMIT_SECONDS, '360');
      t.svc.setActive(OWNER);
      t.ctx.healthCheckNow();
      assert.match(t.svc.mail[0].body, /Apps Script stopped an update after about 5 minutes, sooner than the 30 minutes it allowed before, so AutoPlanner now plans for 6\./);
      // Measured again: the note goes.
      t.svc.props['probe.timeLimit'] = JSON.stringify({ startedAt: now - 1900000, lastAt: now - 120000, seconds: 1785 });
      t.ctx.checkSetup();
      assert.ok(!('limit.dropped' in t.svc.props));
      assert.strictEqual(t.svc.props.RUNTIME_LIMIT_SECONDS, '1800');
    } else {
      assert.strictEqual(t.svc.props.RUNTIME_LIMIT_SECONDS, '1800', 'cut off late in a batch: the limit is still right');
      assert.ok(!('limit.dropped' in t.svc.props));
    }
  }
});

test('batches use the real time limit: the safety trigger fires after it, and a student who would not fit waits for the next batch', () => {
  const t = setup({ RUNTIME_LIMIT_SECONDS: '1800' });
  addAs(t, STAFF, TOKEN_A, '');
  addAs(t, STAFF, TOKEN_B, '');
  // Pretend 23 minutes of a 30-minute limit are gone after the first student, and the next one
  // usually takes 6 minutes: they shouldn't start in this batch even inside the 2-minute budget.
  t.ctx.APP_BATCH_BUDGET_MS = 60 * 60 * 1000;
  const second = JSON.parse(t.svc.props[Object.keys(t.svc.props).filter((k) => k.indexOf('student.') === 0).sort()[1]]);
  second.lastSeconds = 360;
  t.svc.props['student.' + second.id] = JSON.stringify(second);
  let calls = 0;
  const realLeft = t.ctx.msLeftInExecution_;
  t.ctx.msLeftInExecution_ = () => (++calls > 0 ? 7 * 60 * 1000 : realLeft());
  const res = toPlain(t.ctx.startUpdateAll());
  assert.strictEqual(res.run.done, 1, 'stopped after the first student');
  const triggers = t.svc.triggers.filter((x) => x.handler === 'continueRun');
  assert.deepStrictEqual(triggers.map((x) => x.config.after), [60 * 1000], 'the next batch, a minute later');
  // With 30 minutes left they'd fit; the safety trigger is set to the limit plus 2 minutes.
  t.ctx.msLeftInExecution_ = () => 30 * 60 * 1000;
  t.ctx.continueRun({ triggerUid: triggers[0].uid });
  assert.strictEqual(JSON.parse(t.svc.props['run.last']).updated, 2);
  const u = setup({ RUNTIME_LIMIT_SECONDS: '1800' });
  addAs(u, STAFF, TOKEN_A, '');
  u.ctx.updateOneStudent_ = () => { throw new Error('Exceeded maximum execution time'); };
  assert.throws(() => u.ctx.startUpdateAll());
  assert.strictEqual(u.svc.triggers.find((x) => x.handler === 'continueRun').config.after, 32 * 60 * 1000);
});

test('automatic batches use 60% of the measured limit (up to 18 minutes); page-started batches stay at 2 minutes', () => {
  const t = setup();
  assert.strictEqual(t.ctx.triggerBatchBudgetMs_(), 2 * 60 * 1000, 'default 6-minute limit: 2 minutes');
  t.svc.props.RUNTIME_LIMIT_SECONDS = '1800';
  assert.strictEqual(t.ctx.triggerBatchBudgetMs_(), 18 * 60 * 1000);
  t.svc.props.RUNTIME_LIMIT_SECONDS = '600';
  assert.strictEqual(t.ctx.triggerBatchBudgetMs_(), 6 * 60 * 1000);
  t.svc.props.RUNTIME_LIMIT_SECONDS = '1800';
  const budgets = [];
  const real = t.ctx.processRunBatch_;
  t.ctx.processRunBatch_ = (id, budget) => { budgets.push(budget); return real(id, budget); };
  addAs(t, STAFF, TOKEN_A, '');
  t.ctx.startUpdateAll();
  t.svc.setActive(OWNER);
  t.ctx.scheduleTestRun();
  const oneOff = t.svc.triggers.find((x) => x.handler === 'scheduledRun' && x.config.at);
  t.ctx.scheduledRun({ triggerUid: oneOff.uid });
  assert.deepStrictEqual(budgets, [2 * 60 * 1000, 18 * 60 * 1000]);
});

test('measureTimeLimit: once Apps Script has stopped it, checkSetup saves the limit (rounded down to a minute)', () => {
  const t = setup();
  t.svc.setActive(OWNER);
  t.svc.props['probe.timeLimit'] = JSON.stringify({ startedAt: Date.now() - 400000, lastAt: Date.now() - 90000, seconds: 345 });
  t.ctx.checkSetup();
  assert.strictEqual(t.svc.props.RUNTIME_LIMIT_SECONDS, '300');
  assert.ok(!t.svc.props['probe.timeLimit']);
  assert.match(t.sb.logs.join('\n'), /Apps Script time limit: 300 s per run \(measured\)/);
  t.svc.props['probe.timeLimit'] = JSON.stringify({ startedAt: Date.now() - 1900000, lastAt: Date.now() - 90000, seconds: 1785 });
  t.ctx.checkSetup();
  assert.strictEqual(t.svc.props.RUNTIME_LIMIT_SECONDS, '1800');
  // Still running: nothing saved yet.
  t.svc.props['probe.timeLimit'] = JSON.stringify({ startedAt: Date.now() - 100000, lastAt: Date.now() - 5000, seconds: 95 });
  t.ctx.checkSetup();
  assert.strictEqual(t.svc.props.RUNTIME_LIMIT_SECONDS, '1800');
  assert.match(t.sb.logs.join('\n'), /measureTimeLimit is still running/);
});

test('a student whose update stopped between weeks (time running out) is told so on their row, and their time is kept', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.upsertPlannerDocument_ = (payload) => ({ docUrl: 'u', documentId: payload.documentId || 'DOC-A', weeksDone: 2, weeksTotal: 4 });
  const r = toPlain(t.ctx.updateStudentNow(student.id));
  assert.strictEqual(r.last.ok, true);
  assert.strictEqual(r.last.message, 'Updated 2 of 4 weeks: Google Docs was slow, so the other weeks will be updated at the next update (their Status and Notes are kept).');
  assert.ok(Number.isInteger(JSON.parse(t.svc.props['student.' + student.id]).lastSeconds));
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
  assert.match(t.sb.logs.join('\n'), /PASS Doc: create or update yours in the shared folder: your student row's Doc: https:\/\/docs\.google\.com\/document\/d\/MY-DOC\/edit/);
  assert.match(t.sb.logs[0], /^NOTE selfTest edits your planner Doc for about 6 minutes\. Don't open or edit that Doc until it finishes/);
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
  assert.match(log, /(PASS|FAIL) Doc reads are slim/, 'a check after the failures still ran');
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
  assert.match(t.sb.logs.join('\n'), /FAIL Your row is held for selfTest[^\n]*: Your row is being updated right now \(held since [0-9:]+ [AP]M\)\. Run selfTest again in a few minutes\. A hold lapses on its own 7 minutes after it was set, even if the update that set it stopped midway\./);
  assert.strictEqual(wrote, false);
  void u;
});

// The real Doc writer and selfTest on the fake Docs API (the other App tests replace the writer).
function liveSetup() {
  const svc = fakeServices({ owner: OWNER, active: STAFF, props: { ALLOWED_USERS: `${OWNER}, ${STAFF}`, DOCS_FOLDER_ID: 'FOLDER123', TEST_CANVAS_TOKEN: TOKEN_A } });
  const sb = createSandbox({ files: ['apps_script/Code.gs', 'apps_script/Canvas.gs', 'apps_script/App.gs'], globals: svc.globals });
  const ctx = sb.context;
  const docs = fakeDocs([{ tabProperties: { tabId: 't.0', title: 'CLC Planner' },
    documentTab: { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } }, childTabs: [] }]);
  ctx.Docs = docs.service;
  ctx.DocumentApp = { openById: (id) => ({ setName: () => {}, getUrl: () => 'https://docs/' + id }), create: () => { throw new Error('no new Docs here'); } };
  ctx.sleepDocsChunkGap_ = () => {};
  withRendering({ ctx }, docs);
  const u = (n) => 'https://pomfret.instructure.com/courses/1/assignments/' + n;
  const item = (n, name, week) => ({ day: 'Monday', assignment: name, course: 'Biology', due_time: '8:30 AM', priority: 'Upcoming', days_until_due: 9, due_date: week, week_start: week, url: u(n) });
  ctx.fetchCanvasProfile_ = () => CANVAS[TOKEN_A];
  ctx.fetchCanvasTokenExpiry_ = () => null;
  ctx.fetchStudentSchedule_ = () => ({
    student_full_name: 'Avery Example', canvas_user_id: 101, total_assignments: 3, generated_at: 'x', courses: ['Biology'],
    weeks: {
      '2099-01-05': { week_label: 'Jan 5 – Jan 11', days: [{ day: 'Monday', assignments: [item(1, 'X', '2099-01-05'), item(2, 'Y', '2099-01-05')] }] },
      '2099-01-12': { week_label: 'Jan 12 – Jan 18', days: [{ day: 'Monday', assignments: [item(3, 'Z', '2099-01-12')] }] },
    },
  });
  // selfTest edits cells by position; the fake has no positions, so edits go by tab, link and table.
  ctx.writeStatusAndNote_ = (docId, target, status, note) => {
    const tab = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.tabId === target.tabId);
    staffTypes(docs, tab.tabProperties.title, target.url, target.kind === 'By Day' ? 'day' : 'class', status, note);
  };
  ctx.writeStaffRow_ = (docId, tabId, r, texts) => {
    const tab = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.tabId === tabId);
    staffWrites(docs, tab.tabProperties.title, r, texts);
  };
  svc.setActive(STAFF);
  const student = toPlain(ctx.addStudent(TOKEN_A, 'Demo')).student;
  const rec = JSON.parse(svc.props['student.' + student.id]);
  rec.docId = 'DOC1';
  svc.props['student.' + student.id] = JSON.stringify(rec);
  svc.addFile('DOC1', 'Avery Example - CLC Assignments', 'FOLDER123');
  ctx.updateStudentNow(student.id); // the Doc as the real writer makes it
  svc.setActive(OWNER);
  return { svc, sb, ctx, docs, X: u(1), student };
}

test('selfTestEveryday (real code, fake Docs API): the By Class edit survives a plain update, then everything is put back', () => {
  const { sb, ctx, docs, X, svc, student } = liveSetup();
  ctx.selfTestEveryday();
  const log = sb.logs.join('\n');
  assert.match(sb.logs[0], /^NOTE selfTestEveryday edits your planner Doc for about 4 minutes/);
  assert.match(log, /PASS A staff edit in By Class survives a plain update: "Complete" and a note on "X", kept in By Class and By Day/);
  assert.match(log, /PASS Clean-up/);
  assert.match(log, /selfTestEveryday finished in \d+ s \(TEST_CANVAS_TOKEN kept\)/);
  assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Not started', ''], ['Not started', '']]);
  assert.ok(!svc.props['busy.' + student.id], 'hold released');
  assert.ok(svc.props.TEST_CANVAS_TOKEN, 'token kept');
});

test('selfTest (real code, fake Docs API): two runs in a row pass the type, move, come-back and clean-up checks', () => {
  const { sb, ctx, docs, X } = liveSetup();
  for (const run of [1, 2]) {
    sb.logs.length = 0;
    ctx.selfTestKeepToken();
    const log = sb.logs.join('\n');
    for (const name of ['Your row is held for selfTest', 'Doc: create or update yours in the shared folder', 'Doc: type a test Status and Note',
      'Doc: type a row into "Added by staff" in that week', 'Status and Note followed the assignment to its new week',
      'An assignment removed from Canvas keeps its Status and Note in its week, marked "Not on Canvas"', 'Doc: run a normal update',
      'Existing week tabs were rebuilt in place', 'Status and Note came back with it, in exactly one week tab',
      'The "Added by staff" row came through both updates exactly', 'Clean-up']) {
      assert.match(log, new RegExp('PASS ' + name.replace(/[()]/g, '\\$&')), 'run ' + run + ': ' + name + '\n' + log);
    }
    assert.ok(log.indexOf('PASS Doc: run a normal update') < log.indexOf('Every class has its own By Class table'), 'layout checks come after the update');
    assert.deepStrictEqual(copiesOf(docs, X).map((c) => [c.status, c.note]), [['Not started', ''], ['Not started', '']], 'run ' + run + ' cleaned up');
    const staffTab = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === 'Week of Jan 5 – Jan 11, 2099');
    assert.deepStrictEqual(toPlain(ctx.readStaffRows_(staffTab)).map((r) => r.map((c) => c.text).join('')), ['', ''], 'staff test row cleared');
  }
});

test('selfTest on a Doc written by an older AutoPlanner (no "Added by staff" yet): it updates the Doc first, then the staff checks pass', () => {
  const { sb, ctx, docs } = liveSetup();
  // As before Phase 2: each week tab ends after By Day.
  const isHeading = (el) => el.paragraph && (el.paragraph.elements[0] || {}).textRun && el.paragraph.elements[0].textRun.content === 'Added by staff\n';
  docs.service.Documents.get().tabs[0].childTabs.forEach((copy) => {
    const tab = docs.find(copy.tabProperties.tabId);
    const body = tab.documentTab.body;
    body.content = body.content.slice(0, body.content.findIndex(isHeading) - 1);
    assert.strictEqual(ctx.readStaffRows_(tab), null, 'no staff table');
  });
  const staffChecks = (log) => {
    for (const name of ['Doc: type a test Status and Note', 'Doc: type a row into "Added by staff" in that week',
      'Status and Note followed the assignment to its new week', 'Status and Note came back with it, in exactly one week tab',
      'The "Added by staff" row came through both updates exactly', 'Clean-up']) {
      assert.match(log, new RegExp('PASS ' + name), name + '\n' + log);
    }
  };
  ctx.selfTestKeepToken();
  let log = sb.logs.join('\n');
  assert.match(log, /PASS Doc: create or update yours in the shared folder: your student row's Doc: \S+ \(2 week tabs had no "Added by staff" table yet, so it was updated first, in \d+ s\)/);
  staffChecks(log);
  // The next run finds the new layout and skips the extra update.
  sb.logs.length = 0;
  ctx.selfTestKeepToken();
  log = sb.logs.join('\n');
  assert.doesNotMatch(log, /updated first/);
  staffChecks(log);
});

test('selfTest teacher-folder check (real code): assign, switch, drag-in, folder lock, Unassigned, then your row exactly as before', () => {
  const { sb, ctx, svc, student } = liveSetup();
  svc.props.CLC_TEACHERS = TEACHERS;
  ctx.teacherFolderCache_ = null;
  ctx.selfTestKeepToken();
  const log = sb.logs.join('\n');
  assert.match(log, /PASS CLC teacher folders: assign, switch, a Drive drag-in, the folder lock, Unassigned: your Doc went to Pat Example, then Sam Sample, was adopted after a drag, then back to the shared folder; your row is Unassigned again/);
  assert.strictEqual(svc.files.DOC1.parent, 'FOLDER123');
  assert.strictEqual(JSON.parse(svc.props['student.' + student.id]).teacher, '');
});

test('Drive says "Invalid argument" about a Doc: no new Doc the first time; a new one only when an update 4+ hours later agrees', () => {
  const t = setup();
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.updateStudentNow(student.id);
  const oldId = JSON.parse(t.svc.props['student.' + student.id]).docId;
  t.ctx.DriveApp.getFileById = (id) => { if (id === oldId) throw new Error('Exception: Invalid argument: id'); throw new Error('No item with the given ID could be found'); };
  const writes = [];
  t.ctx.upsertPlannerDocument_ = (payload) => {
    if (payload.documentId) t.ctx.savedDocFile_(payload.documentId);
    writes.push(payload.documentId || 'new');
    return { docUrl: 'u', documentId: payload.documentId || 'FRESH-DOC' };
  };
  const first = toPlain(t.ctx.updateStudentNow(student.id));
  assert.deepStrictEqual(writes, [], 'no new Doc yet');
  assert.match(first.last.message, /^Google Drive couldn't find this student's Doc just now\. If it is still missing at an update 4 or more hours from now, AutoPlanner will make a new one\.$/);
  // An hour later: still waiting.
  const rec = JSON.parse(t.svc.props['student.' + student.id]);
  rec.docUnsureSince = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
  t.svc.props['student.' + student.id] = JSON.stringify(rec);
  t.ctx.updateStudentNow(student.id);
  assert.deepStrictEqual(writes, []);
  // Five hours after the first miss (the next scheduled update): it's gone, so a new Doc.
  const rec2 = JSON.parse(t.svc.props['student.' + student.id]);
  rec2.docUnsureSince = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  t.svc.props['student.' + student.id] = JSON.stringify(rec2);
  const after = toPlain(t.ctx.updateStudentNow(student.id));
  assert.deepStrictEqual(writes, ['new']);
  assert.match(after.docUrl, /FRESH-DOC/);
  assert.strictEqual(after.notice.message, 'Their Doc was deleted, so AutoPlanner made a new one.');
  assert.ok(!JSON.parse(t.svc.props['student.' + student.id]).docUnsureSince, 'cleared once it worked');
});

// ---- CLC teachers -------------------------------------------------------------------------------

const TEACHERS = 'Pat Example <pexample@pomfret.org>, Sam Sample <SSample@pomfret.org>';
const folderNamed = (svc, name) => Object.values(svc.folders).filter((f) => f.name === name);

test('CLC teacher folders: one per teacher inside the shared folder, made once, made again if trashed or deleted', () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  t.svc.setActive(STAFF);
  assert.deepStrictEqual(toPlain(t.ctx.getAppState()).teachers, [{ name: 'Pat Example', email: 'pexample@pomfret.org' }, { name: 'Sam Sample', email: 'ssample@pomfret.org' }]);
  assert.deepStrictEqual(folderNamed(t.svc, 'Pat Example').map((f) => f.parent), ['FOLDER123']);
  assert.deepStrictEqual(folderNamed(t.svc, 'Sam Sample').map((f) => f.parent), ['FOLDER123']);
  const stored = JSON.parse(t.svc.props.teacherFolders);
  // Later calls (new executions) reuse the stored folders.
  t.ctx.teacherFolderCache_ = null;
  t.ctx.getAppState();
  assert.strictEqual(folderNamed(t.svc, 'Pat Example').length, 1);
  // Trashed: a new one is made, the trashed one is left alone.
  t.svc.folders[stored['pexample@pomfret.org']].trashed = true;
  t.ctx.teacherFolderCache_ = null;
  t.ctx.getAppState();
  assert.strictEqual(folderNamed(t.svc, 'Pat Example').length, 2);
  assert.notStrictEqual(JSON.parse(t.svc.props.teacherFolders)['pexample@pomfret.org'], stored['pexample@pomfret.org']);
  // Deleted for good: made again.
  delete t.svc.folders[JSON.parse(t.svc.props.teacherFolders)['ssample@pomfret.org']];
  t.ctx.teacherFolderCache_ = null;
  t.ctx.getAppState();
  assert.ok(t.svc.folders[JSON.parse(t.svc.props.teacherFolders)['ssample@pomfret.org']]);
  // A folder with the teacher's name already there (made by hand) is used, not duplicated.
  const u = setup({ CLC_TEACHERS: 'Pat Example <pexample@pomfret.org>' });
  const own = u.svc.globals.DriveApp.getFolderById('FOLDER123').createFolder('Pat Example');
  u.svc.setActive(STAFF);
  u.ctx.getAppState();
  assert.strictEqual(JSON.parse(u.svc.props.teacherFolders)['pexample@pomfret.org'], own.getId());
  assert.strictEqual(folderNamed(u.svc, 'Pat Example').length, 1);
});

test('changing a student\'s CLC teacher moves the same Doc (same ID) into that folder, and back for Unassigned', () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  t.svc.addFile('DOC-A', 'Avery Example - CLC Assignments', 'FOLDER123');
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  const pat = JSON.parse(t.svc.props.teacherFolders)['pexample@pomfret.org'];
  const res = toPlain(t.ctx.setStudentTeacher(student.id, 'PExample@pomfret.org'));
  assert.strictEqual(t.svc.files['DOC-A'].parent, pat);
  assert.strictEqual(res.student.teacher, 'pexample@pomfret.org');
  assert.match(res.student.docUrl, /DOC-A/, 'same Doc');
  assert.strictEqual(res.message, "Moved Avery Example's Doc into Pat Example's folder. Same Doc and link, with all its notes.");
  const back = toPlain(t.ctx.setStudentTeacher(student.id, ''));
  assert.strictEqual(t.svc.files['DOC-A'].parent, 'FOLDER123');
  assert.strictEqual(back.student.teacher, '');
  assert.match(back.message, /^Moved Avery Example's Doc back to the shared folder \(no CLC teacher\)/);
  assert.throws(() => t.ctx.setStudentTeacher(student.id, 'nobody@pomfret.org'), /no longer on the list/);
  t.svc.setActive(STRANGER);
  assert.throws(() => t.ctx.setStudentTeacher(student.id, ''), /Not authorized/);
});

test("scenario (f): the CLC teacher changed while a new student's first Doc is being made: the Doc ends up in the new teacher's folder, and stays theirs", () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  const { student } = toPlain((t.svc.setActive(STAFF), t.ctx.addStudent(TOKEN_A, '', 'pexample@pomfret.org')));
  const folders = () => JSON.parse(t.svc.props.teacherFolders);
  t.ctx.upsertPlannerDocument_ = (p) => {
    // Staff pick Sam Sample on the row while the Doc is being made (in Pat Example's folder).
    t.ctx.setStudentTeacher(student.id, 'ssample@pomfret.org');
    t.svc.addFile('DOC-NEW', 'Avery Example - CLC Assignments', p.targetFolderId);
    return { docUrl: 'https://docs/x', documentId: 'DOC-NEW' };
  };
  t.ctx.updateStudentNow(student.id);
  assert.strictEqual(t.svc.files['DOC-NEW'].parent, folders()['ssample@pomfret.org']);
  t.ctx.getAppState(); // a page load reads the folders back: still Sam Sample's
  assert.strictEqual(JSON.parse(t.svc.props['student.' + student.id]).teacher, 'ssample@pomfret.org');
});

test("scenario (j): a teacher's folder trashed, or moved out of the shared folder: a new folder is made and their students' Docs move into it (same Docs, nothing lost)", () => {
  for (const what of ['trashed', 'moved out']) {
    const t = setup({ CLC_TEACHERS: TEACHERS });
    t.svc.addFile('DOC-A', 'Avery Example - CLC Assignments', 'FOLDER123');
    const { student } = addAs(t, STAFF, TOKEN_A, '');
    t.ctx.setStudentTeacher(student.id, 'pexample@pomfret.org');
    const oldId = JSON.parse(t.svc.props.teacherFolders)['pexample@pomfret.org'];
    assert.strictEqual(t.svc.files['DOC-A'].parent, oldId);
    if (what === 'trashed') t.svc.folders[oldId].trashed = true;
    else t.svc.folders[oldId].parent = 'ROOT';
    t.ctx.teacherFolderCache_ = null;
    t.ctx.updateStudentNow(student.id);
    const newId = JSON.parse(t.svc.props.teacherFolders)['pexample@pomfret.org'];
    assert.notStrictEqual(newId, oldId, what);
    assert.strictEqual(t.svc.folders[newId].parent, 'FOLDER123');
    assert.strictEqual(t.svc.files['DOC-A'].parent, newId, what + ': the Doc moved into the new folder');
    assert.ok(!t.svc.globals.DriveApp.getFileById('DOC-A').isTrashed(), what + ': and is out of the trash');
    const row = JSON.parse(t.svc.props['student.' + student.id]);
    assert.deepStrictEqual([row.docId, row.teacher, row.last.ok, row.notice], ['DOC-A', 'pexample@pomfret.org', true, undefined], what + ': same Doc, no "made a new one"');
  }
});

test('Add a student with a CLC teacher: an existing Doc moves there; a new Doc is made there and the home tab names the teacher', () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  t.svc.addFile('DOC-A', 'Avery Example - CLC Assignments', 'FOLDER123');
  t.svc.setActive(STAFF);
  const a = toPlain(t.ctx.addStudent(TOKEN_A, '', 'ssample@pomfret.org')).student;
  const sam = JSON.parse(t.svc.props.teacherFolders)['ssample@pomfret.org'];
  assert.strictEqual(t.svc.files['DOC-A'].parent, sam);
  assert.strictEqual(a.teacher, 'ssample@pomfret.org');
  const b = toPlain(t.ctx.addStudent(TOKEN_B, '', 'pexample@pomfret.org')).student;
  t.ctx.updateStudentNow(b.id);
  const pay = t.docWrites[t.docWrites.length - 1];
  assert.strictEqual(pay.targetFolderId, JSON.parse(t.svc.props.teacherFolders)['pexample@pomfret.org'], 'a new Doc goes into the teacher folder');
  assert.strictEqual(pay.teacherName, 'Pat Example');
  // With no teacher chosen, a re-added student keeps the teacher whose folder their Doc is in.
  t.ctx.removeStudent(a.id);
  const again = toPlain(t.ctx.addStudent(TOKEN_A, '', '')).student;
  assert.strictEqual(again.teacher, 'ssample@pomfret.org');
  assert.match(again.docUrl, /DOC-A/, 'found in the teacher folder (not a new Doc)');
});

test('a Doc dragged into another teacher\'s folder in Drive brings that teacher (page load or next update); dragged to the top = Unassigned', () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  t.svc.addFile('DOC-A', 'Avery Example - CLC Assignments', 'FOLDER123');
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  const ids = JSON.parse(t.svc.props.teacherFolders);
  t.svc.files['DOC-A'].parent = ids['ssample@pomfret.org']; // staff drag it in Drive
  const page = toPlain(t.ctx.getAppState()).students[0];
  assert.strictEqual(page.teacher, 'ssample@pomfret.org');
  t.svc.files['DOC-A'].parent = ids['pexample@pomfret.org'];
  t.ctx.updateStudentNow(student.id);
  assert.strictEqual(JSON.parse(t.svc.props['student.' + student.id]).teacher, 'pexample@pomfret.org');
  assert.strictEqual(t.docWrites[t.docWrites.length - 1].teacherName, 'Pat Example', 'the home tab line follows');
  t.svc.files['DOC-A'].parent = 'FOLDER123';
  assert.strictEqual(toPlain(t.ctx.getAppState()).students[0].teacher, '');
});

test('removing a teacher from CLC_TEACHERS: their students become Unassigned, Docs move to the top; nothing is deleted', () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  t.svc.addFile('DOC-A', 'Avery Example - CLC Assignments', 'FOLDER123');
  const { student } = addAs(t, STAFF, TOKEN_A, '');
  t.ctx.setStudentTeacher(student.id, 'ssample@pomfret.org');
  const samFolder = JSON.parse(t.svc.props.teacherFolders)['ssample@pomfret.org'];
  t.svc.props.CLC_TEACHERS = 'Pat Example <pexample@pomfret.org>';
  t.ctx.teacherFolderCache_ = null;
  const page = toPlain(t.ctx.getAppState());
  assert.deepStrictEqual(page.teachers.map((x) => x.name), ['Pat Example']);
  assert.strictEqual(page.students[0].teacher, '');
  assert.strictEqual(t.svc.files['DOC-A'].parent, 'FOLDER123');
  assert.ok(t.svc.folders[samFolder] && !t.svc.folders[samFolder].trashed, 'the old folder is left as it was');
  assert.ok(t.svc.files['DOC-A'], 'the Doc is kept');
});

test('folder lock with teacher folders: Docs anywhere inside the shared folder are updated, never outside it; finding a Doc searches teacher folders', () => {
  const t = setup({ CLC_TEACHERS: TEACHERS });
  t.svc.setActive(STAFF);
  t.ctx.getAppState();
  const pat = JSON.parse(t.svc.props.teacherFolders)['pexample@pomfret.org'];
  t.svc.addFile('IN-TEACHER', 'Blake Sample - CLC Assignments', pat);
  t.svc.addFile('OUTSIDE', 'Blake Sample - CLC Assignments', 'SOMEWHERE-ELSE');
  const folder = t.ctx.getDocsFolder_();
  t.ctx.assertDocIsInFolder_('IN-TEACHER', folder);
  assert.throws(() => t.ctx.assertDocIsInFolder_('OUTSIDE', folder), /only updates Docs in the "AutoPlanner – CLC Student Planners" folder \(or a CLC teacher's folder inside it\)/);
  assert.strictEqual(t.ctx.findReusableDoc_('Blake Sample', null), 'IN-TEACHER');
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
