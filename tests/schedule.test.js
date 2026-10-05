'use strict';
// Tests for the week grouping in apps_script/Canvas.gs (the JavaScript port of backend/processor.py).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, toPlain } = require('./helpers/gas-sandbox');

const TZ = 'America/New_York';
// Frozen "now": Wednesday 2026-10-28, 10:00 AM in New York (EDT).
const NOW = new Date('2026-10-28T14:00:00Z');

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function loadSchedule() {
  return createSandbox({ files: ['apps_script/Canvas.gs'] }).context;
}

// One fake assignment pair with the given UTC due time.
function pair(name, dueAt) {
  return [{ name, due_at: dueAt, html_url: 'https://pomfret.instructure.com/courses/1/assignments/1' }, 'Biology'];
}

// Flatten a schedule into a list of its assignments, in output order.
function allAssignments(schedule) {
  const out = [];
  for (const week of Object.values(schedule.weeks)) {
    for (const day of week.days) out.push(...day.assignments);
  }
  return out;
}

// The golden file is the Python version's output, plus this week's past-due work (kept since the
// final delivery so a week keeps all its assignments until it moves into Past weeks).
test('matches the golden output exactly (including key order)', () => {
  const gs = loadSchedule();
  const input = JSON.parse(readFixture('schedule-input.json'));
  const golden = JSON.parse(readFixture('schedule-golden.json'));

  const result = toPlain(gs.buildWeeklySchedule_(input, TZ, 4, NOW));
  delete result.generated_at;

  // deepStrictEqual gives a readable diff; the string check also catches key-order changes.
  assert.deepStrictEqual(result, golden);
  assert.equal(JSON.stringify(result), JSON.stringify(golden));
});

test('generated_at is the local time in the school time zone, yyyy-MM-ddTHH:mm:ss', () => {
  const gs = loadSchedule();
  const summer = gs.buildWeeklySchedule_([], TZ, 2, NOW);
  assert.match(summer.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(summer.generated_at, '2026-10-28T10:00:00'); // EDT (UTC-4)

  const winter = gs.buildWeeklySchedule_([], TZ, 2, new Date('2026-11-05T15:04:05Z'));
  assert.equal(winter.generated_at, '2026-11-05T10:04:05'); // EST (UTC-5)
});

test('priority boundaries: earlier this week Past due, 0 Today, 1 Tomorrow, 2-3 Due Soon, 4-7 This Week, 8+ Upcoming', () => {
  const gs = loadSchedule();
  // Noon New York time on each day from Oct 25 (last Sunday) to Nov 5 (8 days out). Today is Wed Oct 28.
  const days = [
    ['2026-10-25T16:00:00Z', null], // -3: last week, dropped (that week is in Past weeks)
    ['2026-10-26T16:00:00Z', 'Past due'], // -2: this Monday, kept until the week ends
    ['2026-10-27T16:00:00Z', 'Past due'], // -1
    ['2026-10-28T16:00:00Z', 'Today'], // 0
    ['2026-10-29T16:00:00Z', 'Tomorrow'], // 1
    ['2026-10-30T16:00:00Z', 'Due Soon'], // 2
    ['2026-10-31T16:00:00Z', 'Due Soon'], // 3
    ['2026-11-01T17:00:00Z', 'This Week'], // 4 (first day of EST)
    ['2026-11-04T17:00:00Z', 'This Week'], // 7
    ['2026-11-05T17:00:00Z', 'Upcoming'], // 8
  ];
  const pairs = days.map(([dueAt], i) => pair('Item ' + i, dueAt));
  const result = toPlain(gs.buildWeeklySchedule_(pairs, TZ, 4, NOW));

  const got = allAssignments(result).map((a) => [a.days_until_due, a.priority]);
  assert.deepStrictEqual(got, [
    [-2, 'Past due'], [-1, 'Past due'], [0, 'Today'], [1, 'Tomorrow'], [2, 'Due Soon'], [3, 'Due Soon'],
    [4, 'This Week'], [7, 'This Week'], [8, 'Upcoming'],
  ]);
  assert.equal(result.total_assignments, 9);

  // The priority helper on its own, at every boundary.
  const labels = [-6, -1, 0, 1, 2, 3, 4, 7, 8, 30].map((d) => gs.schedulePriority_(d));
  assert.deepStrictEqual(toPlain(labels), [
    'Past due', 'Past due', 'Today', 'Tomorrow', 'Due Soon', 'Due Soon', 'This Week', 'This Week', 'Upcoming', 'Upcoming',
  ]);
});

test('weeksAhead = 1 keeps work through this Sunday 11:59 PM, even across the DST change', () => {
  const gs = loadSchedule();
  const pairs = [
    pair('Sunday night', '2026-11-02T04:59:00Z'), // Sun Nov 1, 11:59 PM EST: kept
    pair('Monday morning', '2026-11-02T05:00:00Z'), // Mon Nov 2, 12:00 AM EST: next week
  ];
  const result = toPlain(gs.buildWeeklySchedule_(pairs, TZ, 1, NOW));
  assert.deepStrictEqual(Object.keys(result.weeks), ['2026-10-26']);
  assert.equal(result.weeks['2026-10-26'].week_label, 'Oct 26 – Nov 1');
  const sunday = result.weeks['2026-10-26'].days[6];
  assert.equal(sunday.day, 'Sunday');
  assert.deepStrictEqual(sunday.assignments.map((a) => a.due_time), ['11:59 PM']);
  assert.equal(result.total_assignments, 1);
});

test('every week lists all seven days; empty input gives no weeks', () => {
  const gs = loadSchedule();
  const empty = toPlain(gs.buildWeeklySchedule_([], TZ, 2, NOW));
  assert.deepStrictEqual(empty.weeks, {});
  assert.equal(empty.total_assignments, 0);

  const one = toPlain(gs.buildWeeklySchedule_([pair('Essay draft', '2026-10-29T16:00:00Z')], TZ, 2, NOW));
  assert.deepStrictEqual(
    one.weeks['2026-10-26'].days.map((d) => d.day),
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  );
});
