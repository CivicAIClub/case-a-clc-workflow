'use strict';
// Tests for apps_script/Canvas.gs, using a fake Canvas server (all data is made up).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, toPlain } = require('./helpers/gas-sandbox');

const TOKEN = 'SECRET-TOKEN-1234';
const BASE = 'https://pomfret.instructure.com';
const NOW = new Date('2026-10-28T14:00:00Z'); // Wed Oct 28, 10:00 AM New York

const PROFILE_URL = `${BASE}/api/v1/users/self/profile`;
const COURSES_URL = `${BASE}/api/v1/courses?enrollment_type=student&enrollment_state=active&state%5B%5D=available&per_page=100`;
const COURSES_P2 = `${BASE}/api/v1/courses?enrollment_type=student&enrollment_state=active&page=2&per_page=100&state%5B%5D=available`;
const assignmentsUrl = (id) => `${BASE}/api/v1/courses/${id}/assignments?order_by=due_at&per_page=100`;
const assignmentsPage = (id, n) => `${BASE}/api/v1/courses/${id}/assignments?order_by=due_at&page=${n}&per_page=100`;

const MSG_401 = "Canvas didn't accept this student's token. It may have expired or been deleted. Ask the student for a new token.";

function ok(body, headers) {
  return { code: 200, body, headers: headers || {} };
}

function course(id, name, workflowState) {
  return { id, name, workflow_state: workflowState || 'available' };
}

function assignment(id, courseId, dueAt) {
  return {
    id,
    name: `Assignment ${id}`,
    due_at: dueAt === undefined ? '2026-10-29T16:00:00Z' : dueAt,
    html_url: `${BASE}/courses/${courseId}/assignments/${id}`,
  };
}

// Answers each call in turn with the next response (the last one repeats).
function sequence(...responses) {
  let n = 0;
  return () => responses[Math.min(n++, responses.length - 1)];
}

// A fake Canvas: `routes` maps exact URLs to a response or a function returning one.
function fakeCanvas(routes) {
  return (url, params) => {
    const route = routes[url];
    if (route === undefined) {
      return { code: 404, body: { errors: [{ message: `No test route for ${url}` }] } };
    }
    return typeof route === 'function' ? route(url, params) : route;
  };
}

function setup(routes) {
  return createSandbox({
    files: ['apps_script/Canvas.gs'],
    fetchHandler: fakeCanvas(routes),
  });
}

// Run fn and return the error it throws (fails the test if it doesn't throw).
function errorFrom(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected an error to be thrown');
}

function assertNoToken(err) {
  assert.ok(!String(err.message).includes(TOKEN), 'token leaked into error message');
  assert.ok(!String(err.stack).includes(TOKEN), 'token leaked into error stack');
}

// A student with 4 open classes over 2 pages (plus one finished class), where English 10's
// assignments span 3 pages and Biology's span 2. Header names use mixed casing on purpose.
function paginatedRoutes(profile) {
  return {
    [PROFILE_URL]: ok(profile),
    [COURSES_URL]: ok(
      [course(1, 'English 10'), course(2, 'Biology'), course(9, 'Old Elective', 'completed')],
      { Link: `<${COURSES_URL}&page=1>; rel="current",<${COURSES_P2}>; rel="next",<${COURSES_URL}&page=1>; rel="first",<${COURSES_P2}>; rel="last"` },
    ),
    [COURSES_P2]: ok(
      [course(3, 'Algebra II'), course(4, null)],
      { link: `<${COURSES_P2}>; rel="current",<${COURSES_URL}&page=1>; rel="first",<${COURSES_P2}>; rel="last"` },
    ),
    [assignmentsUrl(1)]: ok(
      [assignment(101, 1), assignment(102, 1, null)],
      { LINK: `<${assignmentsPage(1, 2)}>; rel="next",<${assignmentsUrl(1)}>; rel="first"` },
    ),
    [assignmentsPage(1, 2)]: ok(
      [assignment(103, 1, '2026-10-30T16:00:00Z')],
      { Link: [`<${assignmentsPage(1, 2)}>; rel="current"`, `<${assignmentsPage(1, 3)}>; rel="next"`] },
    ),
    [assignmentsPage(1, 3)]: ok(
      [assignment(104, 1, '2026-10-31T16:00:00Z')],
      { 'Link': `<${assignmentsPage(1, 3)}>; rel="current",<${assignmentsUrl(1)}>; rel="first"` },
    ),
    [assignmentsUrl(2)]: ok([assignment(201, 2)], { link: `<${assignmentsPage(2, 2)}>; rel="next"` }),
    [assignmentsPage(2, 2)]: ok([assignment(202, 2)]),
    [assignmentsUrl(3)]: ok([assignment(301, 3)]),
    [assignmentsUrl(4)]: ok([assignment(401, 4)]),
    [assignmentsUrl(9)]: ok([assignment(901, 9)]), // must never be requested
  };
}

