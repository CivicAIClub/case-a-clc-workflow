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
var APP_CONTINUE_AFTER_MS = 60 * 1000; // next batch of a long run
var APP_SAFETY_CONTINUE_AFTER_MS = 8 * 60 * 1000; // resumes a run if a batch is cut off
var APP_RUN_STALE_MS = 15 * 60 * 1000; // a run with no progress this long is treated as stopped
var APP_STUDENT_BUSY_MS = 7 * 60 * 1000;
var APP_NOTICE_DAYS = 7; // how long a one-off message (e.g. "made a new Doc") stays on a row
// A run summary is one Script Property (9 KB at most), so it keeps this many problems in full.
var APP_MAX_FAILURES_KEPT = 20;
var APP_STALE_AFTER_MS = 26 * 3600 * 1000; // no finished update for this long means something is wrong

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
  return {
    user: email,
    students: listStudents_().map(publicStudent_),
    run: publicRun_(readJson_('run.current')),
    lastRun: readJson_('run.last'),
    automaticUpdatesOn: dailyTriggerCount_() === APP_DAILY_HOURS.length,
    updatesStaleSince: updatesStaleSince_(),
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
  if (!last || !last.finishedAt || activeRun_()) return null;
  return Date.now() - new Date(last.finishedAt).getTime() > APP_STALE_AFTER_MS ? last.finishedAt : null;
}

