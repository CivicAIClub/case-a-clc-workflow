'use strict';
// The made-up school year: calendar, classes, students, Canvas assignments, churn, and a fake
// Canvas REST API answering the real Canvas.gs requests. Every name here is made up.

const TZ = 'America/New_York';
const DAY_MS = 86400000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- dates ('yyyy-mm-dd' strings; arithmetic in UTC) ------------------------------------------------
const toMs = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fromMs(toMs(d) + n * DAY_MS);
const weekday = (d) => (new Date(toMs(d)).getUTCDay() + 6) % 7; // 0 = Monday
const monday = (d) => addDays(d, -weekday(d));
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nyParts(ms) {
  const p = {};
  nyFmt.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { date: p.year + '-' + p.month + '-' + p.day, hh: Number(p.hour) % 24, mm: Number(p.minute) };
}
/** The UTC instant of a New York wall-clock time (the later one if the hour doesn't exist). */
function nyToMs(date, hh, mm) {
  const [y, m, d] = date.split('-').map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, hh, mm) + off * 3600000;
    const p = nyParts(ms);
    if (p.date === date && p.hh === hh && p.mm === mm) return ms;
  }
  return Date.UTC(y, m - 1, d, hh, mm) + 5 * 3600000; // a time skipped by DST: an hour later
}
function hmText(hh, mm) { return ((hh % 12) || 12) + ':' + String(mm).padStart(2, '0') + ' ' + (hh < 12 ? 'AM' : 'PM'); }

// ---- calendar -------------------------------------------------------------------------------------
const FIRST_DAY = '2026-09-08';
const LAST_DAY = '2027-06-11';
const BREAKS = [['2026-12-19', '2027-01-03'], ['2027-03-13', '2027-03-28']];
const SEMESTER_CHANGE = '2027-01-25';
const isBreak = (d) => BREAKS.some(([a, b]) => d >= a && d <= b);

// ---- classes ----------------------------------------------------------------------------------------
const POOL = [
  'Biology H - Section 2 (Avery Example)',
  'ADV Calculus III-Sample-G',
  'English 10 - Section 1 (Jordan Placeholder)',
  'World History',
  'Spanish III - Section 4 (Riley Example)',
  'Chemistry - Section 3 (Morgan Sample)',
  'Studio Art-Testcase-C',
  'Physics H - Section 1 (Casey Example)',
  'Psychology',
  'US History H - Section 5 (Taylor Specimen)',
  'Computer Science Principles-Demo-E',
  'Statistics - Section 2 (Drew Sample)',
  'French II-Example-B',
  'Environmental Science - Section 1 (Alex Mock)',
  'Music Theory',
];
const S2_ONLY = ['Economics - Section 1 (Parker Example)', 'Creative Writing', 'Robotics-Sample-D', 'Ethics - Section 2 (Rowan Example)'];
const HEAVY_PRIVATE = ['Independent Study: Senior Project (Sample)', 'Directed Research - Section 1 (Example)'];
const ADVISORY = 'Advisory - Grade 11 (Kim Example)';

const KINDS = ['Problem Set', 'Reading Response', 'Lab Report', 'Quiz', 'Essay Draft', 'Vocabulary Quiz', 'Project Checkpoint',
  'Discussion Post', 'Worksheet', 'Unit Test', 'Presentation Slides', 'Journal Entry', 'Peer Review', 'Study Guide', 'Homework'];
const TOPICS = ['cell membranes', 'derivatives of trig functions', 'the French Revolution', 'chapter 7', 'stoichiometry', 'Newton’s laws',
  'the subjunctive mood', 'primary sources', 'probability trees', 'the water cycle', 'sonnets', 'supply and demand', 'loops and functions',
  'color theory', 'photosynthesis', 'the Constitution', 'vectors', 'Hamlet act 3', 'chord progressions', 'sampling bias'];
const DETAILS = ['bring two printed sources', 'show all work', 'upload as PDF', 'no calculators', 'pages 112–118', 'partner work allowed',
  'submit on Canvas by the deadline', 'include a works-cited page', 'rough draft only', 'typed, double-spaced', 'see rubric', 'retakes allowed'];