test('follows Link-header pages, runs rounds in parallel, and builds the schedule', () => {
  const sb = setup(paginatedRoutes({ id: 4242, name: '', short_name: '  Alex Rivera  ' }));
  // Trailing slash on the address should be removed.
  const schedule = toPlain(sb.context.fetchStudentSchedule_(TOKEN, `${BASE}/`, 2, NOW));

  // Rounds: profile + classes together; class page 2 alone; page 1 of every class together;
  // then every pending "next" page together until none are left.
  assert.deepStrictEqual(toPlain(sb.fetchBatches), [
    { method: 'fetchAll', urls: [PROFILE_URL, COURSES_URL] },
    { method: 'fetch', urls: [COURSES_P2] },
    { method: 'fetchAll', urls: [assignmentsUrl(1), assignmentsUrl(2), assignmentsUrl(3), assignmentsUrl(4)] },
    { method: 'fetchAll', urls: [assignmentsPage(1, 2), assignmentsPage(2, 2)] },
    { method: 'fetch', urls: [assignmentsPage(1, 3)] },
  ]);

  // The finished class (workflow_state "completed") was filtered out and never fetched.
  assert.ok(!sb.fetchCalls.some((c) => c.url === assignmentsUrl(9)));

  // Every request carries the token and the same options.
  assert.equal(sb.fetchCalls.length, 10);
  for (const call of sb.fetchCalls) {
    assert.equal(call.params.headers.Authorization, `Bearer ${TOKEN}`, call.url);
    assert.equal(call.params.method, 'get');
    assert.equal(call.params.muteHttpExceptions, true);
    assert.equal(call.params.followRedirects, true);
    assert.ok(!call.url.includes('.com//'), call.url);
  }

  // Name falls back to short_name (trimmed); the Canvas ID is passed along.
  assert.equal(schedule.student_full_name, 'Alex Rivera');
  assert.equal(schedule.canvas_user_id, 4242);
  // 8 assignments, minus the one with no due date.
  assert.equal(schedule.total_assignments, 7);
  assert.deepStrictEqual(Object.keys(schedule.weeks), ['2026-10-26']);
});

test('assignment pairs keep class order and page order; unnamed class gets "Course <id>"', () => {
  const sb = setup(paginatedRoutes({ id: 1 }));
  const pairs = toPlain(sb.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));

  assert.deepStrictEqual(
    pairs.map(([a, courseName]) => [a.id, courseName, a._course_id]),
    [
      [101, 'English 10', 1], [102, 'English 10', 1], [103, 'English 10', 1], [104, 'English 10', 1],
      [201, 'Biology', 2], [202, 'Biology', 2],
      [301, 'Algebra II', 3],
      [401, 'Course 4', 4],
    ],
  );
  // Without the profile, the first round is just the classes request.
  assert.deepStrictEqual(toPlain(sb.fetchBatches[0]), { method: 'fetch', urls: [COURSES_URL] });
  assert.ok(!sb.fetchCalls.some((c) => c.url === PROFILE_URL));
});

test('profile: name fallbacks, and canvas_user_id only when Canvas gives an id', () => {
  const cases = [
    [{ id: 77, name: 'Jordan Lee', short_name: 'Jordan' }, { id: 77, name: 'Jordan Lee' }],
    [{ id: 78, name: null, short_name: 'Sam' }, { id: 78, name: 'Sam' }],
    [{ name: '   ', short_name: 'Ignored' }, { id: null, name: 'Student' }],
    [{}, { id: null, name: 'Student' }],
  ];
  for (const [profile, expected] of cases) {
    const sb = setup({ [PROFILE_URL]: ok(profile) });
    assert.deepStrictEqual(toPlain(sb.context.fetchCanvasProfile_(TOKEN, BASE)), expected);
    assert.deepStrictEqual(toPlain(sb.fetchBatches), [{ method: 'fetch', urls: [PROFILE_URL] }]);
  }

  // No id in the profile: the schedule has no canvas_user_id key at all.
  const sb = setup({ [PROFILE_URL]: ok({ name: 'Jordan Lee' }), [COURSES_URL]: ok([]) });
  const schedule = toPlain(sb.context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW));
  assert.equal(schedule.student_full_name, 'Jordan Lee');
  assert.ok(!('canvas_user_id' in schedule));
  assert.deepStrictEqual(schedule.weeks, {});
});