/** Add a student from their Canvas token. Checks the token with Canvas before saving it. */
function addStudent(token, label) {
  var email = requireAllowedUser_();
  token = cleanToken_(token);
  if (!token) throw new Error("Paste the student's Canvas token first.");
  var profile = canvasProfileOrFriendlyError_(token);

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
      addedAt: new Date().toISOString(),
      addedBy: email,
      last: null,
    };
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
    }
    saveStudent_(student);
    return publicStudent_(student);
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
  var files = folder.searchFiles(query);
  var best = null;
  while (files.hasNext()) {
    var f = files.next();
    if (taken[f.getId()]) continue;
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
  }
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
    return { ok: false, skipped: true, message: 'This student is already being updated. Try again in a minute.' };
  }
  var token = getToken_(id);
  var result;
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
    var docInfo = {};
    var docId = writeDocWithRecovery_(student, schedule, docInfo);
    student = getStudent_(id) || student;
    student.name = schedule.student_full_name || student.name;
    student.docId = docId;
    if (docInfo.replaced) student.notice = { at: new Date().toISOString(), message: docInfo.replaced };
    var count = schedule.total_assignments || 0;
    student.last = {
      at: new Date().toISOString(),
      ok: true,
      message: 'Updated: ' + count + ' assignment' + (count === 1 ? '' : 's') + ' in the next ' + APP_WEEKS_AHEAD + ' weeks.',
    };
    result = { ok: true, name: student.name, message: student.last.message };
  } catch (err) {
    student = getStudent_(id) || student;
    student.last = { at: new Date().toISOString(), ok: false, message: friendlyError_(err, token) };
    result = { ok: false, name: student.name, message: student.last.message };
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
  var docId = student.docId || findReusableDoc_(schedule.student_full_name, student.id);
  if (docId) payload.documentId = docId;
  try {
    return upsertPlannerDocument_(payload).documentId;
  } catch (err) {
    if (!docId || String(err.message || err).indexOf(DOC_GONE_PREFIX) === -1) throw err;
    // The saved Doc is gone (deleted or in the trash): start again with a reused or new Doc.
    delete payload.documentId;
    var other = findReusableDoc_(schedule.student_full_name, student.id);
    // Drive can still find the same Doc, not in the trash: it was a hiccup, not a deleted Doc.
    if (other === docId) {
      throw new Error("Google Drive didn't answer about this student's Doc. They'll be tried again at the next update.");
    }
    if (other) payload.documentId = other;
    var newId = upsertPlannerDocument_(payload).documentId;
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
  processRunBatch_(run.id);
  return true;
}

/**
 * Works through the queue until it's empty or the time budget is used up, then either finishes
 * the run or schedules continueRun a minute later. A safety trigger resumes the run if this
 * execution is cut off.
 */
function processRunBatch_(runId) {
  var batchStart = Date.now();
  replaceContinueTrigger_(APP_SAFETY_CONTINUE_AFTER_MS);
  while (true) {
    var id = takeNextStudent_(runId);
    if (id === null) {
      finishRun_(runId);
      deleteTriggersFor_('continueRun');
      return;
    }
    var result = updateOneStudent_(id);
    recordResult_(runId, result);
    if (Date.now() - batchStart > APP_BATCH_BUDGET_MS) {
      var run = readJson_('run.current');
      if (run && run.id === runId && run.queue.length) {
        replaceContinueTrigger_(APP_CONTINUE_AFTER_MS);
        return;
      }
    }
  }
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

function recordResult_(runId, result) {
  withLock_(function () {
    var run = readJson_('run.current');
    if (!run || run.id !== runId) return;
    run.inProgress = null;
    run.heartbeatAt = Date.now();
    if (result.ok) run.updated++;
    else if (result.skipped && result.message === 'That student was removed.') run.total--;
    else if (run.failed.length < APP_MAX_FAILURES_KEPT) {
      run.failed.push({ name: result.name || 'A student', message: String(result.message || '').substring(0, 200) });
    } else {
      run.moreFailed = (run.moreFailed || 0) + 1;
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
      message: 'Took longer than Apps Script allows (6 minutes). It will be tried again at the next update.',
    });
    PropertiesService.getScriptProperties().deleteProperty('busy.' + run.inProgress);
  }
  processRunBatch_(run.id);
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
  PropertiesService.getScriptProperties().deleteProperty('APPS_SCRIPT_SECRET');
  Logger.log('Daily updates installed: about 7 pm and about midnight (New York time).');
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
  Logger.log('OK   Canvas: ' + canvasBaseUrl_());
  var excluded = courseExcludeKeywords_();
  Logger.log('     COURSE_EXCLUDE: ' + (excluded.length ? excluded.join(', ') : '(none: every class is shown)'));
  var daily = dailyTriggerCount_();
  Logger.log(
    daily === APP_DAILY_HOURS.length
      ? 'OK   Daily updates: about 7 pm and about midnight.'
      : 'FIX  Daily updates: ' + daily + ' found, expected 2. Run setupTriggers.'
  );
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
  var token = cleanToken_(getScriptProperty_('TEST_CANVAS_TOKEN'));
  var schedule, docId, target, testStatus, testNote, doc, firstSeconds, selfStudent, movedTo;
  // Only the weeks AutoPlanner just wrote; tabs from earlier weeks are left as they were.
  var currentWeeks = function () {
    var titles = Object.keys(schedule.weeks || {}).map(function (k) {
      return buildWeekTabTitle_(k, schedule.weeks[k].week_label);
    });
    return weekTabsOf_(doc).filter(function (w) { return titles.indexOf(w.title) !== -1; });
  };

  var ok =
    check('TEST_CANVAS_TOKEN is set', function () {
      if (!token) throw new Error('Add the TEST_CANVAS_TOKEN Script Property first.');
    }) &&
    check('Shared folder is set', function () {
      var f = getDocsFolder_();
      if (!f) throw new Error('DOCS_FOLDER_ID is not set.');
      return f.getName();
    }) &&
    check('You are in ALLOWED_USERS', function () {
      if (!isAllowedUser_(requireOwner_())) throw new Error('Add your email to ALLOWED_USERS.');
    }) &&
    check('Not authorized page: the CLC-staff message, and no data or actions', function () {
      var stranger = 'not-on-the-list@pomfret.org';
      if (isAllowedUser_(stranger)) throw new Error(stranger + ' is allowed in');
      var html = notAuthorizedPage_(stranger).getContent();
      var want = 'This page is only for CLC staff. If you need access, contact Cayden Auyang or Luke Ryan.';
      if (html.indexOf(want) === -1) throw new Error('the message is missing');
      if (/<script|google\.script\.run/.test(html)) throw new Error('the page has a script');
      return 'shows "' + want + '"';
    }) &&
    check('Canvas: fetch your assignments and classes', function () {
      try {
        schedule = fetchStudentSchedule_(token, canvasBaseUrl_(), APP_WEEKS_AHEAD, undefined, courseExcludeKeywords_());
      } catch (err) {
        if (err.canvasKind !== 'auth') throw err;
        throw new Error("Canvas didn't accept TEST_CANVAS_TOKEN. Check that the property holds a working token.");
      }
      return schedule.student_full_name + ', ' + schedule.total_assignments + ' assignments in the next ' +
        APP_WEEKS_AHEAD + ' weeks, ' + schedule.courses.length + ' classes: ' + schedule.courses.join('; ');
    }) &&
    check('Doc: create or update yours in the shared folder', function () {
      // If you're also on the student list, test that same Doc, so selfTest never makes a second
      // copy of your planner in the folder.
      var row = listStudents_().filter(function (s) {
        return s.canvasUserId !== null && s.canvasUserId !== undefined &&
          String(s.canvasUserId) === String(schedule.canvas_user_id);
      })[0];
      selfStudent = { id: row ? row.id : 'selftest', docId: row && row.docId ? row.docId : findReusableDoc_(schedule.student_full_name, null) };
      var how = row && row.docId ? "used your student row's Doc" : selfStudent.docId ? 'reused' : 'created';
      var t0 = Date.now();
      docId = writeDocWithRecovery_(selfStudent, schedule);
      firstSeconds = Math.round((Date.now() - t0) / 1000);
      assertDocIsInFolder_(docId, getDocsFolder_());
      doc = docsGet_(docId, { includeTabsContent: true }); // full read: the Past weeks check looks inside
      return how + ' in ' + firstSeconds + ' s: https://docs.google.com/document/d/' + docId + '/edit';
    }) &&
    check('Every class has its own By Class table in every week', function () {
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
    }) &&
    check('A class with nothing due shows "' + NO_ASSIGNMENTS_TEXT + '"', function () {
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
    }) &&
    check('Status is plain text (no symbols) everywhere', function () {
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
    }) &&
    check('All By Class tables share one set of column widths, By Day another, all full width', function () {
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
    }) &&
    check('The Status/Notes help line is on every week tab', function () {
      var tabs = currentWeeks();
      tabs.forEach(function (w) {
        var body = w.tab && w.tab.documentTab && w.tab.documentTab.body;
        if (!body || tabBodyPlainText_(body).indexOf(STATUS_HELP_LINE) === -1) throw new Error('missing on "' + w.title + '"');
      });
      return tabs.length + ' tabs';
    }) &&
    check('Home tab: name, last updated, this-week summary and class table', function () {
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
        ? /( in the coming week|^Nothing is due in the coming week) · (\d+ due this weekend|Nothing due this weekend)\.$/
        : / this week · \d+ due today or tomorrow\.$|^Nothing is due this week\./;
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
    }) &&
    check('Past weeks: ended weeks are filed under "Past weeks", newest first', function () {
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
    }) &&
    check('Doc: type a test Status and Note into a By Class table', function () {
      target = findFirstAssignmentRow_(docId);
      if (!target) throw new Error('No assignments in the next ' + APP_WEEKS_AHEAD + ' weeks to test with.');
      testStatus = getCellText_(target.status) === 'In progress' ? 'Complete' : 'In progress';
      testNote = 'selfTest note ' + Utilities.formatDate(new Date(), APP_TIME_ZONE, 'MMM d h:mm a');
      writeStatusAndNote_(docId, target, testStatus, testNote);
      return '"' + testStatus + '" and a note on "' + target.title + '"';
    }) &&
    check('Doc: run an update with that assignment moved to another week (timed)', function () {
      var from = weekKeyOfTab_(docsGet_(docId), target.tabId);
      movedTo = Object.keys(schedule.weeks || {}).sort().filter(function (k) { return k !== from; })[0] || null;
      var t0 = Date.now();
      writeDocWithRecovery_(selfStudent, movedTo ? scheduleWithMovedAssignment_(schedule, target.url, movedTo) : schedule);
      var s = Math.round((Date.now() - t0) / 1000);
      if (s * 1000 > 6 * 60 * 1000 - APP_BATCH_BUDGET_MS) {
        throw new Error('took ' + s + ' s: too close to the 6-minute limit for the 2-minute batch budget');
      }
      return (movedTo ? 'moved from the week of ' + from + ' to ' + movedTo + '; ' : 'only one week, so not moved; ') +
        'took ' + s + ' s (first write ' + firstSeconds + ' s; each student must fit in the ' +
        (6 * 60 - APP_BATCH_BUDGET_MS / 1000) + ' s left after the batch budget)';
    }) &&
    check('Status and Note followed the assignment to its new week', function () {
      var rows = findRowsByUrl_(docId, target.url);
      if (rows.length < 2) throw new Error('Expected the assignment in both tables, found ' + rows.length + '.');
      rows.forEach(function (r) {
        if (movedTo && r.weekKey !== movedTo) throw new Error('found in the week of ' + r.weekKey + ', expected ' + movedTo);
        if (r.status !== testStatus) throw new Error(r.table + ' Status is "' + r.status + '"');
        if (r.note !== testNote) throw new Error(r.table + ' Notes is "' + r.note + '"');
      });
      return movedTo ? 'By Class and By Day in the week of ' + movedTo : 'By Class and By Day both kept them';
    }) &&
    check('Doc: run a normal update (the real due date again)', function () {
      var t0 = Date.now();
      writeDocWithRecovery_(selfStudent, schedule);
      return 'took ' + Math.round((Date.now() - t0) / 1000) + ' s';
    }) &&
    check('Status and Note came back with it', function () {
      var rows = findRowsByUrl_(docId, target.url);
      if (rows.length < 2) throw new Error('Expected the assignment in both tables, found ' + rows.length + '.');
      rows.forEach(function (r) {
        if (r.status !== testStatus || r.note !== testNote) throw new Error(r.table + ' lost them');
      });
      return 'week of ' + rows[0].weekKey;
    }) &&
    check('A Doc in the trash, or gone, is never written to (so the student gets a fresh Doc)', function () {
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
      // A made-up ID shaped like a real one (44 characters), for a Doc that doesn't exist.
      var missing = ('1' + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 44);
      if (!refused(missing)) throw new Error('a missing Doc was not reported as gone');
      return 'both refused before any edit; updateOneStudent_ then makes a new Doc and tells staff on the row';
    }) &&
    check("Doc reads skip Past weeks' content, so updates stay fast all year", function () {
      var short = docsGet_(docId);
      if (docsGetFieldsRejected_) {
        throw new Error('Google refused the shorter read, so AutoPlanner reads everything. Updates still work but get slower as Past weeks grows.');
      }
      var parent = findTabJsonById_(short, findRootTabIdByTitle_(short, PARENT_TAB_TITLE));
      var weeks = (parent.childTabs || []).filter(function (t) { return t.tabProperties.title !== PAST_WEEKS_TITLE; });
      if (weeks.some(function (t) { return !t.documentTab; })) throw new Error('a current week came back without its content');
      var past = (parent.childTabs || []).filter(function (t) { return t.tabProperties.title === PAST_WEEKS_TITLE; })[0];
      var kids = (past && past.childTabs) || [];
      if (kids.some(function (t) { return t.documentTab; })) throw new Error('past weeks came back with their content');
      var kb = function (o) { return Math.round(JSON.stringify(o).length / 1024); };
      return kb(short) + ' KB per read instead of ' + kb(doc) + ' KB; ' + kids.length + ' past week' +
        (kids.length === 1 ? '' : 's') + ' left out, current weeks complete';
    });

  if (!keepToken) {
    PropertiesService.getScriptProperties().deleteProperty('TEST_CANVAS_TOKEN');
    Logger.log('     TEST_CANVAS_TOKEN deleted.');
  }
  var failed = results.filter(function (r) { return !r; }).length;
  Logger.log(
    ok && !failed
      ? 'selfTest: ALL ' + results.length + ' CHECKS PASSED'
      : 'selfTest: FAILED (' + failed + ' failed, ' + (results.length - failed) + ' passed; later checks skipped)'
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
          rows.push({ table: kind, weekKey: key, status: getCellText_(cells[4]), note: getCellText_(cells[5]) });
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
    requests.push({ insertText: { text: pair[1], location: { tabId: target.tabId, index: start } } });
  });
  docsBatchUpdate_(docId, requests);
}
