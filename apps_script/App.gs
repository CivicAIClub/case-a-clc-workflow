/**
 * AutoPlanner — the web app.
 *
 * Who may use it, the student list, updates (one student, everyone now, or on a schedule),
 * setup and selfTest. The page is Index.html. Canvas.gs reads Canvas; Code.gs writes the Docs.
 *
 * SAFETY RULE: any function whose name does NOT end in "_" can be called from the web page
 * (google.script.run) or run from the editor, so every one of them checks who is calling first:
 *   - page functions:       requireAllowedUser_()  (ALLOWED_USERS Script Property)
 *   - editor-only functions: requireOwner_()       (only the account that owns the script)
 *   - trigger functions:    requireTrigger_(e)     (only a real trigger of this project)
 *
 * Script Properties:
 *   ALLOWED_USERS       comma-separated Pomfret emails who may use the page (required)
 *   DOCS_FOLDER_ID      shared Drive folder for the Docs (required for the CLC setup)
 *   CANVAS_BASE_URL     optional; default https://pomfret.instructure.com
 *   COURSE_EXCLUDE      optional; comma-separated keywords. Classes whose name contains one
 *                       (e.g. advisory, dorm) are left out of the Docs entirely.
 *   TEST_CANVAS_TOKEN   only while running selfTest
 *   student.<id>, token.<id>, run.current, run.last   written by the app; don't edit by hand
 * Tokens live only in token.<id>. They are never sent to the page, logged, or put in a message.
 */

var APP_TIME_ZONE = 'America/New_York';
var APP_WEEKS_AHEAD = 4;
var APP_DEFAULT_CANVAS_BASE_URL = 'https://pomfret.instructure.com';
var APP_CONTACT = 'Cayden Auyang or Luke Ryan (Civic AI Club)';
var APP_DAILY_HOURS = [19, 0]; // 7 pm and midnight, America/New_York
// One student's Doc takes about 2 minutes (measured: 16 assignments, 97 s to create, 126 s to
// update). Starting nobody new after 2 minutes leaves each student about 4 minutes of the 6.
var APP_BATCH_BUDGET_MS = 2 * 60 * 1000; // don't start another student after this
var APP_DEFAULT_STUDENT_SECONDS = 150; // a student's update time until their first update is timed
var APP_RUN_RESERVE_MS = 30 * 1000; // kept free at the end of a batch for saving and scheduling
var APP_SAFETY_GRACE_MS = 2 * 60 * 1000; // the safety trigger fires this long after the time limit
var APP_CONTINUE_AFTER_MS = 60 * 1000; // next batch of a long run
var APP_SAFETY_CONTINUE_AFTER_MS = 8 * 60 * 1000; // resumes a run if a batch is cut off
var APP_RUN_STALE_MS = 15 * 60 * 1000; // a run with no progress this long is treated as stopped
var APP_STUDENT_BUSY_MS = 7 * 60 * 1000;
var APP_NOTICE_DAYS = 7; // how long a one-off message (e.g. "made a new Doc") stays on a row
// A run summary is one Script Property (9 KB at most), so it keeps this many problems in full.
var APP_MAX_FAILURES_KEPT = 20;
var APP_STALE_AFTER_MS = 26 * 3600 * 1000; // no finished update for this long means something is wrong
var APP_CANVAS_DOWN_STOP = 5; // a run stops after this many students in a row find Canvas down
var APP_TABS_WARN = 80; // the weekly email warns when a Doc has this many tabs (Google allows 100)
var APP_HEALTH_HOUR = 7; // the weekly health check: Mondays at about 7 AM, New York time
var APP_HEALTH_FAILING_MS = 20 * 3600 * 1000; // a student failing this long (two runs) goes in the email
var APP_PROPS_LIMIT_BYTES = 500 * 1024; // Google's limit on all Script Properties together
// The page warns this long before a student's Canvas token expires: three weeks, so tokens that run
// out during a two-week break (Oct 4 tokens expire Jan 2) are flagged while students are still here.
var APP_TOKEN_WARN_DAYS = 21;
// Drive said "Invalid argument" about a student's Doc: it's treated as gone only if an update at least
// this much later says the same (7 pm and midnight are 5 hours apart).
var APP_DOC_UNSURE_CONFIRM_MS = 4 * 3600 * 1000;

// =====================================================================================
// The web page
// =====================================================================================

function doGet() {
  var email = currentUserEmail_();
  if (!isAllowedUser_(email)) return notAuthorizedPage_(email);
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('AutoPlanner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * The page for anyone not on ALLOWED_USERS, in the same design as Index.html (its tokens, fonts and
 * header). It shows no data and offers no actions; doGet's access check above is the only gate.
 */
function notAuthorizedPage_(email) {
  var who = email
    ? '<p class="t-mono who">Signed in as <span class="who-v">' + escapeHtml_(email) + '</span></p>'
    : '';
  var unknown = email
    ? ''
    : '<p class="hint">Google did not tell AutoPlanner which Pomfret account you are using.</p>';
  var html =
    '<!DOCTYPE html><html lang="en"><head><base target="_top" /><meta charset="UTF-8" />' +
    '<link rel="preconnect" href="https://fonts.googleapis.com" />' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />' +
    '<link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@300;400;600' +
    '&family=Martian+Mono:wght@400&display=swap" rel="stylesheet" />' +
    '<style>' +
    // The same tokens and header as Index.html.
    ':root{--ink:#0d0d0c;--paper:#f4f3ef;--ink-2:#5f5d58;--crimson:#a8172b;--mark-text:#fbfaf7;' +
    '--rule:rgb(13 13 12 / 0.25);--font-sans:"Host Grotesk","Helvetica Neue",Arial,sans-serif;' +
    '--font-mono:"Martian Mono",ui-monospace,"SFMono-Regular",Menlo,monospace;--fs-mono:11px;' +
    '--ls-mono:0.04em;--fs-ui:14px;--fs-body:clamp(16px,0.9rem + 0.2vw,18px);--fs-label:20px;' +
    '--fw-light:300;--fw-regular:400;--margin:40px;--gutter:20px;--header-height:62px}' +
    '@media (max-width:1023px){:root{--margin:24px;--gutter:16px;--fs-label:18px}}' +
    '@media (max-width:767px){:root{--margin:16px;--gutter:12px;--fs-label:17px;--header-height:56px}}' +
    '*,*::before,*::after{box-sizing:border-box}html,body,p{margin:0}' +
    'html{background:var(--paper);color:var(--ink);font-family:var(--font-sans);' +
    'font-weight:var(--fw-light);-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}' +
    'body{min-height:100vh;font-size:var(--fs-body);line-height:1.35;overflow-x:clip}' +
    '::selection{background:var(--crimson);color:var(--mark-text)}' +
    '.t-mono{font-family:var(--font-mono);font-size:var(--fs-mono);font-weight:var(--fw-regular);' +
    'letter-spacing:var(--ls-mono);line-height:1.3;text-transform:uppercase}' +
    '.page{width:100%;max-width:calc(900px + 2 * var(--margin));margin:0 auto;padding-inline:var(--margin)}' +
    '.site-header{border-bottom:1px solid var(--rule)}' +
    '.header-inner{min-height:var(--header-height);display:flex;align-items:center;' +
    'justify-content:space-between;gap:8px var(--gutter);flex-wrap:wrap;padding-block:12px}' +
    '.brand{display:flex;align-items:baseline;gap:4px 18px;flex-wrap:wrap}' +
    '.brand-name{font-size:var(--fs-label);font-weight:var(--fw-regular);letter-spacing:-0.01em;line-height:1.2}' +
    '.brand-sub,.who{color:var(--ink-2)}.who-v{color:var(--ink);text-transform:none;letter-spacing:0;overflow-wrap:anywhere}' +
    '.block{margin-top:48px;border-top:1px solid var(--ink);padding-top:16px}' +
    '.flag{display:inline-block;padding:3px 6px;background:var(--ink);color:var(--paper)}' +
    '.lede{margin-top:20px;max-width:34em;font-size:var(--fs-label);line-height:1.3;letter-spacing:-0.01em}' +
    '.hint{margin-top:16px;max-width:46em;color:var(--ink-2);font-size:var(--fs-ui);line-height:1.45}' +
    '.site-footer{margin-top:72px;padding-bottom:40px;color:var(--ink-2)}' +
    '.site-footer p{border-top:1px solid var(--rule);padding-top:16px;font-size:var(--fs-ui);line-height:1.45}' +
    '@media (max-width:767px){.block{margin-top:32px}}' +
    '</style></head><body>' +
    '<header class="site-header"><div class="page header-inner"><div class="brand">' +
    '<span class="brand-name">AutoPlanner</span>' +
    '<span class="t-mono brand-sub">CLC Supported Study Hall · Pomfret School</span></div>' + who +
    '</div></header>' +
    '<main class="page"><div class="block"><p class="t-mono"><span class="flag">Not authorized</span></p>' +
    '<p class="lede">This page is only for CLC staff. If you need access, contact Cayden Auyang or Luke Ryan.</p>' +
    unknown +
    '<p class="hint">Signed in to more than one Google account? Open AutoPlanner in a browser window ' +
    'signed in only to your Pomfret account.</p></div></main>' +
    '<footer class="page site-footer"><p>Built by the Pomfret Civic AI Club</p></footer>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('AutoPlanner: not authorized')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Everything the page needs to draw itself. */
function getAppState() {
  var email = requireAllowedUser_();
  syncTeachersFromDrive_();
  return {
    user: email,
    teachers: clcTeachers_().map(function (t) { return { name: t.name, email: t.email }; }),
    students: listStudents_().map(publicStudent_),
    run: publicRun_(readJson_('run.current')),
    lastRun: readJson_('run.last'),
    automaticUpdatesOn: dailyTriggerCount_() === APP_DAILY_HOURS.length,
    pausedSince: pausedSince_(),
    updatesStaleSince: updatesStaleSince_(),
    tokensExpiring: tokensExpiringSoon_(),
    contact: APP_CONTACT,
  };
}

/**
 * When the last finished update is over a day old (and none is running), its time; otherwise null.
 * The automatic updates would have finished one by now, so a trigger is failing (for example the
 * owner's account was closed or lost its permissions) and staff should tell the club.
 */
function updatesStaleSince_() {
  var last = readJson_('run.last');
  if (!last || !last.finishedAt || activeRun_() || pausedSince_()) return null;
  return Date.now() - new Date(last.finishedAt).getTime() > APP_STALE_AFTER_MS ? last.finishedAt : null;
}

/**
 * Add a student from their Canvas token. Checks the token with Canvas before saving it. `teacher`
 * (optional) is a CLC teacher's email; their Doc then lives in that teacher's folder.
 */
function addStudent(token, label, teacher) {
  var email = requireAllowedUser_();
  token = cleanToken_(token);
  if (!token) throw new Error("Paste the student's Canvas token first.");
  var teacherEmail = String(teacher || '').trim().toLowerCase();
  if (teacherEmail && !teacherByEmail_(teacherEmail)) throw new Error('That CLC teacher is no longer on the list. Reload the page.');
  var profile = canvasProfileOrFriendlyError_(token);
  // Teacher folders are looked up (and made if needed) before the lock below: making one takes
  // the same lock.
  try {
    teacherFolders_();
  } catch (err) {
    if (teacherEmail) throw new Error(friendlyError_(err));
  }

  return withLock_(function () {
    var students = listStudents_();
    for (var i = 0; i < students.length; i++) {
      if (String(students[i].canvasUserId) === String(profile.id)) {
        throw new Error(
          profile.name + ' is already on the list' +
            (students[i].label ? ' (as "' + students[i].label + '")' : '') +
            '. To give them a new token, click Edit on their row.'
        );
      }
    }
    var docId = findReusableDoc_(profile.name, null);
    var student = {
      id: Utilities.getUuid(),
      label: cleanLabel_(label),
      name: profile.name,
      canvasUserId: profile.id,
      docId: docId,
      teacher: teacherEmail,
      addedAt: new Date().toISOString(),
      addedBy: email,
      last: null,
    };
    // An existing Doc goes into the chosen teacher's folder; with no teacher chosen, it keeps the
    // teacher whose folder it's already in.
    if (docId) {
      if (teacherEmail) moveDocToTeacher_(docId, teacherEmail);
      else syncStudentTeacher_(student);
    }
    setTokenDates_(student, token);
    saveStudent_(student);
    PropertiesService.getScriptProperties().setProperty('token.' + student.id, token);
    return {
      student: publicStudent_(student),
      message: docId
        ? 'Added ' + profile.name + '. Found their existing Doc in the shared folder; it will be reused.'
        : 'Added ' + profile.name + '.',
    };
  });
}

/** Change a student's label and/or give them a new token (it must be the same Canvas user). */
function editStudent(id, label, newToken) {
  requireAllowedUser_();
  var token = cleanToken_(newToken);
  var profile = token ? canvasProfileOrFriendlyError_(token) : null;
  return withLock_(function () {
    var student = getStudent_(id);
    if (!student) throw new Error('That student is no longer on the list. Reload the page.');
    if (profile && String(profile.id) !== String(student.canvasUserId)) {
      throw new Error(
        'That token belongs to ' + profile.name + ', not ' + student.name +
          '. To add ' + profile.name + ', use "Add student" instead.'
      );
    }
    student.label = cleanLabel_(label);
    if (profile) {
      student.name = profile.name;
      PropertiesService.getScriptProperties().setProperty('token.' + id, token);
      setTokenDates_(student, token);
    }
    saveStudent_(student);
    return publicStudent_(student);
  });
}

/** Records when this token was added and when Canvas says it expires (null if Canvas doesn't say). */
function setTokenDates_(student, token) {
  var info = fetchCanvasTokenExpiry_(token, canvasBaseUrl_());
  student.tokenAddedAt = new Date().toISOString();
  student.tokenExpiresAt = info ? info.expiresAt : null;
  student.tokenChecked = !!info;
}

/** "Jan 2, 2027" in New York time. */
function shortDate_(iso) {
  return Utilities.formatDate(new Date(iso), APP_TIME_ZONE, 'MMM d, yyyy');
}

/** Students whose token expires within APP_TOKEN_WARN_DAYS (or already has), soonest first. */
function tokensExpiringSoon_() {
  var limit = Date.now() + APP_TOKEN_WARN_DAYS * 24 * 3600 * 1000;
  return listStudents_().filter(function (s) {
    return s.tokenExpiresAt && new Date(s.tokenExpiresAt).getTime() <= limit;
  }).sort(function (a, b) {
    return new Date(a.tokenExpiresAt).getTime() - new Date(b.tokenExpiresAt).getTime();
  }).map(function (s) {
    return { name: s.name || 'Student', date: shortDate_(s.tokenExpiresAt), expired: new Date(s.tokenExpiresAt).getTime() <= Date.now() };
  });
}

/** Remove a student and their token. Their Doc stays in the shared folder. */
function removeStudent(id) {
  requireAllowedUser_();
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty('student.' + id);
    props.deleteProperty('token.' + id);
    props.deleteProperty('busy.' + id);
    return true;
  });
}