test('401 anywhere -> kind "auth", and the message never contains the token', () => {
  const sb = setup({
    [PROFILE_URL]: { code: 401, body: { errors: [{ message: `Invalid access token ${TOKEN}` }] } },
    [COURSES_URL]: { code: 401, body: { errors: [{ message: 'Invalid access token.' }] } },
  });
  const err = errorFrom(() => sb.context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW));
  assert.equal(err.canvasKind, 'auth');
  assert.equal(err.message, MSG_401);
  assertNoToken(err);

  // A 401 on one class's assignments also fails the whole student.
  const routes = paginatedRoutes({ id: 1, name: 'Alex Rivera' });
  routes[assignmentsPage(1, 2)] = { code: 401, body: '' };
  const err2 = errorFrom(() => setup(routes).context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW));
  assert.equal(err2.canvasKind, 'auth');
  assertNoToken(err2);
});

test('403 on the profile or classes -> kind "auth" with the 403 message', () => {
  const sb = setup({ [PROFILE_URL]: ok({ id: 1 }), [COURSES_URL]: { code: 403, body: '' } });
  const err = errorFrom(() => sb.context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW));
  assert.equal(err.canvasKind, 'auth');
  assert.equal(err.message, "Canvas refused this student's token (HTTP 403). Ask the student to make a new token.");
  assertNoToken(err);
});

test("403 or 404 on one class's assignments skips just that class", () => {
  const sb = setup({
    [COURSES_URL]: ok([course(1, 'English 10'), course(2, 'Biology'), course(3, 'Algebra II')]),
    [assignmentsUrl(1)]: ok([assignment(101, 1)]),
    [assignmentsUrl(2)]: { code: 403, body: { errors: [{ message: 'user not authorized to perform that action' }] } },
    [assignmentsUrl(3)]: { code: 404, body: '' },
  });
  const pairs = toPlain(sb.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));
  assert.deepStrictEqual(pairs.map(([a, name]) => [a.id, name]), [[101, 'English 10']]);
  assert.deepStrictEqual(sb.sleepCalls, []);
});

test('403 "Rate Limit Exceeded" is Canvas saying "slow down": retried, then the student waits (no class dropped)', () => {
  const limited = { code: 403, body: '403 Forbidden (Rate Limit Exceeded)' };
  // Once, then fine: retried after 2 seconds, nothing lost.
  let sb = setup({
    [COURSES_URL]: ok([course(1, 'English 10'), course(2, 'Biology')]),
    [assignmentsUrl(1)]: ok([assignment(101, 1)]),
    [assignmentsUrl(2)]: sequence(limited, ok([assignment(201, 2)])),
  });
  let pairs = toPlain(sb.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));
  assert.deepStrictEqual(pairs.map(([a]) => a.id), [101, 201]);
  assert.deepStrictEqual(sb.sleepCalls, [2000]);
  // Still limited after the retry: a plain "try again" error, so the Doc isn't written without Biology.
  sb = setup({
    [COURSES_URL]: ok([course(1, 'English 10'), course(2, 'Biology')]),
    [assignmentsUrl(1)]: ok([assignment(101, 1)]),
    [assignmentsUrl(2)]: limited,
  });
  let err = errorFrom(() => sb.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));
  assert.equal(err.canvasKind, 'unavailable');
  assert.equal(err.message, 'Canvas is getting too many requests right now. This student will be tried again at the next update.');
  // On the class list it isn't called a bad token either.
  sb = setup({ [PROFILE_URL]: ok({ id: 1 }), [COURSES_URL]: limited });
  err = errorFrom(() => sb.context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW));
  assert.equal(err.canvasKind, 'unavailable');
});

test('classes hidden by COURSE_EXCLUDE are never asked for', () => {
  const sb = setup({
    [PROFILE_URL]: ok({ id: 1, name: 'Avery Example' }),
    [COURSES_URL]: ok([course(1, 'English 10'), course(2, 'Advisory - Smith'), course(3, 'Dorm Life')]),
    [assignmentsUrl(1)]: ok([assignment(101, 1)]),
  });
  const schedule = toPlain(sb.context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW, ['advisory', 'dorm']));
  assert.deepStrictEqual(schedule.courses, ['English 10']);
  assert.ok(!sb.fetchCalls.some((c) => /courses\/(2|3)\/assignments/.test(c.url)));
});