const NOTE_BITS = ['Started in study hall', 'Needs to email teacher about an extension', 'Check rubric before submitting', 'Done except citations',
  'Ask about problem 4', 'Missing the lab data — see Ms. Example', 'Turned in on paper', 'Will finish over the weekend 📚', 'Met with tutor',
  'Half done', 'Waiting on partner', 'Re-read chapter first', 'Teacher said it’s optional', 'Submitted, needs review'];
const FIRST = ['Avery', 'Blake', 'Cameron', 'Dakota', 'Emerson', 'Finley', 'Gray', 'Harper', 'Indigo', 'Jules', 'Kai', 'Logan', 'Marlow',
  'Noel', 'Oakley', 'Peyton', 'Quinn', 'Reese', 'Sage', 'Tatum', 'Umber', 'Vale', 'Wren', 'Xen', 'Yael', 'Zion', 'Arden', 'Brook', 'Cove', 'Dell'];
const LAST = ['Example', 'Sample', 'Placeholder', 'Specimen', 'Testcase', 'Demo', 'Fixture', 'Mockup', 'Prototype', 'Stand-In'];

function createWorld(seed, options) {
  const opt = Object.assign({ students: 30, heavyStudent: true }, options || {});
  // Three random streams: generation, Canvas churn (fixed times, so every run schedule sees the
  // same Canvas), and everything else (staff typing, IDs).
  const genRng = mulberry32(seed);
  const churnRng = mulberry32(seed ^ 0x9e3779b9);
  const otherRng = mulberry32(seed ^ 0x85ebca6b);
  let active = genRng;
  const rng = () => active();
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const sentence = (target, gen) => {
    let s = gen();
    while (s.length < target) s += ' ' + gen().toLowerCase();
    if (s.length > target) {
      s = s.slice(0, target);
      const cut = s.lastIndexOf(' ');
      if (cut > target * 0.6) s = s.slice(0, cut);
      s = s.replace(/[\s,;:—–-]+$/, '');
    }
    return s;
  };
  const assignmentName = () => {
    const target = randInt(20, 90);
    let s = pick(KINDS) + ' ' + randInt(1, 12) + ': ' + pick(TOPICS);
    while (s.length < target) s += (s.indexOf('(') === -1 ? ' (' + pick(DETAILS) + ')' : '; ' + pick(DETAILS));
    if (s.length > target) { s = s.slice(0, target).replace(/[\s,;:(–-]+$/, ''); if ((s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length) s = s.slice(0, Math.max(20, target - 1)) + ')'; }
    return s.length < 20 ? (s + ' — practice set').slice(0, 30) : s;
  };
  const noteText = () => sentence(randInt(10, 80), () => pick(NOTE_BITS));

  // Courses
  let nextCourseId = 31000 + randInt(0, 500);
  const courses = new Map(); // id -> course
  const addCourse = (name, kind) => {
    const id = nextCourseId++;
    const c = { id, name, kind, intensity: 1.6 + rng() * 1.8, assignments: [], ver: 0 };
    courses.set(id, c);
    return c;
  };
  const shared = POOL.map((n) => addCourse(n, 'year'));
  const s2 = S2_ONLY.map((n) => addCourse(n, 'S2'));
  const advisory = addCourse(ADVISORY, 'advisory');
  const heavyPrivate = opt.heavyStudent ? HEAVY_PRIVATE.map((n) => addCourse(n, 'private')) : [];

  // Assignments
  let nextAssignmentId = 4100000 + randInt(0, 50000);
  const byId = new Map();
  const dueTimes = [[8, 0], [8, 30], [10, 25], [11, 59], [13, 15], [15, 15], [17, 0], [20, 0], [22, 0], [23, 59], [23, 59], [23, 59]];
  const dueCandidates = (weekMonday) => {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekMonday, i);
      if (d < FIRST_DAY || d > '2027-06-13' || isBreak(d)) continue;
      if (i <= 4) out.push(d, d, d); else if (i === 6) out.push(d); // weekdays, sometimes Sunday night
    }
    return out;
  };
  const makeAssignment = (course, date, hh, mm, publishMs) => {
    const id = nextAssignmentId++;
    const a = { id, courseId: course.id, name: assignmentName(), date, hh, mm, dueMs: nyToMs(date, hh, mm), publishMs, removed: false };
    a.html_url = 'https://pomfret.instructure.com/courses/' + course.id + '/assignments/' + id;
    course.assignments.push(a);
    byId.set(id, a);
    return a;
  };
  const countFor = (intensity) => Math.max(1, Math.min(5, Math.round(intensity + (rng() - 0.5) * 2.2)));
  for (const course of courses.values()) {
    if (course.kind === 'advisory') continue;
    for (let wk = monday(FIRST_DAY); wk <= monday(LAST_DAY); wk = addDays(wk, 7)) {
      if (course.kind === 'S2' && wk < SEMESTER_CHANGE) continue;
      const cands = dueCandidates(wk);
      if (!cands.length) continue;
      const n = countFor(course.intensity);
      for (let i = 0; i < n; i++) {
        const date = pick(cands);
        const [hh, mm] = weekday(date) === 6 ? [23, 59] : pick(dueTimes);
        const late = rng() < 0.08;
        const lead = late ? rng() * 3 : 7 + rng() * 28;
        makeAssignment(course, date, hh, mm, nyToMs(date, 8, 0) - lead * DAY_MS);
      }
    }
  }
  // DST edge cases: due late on the Sunday DST ends, and the Friday before it starts.
  makeAssignment(shared[3], '2026-11-01', 23, 59, nyToMs('2026-10-01', 8, 0)).name = 'Reading Response 4: the clocks go back tonight (DST ends)';
  makeAssignment(shared[3], '2026-11-01', 0, 30, nyToMs('2026-10-01', 8, 0)).name = 'Journal Entry 5: just after midnight on the DST Sunday';
  makeAssignment(shared[8], '2027-03-12', 23, 59, nyToMs('2027-02-15', 8, 0)).name = 'Problem Set 9: due the Friday before DST starts';

  // Students
  const teachers = [
    { name: 'Pat Example', email: 'pexample@pomfret.org' },
    { name: 'Sam Sample', email: 'ssample@pomfret.org' },
    { name: 'Lee Placeholder', email: 'lplaceholder@pomfret.org' },
  ];
  const tokenChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const students = [];
  const usedNames = new Set();
  for (let i = 0; i < opt.students; i++) {
    let name;
    do { name = pick(FIRST) + ' ' + pick(LAST); } while (usedNames.has(name));
    usedNames.add(name);
    let token = '7867~';
    for (let k = 0; k < 64; k++) token += tokenChars[Math.floor(rng() * tokenChars.length)];
    const s1 = [];
    const heavy = opt.heavyStudent && i === opt.students - 1;
    const want = heavy ? 3 : 5;
    while (s1.length < want) { const c = pick(shared); if (!s1.includes(c)) s1.push(c); }
    if (heavy) s1.push(...heavyPrivate);
    // semester change: drop 1–2 (never the private ones), add 1–2 not taken
    const s2list = s1.slice();
    const drops = randInt(1, 2);
    for (let k = 0; k < drops; k++) {
      const can = s2list.filter((c) => c.kind === 'year');
      s2list.splice(s2list.indexOf(pick(can)), 1);
    }
    const adds = randInt(1, 2);
    const pool2 = shared.concat(s2).filter((c) => !s1.includes(c));
    for (let k = 0; k < adds; k++) { const c = pick(pool2.filter((x) => !s2list.includes(x))); s2list.push(c); }
    students.push({
      idx: i, name, token, canvasUserId: 90000 + randInt(0, 9999) * 10 + i, heavy,
      label: rng() < 0.5 ? 'Grade ' + randInt(9, 12) : '',
      teacher: i % 4 === 3 ? '' : teachers[i % 3].email,
      s1, s2: s2list,
    });
  }
  // Heavy week: 45 assignments due in the week of Jan 11, 2027 for the heavy student.
  const HEAVY_WEEK = '2027-01-11';
  if (opt.heavyStudent) {
    const hs = students[students.length - 1];
    const inWeek = (c) => c.assignments.filter((a) => monday(a.date) === HEAVY_WEEK).length;
    let have = hs.s1.reduce((n, c) => n + inWeek(c), 0);
    const cands = dueCandidates(HEAVY_WEEK);
    let k = 0;
    while (have < 45) {
      const date = cands[k % cands.length];
      makeAssignment(heavyPrivate[k % 2], date, pick(dueTimes)[0], 0, nyToMs('2026-12-14', 8, 0));
      have++; k++;
    }
  }

  const coursesOf = (st, dateText) => (dateText >= SEMESTER_CHANGE ? st.s2 : st.s1);

  // ---- churn ----------------------------------------------------------------------------------------
  const events = { moves: 0, crossWeekMoves: 0, bigMoves: 0, removed: 0, extensions: 0, lateAdds: 0, log: [] };
  const okDue = (d) => !isBreak(d) && d >= FIRST_DAY && d <= '2027-06-13' && weekday(d) !== 5;
  function churn(nowMs, today, scale) {
    const prev = active;
    active = churnRng;
    try { churnInner(nowMs, today, scale); } finally { active = prev; }
  }
  function churnInner(nowMs, today, scale) {
    for (const c of courses.values()) {
      let changed = false;
      for (const a of c.assignments) {
        if (a.removed || a.publishMs > nowMs) continue;
        if (a.date >= today && a.date <= addDays(today, 35)) {
          const r = rng();
          if (r < 0.01 * scale) { a.removed = true; events.removed++; changed = true; events.log.push({ t: nowMs, kind: 'removed', id: a.id }); continue; }
          if (r < 0.04 * scale) {
            const delta = pick([-3, -2, -1, 1, 1, 2, 2, 3, 4, 5, 7, 9]);
            const nd = addDays(a.date, delta);
            if (!okDue(nd) || nd < today) continue;
            if (monday(nd) !== monday(a.date)) events.crossWeekMoves++;
            events.log.push({ t: nowMs, kind: 'move', id: a.id, from: a.date, to: nd });
            (a.history = a.history || []).push({ t: nowMs, kind: 'move', from: a.date, to: nd });
            a.date = nd; a.dueMs = nyToMs(nd, a.hh, a.mm); events.moves++; changed = true;
            continue;
          }
          if (r < 0.0425 * scale) {
            const nd = addDays(a.date, randInt(28, 42));
            if (!okDue(nd)) continue;
            events.log.push({ t: nowMs, kind: 'bigmove', id: a.id, from: a.date, to: nd });
            (a.history = a.history || []).push({ t: nowMs, kind: 'bigmove', from: a.date, to: nd });
            a.date = nd; a.dueMs = nyToMs(nd, a.hh, a.mm); events.bigMoves++; changed = true;
          }
        } else if (a.date < today && a.date >= addDays(today, -7)) {
          if (rng() < 0.01 * scale) {
            let nd = addDays(today, randInt(1, 5));
            let guard = 0;
            while (!okDue(nd) && guard++ < 10) nd = addDays(nd, 1);
            if (!okDue(nd)) continue;
            events.log.push({ t: nowMs, kind: 'extension', id: a.id, from: a.date, to: nd });
            (a.history = a.history || []).push({ t: nowMs, kind: 'extension', from: a.date, to: nd });
            a.date = nd; a.dueMs = nyToMs(nd, a.hh, a.mm); events.extensions++; changed = true;
          }
        }
      }
      if (c.kind !== 'advisory' && rng() < 0.1 * scale && !(c.kind === 'S2' && today < SEMESTER_CHANGE)) {
        let nd = addDays(today, randInt(1, 6));
        let guard = 0;
        while (!okDue(nd) && guard++ < 10) nd = addDays(nd, 1);
        if (okDue(nd)) {
          const [hh, mm] = pick(dueTimes);
          const a = makeAssignment(c, nd, hh, mm, nowMs - 60000);
          events.lateAdds++; changed = true;
          events.log.push({ t: nowMs, kind: 'lateadd', id: a.id, to: nd });
        }
      }
      if (changed) c.ver++;
    }
  }

  // ---- fake Canvas API ------------------------------------------------------------------------------
  const listCache = new Map();
  let nowMsRef = () => Date.now();
  const visible = (c, nowMs) => {
    let published = 0;
    for (const a of c.assignments) if (a.publishMs <= nowMs) published++;
    const key = c.id + ':' + c.ver + ':' + published;
    let v = listCache.get(key);
    if (!v) {
      v = c.assignments.filter((a) => !a.removed && a.publishMs <= nowMs).sort((x, y) => x.dueMs - y.dueMs || x.id - y.id)
        .map((a) => ({ id: a.id, name: a.name, due_at: new Date(a.dueMs).toISOString().replace('.000Z', 'Z'), html_url: a.html_url,
          course_id: c.id, points_possible: 10, published: true, submission_types: ['online_upload'], lock_at: null, unlock_at: null }));
      listCache.set(key, v);
      if (listCache.size > 5000) listCache.clear();
    }
    return v;
  };
  function canvasHandler(url, params) {
    const auth = ((params && params.headers) || {}).Authorization || '';
    const st = students.find((s) => 'Bearer ' + s.token === auth);
    if (!st) return { code: 401, body: { errors: [{ message: 'Invalid access token.' }] } };
    const nowMs = nowMsRef();
    const today = nyParts(nowMs).date;
    const u = new URL(url);
    const p = u.pathname;
    if (p === '/api/v1/users/self/profile') return { body: { id: st.canvasUserId, name: st.name, short_name: st.name.split(' ')[0], sortable_name: st.name.split(' ').reverse().join(', ') } };
    if (p.indexOf('/api/v1/users/self/tokens/') === 0) return { body: { expires_at: null, created_at: '2026-09-01T12:00:00Z' } };
    if (p === '/api/v1/courses') {
      const list = coursesOf(st, today).concat([advisory]).map((c) => ({ id: c.id, name: c.name, course_code: c.name.slice(0, 12), workflow_state: 'available', enrollment_term_id: 7 }));
      return { body: list };
    }
    const m = /^\/api\/v1\/courses\/(\d+)\/assignments$/.exec(p);
    if (m) {
      const c = courses.get(Number(m[1]));
      if (!c) return { code: 404, body: { errors: [{ message: 'not found' }] } };
      const page = Number(u.searchParams.get('page') || 1);
      const per = Number(u.searchParams.get('per_page') || 10);
      const all = visible(c, nowMs);
      const body = all.slice((page - 1) * per, page * per);
      const headers = {};
      if (page * per < all.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers.Link = '<' + next.toString() + '>; rel="next", <' + url + '>; rel="current"';
      }
      return { body, headers };
    }
    return { code: 404, body: { errors: [{ message: 'unknown ' + p }] } };
  }

  /** What the student's Doc should show for the 4 weeks from this Monday: { weekKey: [assignment] }. */
  function expectedWeeks(st, nowMs) {
    const today = nyParts(nowMs).date;
    const mon = monday(today);
    const last = addDays(mon, 27);
    const out = {};
    coursesOf(st, today).forEach((c) => c.assignments.forEach((a) => {
      if (a.removed || a.publishMs > nowMs || a.date < mon || a.date > last) return;
      (out[monday(a.date)] = out[monday(a.date)] || []).push(a);
    }));
    return out;
  }

  active = otherRng; // after generation, everything but churn uses the third stream
  return {
    rng, pick, randInt, noteText, courses, students, teachers, byId, events, churn, canvasHandler, expectedWeeks, coursesOf,
    setNow: (fn) => { nowMsRef = fn; }, HEAVY_WEEK, advisory,
    staffRowTexts: (st, today) => {
      const c = pick(coursesOf(st, today));
      return [sentence(randInt(15, 45), () => pick(['Retake quiz', 'Bring signed form', 'Study group', 'Library book due', 'Make up lab', 'Meet advisor'])) ,
        c.name.replace(/ - Section.*$/, '').replace(/-[A-Z][a-z]+-[A-Z]$/, ''), WEEKDAYS[randInt(0, 4)], 'Not started', noteText()];
    },
  };
}

module.exports = { createWorld, nyToMs, nyParts, addDays, monday, weekday, isBreak, hmText, FIRST_DAY, LAST_DAY, BREAKS, SEMESTER_CHANGE, WEEKDAYS, TZ };