/** Update one student's Doc right away (about 1–2 minutes). */
function updateStudentNow(id) {
  requireAllowedUser_();
  if (activeRun_()) {
    throw new Error('An update for all students is running. This student is included in it.');
  }
  var result = updateOneStudent_(id);
  if (result.skipped) throw new Error(result.message);
  return publicStudent_(getStudent_(id));
}

/** "Update all students now": starts a run and works through the first batch. */
function startUpdateAll() {
  var email = requireAllowedUser_();
  var started = startRun_('manual', email);
  return {
    alreadyRunning: !started,
    run: publicRun_(readJson_('run.current')),
    lastRun: readJson_('run.last'),
    students: listStudents_().map(publicStudent_),
  };
}

/** Progress of the current run, polled by the page every few seconds. */
function getRunStatus() {
  requireAllowedUser_();
  return {
    run: publicRun_(readJson_('run.current')),
    lastRun: readJson_('run.last'),
    students: listStudents_().map(publicStudent_),
  };
}

// =====================================================================================
// Who is calling
// =====================================================================================

function currentUserEmail_() {
  var email = '';
  try {
    email = Session.getActiveUser().getEmail();
  } catch (err) {
    email = '';
  }
  return String(email || '').trim().toLowerCase();
}

function allowedUsers_() {
  return getScriptProperty_('ALLOWED_USERS')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s; });
}

function isAllowedUser_(email) {
  return !!email && allowedUsers_().indexOf(email) !== -1;
}

function requireAllowedUser_() {
  var email = currentUserEmail_();
  if (!isAllowedUser_(email)) {
    throw new Error('Not authorized. AutoPlanner is only open to CLC staff. Contact ' + APP_CONTACT + '.');
  }
  return email;
}

/** Editor-only functions: the person running it must be the account that owns the script. */
function requireOwner_() {
  var active = currentUserEmail_();
  var owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!active || active !== owner) {
    throw new Error('Only the script owner can run this, from the Apps Script editor.');
  }
  return owner;
}

/** Trigger functions: `e` must come from a trigger that really belongs to this project. */
function requireTrigger_(e) {
  var uid = e && e.triggerUid ? String(e.triggerUid) : '';
  var found = uid && ScriptApp.getProjectTriggers().some(function (t) {
    return t.getUniqueId() === uid;
  });
  if (!found) throw new Error('This function only runs from its own trigger.');
  return uid;
}

// =====================================================================================
// Storage (Script Properties). One property per student keeps each under the 9 KB limit.
// =====================================================================================

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('AutoPlanner is busy saving another change. Try again in a moment.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function readJson_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function writeJson_(key, value) {
  var props = PropertiesService.getScriptProperties();
  if (value === null || value === undefined) props.deleteProperty(key);
  else props.setProperty(key, JSON.stringify(value));
}

function getStudent_(id) {
  return readJson_('student.' + id);
}

function saveStudent_(student) {
  writeJson_('student.' + student.id, student);
}

function getToken_(id) {
  return PropertiesService.getScriptProperties().getProperty('token.' + id) || '';
}