test('token expiry: Canvas finds the token by its hint (up to "~" plus 5) and says when it expires; never throws', () => {
  const tok = '1234~abcdefghijklmnop';
  const hintUrl = `${BASE}/api/v1/users/self/tokens/1234~abcde`;
  let sb = setup({ [hintUrl]: ok({ id: 1, expires_at: '2027-01-02T05:00:00Z', created_at: '2026-10-04T20:54:53Z', token_hint: '1234~abcde' }) });
  assert.deepStrictEqual(toPlain(sb.context.fetchCanvasTokenExpiry_(tok, BASE)), { expiresAt: '2027-01-02T05:00:00Z', createdAt: '2026-10-04T20:54:53Z' });
  assert.ok(sb.fetchCalls.every((c) => !c.url.includes(tok)), 'only the hint is sent in the address, never the whole token');
  sb = setup({ [hintUrl]: ok({ id: 1, expires_at: null, created_at: '2026-10-04T20:54:53Z' }) });
  assert.deepStrictEqual(toPlain(sb.context.fetchCanvasTokenExpiry_(tok, BASE)), { expiresAt: null, createdAt: '2026-10-04T20:54:53Z' });
  sb = setup({});
  assert.strictEqual(sb.context.fetchCanvasTokenExpiry_(tok, BASE), null, "Canvas doesn't say: null");
  assert.strictEqual(sb.context.fetchCanvasTokenExpiry_('no-tilde-token', BASE), null);
});

test('503 then 200 -> retried once after 2 seconds, then succeeds', () => {
  const sb = setup({
    [COURSES_URL]: sequence({ code: 503, body: 'Service Unavailable' }, ok([course(1, 'Biology')])),
    [assignmentsUrl(1)]: ok([assignment(101, 1)]),
  });
  const pairs = toPlain(sb.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));
  assert.deepStrictEqual(pairs.map(([a, name]) => [a.id, name]), [[101, 'Biology']]);
  assert.deepStrictEqual(sb.sleepCalls, [2000]);
  assert.equal(sb.fetchCalls.filter((c) => c.url === COURSES_URL).length, 2);
});

test('busy twice -> kind "unavailable" (503 on classes, 429 on assignments)', () => {
  const sb = setup({ [PROFILE_URL]: ok({ id: 1 }), [COURSES_URL]: { code: 503, body: '' } });
  const err = errorFrom(() => sb.context.fetchStudentSchedule_(TOKEN, BASE, 2, NOW));
  assert.equal(err.canvasKind, 'unavailable');
  assert.equal(err.message, 'Canvas is busy or down right now (HTTP 503). Try again later.');
  assert.deepStrictEqual(sb.sleepCalls, [2000]);
  // Only the failed request was retried, and only once.
  assert.equal(sb.fetchCalls.filter((c) => c.url === COURSES_URL).length, 2);
  assert.equal(sb.fetchCalls.filter((c) => c.url === PROFILE_URL).length, 1);
  assertNoToken(err);

  const sb2 = setup({
    [COURSES_URL]: ok([course(1, 'Biology'), course(2, 'Algebra II')]),
    [assignmentsUrl(1)]: ok([assignment(101, 1)]),
    [assignmentsUrl(2)]: { code: 429, body: '' },
  });
  const err2 = errorFrom(() => sb2.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));
  assert.equal(err2.canvasKind, 'unavailable');
  assert.match(err2.message, /\(HTTP 429\)/);
});

test('network failure -> kind "network" without the original exception text', () => {
  const sb = setup({});
  sb.setFetchHandler(() => {
    throw new Error(`DNS error: getaddrinfo ENOTFOUND (Authorization: Bearer ${TOKEN})`);
  });
  const err = errorFrom(() => sb.context.fetchStudentSchedule_(TOKEN, `${BASE}/`, 2, NOW));
  assert.equal(err.canvasKind, 'network');
  assert.equal(err.message, "Couldn't reach Canvas at https://pomfret.instructure.com.");
  assert.ok(!err.message.includes('ENOTFOUND'));
  assertNoToken(err);
});

test('other errors -> kind "other", with a short Canvas message when safe', () => {
  const run = (body) => {
    const sb = setup({ [COURSES_URL]: { code: 400, body } });
    return errorFrom(() => sb.context.fetchCanvasAssignmentPairs_(TOKEN, BASE));
  };

  const short = run({ errors: [{ message: 'Invalid per_page value' }] });
  assert.equal(short.canvasKind, 'other');
  assert.equal(short.message, 'Canvas returned an error (HTTP 400). Canvas said: "Invalid per_page value"');

  const long = run({ errors: [{ message: 'x'.repeat(120) }] });
  assert.equal(long.message, 'Canvas returned an error (HTTP 400).');

  const withToken = run({ errors: [{ message: `Bad token ${TOKEN}` }] });
  assert.equal(withToken.message, 'Canvas returned an error (HTTP 400).');

  const notJson = run('<html>Bad Request</html>');
  assert.equal(notJson.message, 'Canvas returned an error (HTTP 400).');
});
