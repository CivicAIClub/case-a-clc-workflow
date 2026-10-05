/**
 * Canvas.gs: the part of AutoPlanner that talks to Canvas (top half) and sorts the
 * assignments into weeks and days (bottom half, a port of backend/processor.py).
 *
 * Top half: talks to Canvas, the school's online class system
 * (a port of backend/canvas_api.py, plus the name handling from backend/main.py).
 *
 * For one student at a time it asks Canvas: "what is this student's name?", "which classes
 * is this student in right now?", and "what assignments does each class have?".
 * Every question carries the student's Canvas token (a long secret password the student
 * made in Canvas). The token must never appear in an error message or a log.
 *
 * Questions are sent in parallel with UrlFetchApp.fetchAll where possible, so a student
 * with eight classes takes a few rounds of requests instead of dozens one after another.
 *
 * Errors thrown from here have a plain-English message plus `err.canvasKind`, one of:
 *   'auth'        the token was refused (expired, deleted, or wrong)
 *   'unavailable' Canvas is busy or down
 *   'network'     Canvas couldn't be reached at all (wrong address, no internet)
 *   'other'       any other error answer from Canvas
 */

// How long to wait before trying a busy request one more time.
var CANVAS_RETRY_WAIT_MS = 2000;

// Get one student's planner: their assignments sorted into weeks, plus their name, their
// Canvas ID number, and `courses` (every current class, A to Z, so the Doc can show a table for
// each one). Classes whose name contains any of `excludeKeywords` (e.g. "advisory") are left
// out completely. `now` is optional (tests pass a fixed time).
function fetchStudentSchedule_(token, baseUrl, weeksAhead, now, excludeKeywords) {
  var data = fetchCanvasData_(token, baseUrl, true, excludeKeywords);
  var keep = function (name) { return !canvasCourseExcluded_(name, excludeKeywords); };
  var pairs = data.pairs.filter(function (pair) { return keep(pair[1]); });
  var schedule = buildWeeklySchedule_(pairs, SCHEDULE_TIME_ZONE, weeksAhead, now);
  schedule.courses = data.courseNames.filter(keep).sort(function (a, b) {
    var x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  schedule.student_full_name = canvasDisplayName_(data.profile);
  // The Canvas ID lets the web page find the same student's Doc again next time.
  if (data.profile.id !== null && data.profile.id !== undefined) {
    schedule.canvas_user_id = data.profile.id;
  }
  return schedule;
}

// Ask Canvas only "who owns this token?" (one request). Used when staff add a student.
function fetchCanvasProfile_(token, baseUrl) {
  var client = canvasClient_(token, baseUrl);
  var response = canvasFetchAll_(client, [canvasProfileUrl_(client)])[0];
  var profile = canvasReadJson_(response, client) || {};
  var id = (profile.id === undefined) ? null : profile.id;
  return { id: id, name: canvasDisplayName_(profile) };
}

// When this token expires, from Canvas itself: { expiresAt, createdAt } (ISO text; expiresAt is null
// for a token that never expires), or null if Canvas doesn't say. Canvas finds a token by its
// "hint": everything up to the "~" plus the next 5 characters (checked live). Never throws, and the
// hint never appears in a message or log.
function fetchCanvasTokenExpiry_(token, baseUrl) {
  var t = String(token || '');
  var cut = t.indexOf('~');
  if (cut < 1) return null;
  try {
    var client = canvasClient_(token, baseUrl);
    var response = canvasSend_(client, [client.baseUrl + '/api/v1/users/self/tokens/' + encodeURIComponent(t.slice(0, cut + 6))])[0];
    if (response.getResponseCode() !== 200) return null;
    var info = JSON.parse(response.getContentText()) || {};
    return { expiresAt: info.expires_at || null, createdAt: info.created_at || null };
  } catch (e) {
    return null;
  }
}

// Get every assignment from the student's current classes, as [assignment, className] pairs.
function fetchCanvasAssignmentPairs_(token, baseUrl) {
  return fetchCanvasData_(token, baseUrl, false).pairs;
}

// True if the class name contains one of the keywords (not case-sensitive).
function canvasCourseExcluded_(name, keywords) {
  var lower = String(name || '').toLowerCase();
  return (keywords || []).some(function (k) {
    var key = String(k || '').trim().toLowerCase();
    return key && lower.indexOf(key) !== -1;
  });
}

// The main "gather everything" step. Gives back { profile, pairs, courseNames }.
// (profile is only fetched when includeProfile is true.) Classes matching `excludeKeywords` are
// never asked for, which keeps the number of requests to Canvas down.
function fetchCanvasData_(token, baseUrl, includeProfile, excludeKeywords) {
  var client = canvasClient_(token, baseUrl);
  var coursesUrl = client.baseUrl + '/api/v1/courses' +
    '?enrollment_type=student&enrollment_state=active&state%5B%5D=available&per_page=100';

  // Round 1: ask for the profile and the first page of classes at the same time.
  var firstUrls = includeProfile ? [canvasProfileUrl_(client), coursesUrl] : [coursesUrl];
  var first = canvasFetchAll_(client, firstUrls);
  var profile = includeProfile ? (canvasReadJson_(first[0], client) || {}) : null;
  var coursesResponse = first[first.length - 1];
  var courses = canvasReadList_(coursesResponse, client);

  // More pages of classes (rare: only over 100 classes), one after another.
  var nextUrl = canvasNextPageUrl_(coursesResponse);
  while (nextUrl) {
    var pageResponse = canvasFetchAll_(client, [nextUrl])[0];
    courses = courses.concat(canvasReadList_(pageResponse, client));
    nextUrl = canvasNextPageUrl_(pageResponse);
  }

  // Keep only open classes, as a second safety check on Canvas's own filter.
  courses = courses.filter(function (course) {
    return course && course.workflow_state === 'available' &&
      !canvasCourseExcluded_(course.name || ('Course ' + course.id), excludeKeywords);
  });

  // One "to do" record per class: which page to fetch next, and what we've collected so far.
  var classes = courses.map(function (course) {
    return {
      course: course,
      name: course.name || ('Course ' + course.id),
      nextUrl: client.baseUrl + '/api/v1/courses/' + course.id +
        '/assignments?order_by=due_at&per_page=100',
      assignments: [],
      skipped: false
    };
  });

  // Fetch page 1 of every class's assignments together, then all the "next" pages
  // together, and so on, until no class has another page.
  var pending = classes;
  while (pending.length > 0) {
    var responses = canvasFetchAll_(client, pending.map(function (c) { return c.nextUrl; }));
    pending.forEach(function (c, i) {
      var code = responses[i].getResponseCode();
      // Too many requests, even after the retry: stop, and leave the Doc as it is, rather than
      // write it without this class (its tables, Status and Notes would disappear).
      if (canvasIsRateLimited_(responses[i])) {
        throw canvasError_('unavailable', CANVAS_RATE_LIMIT_MESSAGE);
      }
      // Canvas sometimes blocks one class (403) or can't find it (404). Skip just that
      // class so the student's other classes still show up.
      if (code === 403 || code === 404) {
        c.skipped = true;
        c.nextUrl = null;
        return;
      }
      c.assignments = c.assignments.concat(canvasReadList_(responses[i], client));
      c.nextUrl = canvasNextPageUrl_(responses[i]);
    });
    pending = classes.filter(function (c) { return c.nextUrl; });
  }

  // Build the pairs in a fixed order: classes in Canvas's order, assignments in page order.
  var pairs = [];
  classes.forEach(function (c) {
    if (c.skipped) return;
    c.assignments.forEach(function (assignment) {
      // Stamp each assignment with its class ID, like the Python version did.
      assignment._course_id = c.course.id;
      pairs.push([assignment, c.name]);
    });
  });
  var courseNames = [];
  classes.forEach(function (c) {
    if (!c.skipped && courseNames.indexOf(c.name) === -1) courseNames.push(c.name);
  });
  return { profile: profile, pairs: pairs, courseNames: courseNames };
}

// Pick the student's name: full name, else short name, else "Student".
function canvasDisplayName_(profile) {
  var p = profile || {};
  return String(p.name || p.short_name || 'Student').trim() || 'Student';
}

// Bundle the token and the school's Canvas address (minus any trailing "/").
function canvasClient_(token, baseUrl) {
  return {
    token: String(token || ''),
    baseUrl: String(baseUrl || '').replace(/\/+$/, '')
  };
}

// The address that answers "who owns this token?".
function canvasProfileUrl_(client) {
  return client.baseUrl + '/api/v1/users/self/profile';
}

// The settings sent with every request, including the token as an "ID badge".
// muteHttpExceptions lets us read error answers ourselves instead of crashing.
function canvasRequestOptions_(client) {
  return {
    method: 'get',
    headers: { Authorization: 'Bearer ' + client.token },
    muteHttpExceptions: true,
    followRedirects: true
  };
}

// Send several requests at once and give back the answers in the same order.
// Any request Canvas answers with "too busy" (429) or a server error (5xx) gets one
// more try after a short pause.
function canvasFetchAll_(client, urls) {
  var responses = canvasSend_(client, urls);
  var retryIndexes = [];
  for (var i = 0; i < responses.length; i++) {
    if (canvasIsBusyCode_(responses[i].getResponseCode()) || canvasIsRateLimited_(responses[i])) retryIndexes.push(i);
  }
  if (retryIndexes.length > 0) {
    Utilities.sleep(CANVAS_RETRY_WAIT_MS);
    var retried = canvasSend_(client, retryIndexes.map(function (index) { return urls[index]; }));
    retryIndexes.forEach(function (index, n) { responses[index] = retried[n]; });
  }
  return responses;
}

// Do the actual sending: one request uses fetch, several use fetchAll (in parallel).
// If Canvas can't be reached at all, UrlFetchApp throws; we replace its message with our
// own so nothing unexpected (like the token) can leak out.
function canvasSend_(client, urls) {
  try {
    if (urls.length === 1) {
      return [UrlFetchApp.fetch(urls[0], canvasRequestOptions_(client))];
    }
    var requests = urls.map(function (url) {
      var request = canvasRequestOptions_(client);
      request.url = url;
      return request;
    });
    // Copy into a fresh list so canvasFetchAll_ can swap in retried answers.
    return UrlFetchApp.fetchAll(requests).slice();
  } catch (e) {
    throw canvasError_('network', "Couldn't reach Canvas at " + client.baseUrl + '.');
  }
}

// 429 means "slow down"; 500 and up mean Canvas itself had a problem.
function canvasIsBusyCode_(code) {
  return code === 429 || code >= 500;
}

// Canvas also says "slow down" as a 403 with "Rate Limit Exceeded" in the answer.
var CANVAS_RATE_LIMIT_MESSAGE = 'Canvas is getting too many requests right now. This student will be ' +
  'tried again at the next update.';
function canvasIsRateLimited_(response) {
  if (response.getResponseCode() !== 403) return false;
  try {
    return /rate limit/i.test(response.getContentText());
  } catch (e) {
    return false;
  }
}

// Check Canvas's answer and turn it into data, or throw a plain-English error.
function canvasReadJson_(response, client) {
  var code = response.getResponseCode();
  if (code === 401) {
    throw canvasError_('auth', "Canvas didn't accept this student's token. It may have " +
      "expired or been deleted. Ask the student for a new token.");
  }
  if (canvasIsRateLimited_(response)) {
    throw canvasError_('unavailable', CANVAS_RATE_LIMIT_MESSAGE);
  }
  if (code === 403) {
    throw canvasError_('auth', "Canvas refused this student's token (HTTP 403). " +
      'Ask the student to make a new token.');
  }
  if (canvasIsBusyCode_(code)) {
    throw canvasError_('unavailable', 'Canvas is busy or down right now (HTTP ' + code +
      '). Try again later.');
  }
  if (code < 200 || code >= 300) {
    throw canvasError_('other', 'Canvas returned an error (HTTP ' + code + ').' +
      canvasErrorDetail_(response, client));
  }
  try {
    return JSON.parse(response.getContentText());
  } catch (e) {
    throw canvasError_('other', 'Canvas sent back something this tool could not read.');
  }
}

// Like canvasReadJson_, but the answer must be a list (one page of classes or assignments).
function canvasReadList_(response, client) {
  var data = canvasReadJson_(response, client);
  if (!Array.isArray(data)) {
    throw canvasError_('other', 'Canvas sent back something this tool could not read.');
  }
  return data;
}

// Canvas error answers often look like {"errors":[{"message":"..."}]}. If the message is
// short (and, to be safe, doesn't contain the token), add it to our error text.
function canvasErrorDetail_(response, client) {
  try {
    var body = JSON.parse(response.getContentText());
    var message = body && body.errors && body.errors[0] && body.errors[0].message;
    if (typeof message === 'string' && message.length > 0 && message.length < 120 &&
        (client.token === '' || message.indexOf(client.token) === -1)) {
      return ' Canvas said: "' + message + '"';
    }
  } catch (e) {
    // Not JSON: leave the detail out.
  }
  return '';
}

// Canvas splits long lists into pages. The address of the next page hides in the reply's
// "Link" header, in the part marked rel="next". Gives back that address, or null if this
// was the last page.
function canvasNextPageUrl_(response) {
  var headers = response.getAllHeaders() || {};
  var value = '';
  // Header names can arrive as "Link", "link", or "LINK", so compare in lowercase.
  Object.keys(headers).forEach(function (name) {
    if (name.toLowerCase() === 'link') value = headers[name];
  });
  // If Canvas sent the header more than once, the value is a list; join it into one string.
  if (Array.isArray(value)) value = value.join(',');
  var match = /<([^>]+)>;\s*rel="next"/.exec(String(value || ''));
  return match ? match[1] : null;
}

// Make an Error with a plain-English message and a `canvasKind` label for the caller.
function canvasError_(kind, message) {
  var err = new Error(message);
  err.canvasKind = kind;
  return err;
}

// =====================================================================================
// Bottom half: sorting assignments into weeks and days
// =====================================================================================

/**
 * Week grouping: the "sorting table" of AutoPlanner (a port of backend/processor.py).
 *
 * It takes the raw assignment list that Canvas.gs pulled from Canvas and turns it into a
 * tidy planner: which assignments are due, on what day and time, how urgent they are,
 * grouped first by week (Monday to Sunday) and then by day of the week.
 * Nothing here talks to Canvas or Google; it only rearranges the data it is handed.
 *
 * Output shape (the same JSON the Python version made, which Code.gs reads):
 * {
 *   weeks: {
 *     '2026-10-26': {
 *       week_label: 'Oct 26 – Nov 1',
 *       days: [ { day: 'Monday', assignments: [ ... ] }, ... seven days ... ]
 *     }
 *   },
 *   total_assignments: 14,
 *   generated_at: '2026-10-28T10:00:00'
 * }
 */

// The school's time zone. Used when no time zone is passed in.
var SCHEDULE_TIME_ZONE = 'America/New_York';

// How many weeks to show when no number is passed in (same default as the Python version).
var SCHEDULE_DEFAULT_WEEKS_AHEAD = 2;

// The days of the week in planner order (Monday first).
var SCHEDULE_WEEKDAY_NAMES = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
];

// Short English month names, used in week labels like "Oct 26 – Nov 1".
var SCHEDULE_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

// Milliseconds in one calendar day.
var SCHEDULE_MS_PER_DAY = 24 * 60 * 60 * 1000;

// The full sorting process, start to finish.
// Given (Canvas assignment, class name) pairs, the school's time zone, how many weeks to
// show, and (optionally) the current time, gives back the finished planner.
function buildWeeklySchedule_(pairs, timeZone, weeksAhead, now) {
  var zone = timeZone || SCHEDULE_TIME_ZONE;
  var weeks = (weeksAhead === undefined || weeksAhead === null)
    ? SCHEDULE_DEFAULT_WEEKS_AHEAD
    : Number(weeksAhead);
  var rightNow = now || new Date();
  // "Today" as a date string in the school's time zone, e.g. '2026-10-28'.
  var today = Utilities.formatDate(rightNow, zone, 'yyyy-MM-dd');

  // Step 1: tidy up each assignment, keeping only ones with a due date that hasn't passed.
  var tidied = [];
  (pairs || []).forEach(function (pair) {
    var item = normalizeAssignment_(pair[0], pair[1], zone, today);
    if (item !== null) tidied.push(item);
  });

  // Step 2: keep only the weeks that were asked for.
  var upcoming = filterAssignmentsInCalendarWeeks_(tidied, weeks, today);

  // Step 3: group by week, then split each week into its seven days.
  var byWeek = groupByWeek_(upcoming);
  var weeksOutput = {};
  Object.keys(byWeek).forEach(function (weekStart) {
    var weekEnd = scheduleAddDays_(weekStart, 6);
    weeksOutput[weekStart] = {
      week_label: scheduleShortDate_(weekStart) + ' – ' + scheduleShortDate_(weekEnd),
      days: groupByWeekday_(byWeek[weekStart])
    };
  });

  return {
    weeks: weeksOutput,
    total_assignments: upcoming.length,
    generated_at: Utilities.formatDate(rightNow, zone, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

// Clean up one Canvas assignment. Gives back a tidy summary, or null if it should be
// left off the planner (no due date, or due before this week's Monday).
// `today` is today's date string in the school's time zone.
function normalizeAssignment_(raw, courseName, timeZone, today) {
  // Assignments with no due date can't go on a day-by-day planner.
  if (!raw || !raw.due_at) return null;

  // Canvas sends due dates in UTC (ending in "Z"). Turn that into the school's local date
  // and time, so 11:59 PM in Connecticut doesn't show up as 3:59 AM the next day.
  var due = new Date(raw.due_at);
  if (isNaN(due.getTime())) return null;
  var dueDate = Utilities.formatDate(due, timeZone, 'yyyy-MM-dd');
  var dueTime = Utilities.formatDate(due, timeZone, 'h:mm a');

  // 0 = due today, 1 = tomorrow, and so on. Anything due earlier today still counts.
  var daysUntil = scheduleDaysBetween_(today, dueDate);
  // Work from earlier this week stays (as "Past due"), so a week keeps all of its assignments
  // and their Status and Notes until it ends and moves into "Past weeks".
  if (dueDate < scheduleWeekStart_(today)) return null;

  // The key order here matters: it matches the Python version's JSON exactly.
  return {
    day: SCHEDULE_WEEKDAY_NAMES[scheduleWeekdayIndex_(dueDate)],
    assignment: scheduleHasKey_(raw, 'name') ? raw.name : 'Untitled Assignment',
    course: courseName,
    due_time: dueTime,
    priority: schedulePriority_(daysUntil),
    days_until_due: daysUntil,
    due_date: dueDate,
    week_start: scheduleWeekStart_(dueDate),
    url: scheduleHasKey_(raw, 'html_url') ? raw.html_url : ''
  };
}

// Turn "how many days until this is due" into a short urgency label.
function schedulePriority_(days) {
  if (days < 0) return 'Past due';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days <= 3) return 'Due Soon';
  if (days <= 7) return 'This Week';
  return 'Upcoming';
}

// Keep assignments due from this week's Monday through the last Sunday of the requested window.
// Example: asked for 2 weeks on a Wednesday, it keeps work due from this Monday through next
// week's Sunday.
function filterAssignmentsInCalendarWeeks_(assignments, weeksAhead, today) {
  var monday = scheduleWeekStart_(today);
  var lastIncludedSunday = scheduleAddDays_(monday, weeksAhead * 7 - 1);
  // 'yyyy-MM-dd' strings sort the same way the dates do, so plain < and > work here.
  return assignments.filter(function (a) {
    return a.due_date >= monday && a.due_date <= lastIncludedSunday;
  });
}

// Sort assignments into weeks, keyed by each week's Monday (e.g. '2026-10-26').
// Sorting by due date first makes the weeks come out in order.
function groupByWeek_(assignments) {
  // JavaScript's sort keeps ties in their original order, just like Python's.
  var sorted = assignments.slice().sort(function (a, b) {
    return scheduleCompare_(a.due_date, b.due_date);
  });
  var grouped = {};
  sorted.forEach(function (a) {
    if (!grouped[a.week_start]) grouped[a.week_start] = [];
    grouped[a.week_start].push(a);
  });
  return grouped;
}

// Split one week's assignments into a Monday-to-Sunday list. Empty days still appear,
// so every week always shows all seven days.
function groupByWeekday_(assignments) {
  return SCHEDULE_WEEKDAY_NAMES.map(function (dayName) {
    var forDay = assignments.filter(function (a) { return a.day === dayName; });
    // Earliest due time first. Same time? Then by name. The time text is turned into
    // minutes first, because comparing text would put "10:00 AM" before "9:00 AM".
    forDay.sort(function (a, b) {
      return (a.days_until_due - b.days_until_due) ||
        (scheduleTimeToMinutes_(a.due_time) - scheduleTimeToMinutes_(b.due_time)) ||
        scheduleCompare_(a.assignment, b.assignment);
    });
    return { day: dayName, assignments: forDay };
  });
}

// ---- Small date helpers --------------------------------------------------------------
// These work on 'yyyy-MM-dd' text and do the math in UTC, where every day is exactly
// 24 hours long. That keeps daylight-saving-time switches from shifting any dates.

// Turn '2026-10-28' into a number of milliseconds (midnight UTC of that date).
function scheduleDateToMs_(dateText) {
  var parts = dateText.split('-');
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// Turn milliseconds back into 'yyyy-MM-dd' text.
function scheduleMsToDate_(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' +
    ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
    ('0' + d.getUTCDate()).slice(-2);
}

// Add (or subtract) whole days from a date string.
function scheduleAddDays_(dateText, days) {
  return scheduleMsToDate_(scheduleDateToMs_(dateText) + days * SCHEDULE_MS_PER_DAY);
}

// How many days from one date string to another (negative if `to` is earlier).
function scheduleDaysBetween_(from, to) {
  return Math.round((scheduleDateToMs_(to) - scheduleDateToMs_(from)) / SCHEDULE_MS_PER_DAY);
}

// Day of the week for a date string: 0 = Monday ... 6 = Sunday.
function scheduleWeekdayIndex_(dateText) {
  // getUTCDay() counts from Sunday = 0, so shift it to start on Monday.
  return (new Date(scheduleDateToMs_(dateText)).getUTCDay() + 6) % 7;
}

// The Monday of the week that contains this date.
function scheduleWeekStart_(dateText) {
  return scheduleAddDays_(dateText, -scheduleWeekdayIndex_(dateText));
}

// '2026-10-05' becomes 'Oct 5' (no leading zero).
function scheduleShortDate_(dateText) {
  var parts = dateText.split('-');
  return SCHEDULE_MONTH_NAMES[Number(parts[1]) - 1] + ' ' + Number(parts[2]);
}

// '9:00 PM' becomes minutes after midnight (21 * 60 = 1260). '12:00 AM' is 0.
function scheduleTimeToMinutes_(timeText) {
  var match = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(timeText));
  if (!match) return 0;
  var hours = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'P') hours += 12;
  return hours * 60 + Number(match[2]);
}

// Compare two values with plain < and > (character codes, like Python),
// not localeCompare, so "Zebra" comes before "apple" in both versions.
function scheduleCompare_(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// True if the object has this key at all (even if its value is empty), which is how
// Python's dict.get(key, default) decides whether to use the default.
function scheduleHasKey_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