/** All students, sorted by name (then label). */
function listStudents_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var students = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('student.') !== 0) return;
    try {
      students.push(JSON.parse(all[key]));
    } catch (err) {
      /* skip a damaged record */
    }
  });
  students.sort(function (a, b) {
    var ka = (String(a.name || '') + ' ' + String(a.label || '')).toLowerCase();
    var kb = (String(b.name || '') + ' ' + String(b.label || '')).toLowerCase();
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return students;
}

/** What the page may see about a student: never the token, only its last 4 characters. */
function publicStudent_(s) {
  var token = getToken_(s.id);
  return {
    id: s.id,
    label: s.label || '',
    name: s.name || 'Student',
    tokenEnd: token ? token.slice(-4) : '',
    docUrl: s.docId ? 'https://docs.google.com/document/d/' + s.docId + '/edit' : '',
    last: s.last || null,
    notice: recentNotice_(s.notice),
    teacher: s.teacher && teacherByEmail_(s.teacher) ? s.teacher : '',
    tokenDate: s.tokenExpiresAt
      ? (new Date(s.tokenExpiresAt).getTime() <= Date.now() ? 'Token expired ' : 'Token expires ') + shortDate_(s.tokenExpiresAt)
      : s.tokenAddedAt ? 'Token added ' + shortDate_(s.tokenAddedAt) : '',
  };
}

/** A one-off row message, while it's less than APP_NOTICE_DAYS old; otherwise null. */
function recentNotice_(notice) {
  if (!notice || !notice.at || !notice.message) return null;
  var age = Date.now() - new Date(notice.at).getTime();
  return age >= 0 && age < APP_NOTICE_DAYS * 24 * 3600 * 1000 ? { at: notice.at, message: notice.message } : null;
}

function cleanToken_(token) {
  return String(token || '').replace(/\s+/g, '');
}

function cleanLabel_(label) {
  return String(label || '').trim().substring(0, 60);
}

/** Keywords from COURSE_EXCLUDE (e.g. "advisory, dorm"); classes containing one are hidden. */
function courseExcludeKeywords_() {
  return getScriptProperty_('COURSE_EXCLUDE')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

function canvasBaseUrl_() {
  return getScriptProperty_('CANVAS_BASE_URL') || APP_DEFAULT_CANVAS_BASE_URL;
}

function canvasProfileOrFriendlyError_(token) {
  try {
    return fetchCanvasProfile_(token, canvasBaseUrl_());
  } catch (err) {
    throw new Error(friendlyError_(err, token));
  }
}

/** Plain-English error text, with the token scrubbed out just in case, kept short. */
function friendlyError_(err, token) {
  var msg = String((err && err.message) || err || 'Unknown error').replace(/^Error:\s*/, '');
  if (token) msg = msg.split(token).join('[token]');
  if (err && err.canvasKind) {
    // Canvas messages are already plain English (and a Canvas 429 isn't a Docs problem).
  } else if (docsApiIsQuotaError_(msg)) {
    msg = 'Google is limiting how fast Docs can be edited right now. This student will be tried again at the next update.';
  } else if (APP_RAW_GOOGLE_ERROR.test(msg)) {
    console.warn('Raw error shown to staff in plain words: ' + msg);
    msg = 'Google Docs or Drive had a temporary problem. This student will be tried again at the next ' +
      'update. If it keeps happening, contact ' + APP_CONTACT + '.';
  }
  return msg.length > 300 ? msg.substring(0, 297) + '…' : msg;
}

// Google's own error texts (and a few internal ones) that mean nothing to staff.
var APP_RAW_GOOGLE_ERROR = new RegExp([
  'Exception:', 'Service error', 'server error', 'Internal error', 'unavailable', 'Backend Error',
  'GoogleJsonResponseException', 'Invalid requests\\[', 'addDocumentTab failed', 'Timed out clearing',
  'Table cell has no paragraph', 'Service invoked too many times',
].join('|'), 'i');

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// =====================================================================================
// CLC teachers: one folder each, inside the shared folder
// =====================================================================================

/**
 * The CLC teachers, from the CLC_TEACHERS Script Property ("Name <email>, Name <email>"), in that
 * order: [{ name, email }]. Adding a teacher later is just editing that property.
 */
function clcTeachers_() {
  var raw = getScriptProperty_('CLC_TEACHERS');
  var re = /([^<>,]+?)\s*<\s*([^<>\s,]+@[^<>\s,]+)\s*>/g;
  var out = [];
  var seen = {};
  var m;
  while ((m = re.exec(raw))) {
    var email = m[2].toLowerCase();
    if (seen[email]) continue;
    seen[email] = true;
    out.push({ name: m[1].trim(), email: email });
  }
  return out;
}

function teacherByEmail_(email) {
  var e = String(email || '').trim().toLowerCase();
  return clcTeachers_().filter(function (t) { return t.email === e; })[0] || null;
}

var teacherFolderCache_ = null;

/**
 * { email: Folder } with every CLC teacher's folder, inside the shared folder and named with their
 * full name. A folder is made the first time it's needed, and again if it's trashed, deleted or
 * moved out of the shared folder (its ID is kept in the "teacherFolders" Script Property).
 * Folders made inside the shared folder share it with the same people; sharing is never changed.
 */
function teacherFolders_() {
  if (teacherFolderCache_) return teacherFolderCache_;
  var shared = getDocsFolder_();
  var teachers = clcTeachers_();
  var map = {};
  if (!shared || !teachers.length) return (teacherFolderCache_ = map);
  var stored = readJson_('teacherFolders') || {};
  var usable = function (id) {
    try {
      var f = DriveApp.getFolderById(id);
      return !f.isTrashed() && isInsideFolder_(f, shared.getId(), 0) ? f : null;
    } catch (e) {
      return null;
    }
  };
  var missing = teachers.filter(function (t) {
    var f = stored[t.email] ? usable(stored[t.email]) : null;
    if (f) map[t.email] = f;
    return !f;
  });
  if (missing.length) {
    withLock_(function () {
      stored = readJson_('teacherFolders') || {};
      missing.forEach(function (t) {
        var f = stored[t.email] ? usable(stored[t.email]) : null;
        if (!f) {
          var byName = shared.getFoldersByName(t.name);
          while (!f && byName.hasNext()) {
            var c = byName.next();
            if (!c.isTrashed()) f = c;
          }
        }
        if (!f) f = shared.createFolder(t.name);
        // The old folder was trashed or moved out of the shared folder: its Docs come along.
        if (stored[t.email] && stored[t.email] !== f.getId()) rescueTeacherFolder_(stored[t.email], f);
        stored[t.email] = f.getId();
        map[t.email] = f;
      });
      writeJson_('teacherFolders', stored);
    });
  }
  return (teacherFolderCache_ = map);
}

/**
 * Moves every file from a teacher's old folder (trashed, or moved out of the shared folder) into
 * their new one, out of the trash, so their students keep the same Docs, Status and Notes. A
 * folder deleted for good can't be helped: those Docs are gone, and new ones are made.
 */
function rescueTeacherFolder_(oldId, dest) {
  var old;
  try {
    old = DriveApp.getFolderById(oldId);
  } catch (e) {
    return 0;
  }
  var moved = 0;
  var files = old.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    try {
      try {
        file.moveTo(dest);
      } catch (e) {
        file.setTrashed(false); // Drive may not move a file that's in the trash
        file.moveTo(dest);
      }
      if (file.isTrashed()) file.setTrashed(false);
      moved++;
    } catch (err) {
      console.warn('Could not move a file out of an old teacher folder: ' + err);
    }
  }
  if (moved) console.log('Moved ' + moved + ' Doc(s) from a trashed or moved teacher folder into "' + dest.getName() + '".');
  return moved;
}

/** Who a Drive folder belongs to: a teacher's email, '' for the shared folder itself, else null. */
function teacherOfFolderId_(folderId) {
  var shared = getDocsFolder_();
  if (shared && folderId === shared.getId()) return '';
  var folders = teacherFolders_();
  var found = null;
  Object.keys(folders).forEach(function (email) {
    if (folders[email].getId() === folderId) found = email;
  });
  return found;
}

/** The IDs of the folders a Doc is in. */
function docFolderIds_(docId) {
  var ids = [];
  var parents = DriveApp.getFileById(docId).getParents();
  while (parents.hasNext()) ids.push(parents.next().getId());
  return ids;
}

/** Moves a Doc into the teacher's folder ('' = the shared folder itself). Same Doc, same link. */
function moveDocToTeacher_(docId, email) {
  var dest = email ? teacherFolders_()[email] : getDocsFolder_();
  if (!dest) throw new Error("That CLC teacher's folder isn't available. Contact " + APP_CONTACT + '.');
  if (docFolderIds_(docId).indexOf(dest.getId()) === -1) DriveApp.getFileById(docId).moveTo(dest);
}

/**
 * Brings a student's teacher in line with where their Doc is (staff can drag a Doc between teacher
 * folders in Drive): a Doc in a teacher's folder takes that teacher, a Doc in the shared folder
 * itself is Unassigned. A teacher removed from CLC_TEACHERS: their students become Unassigned and
 * their Docs move back to the shared folder; nothing is deleted. Gives back true if it changed.
 */
function syncStudentTeacher_(student, folderIds) {
  var before = student.teacher || '';
  if (!before && !clcTeachers_().length) return false; // no CLC teachers set up: nothing to do
  if (student.teacher && !teacherByEmail_(student.teacher)) {
    student.teacher = '';
    if (student.docId) {
      try {
        moveDocToTeacher_(student.docId, '');
      } catch (e) {
        console.warn('Could not move a removed teacher\'s student Doc back: ' + e);
      }
    }
    return before !== '';
  }
  if (!student.docId) return false;
  var ids = folderIds || docFolderIds_(student.docId);
  for (var i = 0; i < ids.length; i++) {
    var owner = teacherOfFolderId_(ids[i]);
    if (owner !== null) {
      student.teacher = owner;
      break;
    }
  }
  return (student.teacher || '') !== before;
}

/**
 * Page load: one listing of each teacher's folder and the shared folder, so Docs dragged between
 * folders in Drive show the right teacher straight away. Never stops the page from loading.
 */
function syncTeachersFromDrive_() {
  try {
    var shared = getDocsFolder_();
    if (!shared) return;
    if (!clcTeachers_().length && !listStudents_().some(function (s) { return s.teacher; })) return;
    var where = {};
    var list = function (folder, email) {
      var files = folder.getFilesByType(MimeType.GOOGLE_DOCS);
      while (files.hasNext()) where[files.next().getId()] = email;
    };
    list(shared, '');
    var folders = teacherFolders_();
    Object.keys(folders).forEach(function (email) { list(folders[email], email); });
    listStudents_().forEach(function (s) {
      var removed = s.teacher && !teacherByEmail_(s.teacher);
      var here = s.docId && Object.prototype.hasOwnProperty.call(where, s.docId) ? where[s.docId] : null;
      if (!removed && (here === null || here === (s.teacher || ''))) return;
      withLock_(function () {
        var fresh = getStudent_(s.id);
        if (!fresh) return;
        if (removed) syncStudentTeacher_(fresh);
        else fresh.teacher = here;
        saveStudent_(fresh);
      });
    });
  } catch (err) {
    console.warn('Teacher folders not checked on page load: ' + err);
  }
}

/** Set a student's CLC teacher ('' = Unassigned). Moves their Doc (the same Doc) right away. */
function setStudentTeacher(id, email) {
  requireAllowedUser_();
  var e = String(email || '').trim().toLowerCase();
  var teacher = e ? teacherByEmail_(e) : null;
  if (e && !teacher) throw new Error('That CLC teacher is no longer on the list. Reload the page.');
  var student = getStudent_(id);
  if (!student) throw new Error('That student is no longer on the list. Reload the page.');
  var moved = false;
  if (student.docId) {
    try {
      moveDocToTeacher_(student.docId, e);
      moved = true;
    } catch (err) {
      throw new Error(friendlyError_(err));
    }
  }
  student = withLock_(function () {
    var fresh = getStudent_(id) || student;
    fresh.teacher = e;
    saveStudent_(fresh);
    return fresh;
  });
  var name = student.name || 'This student';
  var message = !moved
    ? 'Saved. ' + name + '\'s Doc will be made in ' + (teacher ? teacher.name + '\'s folder.' : 'the shared folder.')
    : teacher
      ? 'Moved ' + name + '\'s Doc into ' + teacher.name + '\'s folder. Same Doc and link, with all its notes.'
      : 'Moved ' + name + '\'s Doc back to the shared folder (no CLC teacher). Same Doc and link, with all its notes.';
  return { student: publicStudent_(student), message: message };
}

// =====================================================================================
// Finding an existing Doc (so a re-added student keeps their old Doc)
// =====================================================================================

/**
 * Looks in the shared folder for "<name> - CLC Assignments" and returns its ID, skipping Docs
 * that already belong to another student on the list. Newest wins if there are several.
 */
function findReusableDoc_(name, forStudentId) {
  var folder = getDocsFolder_();
  if (!folder || !name) return null;
  var title = buildDocumentTitle_({ studentFullName: name });
  var taken = {};
  listStudents_().forEach(function (s) {
    if (s.docId && s.id !== forStudentId) taken[s.docId] = true;
  });
  var query =
    "title = '" + title.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'" +
    " and mimeType = 'application/vnd.google-apps.document' and trashed = false";
  // The shared folder and every CLC teacher's folder inside it.
  var places = [folder];
  try {
    var folders = teacherFolders_();
    Object.keys(folders).forEach(function (email) { places.push(folders[email]); });
  } catch (e) {
    console.warn('Teacher folders not searched: ' + e);
  }
  var best = null;
  places.forEach(function (place) {
    var files = place.searchFiles(query);
    while (files.hasNext()) {
      var f = files.next();
      if (taken[f.getId()]) continue;
      if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
    }
  });
  return best ? best.getId() : null;
}

// =====================================================================================
// Updating one student
// =====================================================================================

/**
 * Fetch one student's Canvas assignments and write their Doc. Never throws: the result is saved
 * on the student (last) and returned, so one bad token can't stop the other students.
 */
function updateOneStudent_(id) {
  var student = getStudent_(id);
  if (!student) return { ok: false, skipped: true, message: 'That student was removed.' };
  if (!claimStudent_(id)) {
    return { ok: false, skipped: true, busy: true, name: student.name, message: 'This student is already being updated. Try again in a minute.' };
  }
  var token = getToken_(id);
  var result;
  var docInfo = {};
  var startedAt = Date.now();
  // Students added before AutoPlanner knew about expiry dates: ask Canvas once.
  var tokenInfo = student.tokenChecked ? null : fetchCanvasTokenExpiry_(token, canvasBaseUrl_());
  var applyTokenInfo = function (s) {
    if (!tokenInfo || s.tokenChecked) return;
    s.tokenExpiresAt = tokenInfo.expiresAt;
    s.tokenChecked = true;
    if (!s.tokenAddedAt && tokenInfo.createdAt) s.tokenAddedAt = tokenInfo.createdAt;
  };
  try {
    var schedule = fetchStudentSchedule_(token, canvasBaseUrl_(), APP_WEEKS_AHEAD, undefined, courseExcludeKeywords_());
    if (
      student.canvasUserId !== undefined && student.canvasUserId !== null &&
      schedule.canvas_user_id !== undefined &&
      String(schedule.canvas_user_id) !== String(student.canvasUserId)
    ) {
      throw new Error(
        'This token now belongs to a different Canvas user (' + schedule.student_full_name +
          '). Click Edit and paste ' + student.name + "'s own token."
      );
    }
    // A Doc dragged into another teacher's folder in Drive brings that teacher with it.
    try {
      if (syncStudentTeacher_(student)) {
        var adopted = student.teacher;
        withLock_(function () {
          var fresh = getStudent_(id);
          if (fresh) {
            fresh.teacher = adopted;
            saveStudent_(fresh);
          }
        });
      }
    } catch (e) {
      console.warn('Teacher folder not checked: ' + e);
    }
    var teacherUsed = student.teacher || '';
    var docId = writeDocWithRecovery_(student, schedule, docInfo);
    student = getStudent_(id) || student;
    // Staff picked another CLC teacher while this update was writing (a new Doc goes into the
    // folder of the teacher it started with): put the Doc where the row now says.
    if ((student.teacher || '') !== teacherUsed && (!student.teacher || teacherByEmail_(student.teacher))) {
      try {
        moveDocToTeacher_(docId, student.teacher || '');
      } catch (e) {
        console.warn('Doc not moved to the new CLC teacher: ' + e);
      }
    }
    applyTokenInfo(student);
    delete student.docUnsureSince;
    delete student.failingSince;
    if (docInfo.tabs) student.docTabs = docInfo.tabs; // the weekly email warns well before Google's 100
    student.name = schedule.student_full_name || student.name;
    student.docId = docId;
    if (docInfo.replaced) student.notice = { at: new Date().toISOString(), message: docInfo.replaced };
    var count = schedule.total_assignments || 0;
    student.lastSeconds = Math.round((Date.now() - startedAt) / 1000);
    student.last = {
      at: new Date().toISOString(),
      ok: true,
      message: docInfo.weeksDone < docInfo.weeksTotal
        ? 'Updated ' + docInfo.weeksDone + ' of ' + docInfo.weeksTotal + ' weeks: Google Docs was slow, so the other ' +
          'weeks will be updated at the next update (their Status and Notes are kept).'
        : 'Updated: ' + count + ' assignment' + (count === 1 ? '' : 's') + ' in the next ' + APP_WEEKS_AHEAD + ' weeks.',
    };
    result = { ok: true, name: student.name, message: student.last.message };
  } catch (err) {
    student = getStudent_(id) || student;
    applyTokenInfo(student);
    if (docInfo.docUnsureSince) student.docUnsureSince = docInfo.docUnsureSince;
    var message = friendlyError_(err, token);
    if (err && err.canvasKind === 'auth' && student.tokenExpiresAt && new Date(student.tokenExpiresAt).getTime() <= Date.now()) {
      message = "This student's Canvas token expired on " + shortDate_(student.tokenExpiresAt) + '. Ask the student for a ' +
        'new token, then click Edit on their row, paste it and click Save.';
    }
    student.last = { at: new Date().toISOString(), ok: false, message: message };
    student.failingSince = student.failingSince || student.last.at; // for the weekly health check
    result = { ok: false, name: student.name, message: student.last.message };
    if (err && (err.canvasKind === 'unavailable' || err.canvasKind === 'network')) result.canvasDown = true;
  } finally {
    PropertiesService.getScriptProperties().deleteProperty('busy.' + id);
  }
  if (getStudent_(id)) saveStudent_(student); // unless they were removed meanwhile
  return result;
}

/**
 * Writes the Doc; if the saved Doc is in the trash or deleted, reuses or creates one instead, and
 * puts a message for the student's row in `info.replaced`. Returns the Doc's ID.
 */
function writeDocWithRecovery_(student, schedule, info) {
  var payload = {};
  Object.keys(schedule).forEach(function (k) { payload[k] = schedule[k]; });
  payload.studentFullName = schedule.student_full_name;
  var teacher = student.teacher ? teacherByEmail_(student.teacher) : null;
  if (teacher) {
    payload.teacherName = teacher.name;
    var folders = teacherFolders_();
    if (folders[teacher.email]) payload.targetFolderId = folders[teacher.email].getId();
  }
  var docId = student.docId || findReusableDoc_(schedule.student_full_name, student.id);
  if (docId) payload.documentId = docId;
  if (info && info.noDeadline) payload.noDeadline = true;
  var done = function (res) {
    if (info) {
      info.weeksDone = res.weeksDone;
      info.weeksTotal = res.weeksTotal;
      info.tabs = res.tabs;
    }
    return res.documentId;
  };
  try {
    return done(upsertPlannerDocument_(payload));
  } catch (err) {
    var msg = String(err.message || err);
    if (docId && msg.indexOf(DOC_UNSURE_PREFIX) === 0) {
      // Not sure yet: remember when it started, and only treat the Doc as gone once an update at
      // least APP_DOC_UNSURE_CONFIRM_MS later still can't find it.
      var since = student.docUnsureSince ? new Date(student.docUnsureSince).getTime() : 0;
      if (!since || Date.now() - since < APP_DOC_UNSURE_CONFIRM_MS) {
        if (info) info.docUnsureSince = student.docUnsureSince || new Date().toISOString();
        throw err;
      }
    } else if (!docId || msg.indexOf(DOC_GONE_PREFIX) === -1) {
      throw err;
    }
    // The saved Doc is gone (deleted or in the trash): start again with a reused or new Doc.
    delete payload.documentId;
    var other = findReusableDoc_(schedule.student_full_name, student.id);
    // Drive can still find the same Doc, not in the trash: it was a hiccup, not a deleted Doc.
    if (other === docId) {
      throw new Error("Google Drive didn't answer about this student's Doc. They'll be tried again at the next update.");
    }
    if (other) payload.documentId = other;
    payload.previousDocId = docId; // its record of Statuses comes along
    var newId = done(upsertPlannerDocument_(payload));
    if (info) {
      info.replaced = payload.documentId
        ? 'Their Doc was deleted, so AutoPlanner switched to their other Doc in the shared folder.'
        : 'Their Doc was deleted, so AutoPlanner made a new one.';
    }
    return newId;
  }
}

/** Marks a student as "being updated" so two updates never write the same Doc at once. */
function claimStudent_(id) {
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var since = Number(props.getProperty('busy.' + id) || 0);
    if (since && Date.now() - since < APP_STUDENT_BUSY_MS) return false;
    props.setProperty('busy.' + id, String(Date.now()));
    return true;
  });
}

// =====================================================================================
// Runs: update every student, in batches that stay under Apps Script's 6-minute limit
// =====================================================================================

function activeRun_() {
  var run = readJson_('run.current');
  if (!run) return null;
  if (Date.now() - (run.heartbeatAt || run.startedAt) > APP_RUN_STALE_MS) return null;
  return run;
}

/** Starts a run unless one is already going. Returns false if one was. */
function startRun_(reason, startedBy) {
  var run = withLock_(function () {
    if (activeRun_()) return null;
    var ids = listStudents_().map(function (s) { return s.id; });
    var fresh = {
      id: Utilities.getUuid(),
      reason: reason,
      startedBy: startedBy,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      queue: ids,
      total: ids.length,
      updated: 0,
      failed: [],
      inProgress: null,
    };
    writeJson_('run.current', fresh);
    return fresh;
  });
  if (!run) return false;
  // From the page, the first batch is short, so the page hears back quickly; automatic runs use
  // the longer batches the time limit allows.
  processRunBatch_(run.id, reason === 'manual' ? APP_BATCH_BUDGET_MS : triggerBatchBudgetMs_());
  return true;
}

/**
 * How long an automatic batch keeps starting students: 2 minutes with the default 6-minute limit;
 * with a longer measured limit, 60% of it in whole minutes (18 minutes at most). With the last
 * student's update, an execution ends around two thirds of the limit (the year simulation: 64%),
 * never close to it. The last student must still fit (nextStudentFits_).
 */
function triggerBatchBudgetMs_() {
  var limit = runtimeLimitMs_();
  if (limit <= DEFAULT_RUNTIME_LIMIT_SECONDS * 1000) return APP_BATCH_BUDGET_MS;
  return Math.max(APP_BATCH_BUDGET_MS, Math.min(Math.floor(limit * 0.6 / 60000) * 60000, 18 * 60 * 1000));
}

/**
 * Works through the queue until it's empty or the time budget is used up, then either finishes
 * the run or schedules continueRun a minute later. A safety trigger resumes the run if this
 * execution is cut off.
 */
