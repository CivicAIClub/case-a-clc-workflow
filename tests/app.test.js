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
  ctx.fetchStudentSchedule_ = (token) => {
    if (badTokens.has(token) || !CANVAS[token]) throw authError();
    return {
      weeks: {}, total_assignments: 3, generated_at: '2026-10-04T19:00:00',
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
  assert.match(page.value, /Cayden Auyang or Luke Ryan/);
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
  t.ctx.APP_BATCH_BUDGET_MS = 3.5 * 60 * 1000;
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
  t.ctx.APP_BATCH_BUDGET_MS = 3.5 * 60 * 1000;
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
    { atHour: 0, nearMinute: 0, everyDays: 1, timeZone: 'America/New_York' },
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
  const t = setup({ TEST_CANVAS_TOKEN: TOKEN_A });
  t.svc.setActive(OWNER);
  t.ctx.checkSetup();
  // Skip the Doc steps: pretend the Doc has no assignment rows.
  t.ctx.writeDocWithRecovery_ = () => 'DOC-SELF';
  t.ctx.assertDocIsInFolder_ = () => {};
  t.ctx.findFirstAssignmentRow_ = () => null;
  t.ctx.selfTestKeepToken();
  assert.strictEqual(t.svc.props.TEST_CANVAS_TOKEN, TOKEN_A);
  t.ctx.selfTest();
  assert.strictEqual(t.svc.props.TEST_CANVAS_TOKEN, undefined);
  const logText = t.sb.logs.join('\n');
  assert.ok(!logText.includes(TOKEN_A), 'token never logged');
  assert.match(logText, /PASS Canvas: fetch your assignments: Avery Example, 3 assignments/);
  assert.match(logText, /FAIL Doc: type a test Status and Note.*No assignments/);
  assert.match(logText, /selfTest: FAILED/);
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