function processRunBatch_(runId, budgetMs) {
  var budget = budgetMs === undefined ? APP_BATCH_BUDGET_MS : budgetMs;
  var batchStart = Date.now();
  withLock_(function () {
    var run = readJson_('run.current');
    if (run && run.id === runId) {
      run.batchStartedAt = batchStart; // continueRun uses it if this batch is cut off
      writeJson_('run.current', run);
    }
  });
  // The safety trigger fires only after this execution must have ended (the time limit has
  // passed), so it never runs alongside a batch that's still going.
  replaceContinueTrigger_(runtimeLimitMs_() + APP_SAFETY_GRACE_MS);
  var first = true;
  while (true) {
    // After the first student, start the next one only if their usual time fits in what's left of
    // this execution; otherwise they start fresh in the next batch.
    if (!first && !nextStudentFits_(runId)) {
      var waiting = readJson_('run.current');
      if (waiting && waiting.id === runId && waiting.queue.length) {
        replaceContinueTrigger_(APP_CONTINUE_AFTER_MS);
        return;
      }
    }
    first = false;
    var id = takeNextStudent_(runId);
    if (id === null) {
      finishRun_(runId);
      deleteTriggersFor_('continueRun');
      return;
    }
    var result = updateOneStudent_(id);
    recordResult_(runId, result, id);
    if (Date.now() - batchStart > budget) {
      var run = readJson_('run.current');
      if (run && run.id === runId && run.queue.length) {
        replaceContinueTrigger_(APP_CONTINUE_AFTER_MS);
        return;
      }
    }
  }
}

/** True if the next student's update (their last time, plus a quarter) fits in this execution. */
function nextStudentFits_(runId) {
  var run = readJson_('run.current');
  if (!run || run.id !== runId || !run.queue.length) return true;
  var next = getStudent_(run.queue[0]);
  var expected = (next && next.lastSeconds ? next.lastSeconds : APP_DEFAULT_STUDENT_SECONDS) * 1250;
  return msLeftInExecution_() - APP_RUN_RESERVE_MS > expected;
}

/** Pops the next student ID off the queue (null when done), and marks it in progress. */
function takeNextStudent_(runId) {
  return withLock_(function () {
    var run = readJson_('run.current');
    if (!run || run.id !== runId || !run.queue.length) return null;
    var id = run.queue.shift();
    run.inProgress = id;
    run.heartbeatAt = Date.now();
    writeJson_('run.current', run);
    return id;
  });
}

function recordResult_(runId, result, id) {
  withLock_(function () {
    var run = readJson_('run.current');
    if (!run || run.id !== runId) return;
    run.inProgress = null;
    run.heartbeatAt = Date.now();
    run.requeued = run.requeued || [];
    if (result.busy && id && run.requeued.indexOf(id) === -1) {
      // Someone is updating this student from the page right now: try them again at the end.
      run.requeued.push(id);
      run.queue.push(id);
      writeJson_('run.current', run);
      return;
    }
    if (result.busy) result = { name: result.name, message: 'Was already being updated at the same time; see their row.' };
    if (result.ok) run.updated++;
    else if (result.skipped && result.message === 'That student was removed.') run.total--;
    else if (run.failed.length < APP_MAX_FAILURES_KEPT) {
      run.failed.push({ name: result.name || 'A student', message: String(result.message || '').substring(0, 200) });
    } else {
      run.moreFailed = (run.moreFailed || 0) + 1;
    }
    // Canvas down or refusing for several students in a row: stop, rather than keep asking it.
    run.canvasDownStreak = result.canvasDown ? (run.canvasDownStreak || 0) + 1 : 0;
    if (run.canvasDownStreak >= APP_CANVAS_DOWN_STOP && run.queue.length) {
      run.failed.push({
        name: run.queue.length + ' more student' + (run.queue.length === 1 ? '' : 's'),
        message: "Not tried: Canvas wasn't answering for " + APP_CANVAS_DOWN_STOP + ' students in a row. The next update tries again.',
      });
      run.queue = [];
    }
    writeJson_('run.current', run);
  });
}

/** Saves the run summary (times, counts, who failed and why; no assignment data). */
function finishRun_(runId) {
  withLock_(function () {
    var run = readJson_('run.current');
    if (!run || run.id !== runId) return;
    var summary = {
      reason: run.reason,
      startedBy: run.startedBy,
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      total: run.total,
      updated: run.updated,
      failed: run.failed.slice(0, APP_MAX_FAILURES_KEPT).map(function (f) {
        return { name: f.name, message: String(f.message || '').substring(0, 200) };
      }),
      moreFailed: run.moreFailed || 0,
    };
    writeJson_('run.last', summary);
    writeJson_('run.current', null);
  });
}

function publicRun_(run) {
  if (!run || !activeRun_()) return null;
  var current = run.inProgress ? getStudent_(run.inProgress) : null;
  return {
    reason: run.reason,
    startedAt: new Date(run.startedAt).toISOString(),
    total: run.total,
    done: run.total - run.queue.length - (run.inProgress ? 1 : 0),
    failed: run.failed.length + (run.moreFailed || 0),
    current: current ? current.label || current.name : '',
  };
}

// =====================================================================================
// Triggers
// =====================================================================================

/** Daily automatic update (7 pm and midnight), and the one-off test run. */
function scheduledRun(e) {
  var uid = requireTrigger_(e);
  var oneOff = (readJson_('trigger.oneoff') || []).indexOf(uid) !== -1;
  if (oneOff) deleteTriggerByUid_(uid);
  if (!oneOff && pausedSince_()) {
    Logger.log('Automatic updates are paused (since ' + shortDate_(pausedSince_()) + '), so this one was skipped.');
    return;
  }
  startRun_(oneOff ? 'test' : 'scheduled', 'automatic');
}

/** Next batch of a long run (also the safety net if a batch was cut off). */
function continueRun(e) {
  var uid = requireTrigger_(e);
  deleteTriggerByUid_(uid);
  var run = readJson_('run.current');
  if (!run) return;
  if (run.inProgress) {
    // The previous batch was cut off in the middle of this student.
    var stuck = getStudent_(run.inProgress);
    recordResult_(run.id, {
      ok: false,
      name: stuck ? stuck.name : 'A student',
      message: "Was stopped partway by Apps Script's time limit. It will be tried again at the next update.",
    });
    PropertiesService.getScriptProperties().deleteProperty('busy.' + run.inProgress);
    noteEarlyCutOff_(run);
  }
  processRunBatch_(run.id, triggerBatchBudgetMs_());
}

/**
 * A batch cut off long before the time limit AutoPlanner measured (before half of it) means the
 * real limit is now lower: for example Google changed it, or a new owner's account has the usual 6
 * minutes. Plan for 6 minutes from now on (otherwise every batch is cut off and a run takes hours),
 * and say so in the weekly email until measureTimeLimit measures it again.
 */
function noteEarlyCutOff_(run) {
  var limit = runtimeLimitMs_();
  if (limit <= DEFAULT_RUNTIME_LIMIT_SECONDS * 1000 || !run.batchStartedAt || !run.heartbeatAt) return;
  var survived = run.heartbeatAt - run.batchStartedAt;
  if (survived >= limit / 2) return;
  PropertiesService.getScriptProperties().setProperty('RUNTIME_LIMIT_SECONDS', String(DEFAULT_RUNTIME_LIMIT_SECONDS));
  writeJson_('limit.dropped', { at: new Date().toISOString(), was: Math.round(limit / 1000), survived: Math.round(survived / 1000) });
  console.warn('A batch was cut off after about ' + Math.round(survived / 60000) + ' min, before the ' + Math.round(limit / 60000) +
    ' min measured: planning for ' + Math.round(DEFAULT_RUNTIME_LIMIT_SECONDS / 60) + ' min from now on.');
}

function deleteTriggersFor_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function deleteTriggerByUid_(uid) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getUniqueId() === uid) ScriptApp.deleteTrigger(t);
  });
  var oneOffs = (readJson_('trigger.oneoff') || []).filter(function (u) { return u !== uid; });
  writeJson_('trigger.oneoff', oneOffs.length ? oneOffs : null);
}

function replaceContinueTrigger_(afterMs) {
  deleteTriggersFor_('continueRun');
  ScriptApp.newTrigger('continueRun').timeBased().after(afterMs).create();
}

function dailyTriggerCount_() {
  var oneOffs = readJson_('trigger.oneoff') || [];
  return ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'scheduledRun' && oneOffs.indexOf(t.getUniqueId()) === -1;
  }).length;
}

// =====================================================================================
// Editor-only: setup and checks (select the function in the toolbar, then click Run)
// =====================================================================================

/**
 * Installs the daily updates at about 7 pm and about midnight (New York time). Safe to run again:
 * it removes the old copies first. Also removes the retired APPS_SCRIPT_SECRET property.
 */
function setupTriggers() {
  requireOwner_();
  deleteTriggersFor_('scheduledRun');
  deleteTriggersFor_('continueRun');
  writeJson_('trigger.oneoff', null);
  APP_DAILY_HOURS.forEach(function (hour) {
    ScriptApp.newTrigger('scheduledRun')
      .timeBased()
      .atHour(hour)
      // "Near minute 15" runs midnight's update between 12:00 and 12:30 AM, never just before
      // midnight, so the home tab's weekend switch and the past-weeks move happen at that run.
      .nearMinute(hour === 0 ? 15 : 0)
      .everyDays(1)
      .inTimezone(APP_TIME_ZONE)
      .create();
  });
  deleteTriggersFor_('weeklyHealthCheck');
  var weekly = function (near) {
    var b = ScriptApp.newTrigger('weeklyHealthCheck').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(APP_HEALTH_HOUR);
    if (near) b = b.nearMinute(0);
    return b.inTimezone(APP_TIME_ZONE).create();
  };
  try {
    weekly(true);
  } catch (e) {
    weekly(false); // some accounts only take the hour for a weekly trigger
  }
  PropertiesService.getScriptProperties().deleteProperty('APPS_SCRIPT_SECRET');
  Logger.log('Daily updates installed: about 7 pm and about midnight (New York time). Weekly health check: Mondays at about 7 AM.');
  checkSetup();
}

/** Schedules one extra update about 5 minutes from now, to test the automatic updates. */
function scheduleTestRun() {
  requireOwner_();
  var at = new Date(Date.now() + 5 * 60 * 1000);
  var trigger = ScriptApp.newTrigger('scheduledRun').timeBased().at(at).create();
  var oneOffs = readJson_('trigger.oneoff') || [];
  oneOffs.push(trigger.getUniqueId());
  writeJson_('trigger.oneoff', oneOffs);
  Logger.log(
    'Test update scheduled for about ' + Utilities.formatDate(at, APP_TIME_ZONE, 'h:mm a') +
      '. The daily 7 pm and midnight updates are unchanged.'
  );
}

// =====================================================================================
// Summer: pause the automatic updates (the triggers stay, so resuming needs no new permissions)
// =====================================================================================

/** Since when automatic updates are paused (ISO time), or null. */
function pausedSince_() {
  return getScriptProperty_('PAUSED_SINCE') || null;
}

/**
 * Pauses the 7 pm and midnight updates and the weekly health email, for example over the summer.
 * The page still works, including "Update all students now". Run resumeAutomaticUpdates to undo.
 */
function pauseAutomaticUpdates() {
  requireOwner_();
  if (!pausedSince_()) PropertiesService.getScriptProperties().setProperty('PAUSED_SINCE', new Date().toISOString());
  Logger.log('Automatic updates are paused (since ' + shortDate_(pausedSince_()) + '). The page still works, and ' +
    '"Update all students now" still updates everyone. Run resumeAutomaticUpdates to turn them back on.');
}

/** Turns the automatic updates and the weekly health email back on. */
function resumeAutomaticUpdates() {
  requireOwner_();
  PropertiesService.getScriptProperties().deleteProperty('PAUSED_SINCE');
  if (dailyTriggerCount_() !== APP_DAILY_HOURS.length || !triggerCountFor_('weeklyHealthCheck')) {
    setupTriggers(); // they were removed meanwhile: put them back (it logs a setup check)
  } else {
    Logger.log('Automatic updates are back on: about 7 pm and about midnight. The next one runs tonight.');
  }
}

function triggerCountFor_(handler) {
  return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === handler; }).length;
}

// =====================================================================================
// Weekly health check: an email on Mondays, only when something needs attention
// =====================================================================================

/** Who gets the health email: HEALTH_EMAILS (commas between), or else AutoPlanner's owner. */
function healthRecipients_() {
  var list = String(getScriptProperty_('HEALTH_EMAILS') || '').split(',').map(function (e) {
    return e.trim();
  }).filter(function (e) { return /^[^@\s]+@[^@\s]+$/.test(e); });
  if (!list.length) list = [String(Session.getEffectiveUser().getEmail() || '')].filter(Boolean);
  return list;
}

/**
 * What needs attention, as [{ title, lines, todo }]: the daily updates not set up or not
 * finishing, students whose updates have failed for over a day, tokens running out in the next
 * three weeks, and Script Properties close to Google's limit. Empty while updates are paused.
 */
function healthReport_() {
  if (pausedSince_()) return [];
  var items = [];
  var now = Date.now();
  if (dailyTriggerCount_() !== APP_DAILY_HOURS.length) {
    items.push({
      title: "The 7 pm and midnight updates aren't set up.",
      lines: [],
      todo: 'In the Apps Script editor, open App.gs and run setupTriggers.',
    });
  } else if (updatesStaleSince_()) {
    items.push({
      title: 'No update for all students has finished since ' + shortDate_(updatesStaleSince_()) + '.',
      lines: [],
      todo: "The owner's account may have lost access. See \"Long-term care\" in the quick start.",
    });
  }
  var dropped = readJson_('limit.dropped');
  if (dropped) {
    items.push({
      title: 'Apps Script stopped an update after about ' + Math.max(1, Math.round(dropped.survived / 60)) + ' minutes, sooner than the ' +
        Math.round(dropped.was / 60) + ' minutes it allowed before, so AutoPlanner now plans for 6.',
      lines: [],
      todo: 'In the Apps Script editor, open App.gs, run measureTimeLimit and leave it (up to 31 minutes), then run checkSetup.',
    });
  }
  var students = listStudents_();
  var failing = students.filter(function (s) {
    return s.last && !s.last.ok && s.failingSince && now - new Date(s.failingSince).getTime() >= APP_HEALTH_FAILING_MS;
  });
  if (failing.length) {
    items.push({
      title: failing.length + ' student' + (failing.length === 1 ? "'s Doc hasn't" : "s' Docs haven't") + ' updated for over a day:',
      lines: failing.map(function (s) { return (s.name || 'Student') + ': ' + s.last.message; }),
      todo: 'Each line says what to do. The same message is on their row, next to "Needs attention".',
    });
  }
  var full = students.filter(function (s) { return s.docTabs >= APP_TABS_WARN; });
  if (full.length) {
    items.push({
      title: 'Docs getting close to Google\'s limit of ' + DOC_TAB_LIMIT + ' tabs:',
      lines: full.map(function (s) { return (s.name || 'Student') + ': ' + s.docTabs + ' tabs'; }),
      todo: 'Start new Docs for them, as in "Summer, and a new school year" in the quick start (each school year adds about 37 tabs).',
    });
  }
  var expiring = tokensExpiringSoon_().filter(function (x) { return !x.expired; });
  if (expiring.length) {
    items.push({
      title: 'Canvas tokens running out in the next 3 weeks:',
      lines: expiring.map(function (x) { return x.name + ': ' + x.date; }),
      todo: 'Ask each student for a new token (the student token guide shows how), then click Edit on their row, paste it and click Save.',
    });
  }
  var bytes = scriptPropertiesBytes_();
  if (bytes > APP_PROPS_LIMIT_BYTES * 0.7) {
    items.push({
      title: "AutoPlanner's saved data is " + Math.round(bytes / 1024) + ' KB, close to Google\'s limit of 500 KB.',
      lines: [],
      todo: 'Contact the Civic AI Club.',
    });
  }
  return items;
}

/** Everything in Script Properties, in bytes (keys and values). */
function scriptPropertiesBytes_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all).reduce(function (n, k) { return n + k.length + String(all[k]).length; }, 0);
}

/** The email for a health report (plain text, never a token). */
function healthEmail_(items) {
  var n = items.length;
  var body = ['AutoPlanner weekly check, ' + Utilities.formatDate(new Date(), APP_TIME_ZONE, 'EEE MMM d') + ': ' +
    n + (n === 1 ? ' thing needs' : ' things need') + ' attention.', ''];
  items.forEach(function (item, i) {
    body.push((i + 1) + '. ' + item.title);
    item.lines.forEach(function (l) { body.push('   - ' + l); });
    body.push('   What to do: ' + item.todo, '');
  });
  var url = '';
  try {
    url = ScriptApp.getService().getUrl();
  } catch (e) {
    url = '';
  }
  if (url) body.push('Open AutoPlanner: ' + url);
  body.push('This email comes on Mondays only when something needs attention. To change who gets it, edit ' +
    'HEALTH_EMAILS in the Apps Script project\'s Script Properties.');
  return { subject: 'AutoPlanner: ' + n + (n === 1 ? ' thing needs' : ' things need') + ' attention', body: body.join('\n') };
}

/** Mondays at about 7 AM: emails HEALTH_EMAILS if something needs attention. */
function weeklyHealthCheck(e) {
  requireTrigger_(e);
  sendHealthEmail_();
}

/** Run from the editor: the same check right now. It emails only if something needs attention. */
function healthCheckNow() {
  requireOwner_();
  var sent = sendHealthEmail_();
  Logger.log(sent ? 'Sent to ' + sent.to + ':\n\n' + sent.body :
    pausedSince_() ? 'Automatic updates are paused, so there is no health email.' : 'Nothing needs attention, so no email was sent.');
}

function sendHealthEmail_() {
  var items = healthReport_();
  if (!items.length) return null;
  var mail = healthEmail_(items);
  var to = healthRecipients_().join(',');
  if (!to) return null;
  MailApp.sendEmail({ to: to, subject: mail.subject, body: mail.body, name: 'AutoPlanner' });
  return { to: to, body: mail.body };
}

/** Logs whether everything is set up. Never logs tokens. */
function checkSetup() {
  requireOwner_();
  var folder = getDocsFolder_();
  Logger.log(
    folder
      ? 'OK   DOCS_FOLDER_ID: new Docs go in "' + folder.getName() + '", and only Docs in it can be updated.'
      : 'FIX  DOCS_FOLDER_ID is not set: Docs would go to My Drive.'
  );
  var users = allowedUsers_();
  Logger.log(
    users.length
      ? 'OK   ALLOWED_USERS: ' + users.length + ' people: ' + users.join(', ')
      : 'FIX  ALLOWED_USERS is empty: nobody can open the page.'
  );
  var measured = finishTimeLimitProbe_();
  if (measured) Logger.log('OK   measureTimeLimit: Apps Script stopped it after about ' + measured + ' s; saved.');
  if (readJson_('probe.timeLimit')) Logger.log('NOTE measureTimeLimit is still running (or stopped less than a minute ago). Run checkSetup again later.');
  var limitSet = Number(getScriptProperty_('RUNTIME_LIMIT_SECONDS'));
  Logger.log(limitSet >= 60
    ? 'OK   Apps Script time limit: ' + limitSet + ' s per run (measured).'
    : 'NOTE Apps Script time limit: not measured; assuming ' + DEFAULT_RUNTIME_LIMIT_SECONDS + ' s. Run measureTimeLimit once to measure it.');
  if (readJson_('limit.dropped')) {
    Logger.log('NOTE An update was cut off long before the measured limit, so AutoPlanner now plans for ' + DEFAULT_RUNTIME_LIMIT_SECONDS +
      ' s. Run measureTimeLimit, then checkSetup.');
  }
  var teachers = clcTeachers_();
  if (!teachers.length) {
    Logger.log('     CLC_TEACHERS: (none: no teacher folders; every Doc stays in the shared folder)');
  } else {
    try {
      var tf = teacherFolders_();
      Logger.log('OK   CLC_TEACHERS: ' + teachers.map(function (t) {
        return t.name + (tf[t.email] ? ' (folder ready)' : ' (no folder)');
      }).join(', '));
    } catch (err) {
      Logger.log('FIX  CLC teacher folders: ' + friendlyError_(err));
    }
  }
  Logger.log('OK   Canvas: ' + canvasBaseUrl_());
  var excluded = courseExcludeKeywords_();
  Logger.log('     COURSE_EXCLUDE: ' + (excluded.length ? excluded.join(', ') : '(none: every class is shown)'));
  var daily = dailyTriggerCount_();
  Logger.log(
    daily === APP_DAILY_HOURS.length
      ? 'OK   Daily updates: about 7 pm and about midnight.'
      : 'FIX  Daily updates: ' + daily + ' found, expected 2. Run setupTriggers.'
  );
  if (pausedSince_()) {
    Logger.log('NOTE Automatic updates are paused (since ' + shortDate_(pausedSince_()) + '). Run resumeAutomaticUpdates to turn them back on.');
  }
  Logger.log(
    triggerCountFor_('weeklyHealthCheck')
      ? 'OK   Weekly health check: Mondays at about 7 AM, emailed only when something needs attention, to ' +
        (getScriptProperty_('HEALTH_EMAILS') ? 'HEALTH_EMAILS: ' : 'the owner (HEALTH_EMAILS is not set): ') + healthRecipients_().join(', ')
      : 'FIX  Weekly health check: not set up. Run setupTriggers.'
  );
  Logger.log('     Saved data (Script Properties): ' + Math.round(scriptPropertiesBytes_() / 1024) + ' KB of 500 KB');
  Logger.log('     Students on the list: ' + listStudents_().length);
  if (getScriptProperty_('APPS_SCRIPT_SECRET')) {
    Logger.log('FIX  APPS_SCRIPT_SECRET is still set; setupTriggers removes it.');
  }
  if (getScriptProperty_('TEST_CANVAS_TOKEN')) {
    Logger.log('NOTE TEST_CANVAS_TOKEN is set (selfTest deletes it when it finishes).');
  }
}

// =====================================================================================
// Editor-only: selfTest (runs entirely as you, with your own Canvas token)
// =====================================================================================

/**
 * Finds this account's real Apps Script time limit (6 minutes is the documented default; Workspace
 * accounts can get longer). Run it from the editor and leave it: it keeps going until Apps Script
 * stops it (up to 31 minutes). Then run checkSetup, which saves the result in RUNTIME_LIMIT_SECONDS.
 */
function measureTimeLimit() {
  requireOwner_();
  var props = PropertiesService.getScriptProperties();
  var t0 = Date.now();
  props.setProperty('probe.timeLimit', JSON.stringify({ startedAt: t0, lastAt: t0, seconds: 0 }));
  Logger.log('Measuring the time limit: leave this running. It stops on its own (up to 31 minutes); then run checkSetup.');
  while (Date.now() - t0 < 31 * 60 * 1000) {
    Utilities.sleep(15 * 1000);
    var sec = Math.round((Date.now() - t0) / 1000);
    props.setProperty('probe.timeLimit', JSON.stringify({ startedAt: t0, lastAt: Date.now(), seconds: sec }));
    if (sec % 60 < 15) Logger.log('Still running after ' + sec + ' s');
  }
  props.deleteProperty('probe.timeLimit');
  props.setProperty('RUNTIME_LIMIT_SECONDS', '1800');
  Logger.log('Not stopped in 31 minutes: RUNTIME_LIMIT_SECONDS set to 1800 (30 minutes).');
}

/**
 * After measureTimeLimit was stopped by Apps Script: its last heartbeat (every 15 s) is just under
 * the limit, so the limit is saved rounded down to a whole minute (on the safe side).
 */
function finishTimeLimitProbe_() {
  var probe = readJson_('probe.timeLimit');
  if (!probe || Date.now() - probe.lastAt < 60 * 1000) return null;
  var limit = probe.seconds >= 1700 ? 1800 : Math.max(60, Math.floor(probe.seconds / 60) * 60);
  var props = PropertiesService.getScriptProperties();
  props.setProperty('RUNTIME_LIMIT_SECONDS', String(limit));
  props.deleteProperty('probe.timeLimit');
  props.deleteProperty('limit.dropped');
  return limit;
}

/**
 * The everyday case on its own (about 2 minutes): a Status and Note changed in By Class survive a
 * plain update, in both By Class and By Day. Uses your row's Doc and TEST_CANVAS_TOKEN (kept).
 */
function selfTestEveryday() {
  requireOwner_();
  Logger.log("NOTE selfTestEveryday edits your planner Doc for about 4 minutes. Don't open or edit that Doc " +
    'until it finishes: an edit there can change the result.');
  var token = cleanToken_(getScriptProperty_('TEST_CANVAS_TOKEN'));
  var row = null;
  var held = false;
  var t0 = Date.now();
  var restore = null;
  try {
    if (!token) throw new Error('Add the TEST_CANVAS_TOKEN Script Property first.');
    var schedule = fetchStudentSchedule_(token, canvasBaseUrl_(), APP_WEEKS_AHEAD, undefined, courseExcludeKeywords_());
    row = listStudents_().filter(function (s) {
      return s.canvasUserId !== null && s.canvasUserId !== undefined && String(s.canvasUserId) === String(schedule.canvas_user_id);
    })[0] || null;
    if (!row || !row.docId) throw new Error("Add yourself as a student first (selfTestEveryday uses your row's Doc).");
    if (!claimStudent_(row.id)) throw new Error('Your row is being updated right now. Run selfTestEveryday again in a few minutes.');
    held = true;
    var docId = row.docId;
    var target = findFirstAssignmentRow_(docId);
    if (!target) throw new Error('No assignments in the next ' + APP_WEEKS_AHEAD + ' weeks to test with.');
    var before = findRowsByUrl_(docId, target.url);
    var original = { status: normalizeStatus_(getCellText_(target.status)) || STATUS_DEFAULT, note: getCellText_(target.note) };
    if (/^selfTest(Everyday)? note /.test(original.note)) original = { status: STATUS_DEFAULT, note: '' };
    restore = { docId: docId, url: target.url, week: before.length ? before[0].weekKey : null, original: original };
    var newStatus = original.status === 'Complete' ? 'In progress' : 'Complete';
    var newNote = 'selfTestEveryday note ' + Utilities.formatDate(new Date(), APP_TIME_ZONE, 'MMM d h:mm a');
    writeStatusAndNote_(docId, target, newStatus, newNote);
    PropertiesService.getScriptProperties().setProperty('busy.' + row.id, String(Date.now()));
    startUpdateStats_();
    writeDocWithRecovery_({ id: row.id, docId: docId }, schedule, { noDeadline: true });
    var timing = updateStatsText_();
    updateStats_ = null;
    var rows = findRowsByUrl_(docId, target.url);
    if (rows.length !== 2) throw new Error('Expected the assignment once in By Class and once in By Day, found ' + rows.length + ' rows.');
    rows.forEach(function (r) {
      if (r.status !== newStatus) throw new Error(r.table + ' Status is "' + r.status + '", expected "' + newStatus + '"');
      if (r.note !== newNote) throw new Error(r.table + ' Notes lost the edit');
    });
    Logger.log('PASS A staff edit in By Class survives a plain update: "' + newStatus + '" and a note on "' +
      target.title + '", kept in By Class and By Day. The update ' + timing);
  } catch (err) {
    Logger.log('FAIL A staff edit in By Class survives a plain update: ' + friendlyError_(err, token));
  } finally {
    if (restore) {
      try {
        restoreTestValues_(restore.docId, restore.url, restore.original);
        Logger.log('PASS Clean-up: the test assignment\'s Status and Note are back to what they were');
      } catch (err2) {
        Logger.log('FAIL Clean-up: ' + friendlyError_(err2, token));
      }
    }
    if (held) PropertiesService.getScriptProperties().deleteProperty('busy.' + row.id);
    Logger.log('selfTestEveryday finished in ' + Math.round((Date.now() - t0) / 1000) + ' s (TEST_CANVAS_TOKEN kept).');
  }
}

/** The "Added by staff" rows of the week tab with this title (readStaffRows_), or null. */
function staffRowsOfWeek_(docId, title) {
  var w = weekTabsOf_(docsGet_(docId)).filter(function (x) { return x.title === title; })[0];
  return w ? readStaffRows_(w.tab) : null;
}

/** Types plain text into row `r` of a week tab's "Added by staff" table (replacing what's there). */
function writeStaffRow_(docId, tabId, r, texts) {
  var tab = findTabJsonById_(docsGet_(docId), tabId);
  var table = findStaffTable_(tab);
  var cells = table.tableRows[r + 1].tableCells;
  var requests = [];
  // Last cell first, so each edit leaves the earlier cells' positions alone.
  for (var c = cells.length - 1; c >= 0; c--) {
    var start = cellParagraphInsertIndex_(cells[c]);
    var range = getCellTextRange_(cells[c]);
    if (range && range.endIndex - 1 > start) {
      requests.push({ deleteContentRange: { range: { tabId: tabId, startIndex: start, endIndex: range.endIndex - 1 } } });
    }
    if (texts[c]) requests.push({ insertText: { text: texts[c], location: { tabId: tabId, index: start } } });
  }
  docsBatchUpdate_(docId, requests);
}

/** Empties selfTest's row in "Added by staff" again. */
function clearStaffTestRow_(docId, title, r) {
  var w = weekTabsOf_(docsGet_(docId)).filter(function (x) { return x.title === title; })[0];
  if (w) writeStaffRow_(docId, w.tab.tabProperties.tabId, r, ['', '', '', '', '']);
}

/** Puts a test assignment's Status and Note back in every row, and records them as written. */
function restoreTestValues_(docId, url, original) {
  // One row at a time, reading the Doc again each time (each edit moves the text after it).
  for (var n = 0; n < 8; n++) {
    var cells = rowCellsByUrl_(docId, url).filter(function (r) {
      return getCellText_(r.status) !== original.status || getCellText_(r.note) !== original.note;
    })[0];
    if (!cells) break;
    writeStatusAndNote_(docId, cells, original.status, original.note);
  }
  var rows = findRowsByUrl_(docId, url);
  if (!rows.length) throw new Error('the test assignment is not in any week tab');
  rows.forEach(function (r) {
    if (r.status !== original.status || r.note !== original.note) throw new Error(r.table + ' still has the test values');
  });
  recordWritten_(docId, url, rows[0].weekKey, original.status, original.note);
  return rows.length;
}

/** Full check with your own token; deletes TEST_CANVAS_TOKEN at the end. */
function selfTest() {
  runSelfTest_(false);
}

/** Same, but keeps TEST_CANVAS_TOKEN so you can run it again. */
function selfTestKeepToken() {
  runSelfTest_(true);
}

function runSelfTest_(keepToken) {
  requireOwner_();
  Logger.log("NOTE selfTest edits your planner Doc for about 6 minutes. Don't open or edit that Doc " +
    'until it finishes: an edit there can change the results.');
  var results = [];
  function check(name, fn) {
    try {
      var detail = fn();
      if (detail && detail.skip) {
        Logger.log('SKIP ' + name + ': ' + detail.skip);
        return true;
      }
      results.push(true);
      Logger.log('PASS ' + name + (detail ? ': ' + detail : ''));
      return true;
    } catch (err) {
      results.push(false);
      Logger.log('FAIL ' + name + ': ' + friendlyError_(err, token));
      return false;
    }
  }
  // Every check runs, even after a failure, unless a check it needs (by its id) didn't pass.
  var passedIds = {};
  var skippedForDeps = 0;
  function step(id, needs, name, fn) {
    var missing = needs.filter(function (n) { return !passedIds[n]; });
    if (missing.length) {
      skippedForDeps++;
      Logger.log('SKIP ' + name + ': needs an earlier check that did not pass (' + missing.join(', ') + ')');
      return;
    }
    if (check(name, fn)) passedIds[id] = true;
  }
  var token = cleanToken_(getScriptProperty_('TEST_CANVAS_TOKEN'));
  var schedule, docId, target, testStatus, testNote, doc, firstSeconds, selfStudent, movedTo, tabsBefore, original;
  var staffWeekTitle = null;
  var staffRowIndex = -1;
  var staffTestRow = null;
  var selfRow = null;
  var held = false;
  var selfTestStart = Date.now();
  // Keeps your row held (a hold lapses after APP_STUDENT_BUSY_MS) before each update selfTest runs.
  var keepHold = function () {
    if (held) PropertiesService.getScriptProperties().setProperty('busy.' + selfRow.id, String(Date.now()));
  };
  // Only the weeks AutoPlanner just wrote; tabs from earlier weeks are left as they were.
  var currentWeeks = function () {
    var titles = Object.keys(schedule.weeks || {}).map(function (k) {
      return buildWeekTabTitle_(k, schedule.weeks[k].week_label);
    });
    return weekTabsOf_(doc).filter(function (w) { return titles.indexOf(w.title) !== -1; });
  };

    step('token', [], 'TEST_CANVAS_TOKEN is set', function () {
      if (!token) throw new Error('Add the TEST_CANVAS_TOKEN Script Property first.');
    });
    step('folder', [], 'Shared folder is set', function () {
      var f = getDocsFolder_();
      if (!f) throw new Error('DOCS_FOLDER_ID is not set.');
      return f.getName();
    });
    step('allowed', [], 'You are in ALLOWED_USERS', function () {
      if (!isAllowedUser_(requireOwner_())) throw new Error('Add your email to ALLOWED_USERS.');
    });
    step('notauth', [], 'Not authorized page: the CLC-staff message, and no data or actions', function () {
      var stranger = 'not-on-the-list@pomfret.org';
      if (isAllowedUser_(stranger)) throw new Error(stranger + ' is allowed in');
      var html = notAuthorizedPage_(stranger).getContent();
      var want = 'This page is only for CLC staff. If you need access, contact Cayden Auyang or Luke Ryan.';
      if (html.indexOf(want) === -1) throw new Error('the message is missing');
      if (/<script|google\.script\.run/.test(html)) throw new Error('the page has a script');
      return 'shows "' + want + '"';
    });
    step('health', [], 'Weekly health check: set up (nothing is sent now)', function () {
      if (!triggerCountFor_('weeklyHealthCheck')) throw new Error('Its trigger is missing. Run setupTriggers.');
      var to = healthRecipients_();
      if (!to.length) throw new Error('Nobody to send it to: set HEALTH_EMAILS.');
      var items = healthReport_();
      if (pausedSince_()) return 'automatic updates are paused, so there is no email';
      return items.length
        ? 'today it would email ' + to.join(', ') + ' about: ' + items.map(function (i) { return i.title; }).join(' / ')
        : 'nothing needs attention today, so no email; it goes to ' + to.join(', ');
    });
    step('canvas', ['token'], 'Canvas: fetch your assignments and classes', function () {
      try {
        schedule = fetchStudentSchedule_(token, canvasBaseUrl_(), APP_WEEKS_AHEAD, undefined, courseExcludeKeywords_());
      } catch (err) {
        if (err.canvasKind !== 'auth') throw err;
        throw new Error("Canvas didn't accept TEST_CANVAS_TOKEN. Check that the property holds a working token.");
      }
      return schedule.student_full_name + ', ' + schedule.total_assignments + ' assignments in the next ' +
        APP_WEEKS_AHEAD + ' weeks, ' + schedule.courses.length + ' classes: ' + schedule.courses.join('; ');
    });
    step('hold', ['canvas'], 'Your row is held for selfTest, so no other update writes your Doc meanwhile', function () {
      // If you're also on the student list, test that same Doc, so selfTest never makes a second
      // copy of your planner in the folder. While selfTest runs, updates skip your row: an update
      // writing the same Doc at the same time would undo what selfTest types.
      selfRow = listStudents_().filter(function (s) {
        return s.canvasUserId !== null && s.canvasUserId !== undefined &&
          String(s.canvasUserId) === String(schedule.canvas_user_id);
      })[0] || null;
      if (!selfRow) return { skip: "you're not on the student list, so selfTest uses a Doc of its own" };
      if (!claimStudent_(selfRow.id)) {
        var since = Number(PropertiesService.getScriptProperties().getProperty('busy.' + selfRow.id) || 0);
        selfRow = null;
        throw new Error('Your row is being updated right now (held since ' +
          Utilities.formatDate(new Date(since), APP_TIME_ZONE, 'h:mm:ss a') + '). Run selfTest again in a few ' +
          'minutes. A hold lapses on its own ' + Math.round(APP_STUDENT_BUSY_MS / 60000) + ' minutes after it was set, ' +
          'even if the update that set it stopped midway.');
      }
      held = true;
      return 'updates skip ' + selfRow.name + ' until selfTest finishes';
    });
    step('doc', ['folder', 'canvas', 'hold'], 'Doc: create or update yours in the shared folder', function () {
      var row = selfRow;
      selfStudent = { id: row ? row.id : 'selftest', docId: row && row.docId ? row.docId : findReusableDoc_(schedule.student_full_name, null) };
      // An existing Doc isn't updated here: the "normal update" below is a full update, and the
      // layout checks run after it. That keeps selfTest well inside Apps Script's 6-minute limit.
      if (selfStudent.docId) {
        docId = selfStudent.docId;
        assertDocIsInFolder_(docId, getDocsFolder_());
        doc = docsGet_(docId, { includeTabsContent: true });
        var which = (row && row.docId ? "your student row's Doc" : 'your Doc in the folder') +
          ': https://docs.google.com/document/d/' + docId + '/edit';
        // A Doc last written by an older AutoPlanner has week tabs without "Added by staff". Update
        // it first, so the checks below find the layout they test (and the week tabs' IDs they use).
        var older = currentWeeks().filter(function (w) { return !readStaffRows_(w.tab); }).length;
        if (!older) return which;
        keepHold();
        var t1 = Date.now();
        writeDocWithRecovery_(selfStudent, schedule, { noDeadline: true });
        doc = docsGet_(docId, { includeTabsContent: true });
        return which + ' (' + older + ' week tab' + (older === 1 ? '' : 's') + ' had no "Added by staff" table yet, ' +
          'so it was updated first, in ' + Math.round((Date.now() - t1) / 1000) + ' s)';
      }
      keepHold();
      var t0 = Date.now();
      docId = writeDocWithRecovery_(selfStudent, schedule, { noDeadline: true });
      firstSeconds = Math.round((Date.now() - t0) / 1000);
      assertDocIsInFolder_(docId, getDocsFolder_());
      doc = docsGet_(docId, { includeTabsContent: true }); // full read: the Past weeks check looks inside
      return 'created in ' + firstSeconds + ' s: https://docs.google.com/document/d/' + docId + '/edit';
    });
    step('type', ['doc'], 'Doc: type a test Status and Note into a By Class table', function () {
      target = findFirstAssignmentRow_(docId);
      if (!target) throw new Error('No assignments in the next ' + APP_WEEKS_AHEAD + ' weeks to test with.');
      // What to put back at the end. A note left by an earlier selfTest counts as no note.
      original = { status: normalizeStatus_(getCellText_(target.status)) || STATUS_DEFAULT, note: getCellText_(target.note) };
      if (/^selfTest note /.test(original.note)) original = { status: STATUS_DEFAULT, note: '' };
      testStatus = original.status === 'In progress' ? 'Complete' : 'In progress';
      testNote = 'selfTest note ' + Utilities.formatDate(new Date(), APP_TIME_ZONE, 'MMM d h:mm a');
      writeStatusAndNote_(docId, target, testStatus, testNote);
      return '"' + testStatus + '" and a note on "' + target.title + '"';
    });
    step('staffrow', ['type'], 'Doc: type a row into "Added by staff" in that week', function () {
      var week = weekTabsOf_(docsGet_(docId)).filter(function (w) { return w.tab.tabProperties.tabId === target.tabId; })[0];
      if (!week) throw new Error("the test assignment's week tab wasn't found");
      var rows = readStaffRows_(week.tab);
      if (!rows) throw new Error('that week has no "Added by staff" table yet (run an update first)');
      staffRowIndex = -1;
      rows.forEach(function (r, i) { if (staffRowIndex < 0 && !countStaffRows_([r])) staffRowIndex = i; });
      if (staffRowIndex < 0) return { skip: 'every row in that table has something in it; add an empty row to test this' };
      staffTestRow = ['selfTest staff row', 'Study hall', 'Friday', 'Not started', 'selfTest: kept through updates'];
      writeStaffRow_(docId, target.tabId, staffRowIndex, staffTestRow);
      staffWeekTitle = week.title; // only once it's written, so the clean-up knows what to clear
      return 'row ' + (staffRowIndex + 1) + ' of "' + week.title + '"';
    });
    step('moved', ['type'], 'Doc: run an update with that assignment moved to another week (timed)', function () {
      keepHold();
      var from = weekKeyOfTab_(docsGet_(docId), target.tabId);
      movedTo = Object.keys(schedule.weeks || {}).sort().filter(function (k) { return k !== from; })[0] || null;
      startUpdateStats_();
      writeDocWithRecovery_(selfStudent, movedTo ? scheduleWithMovedAssignment_(schedule, target.url, movedTo) : schedule, { noDeadline: true });
      var timing = updateStatsText_();
      updateStats_ = null;
      return (movedTo ? 'moved from the week of ' + from + ' to ' + movedTo + '; ' : 'only one week, so not moved; ') + timing;
    });
    step('followed', ['moved'], 'Status and Note followed the assignment to its new week', function () {
      var rows = findRowsByUrl_(docId, target.url);
      if (rows.length < 2) throw new Error('Expected the assignment in both tables, found ' + rows.length + '.');
      rows.forEach(function (r) {
        if (movedTo && r.weekKey !== movedTo) throw new Error('found in the week of ' + r.weekKey + ', expected ' + movedTo);
        if (r.status !== testStatus) throw new Error(r.table + ' Status is "' + r.status + '"');
        if (r.note !== testNote) throw new Error(r.table + ' Notes is "' + r.note + '"');
      });
      return movedTo ? 'By Class and By Day in the week of ' + movedTo : 'By Class and By Day both kept them';
    });
    step('kept', ['followed'], 'An assignment removed from Canvas keeps its Status and Note in its week, marked "Not on Canvas" (timed)', function () {
      keepHold();
      startUpdateStats_();
      writeDocWithRecovery_(selfStudent, scheduleWithoutAssignment_(schedule, target.url), { noDeadline: true });
      var timing = updateStatsText_();
      updateStats_ = null;
      var rows = findRowsByUrl_(docId, target.url);
      if (rows.length !== 2) throw new Error('Expected it in both tables, found ' + rows.length + '.');
      rows.forEach(function (r) {
        if (movedTo && r.weekKey !== movedTo) throw new Error('found in the week of ' + r.weekKey + ', expected ' + movedTo);
        if (r.priority !== KEPT_NOT_ON_CANVAS) throw new Error(r.table + ' Priority says "' + r.priority + '"');
        if (r.status !== testStatus || r.note !== testNote) throw new Error(r.table + ' lost the Status or Note');
      });
      return 'kept in By Class and By Day, with its Status and Note; ' + timing;
    });
    step('normal', ['doc'], 'Doc: run a normal update (the real due date again)', function () {
      keepHold();
      tabsBefore = weekTabsOf_(docsGet_(docId)).map(function (w) { return { title: w.title, id: w.tab.tabProperties.tabId }; });
      startUpdateStats_();
      writeDocWithRecovery_(selfStudent, schedule, { noDeadline: true });
      var timing = updateStatsText_();
      updateStats_ = null;
      doc = docsGet_(docId, { includeTabsContent: true }); // full read for the layout checks below
      var limit = Number(getScriptProperty_('RUNTIME_LIMIT_SECONDS'));
      return timing + '. Time limit: ' + (limit >= 60 ? limit + ' s (measured)' : DEFAULT_RUNTIME_LIMIT_SECONDS + ' s (assumed; run measureTimeLimit)');
    });
    step('classes', ['normal'], 'Every class has its own By Class table in every week', function () {
      var weeks = currentWeeks();
      if (weeks.length !== Object.keys(schedule.weeks || {}).length) {
        throw new Error('Found ' + weeks.length + ' week tabs for the ' + Object.keys(schedule.weeks || {}).length + ' weeks with work due.');
      }
      if (!weeks.length) throw new Error('No week tabs found.');
      weeks.forEach(function (w) {
        var titles = tablesOfTab_(w).filter(function (t) { return t.kind === 'By Class'; }).map(function (t) { return t.title; });
        var expected = plannerCourseList_(schedule);
        if (titles.join('|') !== expected.join('|')) {
          throw new Error('"' + w.title + '" has [' + titles.join('; ') + '], expected [' + expected.join('; ') + ']');
        }
      });
      return weeks.length + ' week tabs × ' + plannerCourseList_(schedule).length + ' classes';
    });
    step('empty', ['normal'], 'A class with nothing due shows "' + NO_ASSIGNMENTS_TEXT + '"', function () {
      var seen = 0;
      currentWeeks().forEach(function (w) {
        tablesOfTab_(w).forEach(function (t) {
          if (t.kind !== 'By Class') return;
          var empty = t.rows.length === 3 && t.rows[2].text === NO_ASSIGNMENTS_TEXT;
          var hasItems = t.rows.some(function (r) { return r.url; });
          if (!empty && !hasItems) throw new Error(t.title + ' in "' + w.title + '" has neither assignments nor the empty-week row');
          if (empty) seen++;
        });
      });
      return seen ? seen + ' empty class tables, each with the single row' : { skip: 'every class had work due in every week' };
    });
    step('plain', ['normal'], 'Status is plain text (no symbols) everywhere', function () {
      var n = 0;
      currentWeeks().forEach(function (w) {
        tablesOfTab_(w).forEach(function (t) {
          t.rows.forEach(function (r) {
            if (!r.url) return;
            n++;
            if (/[^\x20-\x7E]/.test(r.status) || !/^[A-Za-z0-9]/.test(r.status)) {
              throw new Error('"' + r.status + '" in ' + t.title);
            }
          });
        });
      });
      return n + ' Status cells checked';
    });
    step('widths', ['normal'], 'All By Class tables share one set of column widths, By Day another, all full width', function () {
      var full = null;
      var sets = { 'By Class': {}, 'By Day': {} };
      currentWeeks().forEach(function (w) {
        if (full === null) full = tabContentWidth_(w.tab);
        tablesOfTab_(w).forEach(function (t) {
          if (!sets[t.kind]) return;
          sets[t.kind][t.widths.join(',')] = true;
          var sum = t.widths.reduce(function (a, b) { return a + b; }, 0);
          if (Math.abs(sum - full) > 1) throw new Error(t.title + ' is ' + sum + ' pt wide, page is ' + full + ' pt');
        });
      });
      ['By Class', 'By Day'].forEach(function (k) {
        var n = Object.keys(sets[k]).length;
        if (n !== 1) throw new Error(k + ' tables have ' + n + ' different width sets');
      });
      return 'By Class ' + Object.keys(sets['By Class'])[0] + ' | By Day ' + Object.keys(sets['By Day'])[0] + ' (pt)';
    });
    step('help', ['normal'], 'The Status/Notes help line is on every week tab', function () {
      var tabs = currentWeeks();
      tabs.forEach(function (w) {
        var body = w.tab && w.tab.documentTab && w.tab.documentTab.body;
        if (!body || tabBodyPlainText_(body).indexOf(STATUS_HELP_LINE) === -1) throw new Error('missing on "' + w.title + '"');
      });
      return tabs.length + ' tabs';
    });
    step('home', ['normal'], 'Home tab: name, last updated, this-week summary and class table', function () {
      var home = findTabJsonById_(doc, findRootTabIdByTitle_(doc, PARENT_TAB_TITLE));
      var body = home && home.documentTab && home.documentTab.body;
      if (!body) throw new Error('No CLC Planner tab.');
      var lines = tabBodyPlainText_(body).split('\n');
      var expected = homeSummary_(schedule, plannerCourseList_(schedule), new Date());
      if (lines[0] !== expected.name) throw new Error('title is "' + lines[0] + '"');
      var updated = lines.filter(function (l) { return l.indexOf('Last updated ') === 0; })[0];
      if (!updated) throw new Error('no "Last updated" line');
      var week = lines.filter(function (l) { return l.indexOf(expected.heading) === 0; })[0];
      if (!week) throw new Error('no "' + expected.heading + '" line (' + (expected.weekend ? 'weekend: coming week' : 'weekday: this week') + ')');
      var summaryRe = expected.weekend
        ? /( in the coming week|^Nothing is due in the coming week) · (\d+ due this weekend|Nothing due this weekend)( · \d+ added by staff)?\.$/
        : / this week · \d+ due today or tomorrow( · \d+ added by staff)?\.$|^Nothing is due this week\./;
      var myTeacher = selfRow && selfRow.teacher ? teacherByEmail_(selfRow.teacher) : null;
      var teacherLine = lines.filter(function (l) { return l.indexOf('CLC teacher: ') === 0; })[0];
      if (myTeacher && teacherLine !== 'CLC teacher: ' + myTeacher.name) throw new Error('no "CLC teacher: ' + myTeacher.name + '" line');
      if (!myTeacher && teacherLine) throw new Error('"' + teacherLine + '" shown for a student with no CLC teacher');
      if (!lines.some(function (l) { return summaryRe.test(l); })) {
        throw new Error('no this-week summary line');
      }
      var table = (body.content || []).filter(function (el) { return el.table; })[0];
      var rows = table ? table.table.tableRows || [] : [];
      var header = rows.length ? (rows[0].tableCells || []).map(getCellText_).join(' | ') : '';
      var wantHeader = HOME_CLASS_HEADERS.slice();
      if (expected.weekend) wantHeader[1] = 'Coming week';
      if (header !== wantHeader.join(' | ')) throw new Error('class table header is "' + header + '"');
      if (rows.length - 1 !== expected.rows.length) {
        throw new Error('class table has ' + (rows.length - 1) + ' classes, expected ' + expected.rows.length);
      }
      return expected.name + '; ' + updated + '; ' + week + '; ' + expected.rows.length + ' classes';
    });
    step('past', ['normal'], 'Past weeks: ended weeks are filed under "Past weeks", newest first', function () {
      var parent = findTabJsonById_(doc, findRootTabIdByTitle_(doc, PARENT_TAB_TITLE));
      var today = Utilities.formatDate(new Date(), APP_TIME_ZONE, 'yyyy-MM-dd');
      var stray = endedWeekTabs_(parent, today);
      if (stray.length) throw new Error(stray.length + ' ended week tab(s) still outside "Past weeks"');
      var kids = parent.childTabs || [];
      var past = kids.filter(function (t) { return t.tabProperties.title === PAST_WEEKS_TITLE; })[0];
      if (!past) return { skip: 'no past weeks yet' };
      if (kids[kids.length - 1] !== past) throw new Error('"Past weeks" is not the last tab under CLC Planner');
      if (tabBodyPlainText_(past.documentTab.body).indexOf(PAST_WEEKS_LINE) === -1) throw new Error('its line is missing');
      var keys = (past.childTabs || []).map(function (t) { return weekKeyFromTabTitle_(t.tabProperties.title); });
      var thisMonday = scheduleWeekStart_(today);
      keys.forEach(function (k, i) {
        if (!k || k >= thisMonday) throw new Error('"' + past.childTabs[i].tabProperties.title + '" does not belong in Past weeks');
        if (i && k > keys[i - 1]) throw new Error('Past weeks are not newest first');
      });
      var grayCells = 0;
      (past.childTabs || []).forEach(function (t) { grayCells += assertPriorityGray_(t); });
      return keys.length + ' past week' + (keys.length === 1 ? '' : 's') + ', newest first; ' +
        grayCells + ' Priority cells gray';
    });
    step('rebuilt', ['normal'], 'Existing week tabs were rebuilt in place: same titles and order, all titles unique, no "(updating)" tab left', function () {
      var now = docsGet_(docId);
      var after = weekTabsOf_(now).map(function (w) { return { title: w.title, id: w.tab.tabProperties.tabId }; });
      var names = function (list) { return list.map(function (w) { return w.title; }).join(' | '); };
      if (names(after) !== names(tabsBefore)) throw new Error('before: ' + names(tabsBefore) + '; after: ' + names(after));
      var seen = {};
      (function walk(tabs) {
        (tabs || []).forEach(function (t) {
          var title = t.tabProperties.title;
          if (title.slice(-UPDATING_SUFFIX.length) === UPDATING_SUFFIX) throw new Error('"' + title + '" was left behind');
          if (seen[title]) throw new Error('two tabs are called "' + title + '"');
          seen[title] = true;
          walk(t.childTabs);
        });
      })(now.tabs);
      var titles = Object.keys(schedule.weeks || {}).map(function (k) { return buildWeekTabTitle_(k, schedule.weeks[k].week_label); });
      var rebuilt = after.filter(function (w, i) { return titles.indexOf(w.title) !== -1 && w.id !== tabsBefore[i].id; }).length;
      if (!rebuilt) throw new Error('no existing week tab was rebuilt');
      return rebuilt + ' existing week tab' + (rebuilt === 1 ? '' : 's') + ' rebuilt; ' + after.length + ' tabs in the same order';
    });
    step('cameback', ['type', 'normal'], 'Status and Note came back with it, in exactly one week tab', function () {
      var rows = findRowsByUrl_(docId, target.url);
      if (rows.length !== 2) throw new Error('Expected the assignment once in By Class and once in By Day, found ' + rows.length + ' rows.');
      if (rows[0].weekKey !== rows[1].weekKey) throw new Error('it is in two week tabs: ' + rows[0].weekKey + ' and ' + rows[1].weekKey);
      rows.forEach(function (r) {
        if (r.status !== testStatus || r.note !== testNote) throw new Error(r.table + ' lost them');
      });
      return 'week of ' + rows[0].weekKey;
    });
    step('staffkept', ['staffrow', 'normal'], 'The "Added by staff" row came through both updates exactly', function () {
      if (!staffWeekTitle) return { skip: 'no staff row was typed' };
      var rows = staffRowsOfWeek_(docId, staffWeekTitle);
      var got = rows && rows[staffRowIndex] ? rows[staffRowIndex].map(function (c) { return c.text; }) : null;
      if (!got || got.join('|') !== staffTestRow.join('|')) throw new Error('found ' + JSON.stringify(got));
      return 'kept in "' + staffWeekTitle + '" (that tab was rebuilt by both updates)';
    });
    step('teachers', ['hold'], 'CLC teacher folders: assign, switch, a Drive drag-in, the folder lock, Unassigned', function () {
      var teachers = clcTeachers_();
      if (!selfRow || !selfRow.docId) return { skip: "needs your student row's Doc" };
      if (teachers.length < 2) return { skip: 'set CLC_TEACHERS (at least 2 teachers) to test this' };
      var shared = getDocsFolder_();
      var folders = teacherFolders_();
      teachers.forEach(function (t) {
        if (!folders[t.email]) throw new Error('no folder for ' + t.name);
        if (!isInsideFolder_(folders[t.email], shared.getId(), 0)) throw new Error(t.name + "'s folder isn't inside the shared folder");
      });
      var id = selfRow.id;
      var d = selfRow.docId;
      var startTeacher = (getStudent_(id) || selfRow).teacher || '';
      var inFolder = function (folder) { return docFolderIds_(d).indexOf(folder.getId()) !== -1; };
      try {
        setStudentTeacher(id, teachers[0].email);
        if (!inFolder(folders[teachers[0].email])) throw new Error('assigning ' + teachers[0].name + " didn't move the Doc");
        setStudentTeacher(id, teachers[1].email);
        if (!inFolder(folders[teachers[1].email])) throw new Error('switching to ' + teachers[1].name + " didn't move the Doc");
        assertDocIsInFolder_(d, shared); // the folder lock lets AutoPlanner update it there
        DriveApp.getFileById(d).moveTo(folders[teachers[0].email]); // as if staff dragged it in Drive
        var s = getStudent_(id);
        syncStudentTeacher_(s);
        if (s.teacher !== teachers[0].email) throw new Error('the Drive drag-in was not adopted');
        setStudentTeacher(id, '');
        if (!inFolder(shared)) throw new Error("Unassigned didn't move the Doc back to the shared folder");
      } finally {
        setStudentTeacher(id, startTeacher);
      }
      return 'your Doc went to ' + teachers[0].name + ', then ' + teachers[1].name + ', was adopted after a drag, ' +
        'then back to the shared folder; your row is ' + (startTeacher ? teacherByEmail_(startTeacher).name + "'s" : 'Unassigned') + ' again';
    });
    step('cleanup', ['type'], "Clean-up: the test assignment's Status and Note are back to what they were", function () {
      var n = restoreTestValues_(docId, target.url, original);
      if (staffWeekTitle) clearStaffTestRow_(docId, staffWeekTitle, staffRowIndex);
      return '"' + original.status + '"' + (original.note ? ' and its note' : ' and no note') + ' back in ' + n + ' rows' +
        (staffWeekTitle ? '; the "Added by staff" test row cleared' : '');
    });
    step('trashed', ['folder'], 'A Doc in the trash is never written to (so the student gets a fresh Doc)', function () {
      // A throwaway Doc in your My Drive, trashed at once; Google empties the trash after 30 days.
      var temp = DocumentApp.create('AutoPlanner selfTest: trashed-Doc check (safe to delete)');
      var file = DriveApp.getFileById(temp.getId());
      file.setTrashed(true);
      var refused = function (id) {
        try {
          upsertPlannerDocument_({ documentId: id, studentFullName: 'selfTest', weeks: {} });
        } catch (err) {
          if (String(err.message || err).indexOf(DOC_GONE_PREFIX) === 0) return true;
          throw err;
        }
        return false;
      };
      if (!refused(temp.getId())) throw new Error('a trashed Doc was opened for writing');
      return 'refused before any edit; updateOneStudent_ then makes a new Doc and tells staff on the row ' +
        '(the throwaway Doc is in your Drive trash; Google deletes it after 30 days)';
    });
    step('deleted', [], 'A Doc deleted for good: Drive\'s message (shown as is)', function () {
      // A made-up ID shaped like a real one, for a Doc that doesn't exist. Drive's own words are
      // logged so they can be checked; only these words make AutoPlanner treat a Doc as deleted.
      var missing = ('1' + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 44);
      var said = '';
      try {
        DriveApp.getFileById(missing);
      } catch (err) {
        said = String(err && err.message || err);
      }
      if (DRIVE_NOT_FOUND.test(said)) return 'recognized as deleted: "' + said + '"';
      return { skip: 'Drive said "' + said + '", which AutoPlanner does not treat as deleted, so a Doc ' +
        'deleted for good (not just trashed) would show "Google Drive didn\'t answer" on its row. Trashed Docs ' +
        'are fine (check above). Send this line to the club.' };
    });
    step('reads', ['doc'], "Doc reads are slim (no styles, no Past weeks' content) and give the same answers as a full read", function () {
      // A full read and a slim one, back to back, twice: timed, and compared on every current week.
      var ms = { full: 0, slim: 0 };
      var full;
      var slim;
      for (var round = 0; round < 2; round++) {
        var t1 = Date.now();
        full = docsGet_(docId, { includeTabsContent: true });
        ms.full += Date.now() - t1;
        t1 = Date.now();
        slim = docsGet_(docId);
        ms.slim += Date.now() - t1;
      }
      if (docsGetFieldsRejected_) {
        throw new Error('Google refused the slim read, so AutoPlanner reads everything. Updates still work, but more slowly. Send this line to the club.');
      }
      var parent = findTabJsonById_(slim, findRootTabIdByTitle_(slim, PARENT_TAB_TITLE));
      var weeks = (parent.childTabs || []).filter(function (t) { return t.tabProperties.title !== PAST_WEEKS_TITLE; });
      if (weeks.some(function (t) { return !t.documentTab; })) throw new Error('a current week came back without its content');
      var past = (parent.childTabs || []).filter(function (t) { return t.tabProperties.title === PAST_WEEKS_TITLE; })[0];
      var kids = (past && past.childTabs) || [];
      if (kids.some(function (t) { return t.documentTab; })) throw new Error('past weeks came back with their content');
      var answers = {
        'Status and Notes': readExistingDataFromTab_,
        '"Added by staff" rows': readStaffRows_,
        'page width': tabContentWidth_,
        'Past weeks gray cells': pastPriorityGrayRequests_,
      };
      weeks.forEach(function (w) {
        var whole = findTabJsonById_(full, w.tabProperties.tabId);
        Object.keys(answers).forEach(function (what) {
          if (JSON.stringify(answers[what](w)) !== JSON.stringify(answers[what](whole))) {
            throw new Error('the slim read gives different ' + what + ' on "' + w.tabProperties.title + '". Send this line to the club.');
          }
        });
      });
      var kb = function (o) { return Math.round(JSON.stringify(o).length / 1024); };
      var sec = function (x) { return (x / 2000).toFixed(1) + ' s'; };
      return 'slim ' + kb(slim) + ' KB in ' + sec(ms.slim) + ', full ' + kb(full) + ' KB in ' + sec(ms.full) +
        ' (each the average of 2); the same Status, Notes, staff rows and widths on ' + weeks.length + ' week tabs; ' +
        kids.length + ' past week' + (kids.length === 1 ? '' : 's') + ' left out';
    });

  if (held) PropertiesService.getScriptProperties().deleteProperty('busy.' + selfRow.id);
  if (!keepToken) {
    PropertiesService.getScriptProperties().deleteProperty('TEST_CANVAS_TOKEN');
    Logger.log('     TEST_CANVAS_TOKEN deleted.');
  }
  var failed = results.filter(function (r) { return !r; }).length;
  Logger.log(
    !failed && !skippedForDeps
      ? 'selfTest: ALL ' + results.length + ' CHECKS PASSED in ' + Math.round((Date.now() - selfTestStart) / 1000) + ' s'
      : 'selfTest: FAILED (' + failed + ' failed, ' + (results.length - failed) + ' passed' +
        (skippedForDeps ? ', ' + skippedForDeps + ' not run because a check they need failed' : '') + ')'
  );
}

/** Throws unless every Priority cell holding a priority in this past week is gray; returns how many. */
function assertPriorityGray_(tab) {
  var want = hexToRgbColor_(PAST_PRIORITY_BG);
  var n = 0;
  var tables = (tab.documentTab.body.content || []).filter(function (el) { return el.table; });
  pastPriorityGrayRequests_(tab).forEach(function (req) {
    var range = req.updateTableCellStyle.tableRange;
    var loc = range.tableCellLocation;
    var table = tables.filter(function (el) { return el.startIndex === loc.tableStartLocation.index; })[0].table;
    for (var r = loc.rowIndex; r < loc.rowIndex + range.rowSpan; r++) {
      var style = table.tableRows[r].tableCells[loc.columnIndex].tableCellStyle || {};
      var rgb = (style.backgroundColor && style.backgroundColor.color && style.backgroundColor.color.rgbColor) || {};
      ['red', 'green', 'blue'].forEach(function (k) {
        if (Math.abs((rgb[k] || 0) - want[k]) > 0.01) {
          throw new Error('a Priority cell in "' + tab.tabProperties.title + '" is not gray');
        }
      });
      n++;
    }
  });
  return n;
}

/** The week tabs (children of the CLC Planner tab): [{ title, tab }]. */
function weekTabsOf_(docJson) {
  var parent = findTabJsonById_(docJson, findRootTabIdByTitle_(docJson, PARENT_TAB_TITLE));
  return ((parent && parent.childTabs) || []).map(function (t) {
    return { title: (t.tabProperties || {}).title || '', tab: t };
  });
}

/** "By Class" (a Day column), "By Day" (a Course column) or "other", from the header row. */
function tableKind_(table) {
  var rows = table.tableRows || [];
  for (var r = 0; r < Math.min(rows.length, 2); r++) {
    var cells = rows[r].tableCells || [];
    if (cells.length < 6) continue;
    var name = getCellText_(cells[1]);
    if (name === 'Day') return 'By Class';
    if (name === 'Course') return 'By Day';
  }
  return 'other';
}

/** A week tab's tables, summarized: kind, title (first row), column widths, and each row. */
function tablesOfTab_(week) {
  var body = week.tab.documentTab && week.tab.documentTab.body;
  return ((body && body.content) || []).filter(function (el) { return el.table; }).map(function (el) {
    var rows = (el.table.tableRows || []).map(function (row) {
      var cells = row.tableCells || [];
      return {
        text: cells.length ? getCellText_(cells[0]) : '',
        url: cells.length >= 6 ? getCellLinkUrl_(cells[0]) : null,
        status: cells.length >= 6 ? getCellText_(cells[4]) : '',
        note: cells.length >= 6 ? getCellText_(cells[5]) : '',
      };
    });
    var props = (el.table.tableStyle && el.table.tableStyle.tableColumnProperties) || [];
    return {
      kind: tableKind_(el.table),
      title: rows.length ? rows[0].text : '',
      rows: rows,
      widths: props.map(function (p) { return p.width && typeof p.width.magnitude === 'number' ? p.width.magnitude : 0; }),
    };
  });
}

/** First assignment row in a By Class table: its tab, URL and cells. */
function findFirstAssignmentRow_(docId) {
  var doc = docsGet_(docId);
  var found = null;
  eachTable_(doc, function (tabId, table) {
    if (found || tableKind_(table) !== 'By Class') return;
    (table.tableRows || []).some(function (row) {
      var cells = row.tableCells || [];
      var url = cells.length >= 6 ? getCellLinkUrl_(cells[0]) : null;
      if (!url) return false;
      found = { tabId: tabId, url: url, title: getCellText_(cells[0]), status: cells[4], note: cells[5] };
      return true;
    });
  });
  return found;
}

/** Every row for this Canvas URL in the current and upcoming week tabs, with its week and text. */
function findRowsByUrl_(docId, url) {
  var rows = [];
  weekTabsOf_(docsGet_(docId)).forEach(function (w) {
    var key = weekKeyFromTabTitle_(w.title);
    var body = w.tab.documentTab && w.tab.documentTab.body;
    ((body && body.content) || []).forEach(function (el) {
      if (!el.table) return;
      var kind = tableKind_(el.table);
      (el.table.tableRows || []).forEach(function (row) {
        var cells = row.tableCells || [];
        if (cells.length >= 6 && getCellLinkUrl_(cells[0]) === url) {
          rows.push({ table: kind, weekKey: key, priority: getCellText_(cells[3]), status: getCellText_(cells[4]), note: getCellText_(cells[5]) });
        }
      });
    });
  });
  return rows;
}

/** Every row for this Canvas URL in the current and upcoming week tabs, with the cells to edit. */
function rowCellsByUrl_(docId, url) {
  var rows = [];
  weekTabsOf_(docsGet_(docId)).forEach(function (w) {
    if (!weekKeyFromTabTitle_(w.title)) return;
    var body = w.tab.documentTab && w.tab.documentTab.body;
    ((body && body.content) || []).forEach(function (el) {
      if (!el.table) return;
      (el.table.tableRows || []).forEach(function (row) {
        var cells = row.tableCells || [];
        if (cells.length >= 6 && getCellLinkUrl_(cells[0]) === url) {
          rows.push({ tabId: w.tab.tabProperties.tabId, url: url, kind: tableKind_(el.table), status: cells[4], note: cells[5] });
        }
      });
    });
  });
  return rows;
}

/** The week ('yyyy-MM-dd' Monday) of the week tab with this ID, or null. */
function weekKeyOfTab_(docJson, tabId) {
  var w = weekTabsOf_(docJson).filter(function (x) { return x.tab.tabProperties.tabId === tabId; })[0];
  return w ? weekKeyFromTabTitle_(w.title) : null;
}

/** A copy of the schedule without one assignment, as if it were removed or unpublished in Canvas. */
function scheduleWithoutAssignment_(schedule, url) {
  var copy = JSON.parse(JSON.stringify(schedule));
  Object.keys(copy.weeks).forEach(function (k) {
    (copy.weeks[k].days || []).forEach(function (d) {
      d.assignments = (d.assignments || []).filter(function (a) { return a.url !== url; });
    });
  });
  if (copy.elsewhere) delete copy.elsewhere[url];
  return copy;
}

/** A copy of the schedule with one assignment moved to the same weekday of another week. */
function scheduleWithMovedAssignment_(schedule, url, toWeekKey) {
  var copy = JSON.parse(JSON.stringify(schedule));
  var moved = null;
  Object.keys(copy.weeks).forEach(function (k) {
    (copy.weeks[k].days || []).forEach(function (d) {
      d.assignments = (d.assignments || []).filter(function (a) {
        if (a.url !== url) return true;
        moved = a;
        return false;
      });
    });
  });
  if (!moved) throw new Error('Assignment not found in the schedule.');
  var dayIndex = scheduleWeekdayIndex_(moved.due_date);
  moved.due_date = scheduleAddDays_(toWeekKey, dayIndex);
  moved.week_start = toWeekKey;
  var today = Utilities.formatDate(new Date(), APP_TIME_ZONE, 'yyyy-MM-dd');
  moved.days_until_due = scheduleDaysBetween_(today, moved.due_date);
  moved.priority = schedulePriority_(moved.days_until_due);
  copy.weeks[toWeekKey].days[dayIndex].assignments.push(moved);
  return copy;
}

/** Calls fn(tabId, table) for every table in every tab. */
function eachTable_(docJson, fn) {
  function walk(tab) {
    var tabId = tab.tabProperties && tab.tabProperties.tabId;
    var body = tab.documentTab && tab.documentTab.body;
    ((body && body.content) || []).forEach(function (el) {
      if (el.table) fn(tabId, el.table);
    });
    (tab.childTabs || []).forEach(walk);
  }
  (docJson.tabs || []).forEach(walk);
}

/** Replaces the text of the Status and Notes cells (later cell first, so indexes stay valid). */
function writeStatusAndNote_(docId, target, status, note) {
  var requests = [];
  [[target.note, note], [target.status, status]].forEach(function (pair) {
    var cell = pair[0];
    var start = cellParagraphInsertIndex_(cell);
    var range = getCellTextRange_(cell);
    if (range && range.endIndex - 1 > start) {
      requests.push({
        deleteContentRange: {
          range: { tabId: target.tabId, startIndex: start, endIndex: range.endIndex - 1 },
        },
      });
    }
    // An empty value only clears the cell (Docs refuses to insert nothing).
    if (pair[1]) requests.push({ insertText: { text: pair[1], location: { tabId: target.tabId, index: start } } });
  });
  docsBatchUpdate_(docId, requests);
}
