/**
 * AutoPlanner — writes each student's planner Google Doc (Docs API + document tabs).
 *
 * Called from App.gs: upsertPlannerDocument_(schedule) creates or updates one student's Doc
 * and returns { docUrl, documentId }. `schedule` is the shape Canvas.gs builds: `weeks`,
 * `total_assignments`, `generated_at`, `studentFullName`, and optional `documentId`.
 *
 * Week tabs are created with Docs API `addDocumentTab` (appended under CLC Planner so
 * calendar weeks appear **earliest at the top**, latest at the bottom). Tab bodies use
 * **only** Docs API `batchUpdate` (DocumentApp cannot reliably resolve nested tabs by ID).
 *
 * Script Property DOCS_FOLDER_ID (ID or folder URL): new Docs are created in that folder, and
 * while it is set only Docs inside it can be updated.
 *
 * Every function here ends in "_" so the web page can't call it directly (google.script.run
 * can only call functions without the underscore).
 */

/**
 * LAYOUT: one set of values for every table, so tables line up. Change them here only.
 *   Order:     each week tab has By Day first (the working to-do list), then Weekend plan, then
 *              By Class.
 *   Width:     every table spans the full text width (page width minus margins: 468 pt on
 *              US Letter with 1" margins). The column widths below are for 468 pt and are
 *              scaled to other page sizes, always adding up to the full width.
 *   By Day:    Assignment 160 | Class 80 | Status 116 | Notes 112 (pt)
 *   By Class:  Assignment 160 | Due 80 | Status 116 | Notes 112 (pt)
 *   Weekend:   Saturday or Sunday 80 (never scaled) | Assignment | Notes (the rest, split evenly)
 *   Alignment: Assignment and Notes left; Class, Due and Status centered; every cell vertically
 *              centered.
 *   Padding:   4 pt top and bottom, 5 pt left and right, in every cell.
 *   Text:      10 pt, #212121 in tables; assignment links #1a73e8.
 *   Header row (column names): #EFEFEF background, bold #212121 text, at least 22 pt tall.
 *   Class heading row (By Class) and day row (By Day): merged across the full width, bold,
 *              at least 22 pt tall; the class color (COURSE_COLORS), or #B7B7B7 for days.
 *   Assignment row: white. The class color is only on the class heading row (By Class) and on
 *              the Class cell (By Day); the Status chip is the only other color in a row.
 *              Due is the day ("Tue 11/17"). A time other than 11:59 pm is added after the day
 *              in By Class ("Tue 11/17, 8:00 am") and after the title in By Day ("(due 8:00 am)").
 *   Status:    a dropdown chip (STATUS_OPTIONS), background / text: Need to Start #F4CCCC /
 *              #990000, In progress #FFF2CC / #7F6000, Done/Submitted #D9EAD3 / #274E13.
 *   Kept row:  an assignment that left Canvas, moved past these weeks or lost its due date says
 *              why on a second line of its Assignment cell, in italic #666666.
 *   By Day:    one help line under the heading. Monday to Friday are always listed; Saturday and
 *              Sunday only when something is in them. Inside a day: the Canvas rows, then the
 *              rows staff added (written back exactly as typed; an empty Class cell says "Added
 *              by staff" in italic #666666), then one blank row that says "+ Add a to-do" in
 *              italic #666666 (Monday to Friday only).
 *   Weekend plan (after By Day): a heading, one help line, and a Saturday and a Sunday table.
 *              Header row in the day's color (Saturday #C9DAF8, Sunday #D9EAD3), bold #212121;
 *              rows Morning, Afternoon, Evening. Staff type in them; they're written back exactly.
 *   By Class:  one table for each class with something due. Classes with nothing due are named
 *              in one line after the last table ("Nothing due this week: Art, Chorus."), 10 pt
 *              italic #666666; with nothing due at all it says "No assignments due this week."
 *   Spacing:   each heading sits directly on its help line or table; exactly one empty paragraph
 *              after every table. Help lines are 10 pt, #444444.
 *   Past weeks: a week filed before November 2026 keeps its old layout until the owner runs
 *              reformatPastWeeks (see readOldPastWeek_). It then has the same tables, colors and
 *              widths, with only By Day (the days that have rows, no blank rows, no help line) and
 *              By Class: no Weekend plan. Times stay as written ("8:00 AM").
 */
var LAYOUT_BASE_WIDTH_PT = 468;
var BY_DAY_WIDTHS = [160, 80, 116, 112];
var BY_CLASS_WIDTHS = [160, 80, 116, 112];
var WEEKEND_LABEL_WIDTH_PT = 80;
var TABLE_FONT_PT = 10;
var HELP_FONT_PT = 10;
var HELP_FG = '#444444';
var CELL_PAD_TOP_BOTTOM_PT = 4;
var CELL_PAD_SIDE_PT = 5;
var ROW_MIN_HEIGHT_PT = 22;

var PARENT_TAB_TITLE = 'CLC Planner';

/** Drive title: First Last - CLC Assignments */
function buildDocumentTitle_(data) {
  var raw = String(
    (data.studentFullName || data.student_full_name || '').trim() || 'Student'
  );
  var title = raw + ' - CLC Assignments';
  if (title.length > 255) {
    title = title.substring(0, 252) + '\u2026';
  }
  return title;
}

var DATA_FG = '#212121';
var LINK_FG = '#1a73e8';
// The blue Google Docs gives a link staff add themselves.
var GOOGLE_LINK_FG = '#1155cc';

// Pastels; uniqueness within a week is enforced in buildCourseColorMap_ (not hash-only).
var COURSE_COLORS = [
  '#D9EAD3',
  '#CFE2F3',
  '#FCE5CD',
  '#EAD1DC',
  '#D9D2E9',
  '#FFF2CC',
  '#D0E4F7',
  '#F4CCCC',
  '#B6D7A8',
  '#EA9999',
  '#FFD966',
  '#C9DAF8',
  '#E6B8AF',
  '#D5A6BD',
  '#FFE599',
  '#B4A7D6',
  '#C6E0B4',
  '#F9CB9C',
  '#A4C2F4',
  '#EAEDED',
  '#D7CCC8',
  '#FFCCBC',
  '#C5E1A5',
  '#CE93D8',
  '#80DEEA',
  '#FFF59D',
  '#FFAB91',
  '#A5D6A7',
  '#B39DDB',
  '#90CAF9',
  '#FFCDD2',
];

var HEADER_BG = '#EFEFEF';
var HEADER_FG = '#212121';
var DAY_ROW_BG = '#B7B7B7';

/*
 * Each week tab has:
 *   - a heading and the assignment count;
 *   - "By Day": one table with every assignment, grouped by day, where staff also add their own
 *     to-dos;
 *   - "Weekend plan": a Saturday and a Sunday table that only staff fill in;
 *   - "By Class": one table for each class with something due this week.
 * Status and Notes belong to staff and are kept across updates, keyed by the Canvas link.
 */
var BY_DAY_TITLE = 'By Day';
var BY_DAY_HEADERS = ['Assignment', 'Class', 'Status', 'Notes'];
var BY_DAY_HELP_LINE =
  'To add your own to-do, type in the "+ Add a to-do" row under any day. Need more than one? ' +
  'Right-click a row and choose Insert row below. AutoPlanner keeps everything you add.';
var BY_CLASS_TITLE = 'By Class';
var BY_CLASS_HEADERS = ['Assignment', 'Due', 'Status', 'Notes'];
var NO_ASSIGNMENTS_TEXT = 'No assignments due this week.';
var NOTHING_DUE_PREFIX = 'Nothing due this week: ';

// By Day: the blank row at the end of each day, and what an empty Class cell of a staff row says.
var ADD_TODO_TEXT = '+ Add a to-do';
var ADDED_BY_STAFF_TEXT = 'Added by staff';

// Weekend plan: two tables staff fill in. AutoPlanner writes back what it read, nothing else.
var WEEKEND_TITLE = 'Weekend plan';
var WEEKEND_HELP_LINE = 'Plan Saturday and Sunday here. AutoPlanner never changes these two tables.';
var WEEKEND_TABLES = [
  { day: 'Saturday', bg: '#C9DAF8' },
  { day: 'Sunday', bg: '#D9EAD3' },
];
var WEEKEND_HEADERS = ['Assignment', 'Notes'];
var WEEKEND_ROWS = ['Morning', 'Afternoon', 'Evening'];

/*
 * Status is a dropdown chip. Google keeps a dropdown's choices in the tab the chip is in, so every
 * week tab gets its own copy of this one, always with the same IDs. An ID has a fixed start
 * ("kix." or "dropdownItem.") and then 2 to 14 letters, digits, "_" or "-".
 * The first choice is the default: a new assignment starts on it.
 */
var STATUS_DROPDOWN_ID = 'kix.clc_status';
var STATUS_DROPDOWN_TITLE = 'Status';
var STATUS_OPTIONS = [
  { id: 'dropdownItem.need', label: 'Need to Start', bg: '#F4CCCC', fg: '#990000' },
  { id: 'dropdownItem.progress', label: 'In progress', bg: '#FFF2CC', fg: '#7F6000' },
  { id: 'dropdownItem.done', label: 'Done/Submitted', bg: '#D9EAD3', fg: '#274E13' },
];
var STATUS_DEFAULT = STATUS_OPTIONS[0].label;
// What staff typed in the Status column before it was a dropdown, and what it means now. The first
// three are the old choices; the rest are common ways of saying the same thing. Anything else goes
// to the front of the row's note ("Status was: ...") and the chip starts on Need to Start.
var OLD_STATUS_WORDS = {
  'not started': 'Need to Start',
  'in progress': 'In progress',
  complete: 'Done/Submitted',
  completed: 'Done/Submitted',
  done: 'Done/Submitted',
  submitted: 'Done/Submitted',
  finished: 'Done/Submitted',
  'turned in': 'Done/Submitted',
  started: 'In progress',
};
var OLD_STATUS_NOTE_PREFIX = 'Status was: ';

// The "Added by staff" table every week tab had before staff rows moved into By Day. It's only
// read now: the first update moves its rows into By Day or the Weekend plan (see readStaffWork_).
var OLD_STAFF_COLUMNS = 5;

var MUTED_FG = '#666666';

/* Requests per batchUpdate call; one call counts once against the per-minute write quota. */
var BATCH_CHUNK = 200;

/** Brief pause between chunked write RPCs to stay under per-minute write quota. */
var DOCS_CHUNK_GAP_MS = 450;

function sleepDocsChunkGap_() {
  Utilities.sleep(DOCS_CHUNK_GAP_MS);
  if (updateStats_) updateStats_.pauseMs += DOCS_CHUNK_GAP_MS;
}

// Google allows 60 Docs writes a minute per account. Now that reads are fast, back-to-back updates
// in a run could get close, so each execution keeps to 40 a minute: at most a short wait, never a
// refused write.
var DOCS_WRITES_PER_MINUTE = 40;
var docsWriteTimes_ = [];

function paceDocsWrites_() {
  var now = Date.now();
  docsWriteTimes_ = docsWriteTimes_.filter(function (t) { return now - t < 60000; });
  if (docsWriteTimes_.length >= DOCS_WRITES_PER_MINUTE) {
    var wait = 60000 - (now - docsWriteTimes_[0]) + 50;
    Utilities.sleep(wait);
    if (updateStats_) updateStats_.pauseMs += wait;
    now = Date.now();
    docsWriteTimes_ = docsWriteTimes_.filter(function (t) { return now - t < 60000; });
  }
  docsWriteTimes_.push(now);
}

// ---- Time: every execution's start, Apps Script's limit, and timing for selfTest -------------------
// Global code runs at the start of every execution, so this is when the current one began.
var EXECUTION_STARTED_AT_ = Date.now();
// Apps Script stops a run at this account's limit. 6 minutes is the documented default; the real
// value (measureTimeLimit in App.gs) is kept in the RUNTIME_LIMIT_SECONDS Script Property.
var DEFAULT_RUNTIME_LIMIT_SECONDS = 360;
// An update stops between weeks when the next week might not fit; this much time is kept for the
// home tab and saving the result.
var UPDATE_RESERVE_MS = 30 * 1000;

function runtimeLimitMs_() {
  var s = Number(getScriptProperty_('RUNTIME_LIMIT_SECONDS'));
  return (s >= 60 ? s : DEFAULT_RUNTIME_LIMIT_SECONDS) * 1000;
}

function msLeftInExecution_() {
  return runtimeLimitMs_() - (Date.now() - EXECUTION_STARTED_AT_);
}

// When set (selfTest does), every Docs read and write is counted and timed, and each week's time.
var updateStats_ = null;

function startUpdateStats_() {
  updateStats_ = { start: Date.now(), reads: 0, readMs: 0, readChars: 0, writes: 0, writeMs: 0, requests: 0, pauseMs: 0, weeks: [] };
}

/** "took 205 s: 9 Doc reads 21 s (about 1013 KB each), 20 Doc writes (1410 requests) 162 s, ..." */
function updateStatsText_() {
  var st = updateStats_;
  if (!st) return '';
  var sec = function (ms) { return Math.round(ms / 1000) + ' s'; };
  var total = Date.now() - st.start;
  var other = total - st.readMs - st.writeMs - st.pauseMs;
  return 'took ' + sec(total) + ': ' + st.reads + ' Doc reads ' + sec(st.readMs) +
    (st.reads ? ' (about ' + Math.round(st.readChars / st.reads / 1024) + ' KB each)' : '') + ', ' +
    st.writes + ' Doc writes (' + st.requests + ' requests) ' + sec(st.writeMs) + ', pauses ' + sec(st.pauseMs) +
    ', other ' + sec(Math.max(0, other)) +
    (st.weeks.length ? '; by week: ' + st.weeks.map(function (w) { return w.week + ' ' + sec(w.ms); }).join(', ') : '');
}

function docsApiIsQuotaError_(err) {
  var s = String(err);
  return (
    s.indexOf('Quota exceeded') !== -1 ||
    s.indexOf('429') !== -1 ||
    s.indexOf('RESOURCE_EXHAUSTED') !== -1 ||
    s.indexOf('rateLimitExceeded') !== -1 ||
    s.indexOf('userRateLimitExceeded') !== -1
  );
}

/**
 * Reads ask only for what AutoPlanner uses: every tab's title and ID; each tab's page size and
 * margins (for column widths); the text, positions and links in it, with the text styles kept for
 * what staff typed; each Status chip and the choice picked in it; and the tab's dropdowns (to know
 * whether it already has the Status one). Paragraph and cell styles, about 80% of a full read, are
 * left out, and so is the content of the week tabs inside "Past weeks" (the third tab level), which
 * grow all year. A read is about 5 times smaller (checked on a live Doc, 2026-10-06), and reads
 * were most of every update's time. Pass opts (e.g. { includeTabsContent: true }) for a full read.
 */
var DOCS_READ_TEXT_RUN = 'textRun(content,textStyle(bold,italic,underline,strikethrough,link,foregroundColor,backgroundColor))';
var DOCS_READ_DROPDOWN = 'dropdown(dropdownId,dropdownProperties(dropdownDefinitionId,selectedOptionId,displayValue))';
var DOCS_READ_PARAGRAPH = 'paragraph(elements(startIndex,endIndex,' + DOCS_READ_TEXT_RUN + ',' + DOCS_READ_DROPDOWN + '))';
var DOCS_READ_TABLE = 'table(rows,columns,tableRows(startIndex,endIndex,tableCells(startIndex,endIndex,' +
  'content(startIndex,endIndex,' + DOCS_READ_PARAGRAPH + '))))';
var DOCS_READ_TAB = 'documentTab(documentStyle(pageSize,marginLeft,marginRight),dropdownDefinitions,' +
  'body/content(startIndex,endIndex,' + DOCS_READ_PARAGRAPH + ',' + DOCS_READ_TABLE + ',sectionBreak/sectionStyle/sectionType))';
var DOCS_GET_FIELDS = 'tabs(tabProperties,' + DOCS_READ_TAB + ',childTabs(tabProperties,' + DOCS_READ_TAB +
  ',childTabs(tabProperties)))';
// The same, with Past weeks' content: read only when an assignment comes back from a filed week.
var DOCS_GET_FIELDS_WITH_PAST = 'tabs(tabProperties,' + DOCS_READ_TAB + ',childTabs(tabProperties,' + DOCS_READ_TAB +
  ',childTabs(tabProperties,' + DOCS_READ_TAB + ')))';
var docsGetFieldsRejected_ = false; // set if Google ever refuses DOCS_GET_FIELDS; then reads are full

/** Docs.Documents.get with retries when Google returns quota / rate limit errors. */
function docsGet_(docId, opts) {
  var options = opts ||
    (docsGetFieldsRejected_ ? { includeTabsContent: true } : { includeTabsContent: true, fields: DOCS_GET_FIELDS });
  var lastErr;
  var fellBack = false;
  var slimFailures = 0;
  for (var attempt = 0; attempt < 7; attempt++) {
    try {
      var t0 = Date.now();
      var doc = Docs.Documents.get(docId, options);
      if (updateStats_) {
        updateStats_.reads++;
        updateStats_.readMs += Date.now() - t0;
        updateStats_.readChars += JSON.stringify(doc).length;
      }
      // The full read worked where the shorter one didn't: use full reads for the rest of this run.
      if (fellBack) docsGetFieldsRejected_ = true;
      return doc;
    } catch (e) {
      lastErr = e;
      if (options.fields && !docsApiIsQuotaError_(e)) {
        // Once more first: a passing error ("Internal error encountered") shouldn't switch the rest
        // of this run to full reads, about 5 times bigger (found by the year simulation).
        if (++slimFailures < 2) {
          Utilities.sleep(1000);
          continue;
        }
        // Never let the shorter read break an update: try a full read.
        fellBack = true;
        options = { includeTabsContent: true };
        continue;
      }
      if (docsApiIsQuotaError_(e) && attempt < 6) {
        Utilities.sleep(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Single batchUpdate (at most 500 requests; batchUpdateChunked_ sends BATCH_CHUNK at a time).
 * @returns {*} API reply (e.g. for addDocumentTab replies)
 */
function docsBatchUpdate_(docId, requests) {
  // Docs refuses an insertText with no text ("Insert text requests must specify text to insert"),
  // and inserting nothing changes nothing, so those are left out.
  requests = (requests || []).filter(function (r) { return !(r && r.insertText && !r.insertText.text); });
  if (!requests.length) return null;
  if (requests.length > 500) {
    throw new Error('docsBatchUpdate_: chunk > 500 requests');
  }
  var lastErr;
  for (var attempt = 0; attempt < 7; attempt++) {
    try {
      paceDocsWrites_();
      var t0 = Date.now();
      var reply = sendDocsBatch_(docId, requests);
      if (updateStats_) {
        updateStats_.writes++;
        updateStats_.writeMs += Date.now() - t0;
        updateStats_.requests += requests.length;
      }
      return reply;
    } catch (e) {
      lastErr = e;
      if (docsApiIsQuotaError_(e) && attempt < 6) {
        Utilities.sleep(2500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// Set once the Advanced Docs service has refused Status dropdown requests in this run; then every
// batch with one goes straight to the REST API.
var docsDropdownsViaRest_ = false;

/**
 * Sends one batch through the Advanced Docs service, like every other write. Status dropdowns are
 * newer than that service: if it refuses the batch that adds a tab's dropdown, the same batch goes
 * to the Docs REST API instead, and so does every later batch with a dropdown request in it.
 * Only that first batch is ever sent twice, and it can't be applied twice: Docs refuses a second
 * dropdown with the same ID in a tab. If the REST API refuses it too, the batch was wrong for some
 * other reason, and the first error is the one reported.
 */
function sendDocsBatch_(docId, requests) {
  var has = function (word) {
    return requests.some(function (r) { return Object.keys(r || {}).join(' ').indexOf(word) >= 0; });
  };
  if (docsDropdownsViaRest_ && has('Dropdown')) return docsRestBatchUpdate_(docId, requests);
  try {
    return Docs.Documents.batchUpdate({ requests: requests }, docId);
  } catch (e) {
    if (!has('createDropdownDefinition') || docsApiIsQuotaError_(e)) throw e;
    console.warn('The Advanced Docs service refused a batch with a Status dropdown (' + e + '). Trying the Docs REST API.');
    var reply;
    try {
      paceDocsWrites_();
      reply = docsRestBatchUpdate_(docId, requests);
    } catch (restError) {
      if (docsApiIsQuotaError_(restError)) throw restError;
      console.warn('The Docs REST API refused it too (' + restError + ').');
      throw e;
    }
    docsDropdownsViaRest_ = true;
    return reply;
  }
}

/**
 * documents.batchUpdate through the Docs REST API, as the script's owner. It needs no permission the
 * script doesn't already have (Docs, and "connect to an external service").
 */
function docsRestBatchUpdate_(docId, requests) {
  var res = UrlFetchApp.fetch('https://docs.googleapis.com/v1/documents/' + encodeURIComponent(docId) + ':batchUpdate', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ requests: requests }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code < 200 || code >= 300) {
    var message = body;
    try {
      message = JSON.parse(body).error.message || body;
    } catch (e) {}
    // The code comes first, so a 429 is still seen as a quota error (docsApiIsQuotaError_).
    throw new Error('Docs API ' + code + ': ' + String(message).slice(0, 300));
  }
  return JSON.parse(body);
}

function readJsonProperty_(key) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || 'null');
  } catch (e) {
    return null;
  }
}

function writeJsonProperty_(key, value) {
  var props = PropertiesService.getScriptProperties();
  var json = value && Object.keys(value).length ? JSON.stringify(value) : null;
  if (json === null) props.deleteProperty(key);
  else if (props.getProperty(key) !== json) props.setProperty(key, json);
}

function getScriptProperty_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  return value ? String(value).trim() : '';
}

/** Folder for new Docs from DOCS_FOLDER_ID, or null when unset. Accepts a bare ID or a folder URL. */
function getDocsFolder_() {
  var raw = getScriptProperty_('DOCS_FOLDER_ID');
  if (!raw) return null;
  var id = raw.replace(/^.*\/folders\//, '').replace(/[?#\/].*$/, '');
  var folder;
  try {
    folder = DriveApp.getFolderById(id);
  } catch (err) {
    if (!DRIVE_NOT_FOUND.test(String(err))) throw err; // a Drive hiccup: shown as a temporary problem
    throw new Error(
      "DOCS_FOLDER_ID is set, but this account cannot open that Drive folder. It may have been " +
        'deleted, or AutoPlanner\'s owner lost access to it. Contact Cayden Auyang or Luke Ryan.'
    );
  }
  if (folder.isTrashed()) {
    throw new Error(
      'AutoPlanner\'s shared folder "' + folder.getName() + '" is in the Drive trash. Its owner can ' +
        'restore it from the trash; until then no Doc is updated.'
    );
  }
  return folder;
}

// App.gs looks for this text to make a fresh Doc when the saved one is gone.
var DOC_GONE_PREFIX = 'Could not open the saved Google Doc';
// What Drive says when a file or folder doesn't exist (or this account can't see it). Any other
// error is a hiccup, and must never make AutoPlanner start a new Doc.
var DRIVE_NOT_FOUND = /No item with the given ID|Invalid file or folder ID|Unexpected error while getting the method or property get(File|Folder)ById|do not have permission|Access denied/i;
// Drive also says "Invalid argument" for a Doc that doesn't exist (seen live), but that wording isn't
// specific enough to make a new Doc on the first try: App.gs waits for a second update to agree.
var DRIVE_UNSURE = /Invalid argument/i;
var DOC_UNSURE_PREFIX = "Google Drive couldn't find this student's Doc just now";

/**
 * The saved Doc's Drive file. Throws an error starting with DOC_GONE_PREFIX when the Doc is in the
 * trash or can't be found (tried twice, in case Drive had a hiccup), so nothing is ever written to
 * a trashed Doc. Checked before any edit.
 */
function savedDocFile_(docId) {
  var file = null;
  var lastErr = null;
  for (var attempt = 0; attempt < 2 && !file; attempt++) {
    try {
      file = DriveApp.getFileById(docId);
    } catch (err) {
      lastErr = err;
      if (attempt === 0) Utilities.sleep(2000);
    }
  }
  if (!file && !DRIVE_NOT_FOUND.test(String(lastErr)) && DRIVE_UNSURE.test(String(lastErr))) {
    console.warn('Drive error for Doc ' + docId + ' (not sure it is gone yet): ' + lastErr);
    throw new Error(DOC_UNSURE_PREFIX + '. If it is still missing at an update 4 or more hours from now, ' +
      'AutoPlanner will make a new one.');
  }
  if (!file && !DRIVE_NOT_FOUND.test(String(lastErr))) {
    console.warn('Drive error for Doc ' + docId + ' (treated as a hiccup): ' + lastErr); // Drive's own words
    throw new Error("Google Drive didn't answer about this student's Doc. They'll be tried again at the next update.");
  }
  if (!file) throw new Error(DOC_GONE_PREFIX + ' (' + docId + '): ' + lastErr);
  if (file.isTrashed()) throw new Error(DOC_GONE_PREFIX + ' (' + docId + '): it is in the trash.');
  return file;
}

/**
 * Throws unless the Doc's Drive file is inside `folder`: directly, or in a folder inside it (a CLC
 * teacher's folder). Checked before any edit.
 */
function assertDocIsInFolder_(docId, folder) {
  var file = savedDocFile_(docId);
  if (isInsideFolder_(file, folder.getId(), 0)) return;
  // The message never names the Doc, so it can't reveal the title of a Doc outside the folder.
  throw new Error(
    'AutoPlanner only updates Docs in the "' + folder.getName() + '" folder (or a CLC teacher\'s ' +
      "folder inside it), and this student's Doc is not there. Move the Doc back into that folder and try again."
  );
}

/** True if one of a Drive item's folders is `folderId` or is inside it (up to 4 levels up). */
function isInsideFolder_(item, folderId, depth) {
  if (depth > 4) return false;
  var parents = item.getParents();
  while (parents.hasNext()) {
    var p = parents.next();
    if (p.getId() === folderId) return true;
    if (p.getParents && isInsideFolder_(p, folderId, depth + 1)) return true;
  }
  return false;
}

/**
 * @param {Object} data
 * @returns {{ docUrl: string, documentId: string }}
 */
function upsertPlannerDocument_(data) {
  var docId = data.documentId || data.spreadsheetId;
  var isNew = !docId;
  var desiredTitle = buildDocumentTitle_(data);
  var doc;
  // Look up the folder first, so a bad DOCS_FOLDER_ID fails before any Doc is created or changed.
  var folder = getDocsFolder_();

  if (docId) {
    if (folder) {
      assertDocIsInFolder_(docId, folder);
    } else {
      savedDocFile_(docId);
    }
    doc = DocumentApp.openById(docId);
    try {
      doc.setName(desiredTitle);
    } catch (renameErr) {
      /* ignore — e.g. insufficient permission on shared drives */
    }
  } else {
    doc = DocumentApp.create(desiredTitle);
    docId = doc.getId();
    if (folder) {
      // Into the student's CLC teacher's folder if they have one, else the shared folder.
      var dest = folder;
      if (data.targetFolderId) {
        try {
          dest = DriveApp.getFolderById(data.targetFolderId);
        } catch (e) {
          dest = folder;
        }
      }
      DriveApp.getFileById(docId).moveTo(dest);
    }
  }

  var prepared = {};
  var parentTabId = prepareParentTab_(docId, isNew, prepared);
  // One read serves the steps below; it's read again only after a step changes the Doc.
  var current = prepared.doc || docsGet_(docId);
  if (removeUpdatingLeftovers_(docId, findTabJsonById_(current, parentTabId))) current = docsGet_(docId);
  // Google allows 100 tabs in a Doc, and an update may need two more (a new week, and one being
  // rewritten). About 37 are added each school year, so a Doc kept for years gets there.
  var tabCount = countTabs_(current);
  if (tabCount + 2 > DOC_TAB_LIMIT) {
    throw new Error("This student's Doc has " + tabCount + ' tabs, and Google allows ' + DOC_TAB_LIMIT + '. Start a new Doc ' +
      'for them: add the year to this Doc\'s name, then Remove the student and add them again (quick start, "Summer, and a new school year").');
  }

  // Weeks that have ended move into "Past weeks" first; they are never rebuilt or read again.
  var today = Utilities.formatDate(new Date(), SCHEDULE_TIME_ZONE, 'yyyy-MM-dd');
  // A week tab staff renamed gets its title back first, so it's read, rebuilt and filed as usual.
  if (renameWeekTabsBack_(docId, parentTabId, today, current, Object.keys(data.weeks || {}))) current = docsGet_(docId);
  if (archivePastWeeks_(docId, parentTabId, today, current)) current = docsGet_(docId);

  var weeks = {};
  Object.keys(data.weeks || {}).forEach(function (k) { weeks[k] = data.weeks[k]; });
  // Never write a week that has ended (an update running across Sunday midnight would otherwise
  // make a blank copy of the week it just filed).
  var weekKeys = Object.keys(weeks).sort().filter(function (k) { return k >= scheduleWeekStart_(today); });
  // Every class keeps the same color every week.
  var courses = plannerCourseList_(data);
  var colorMap = buildCourseColorMap_(courses, readJsonProperty_('colors.' + docId));
  writeJsonProperty_('colors.' + docId, colorMap);

  // A week's tab somewhere else in the Doc (someone dragged it out of CLC Planner): every title must
  // be different, so a second one can't be made. Move it back first, so its Status and Notes are
  // read below and it's rebuilt in place.
  if (moveWeekTabsBack_(docId, parentTabId, weekKeys.map(function (k) { return buildWeekTabTitle_(k, weeks[k].week_label); }), current)) {
    current = docsGet_(docId);
  }

  // Read every current and upcoming week's Status and Notes before any tab is rebuilt, so they
  // follow an assignment that moved to another week.
  var beforeParent = findTabJsonById_(current, parentTabId);
  var lastWritten = readWritten_(docId);
  // A new Doc replacing a deleted one: the old Doc's record brings its Statuses back (see below).
  if (data.previousDocId && data.previousDocId !== docId && !Object.keys(lastWritten).length) {
    lastWritten = readWritten_(data.previousDocId);
  }
  var saved = collectSavedData_(beforeParent, lastWritten);
  // Back from a week that's been filed (an extension, or work pushed past these weeks): its Status
  // and Note come from that week, in Past weeks.
  restoreFromPastWeeks_(docId, parentTabId, weeks, saved);
  // An assignment with no row left in the Doc (its week tab or tables were deleted, or it moved
  // out of a week that has just been filed) gets its Status back from what was written last time.
  // Notes can't come back this way: only their fingerprints are kept outside the Doc.
  Object.keys(weeks).forEach(function (k) {
    (weeks[k].days || []).forEach(function (d) {
      (d.assignments || []).forEach(function (a) {
        var last = a.url && !scheduleHasKey_(saved.status, a.url) ? lastWritten[assignmentKey_(a.url)] : null;
        if (!last || !last.s) return;
        var settled = settleStatus_(last.s, saved.notes[a.url]);
        saved.status[a.url] = settled.status;
        if (settled.note) saved.notes[a.url] = settled.note;
      });
    });
  });

  // Every current and upcoming week tab is rebuilt from fresh data, including a week where nothing
  // is due any more, so an assignment is only ever in one week tab.
  ((beforeParent && beforeParent.childTabs) || []).forEach(function (t) {
    var key = weekKeyFromTabTitle_(t.tabProperties.title);
    if (!key || key < scheduleWeekStart_(today) || weeks[key]) return;
    weeks[key] = {
      week_label: scheduleShortDate_(key) + ' \u2013 ' + scheduleShortDate_(scheduleAddDays_(key, 6)),
      days: [],
    };
    weekKeys.push(key);
  });
  weekKeys.sort();

  // A row with a Status or Note whose assignment left the planner stays in its week (see
  // keptAssignments_), so nothing staff typed disappears without a trace.
  keptAssignments_(beforeParent, weeks, saved, data.elsewhere, today).forEach(function (k) {
    weeks[k.week] = weekWithAssignment_(weeks[k.week], k.item);
  });

  if (weekKeys.length === 0) {
    saveWritten_(docId, {});
    rebuildHomeTab_(docId, parentTabId, data, courses, colorMap, new Date());
    return { docUrl: doc.getUrl(), documentId: docId };
  }

  var staffCounts = {};
  var nextRead = null; // the Doc as the last week left it, when that week's last look can be reused
  var weeksDone = [];
  var slowestWeekMs = 60 * 1000;
  var stoppedEarly = false;
  weekKeys.forEach(function (weekKey, i) {
    if (stoppedEarly) return;
    // Stop cleanly between weeks rather than be stopped by Apps Script's time limit partway: the
    // weeks not done keep their content (and their Status and Notes) until the next update.
    if (!data.noDeadline && msLeftInExecution_() < slowestWeekMs + UPDATE_RESERVE_MS) {
      stoppedEarly = true;
      return;
    }
    var weekStartedAt = Date.now();
    var weekData = weeks[weekKey];
    var tabTitle = buildWeekTabTitle_(weekKey, weekData.week_label);

    // The first week can use the read above (nothing has changed since); later weeks use the last
    // week's final read, or read again.
    var resource = i === 0 ? current : nextRead || docsGet_(docId);
    nextRead = null;
    var parentJson = findTabJsonById_(resource, parentTabId);
    var existingWeekTabId =
      parentJson && findChildTabIdByTitle_(parentJson, tabTitle);

    var tabId;
    var probe = resource; // fillWeekTabDocsApi_ can use this read unless a tab is added first
    if (existingWeekTabId) {
      tabId = existingWeekTabId;
    } else {
      tabId = addWeekChildTab_(
        docId,
        parentTabId,
        tabTitle,
        nextChildTabInsertIndex_(parentJson)
      );
      probe = null;
    }

    var after = {};
    staffCounts[weekKey] = fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData, courses, colorMap, saved, beforeParent, probe, after);
    nextRead = after.doc;
    sleepDocsChunkGap_();
    weeksDone.push(weekKey);
    var took = Date.now() - weekStartedAt;
    slowestWeekMs = Math.max(slowestWeekMs, took);
    if (updateStats_) updateStats_.weeks.push({ week: scheduleShortDate_(weekKey), ms: took });
  });

  // Remember what was written, so next time an edit in either table can be told apart. Weeks not
  // done this time keep last time's record.
  var written = {};
  if (stoppedEarly) {
    Object.keys(lastWritten).forEach(function (k) {
      var w = lastWritten[k].w;
      if (w >= scheduleWeekStart_(today) && weeksDone.indexOf(w) === -1) written[k] = lastWritten[k];
    });
  }
  weeksDone.forEach(function (weekKey) {
    (weeks[weekKey].days || []).forEach(function (d) {
      (d.assignments || []).forEach(function (a) {
        if (!a.url) return;
        written[assignmentKey_(a.url)] = {
          w: weekKey,
          s: saved.status[a.url] || STATUS_DEFAULT,
          n: noteFingerprint_(saved.notes[a.url] || ''),
        };
      });
    });
  });
  saveWritten_(docId, written);
  if (data.previousDocId && data.previousDocId !== docId) {
    deleteWritten_(data.previousDocId);
    PropertiesService.getScriptProperties().deleteProperty('filed.' + data.previousDocId);
  }

  // The home tab last, so its "Open this week" link can point at this week's (new) tab.
  rebuildHomeTab_(docId, parentTabId, data, courses, colorMap, new Date(), staffCounts, stoppedEarly ? null : nextRead);

  return { docUrl: DocumentApp.openById(docId).getUrl(), documentId: docId, weeksDone: weeksDone.length, weeksTotal: weekKeys.length, tabs: tabCount };
}

var DOC_TAB_LIMIT = 100;

/** How many tabs a Doc has, at every level (the read lists Past weeks' tabs, without their content). */
function countTabs_(docJson) {
  var n = 0;
  (function walk(tabs) {
    (tabs || []).forEach(function (t) {
      n++;
      walk(t.childTabs);
    });
  })(docJson.tabs);
  return n;
}

function buildWeekTabTitle_(weekKey, weekLabel) {
  var y = String(weekKey).split('-')[0] || '';
  var label = weekLabel || weekKey;
  var t = 'Week of ' + label + ', ' + y;
  // A week that crosses New Year shows both years: "Week of Dec 28, 2026 – Jan 3, 2027".
  var m = /^([A-Z][a-z]{2} \d{1,2}) \u2013 ([A-Z][a-z]{2} \d{1,2})$/.exec(String(label));
  var y2 = /^\d{4}-\d{2}-\d{2}$/.test(String(weekKey)) ? scheduleAddDays_(weekKey, 6).slice(0, 4) : y;
  if (m && y2 !== y) t = 'Week of ' + m[1] + ', ' + y + ' \u2013 ' + m[2] + ', ' + y2;
  if (t.length > 95) {
    t = t.substring(0, 92) + '…';
  }
  return t;
}

function countAssignmentsInWeek_(days) {
  var n = 0;
  days.forEach(function (d) {
    n += (d.assignments || []).length;
  });
  return n;
}

/**
 * Rename default root tab on first create; otherwise locate CLC Planner or first root tab. If `out`
 * is given and nothing was changed, out.doc is the read it made, so the update can use it.
 */
function prepareParentTab_(docId, isNew, out) {
  var resource = docsGet_(docId);
  if (out) out.doc = null;
  var tabs = resource.tabs || [];
  if (!tabs.length) {
    throw new Error('Document has no tabs (unexpected for this account).');
  }

  if (isNew) {
    var pid = tabs[0].tabProperties.tabId;
    docsBatchUpdate_(docId, [
      {
        updateDocumentTabProperties: {
          tabProperties: { tabId: pid, title: PARENT_TAB_TITLE },
          fields: 'title',
        },
      },
    ]);
    return pid;
  }

  var named = findRootTabIdByTitle_(resource, PARENT_TAB_TITLE);
  if (named) {
    if (out) out.doc = resource;
    return named;
  }

  if (tabs.length === 1 && tabs[0].tabProperties) {
    var onlyId = tabs[0].tabProperties.tabId;
    docsBatchUpdate_(docId, [
      {
        updateDocumentTabProperties: {
          tabProperties: { tabId: onlyId, title: PARENT_TAB_TITLE },
          fields: 'title',
        },
      },
    ]);
    return onlyId;
  }

  if (!tabs[0].tabProperties) {
    throw new Error('Could not read root tab metadata.');
  }
  return tabs[0].tabProperties.tabId;
}

function findRootTabIdByTitle_(docJson, title) {
  var tabs = docJson.tabs || [];
  for (var i = 0; i < tabs.length; i++) {
    var tp = tabs[i].tabProperties || {};
    if (tp.title === title) return tp.tabId;
  }
  return null;
}

// Google Docs needs every tab title in a Doc to be different (checked live: even tabs at different
// levels). A week being rebuilt is written under this temporary title, then renamed.
var UPDATING_SUFFIX = ' (updating)';

/** The tab with exactly this title anywhere in the Doc (any level), or null. */
function findTabByTitleAnywhere_(docJson, title) {
  function walk(tabs) {
    for (var i = 0; i < (tabs || []).length; i++) {
      if ((tabs[i].tabProperties || {}).title === title) return tabs[i];
      var f = walk(tabs[i].childTabs);
      if (f) return f;
    }
    return null;
  }
  return walk(docJson.tabs);
}

/**
 * Deletes the "(updating)" tabs an earlier update left when it was cut off mid-rebuild. Their
 * week's real tab is still there, untouched, with its Status and Notes, so nothing is lost.
 */
function removeUpdatingLeftovers_(docId, parentTabJson) {
  var leftovers = ((parentTabJson && parentTabJson.childTabs) || []).filter(function (t) {
    var title = (t.tabProperties || {}).title || '';
    return title.length > UPDATING_SUFFIX.length && title.slice(-UPDATING_SUFFIX.length) === UPDATING_SUFFIX;
  });
  if (leftovers.length) {
    docsBatchUpdate_(docId, leftovers.map(function (t) { return { deleteTab: { tabId: t.tabProperties.tabId } }; }));
  }
  return leftovers.length;
}

/** Moves tabs with these titles that aren't under CLC Planner back under it (above "Past weeks"). */
function moveWeekTabsBack_(docId, parentTabId, titles, readDoc) {
  var doc = readDoc || docsGet_(docId);
  var parent = findTabJsonById_(doc, parentTabId);
  var at = nextChildTabInsertIndex_(parent);
  var moves = [];
  titles.forEach(function (title) {
    if (findChildTabIdByTitle_(parent, title)) return;
    var tab = findTabByTitleAnywhere_(doc, title);
    if (!tab) return;
    moves.push({
      updateDocumentTabProperties: {
        tabProperties: { tabId: tab.tabProperties.tabId, parentTabId: parentTabId, index: at + moves.length },
        fields: 'parentTabId,index',
      },
    });
  });
  if (moves.length) docsBatchUpdate_(docId, moves);
  return moves.length;
}

function findTabJsonById_(docJson, tabId) {
  function walk(tab) {
    if (!tab || !tab.tabProperties) return null;
    if (tab.tabProperties.tabId === tabId) return tab;
    var kids = tab.childTabs || [];
    for (var i = 0; i < kids.length; i++) {
      var f = walk(kids[i]);
      if (f) return f;
    }
    return null;
  }
  var roots = docJson.tabs || [];
  for (var j = 0; j < roots.length; j++) {
    var found = walk(roots[j]);
    if (found) return found;
  }
  return null;
}

function findChildTabIdByTitle_(parentTabJson, title) {
  var kids = parentTabJson.childTabs || [];
  for (var i = 0; i < kids.length; i++) {
    var tp = kids[i].tabProperties || {};
    if (tp.title === title) return tp.tabId;
  }
  return null;
}

/** Where a new week tab goes: after the other weeks, but before the "Past weeks" tab (kept last). */
function nextChildTabInsertIndex_(parentTabJson) {
  var kids = (parentTabJson && parentTabJson.childTabs) || [];
  for (var i = 0; i < kids.length; i++) {
    if ((kids[i].tabProperties || {}).title === PAST_WEEKS_TITLE) return i;
  }
  return kids.length;
}

// ---- Past weeks: ended week tabs move into one "Past weeks" tab, untouched -----------------
var PAST_WEEKS_TITLE = 'Past weeks';
var PAST_WEEKS_LINE = 'Every past week, with the Status and Notes typed during it. AutoPlanner never changes these.';

/** "Week of Oct 5 – Oct 11, 2026" gives '2026-10-05' (its Monday); any other tab title gives null. */
function weekKeyFromTabTitle_(title) {
  var m = /^Week of ([A-Z][a-z]{2}) (\d{1,2}) \u2013 [A-Z][a-z]{2} \d{1,2}, (\d{4})$/.exec(String(title || '')) ||
    /^Week of ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) \u2013 [A-Z][a-z]{2} \d{1,2}, \d{4}$/.exec(String(title || ''));
  if (!m) return null;
  var month = SCHEDULE_MONTH_NAMES.indexOf(m[1]);
  if (month === -1) return null;
  return m[3] + '-' + ('0' + (month + 1)).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

/**
 * Week tabs staff renamed (their title isn't "Week of …, yyyy" any more) get their title back, found
 * from the heading AutoPlanner wrote at the top of the tab ("Week of Oct 5 – Oct 11"). Otherwise
 * the week would be made again under its own title, with its Status and Notes left behind in the
 * renamed tab, which would never be filed into Past weeks. Returns how many were renamed.
 */
function renameWeekTabsBack_(docId, parentTabId, today, readDoc, knownWeeks) {
  var doc = readDoc || docsGet_(docId);
  var parent = findTabJsonById_(doc, parentTabId);
  var reqs = [];
  var taken = {};
  ((parent && parent.childTabs) || []).forEach(function (t) {
    var title = (t.tabProperties || {}).title || '';
    if (title === PAST_WEEKS_TITLE || title.slice(-UPDATING_SUFFIX.length) === UPDATING_SUFFIX) return;
    var titled = weekKeyFromTabTitle_(title);
    if (titled) {
      // A week tab under an older form of its title (the year at the end of a week that crosses New Year).
      var current = buildWeekTabTitle_(titled, scheduleShortDate_(titled) + ' \u2013 ' + scheduleShortDate_(scheduleAddDays_(titled, 6)));
      if (current !== title && !taken[current] && !findTabByTitleAnywhere_(doc, current)) {
        taken[current] = true;
        reqs.push({ updateDocumentTabProperties: { tabProperties: { tabId: t.tabProperties.tabId, title: current }, fields: 'title' } });
      }
      return;
    }
    var body = t.documentTab && t.documentTab.body;
    var heading = body ? tabBodyPlainText_(body).replace(/^\s+/, '').split('\n')[0] : '';
    var key = weekKeyFromHeading_(heading, today, knownWeeks);
    if (!key) return;
    var proper = buildWeekTabTitle_(key, heading.replace(/^Week of /, ''));
    if (taken[proper] || findTabByTitleAnywhere_(doc, proper)) return;
    taken[proper] = true;
    reqs.push({ updateDocumentTabProperties: { tabProperties: { tabId: t.tabProperties.tabId, title: proper }, fields: 'title' } });
  });
  if (reqs.length) docsBatchUpdate_(docId, reqs);
  return reqs.length;
}

/**
 * "Week of Oct 5 – Oct 11" (a week tab's heading, which has no year) gives its Monday: one of
 * `knownWeeks` (this update's weeks) if it matches, else the year nearest `today`.
 */
function weekKeyFromHeading_(heading, today, knownWeeks) {
  var m = /^Week of ([A-Z][a-z]{2} \d{1,2}) \u2013 ([A-Z][a-z]{2} \d{1,2})$/.exec(String(heading || ''));
  if (!m) return null;
  var known = (knownWeeks || []).filter(function (k) {
    return scheduleShortDate_(k) === m[1] && scheduleShortDate_(scheduleAddDays_(k, 6)) === m[2];
  })[0];
  if (known) return known;
  var year = Number(String(today).slice(0, 4));
  var best = null;
  [year - 1, year, year + 1].forEach(function (y) {
    var key = weekKeyFromTabTitle_('Week of ' + m[1] + ' \u2013 ' + m[2] + ', ' + y);
    if (!key || scheduleWeekdayIndex_(key) !== 0 || scheduleShortDate_(scheduleAddDays_(key, 6)) !== m[2]) return;
    if (!best || Math.abs(scheduleDaysBetween_(today, key)) < Math.abs(scheduleDaysBetween_(today, best))) best = key;
  });
  return best;
}

/**
 * Moves every week tab that has ended (its Sunday is before `today`, New York time) into the
 * "Past weeks" tab, newest first. Creates "Past weeks" for the first past week. Moving the tab is
 * the only change: a past week's content is never read, edited, rebuilt or deleted.
 * Returns how many tabs moved.
 */
function archivePastWeeks_(docId, parentTabId, today, readDoc) {
  var docJson = readDoc || docsGet_(docId);
  var parent = findTabJsonById_(docJson, parentTabId);
  var ended = endedWeekTabs_(parent, today);
  if (!ended.length) return 0;
  var pastId = findChildTabIdByTitle_(parent, PAST_WEEKS_TITLE);
  // A "Past weeks" tab somewhere else in the Doc: titles must be unique, so use that one.
  if (!pastId) {
    var other = findTabByTitleAnywhere_(docJson, PAST_WEEKS_TITLE);
    if (other) pastId = other.tabProperties.tabId;
  }
  if (!pastId) {
    pastId = addWeekChildTab_(docId, parentTabId, PAST_WEEKS_TITLE, parent.childTabs.length);
    docsBatchUpdate_(docId, [{ insertText: { text: PAST_WEEKS_LINE, location: { tabId: pastId, index: 1 } } }]);
  }
  docsBatchUpdate_(docId, archiveMoveRequests_(ended, pastId));
  rememberFiledAssignments_(docId, ended.map(function (w) {
    return { key: w.key, tab: parent.childTabs.filter(function (t) { return t.tabProperties.tabId === w.id; })[0] };
  }), today, readWritten_(docId));
  return ended.length;
}

// ---- Assignments that come back from a filed week ---------------------------------------------
// Overdue work is often given a new date after its week has been filed into Past weeks, and work
// pushed past these weeks comes back later. Past weeks aren't read on a normal update, so the
// assignment would come back blank. When a week is filed, the IDs of its assignments with a Status
// or Note are kept for 10 weeks in "filed.<docId>", with what AutoPlanner last wrote for them (in
// the "last written" form: week, Status, a note's fingerprint; never the notes themselves). If one
// comes back with no row in the current weeks, that one update also reads Past weeks' content and
// copies its Status and Note from the filed week: the copy staff edited last, as for current weeks.
var FILED_KEEP_DAYS = 70;
var FILED_MAX_CHARS = 8000;

/** { id: { w, s, n } } (see decodeWritten_); an entry with no record is just { w }. */
function readFiled_(docId) {
  var raw;
  try {
    raw = JSON.parse(PropertiesService.getScriptProperties().getProperty('filed.' + docId) || '{}') || {};
  } catch (e) {
    raw = {};
  }
  var out = {};
  Object.keys(raw).forEach(function (id) {
    var v = String(raw[id]);
    out[id] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? { w: v } : decodeWritten_(v);
  });
  return out;
}

function rememberFiledAssignments_(docId, filedWeeks, today, record) {
  var map = readFiled_(docId);
  filedWeeks.forEach(function (w) {
    eachAssignmentCopy_(w.tab, function (url, kind, status, note) {
      if ((!status || status === STATUS_DEFAULT) && !note) return;
      var id = assignmentKey_(url);
      var last = (record || {})[id];
      map[id] = last && last.w === w.key ? last : { w: w.key };
    });
  });
  var oldest = scheduleAddDays_(scheduleWeekStart_(today), -FILED_KEEP_DAYS);
  var ids = Object.keys(map).filter(function (id) { return map[id].w >= oldest; });
  ids.sort(function (a, b) { return map[a].w < map[b].w ? 1 : map[a].w > map[b].w ? -1 : 0; }); // newest first
  var kept = {};
  var size = 2;
  ids.forEach(function (id) {
    var v = map[id].s ? encodeWritten_(map[id]) : map[id].w;
    size += id.length + v.length + 6;
    if (size <= FILED_MAX_CHARS) kept[id] = v;
  });
  var props = PropertiesService.getScriptProperties();
  if (Object.keys(kept).length) props.setProperty('filed.' + docId, JSON.stringify(kept));
  else props.deleteProperty('filed.' + docId);
}

/**
 * Status and Notes for assignments that are back on the planner with no row in the current weeks,
 * copied from the filed week they were in (see above). Gives back how many came back.
 */
function restoreFromPastWeeks_(docId, parentTabId, weeks, saved) {
  var filed = readFiled_(docId);
  var wanted = {};
  Object.keys(weeks).forEach(function (k) {
    (weeks[k].days || []).forEach(function (d) {
      (d.assignments || []).forEach(function (a) {
        var entry = a.url && !scheduleHasKey_(saved.status, a.url) ? filed[assignmentKey_(a.url)] : null;
        if (entry) wanted[a.url] = entry;
      });
    });
  });
  var urls = Object.keys(wanted);
  if (!urls.length) return 0;
  var deep = docsGet_(docId, { includeTabsContent: true, fields: DOCS_GET_FIELDS_WITH_PAST });
  var parent = findTabJsonById_(deep, parentTabId);
  var pastId = parent && findChildTabIdByTitle_(parent, PAST_WEEKS_TITLE);
  var past = pastId ? findTabJsonById_(deep, pastId) : findTabByTitleAnywhere_(deep, PAST_WEEKS_TITLE);
  var n = 0;
  urls.forEach(function (url) {
    var tab = ((past && past.childTabs) || []).filter(function (t) {
      return weekKeyFromTabTitle_((t.tabProperties || {}).title) === wanted[url].w;
    })[0];
    if (!tab) return;
    // The same choice as for current weeks: the copy that differs from what was last written wins.
    var record = {};
    record[assignmentKey_(url)] = wanted[url];
    var found = collectSavedData_({ childTabs: [tab] }, record);
    if (scheduleHasKey_(found.status, url)) {
      saved.status[url] = found.status[url];
      saved.notes[url] = found.notes[url];
      n++;
    }
  });
  return n;
}

/** The week tabs directly under CLC Planner whose week ended before `today`, oldest first. */
function endedWeekTabs_(parentTabJson, today) {
  var thisMonday = scheduleWeekStart_(today);
  return ((parentTabJson && parentTabJson.childTabs) || []).map(function (t) {
    var p = t.tabProperties || {};
    return { id: p.tabId, key: weekKeyFromTabTitle_(p.title) };
  }).filter(function (w) {
    return w.key && w.key < thisMonday;
  }).sort(function (a, b) {
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** Oldest first, each to the top of "Past weeks", so the newest week ends up first. */
function archiveMoveRequests_(ended, pastId) {
  return ended.map(function (w) {
    return {
      updateDocumentTabProperties: {
        tabProperties: { tabId: w.id, parentTabId: pastId, index: 0 },
        fields: 'parentTabId,index',
      },
    };
  });
}

/**
 * Status and Notes for every assignment, by Canvas link, from every current and upcoming week tab
 * ("Past weeks" is never read), so they follow an assignment whose due date moves to another week.
 *
 * Each value can appear in several places: By Class and By Day in one tab, and (until the next
 * rebuild) more than one week. `written` says what AutoPlanner wrote last time for each assignment
 * (see readWritten_); a copy that differs from it is a staff edit, and an edit always wins. If
 * there's no record (or no edit), a chosen value beats the first choice. Between several edits, the
 * copy from the week the assignment was in last time wins, then By Class, then the most recent week.
 *
 * A Status cell with no chip and no text says nothing (staff deleted the chip): the other copy, or
 * what was written last time, is used. A Status that isn't one of the three choices (typed before
 * Status was a dropdown) moves to the start of the note (see settleStatus_).
 */
function collectSavedData_(parentTabJson, written) {
  var record = written || {};
  var copies = {};
  ((parentTabJson && parentTabJson.childTabs) || []).forEach(function (t) {
    var key = weekKeyFromTabTitle_((t.tabProperties || {}).title);
    if (!key) return; // "Past weeks", "(updating)" leftovers and other tabs are never read
    eachAssignmentCopy_(t, function (url, kind, status, note) {
      (copies[url] = copies[url] || []).push({ week: key, kind: kind, status: status, note: note });
    });
  });
  var result = { notes: {}, status: {} };
  Object.keys(copies).forEach(function (url) {
    var list = copies[url];
    var last = record[assignmentKey_(url)];
    var order = function (a, b) {
      var lastWeek = last ? last.w : null;
      var aw = a.week === lastWeek ? 0 : 1, bw = b.week === lastWeek ? 0 : 1;
      if (aw !== bw) return aw - bw;
      var ak = a.kind === 'day' ? 1 : 0, bk = b.kind === 'day' ? 1 : 0;
      if (ak !== bk) return ak - bk;
      return a.week < b.week ? 1 : a.week > b.week ? -1 : 0;
    };
    var pick = function (from, get, fingerprint, writtenPrint) {
      var edits = from.filter(function (c) { return fingerprint(get(c)) !== writtenPrint; }).sort(order);
      return edits.length ? get(edits[0]) : get(from.slice().sort(order)[0]);
    };
    var lastStatus = last && last.s ? last.s : STATUS_DEFAULT;
    var withStatus = list.filter(function (c) { return c.status !== ''; });
    var status = withStatus.length
      ? pick(withStatus, function (c) { return c.status; }, function (v) { return v; }, lastStatus)
      : lastStatus;
    var note = pick(list, function (c) { return c.note; }, noteFingerprint_, last ? last.n : noteFingerprint_(''));
    var settled = settleStatus_(status, note);
    result.status[url] = settled.status;
    result.notes[url] = settled.note;
  });
  return result;
}

/**
 * Assignments that left the planner while their row had a Status or Note: removed or unpublished in
 * Canvas, given a due date outside these weeks, or no due date any more. Each stays in its week,
 * with its Status and Note, and a line under its title says why ("Not on Canvas", "Now due Nov 30",
 * "No due date"), until it comes back (then its Status and Note follow it as usual) or the week ends.
 * Without this, a teacher unpublishing an assignment for a day would wipe the notes typed on it.
 * Gives back [{ week, item }], item shaped like a Canvas assignment plus kept_reason.
 */
function keptAssignments_(parentTabJson, weeks, saved, elsewhere, today) {
  var onPlanner = {};
  Object.keys(weeks).forEach(function (k) {
    (weeks[k].days || []).forEach(function (d) {
      (d.assignments || []).forEach(function (a) { if (a.url) onPlanner[a.url] = true; });
    });
  });
  var found = {};
  ((parentTabJson && parentTabJson.childTabs) || []).forEach(function (t) {
    var key = weekKeyFromTabTitle_((t.tabProperties || {}).title);
    if (!key || key < scheduleWeekStart_(today) || !weeks[key]) return;
    eachAssignmentRow_(t, function (row) {
      if (onPlanner[row.url]) return;
      var typed = (saved.status[row.url] || STATUS_DEFAULT) !== STATUS_DEFAULT || saved.notes[row.url];
      if (!typed || (found[row.url] && found[row.url].kind === 'class')) return; // By Class knows the class
      row.week = key;
      found[row.url] = row;
    });
  });
  return Object.keys(found).map(function (url) {
    var r = found[url];
    var due = (elsewhere || {})[url];
    var day = SCHEDULE_WEEKDAY_NAMES.indexOf(r.day) >= 0 ? r.day : SCHEDULE_WEEKDAY_NAMES[0];
    return {
      week: r.week,
      item: {
        day: day,
        assignment: r.title,
        course: r.course || '(No Course)',
        due_time: r.dueTime,
        kept_reason: due === undefined ? KEPT_NOT_ON_CANVAS : due === '' ? KEPT_NO_DUE_DATE : 'Now due ' + scheduleShortDate_(due),
        days_until_due: null,
        due_date: scheduleAddDays_(r.week, SCHEDULE_WEEKDAY_NAMES.indexOf(day)),
        week_start: r.week,
        url: url,
      },
    };
  });
}
var KEPT_NOT_ON_CANVAS = 'Not on Canvas';
var KEPT_NO_DUE_DATE = 'No due date';

/** A copy of a week with `item` added on its day (and all seven days listed, in order). */
function weekWithAssignment_(week, item) {
  var days = SCHEDULE_WEEKDAY_NAMES.map(function (name) {
    var have = (week.days || []).filter(function (d) { return d.day === name; })[0];
    var list = have ? (have.assignments || []).slice() : [];
    if (name === item.day) list.push(item);
    return { day: name, assignments: list };
  });
  return { week_label: week.week_label, days: days };
}

// ---- Reading a week tab ----------------------------------------------------------------------------

/**
 * How one of a week tab's tables is laid out, or null if AutoPlanner doesn't read it.
 *   kind:   'day' (By Day), 'class' (a By Class table) or 'weekend' (a Weekend plan table)
 *   status, notes: the columns that hold Status and Notes
 *   old:    true for the six columns week tabs had before November 2026 (Assignment, Day or Course,
 *           Due Time, Priority, Status, Notes). They're still read: that's how a Doc gets to this
 *           layout without losing anything, and weeks filed in Past weeks keep the old one.
 *   header: (By Day in this layout) the row with the column names
 *   day:    (Weekend plan) 'Saturday' or 'Sunday', or '' if its first cell no longer says
 * Tables are told apart by their number of columns, so one more column added at the right end of a
 * table doesn't stop it being read. (A Weekend plan table with an added column is known by its
 * header row: the day, then "Assignment".)
 */
function tableLayout_(table) {
  var rows = table.tableRows || [];
  var cols = table.columns || 0;
  var text = function (r, c) {
    var cells = (rows[r] && rows[r].tableCells) || [];
    return cells.length > c ? getCellText_(cells[c]) : '';
  };
  var heads = [text(0, 1), text(1, 1)];
  if (cols >= 6) return { kind: heads.indexOf('Course') >= 0 ? 'day' : 'class', status: 4, notes: 5, old: true };
  var weekendDay = weekdayFromText_(text(0, 0));
  if (cols === 3) return { kind: 'weekend', day: weekendTable_(weekendDay) ? weekendDay : '' };
  if (cols === 4 || cols === 5) {
    if (weekendTable_(text(0, 0)) && text(0, 1) === WEEKEND_HEADERS[0]) return { kind: 'weekend', day: text(0, 0) };
    var header = heads.indexOf(BY_DAY_HEADERS[1]);
    return header >= 0
      ? { kind: 'day', status: 2, notes: 3, old: false, header: header }
      : { kind: 'class', status: 2, notes: 3, old: false };
  }
  return null;
}

/** The Weekend plan table for 'Saturday' or 'Sunday' (see WEEKEND_TABLES), or null. */
function weekendTable_(day) {
  return WEEKEND_TABLES.filter(function (w) { return w.day === day; })[0] || null;
}

/**
 * Every table in a week tab that AutoPlanner reads: [{ rows, layout }] (see tableLayout_). The old
 * "Added by staff" table isn't one of them (see moveOldStaffRows_).
 */
function weekTabTables_(tabJson) {
  var content = (tabJson && tabJson.documentTab && tabJson.documentTab.body && tabJson.documentTab.body.content) || [];
  var oldStaff = findOldStaffTable_(tabJson);
  var out = [];
  content.forEach(function (el) {
    var layout = el.table && el.table !== oldStaff ? tableLayout_(el.table) : null;
    if (layout) out.push({ rows: el.table.tableRows || [], layout: layout });
  });
  return out;
}

/**
 * What this layout's By Class tables say about the assignments in a week tab:
 *   days:     { assignment link: the weekday in its Due cell }
 *   titles:   { assignment link: its title (the linked words) }
 *   unlinked: { title: true } for assignments Canvas gave no link for (rare). Their By Day rows have
 *             no link either, and must not be taken for to-dos staff typed.
 */
function classTableRows_(tables) {
  var found = { days: {}, titles: {}, unlinked: {} };
  tables.forEach(function (t) {
    if (t.layout.kind !== 'class' || t.layout.old) return;
    t.rows.forEach(function (row, r) {
      var cells = row.tableCells || [];
      if (cells.length <= t.layout.notes) return;
      var url = getCellLinkUrl_(cells[0]);
      if (url && !scheduleHasKey_(found.days, url)) {
        found.days[url] = weekdayFromText_(getCellText_(cells[1]));
        found.titles[url] = cellLinkText_(cells[0]);
      }
      // Rows 0 and 1 are the class name and the column names.
      if (!url && r > 1 && getCellText_(cells[0])) found.unlinked[getCellText_(cells[0])] = true;
    });
  });
  return found;
}

/** True for a By Day row that shows a Canvas assignment without a link (see classTableRows_). */
function isUnlinkedCanvasRow_(cells, unlinked) {
  var text = getCellText_(cells[0]);
  return scheduleHasKey_(unlinked, text) || scheduleHasKey_(unlinked, text.replace(/ \(due [^)]*\)$/, ''));
}

/**
 * Calls fn({ url, kind, title, course, day, dueTime, status, note }) for every assignment row in a
 * week tab; kind is 'class' or 'day'. By Class tables give the class (their first row) and the day;
 * By Day gives the day from its day rows. status is '' when a Status cell holds no chip and no text.
 * For selfTest the row also carries `text` (everything in its Assignment cell: the title, and under
 * it the line that says why a row was kept) and its Status and Notes cells (statusCell, noteCell).
 */
function eachAssignmentRow_(tabJson, fn) {
  var tables = weekTabTables_(tabJson);
  var fromClass = classTableRows_(tables);
  tables.forEach(function (t) {
    var L = t.layout;
    if (L.kind !== 'class') return;
    var first = t.rows.length && t.rows[0].tableCells && t.rows[0].tableCells.length ? t.rows[0].tableCells[0] : null;
    var course = first && !getCellLinkUrl_(first) ? getCellText_(first) : '';
    t.rows.forEach(function (row) {
      var cells = row.tableCells || [];
      var url = cells.length > L.notes ? getCellLinkUrl_(cells[0]) : null;
      if (!url) return;
      var due = getCellText_(cells[1]);
      var day = L.old ? due : weekdayFromText_(due);
      fn({
        url: url,
        kind: 'class',
        title: cellLinkText_(cells[0]),
        course: course,
        day: day,
        dueTime: L.old ? getCellText_(cells[2]) : dueTimeFromText_(due),
        status: cellStatus_(cells[L.status], L.old),
        note: getCellText_(cells[L.notes]),
        text: getCellText_(cells[0]),
        statusCell: cells[L.status],
        noteCell: cells[L.notes],
      });
    });
  });
  tables.forEach(function (t) {
    var L = t.layout;
    if (L.kind !== 'day') return;
    eachDayTableRow_(t, fromClass, function (cells, day) {
      var title = cellLinkText_(cells[0]);
      var whole = getCellText_(cells[0]);
      fn({
        url: getCellLinkUrl_(cells[0]),
        kind: 'day',
        title: title,
        course: getCellText_(cells[1]),
        day: day,
        dueTime: L.old ? getCellText_(cells[2]) : dueTimeFromText_(whole.indexOf(title) === 0 ? whole.slice(title.length) : ''),
        status: cellStatus_(cells[L.status], L.old),
        note: getCellText_(cells[L.notes]),
        text: whole,
        statusCell: cells[L.status],
        noteCell: cells[L.notes],
      });
    }, null);
  });
}

/**
 * Walks one By Day table: onCanvas(cells, day) for each assignment row AutoPlanner wrote, and
 * onStaff(cells, day) for every other row under the column names (the blank "+ Add a to-do" rows and
 * the to-dos staff typed). Day rows only set the day.
 *
 * A row is Canvas work when its first link is also in one of this tab's By Class tables, because
 * AutoPlanner writes every assignment in both. That way a to-do staff typed with a Canvas link in it
 * stays theirs. If a link is in By Day twice (staff pasted it into a to-do in the same week), the
 * Canvas row is the one under the assignment's own day with the assignment's title; the other one
 * is the to-do. (Before November 2026 staff couldn't add rows here: every row with a link is Canvas
 * work.)
 * A Canvas assignment that came without a link can't keep a Status or Note, so its row is skipped.
 */
function eachDayTableRow_(t, fromClass, onCanvas, onStaff) {
  var classDays = fromClass.days;
  var L = t.layout;
  var rows = t.rows.map(function (row) { return row.tableCells || []; });
  var dayOf = [];
  var isDayRow = [];
  var day = '';
  rows.forEach(function (cells, i) {
    isDayRow[i] = cells.length > 0 && dayRowName_(cells, L) !== '';
    if (isDayRow[i]) day = dayRowName_(cells, L);
    dayOf[i] = day;
  });
  var canvasRow = {}; // link -> the row AutoPlanner wrote for it
  var match = {}; // link -> how well that row fits (right day 2, right title 1)
  rows.forEach(function (cells, i) {
    var url = cells.length > L.notes && !isDayRow[i] ? getCellLinkUrl_(cells[0]) : null;
    if (!url || !(L.old || scheduleHasKey_(classDays, url))) return;
    if (L.old) { canvasRow[url + ' ' + i] = i; return; } // every linked row, as it always was
    var fits = (dayOf[i] === classDays[url] ? 2 : 0) + (cellLinkText_(cells[0]) === fromClass.titles[url] ? 1 : 0);
    if (!scheduleHasKey_(canvasRow, url) || fits > match[url]) { canvasRow[url] = i; match[url] = fits; }
  });
  rows.forEach(function (cells, i) {
    if (cells.length <= L.notes || isDayRow[i] || (!L.old && i <= L.header)) return;
    var url = getCellLinkUrl_(cells[0]);
    var isCanvas = url && (L.old ? true : canvasRow[url] === i);
    if (isCanvas) onCanvas(cells, dayOf[i]);
    else if (!url && isUnlinkedCanvasRow_(cells, fromClass.unlinked)) return;
    else if (!L.old && onStaff) onStaff(cells, dayOf[i]);
  });
}

/**
 * The weekday a By Day row announces ("Monday"), or '' if it isn't a day row. In this layout a day
 * row is bold with nothing else in the row, so a to-do staff called "Monday" stays a to-do.
 */
function dayRowName_(cells, layout) {
  var name = getCellText_(cells[0]);
  if (SCHEDULE_WEEKDAY_NAMES.indexOf(name) < 0 || getCellLinkUrl_(cells[0])) return '';
  if (layout.old) return name;
  var others = cells.slice(1).some(function (c) { return getCellText_(c) || cellDropdown_(c); });
  return !others && cellHasBold_(cells[0]) ? name : '';
}

function cellHasBold_(cell) {
  return ((cell && cell.content) || []).some(function (se) {
    return ((se.paragraph && se.paragraph.elements) || []).some(function (pe) {
      return !!(pe.textRun && pe.textRun.textStyle && pe.textRun.textStyle.bold);
    });
  });
}

/** The text that carries a cell's first link: an assignment's title, without what's written after it. */
function cellLinkText_(cell) {
  var url = getCellLinkUrl_(cell);
  var text = '';
  ((cell && cell.content) || []).forEach(function (se) {
    ((se.paragraph && se.paragraph.elements) || []).forEach(function (pe) {
      var link = pe.textRun && pe.textRun.textStyle && pe.textRun.textStyle.link;
      if (url && link && link.url === url) text += pe.textRun.content || '';
    });
  });
  return text.replace(/\s+/g, ' ').trim();
}

/** The first dropdown chip in a cell, or null. */
function cellDropdown_(cell) {
  var found = null;
  ((cell && cell.content) || []).forEach(function (se) {
    ((se.paragraph && se.paragraph.elements) || []).forEach(function (pe) {
      if (!found && pe.dropdown) found = pe.dropdown;
    });
  });
  return found;
}

/**
 * The Status in a cell: the chip's choice, or the text typed there (week tabs from before Status was
 * a dropdown, or a cell whose chip staff deleted). Text beside a chip is ignored. '' means the cell
 * says nothing; in the old layout an empty cell meant the first choice.
 */
function cellStatus_(cell, oldLayout) {
  var chip = cellDropdown_(cell);
  if (chip) {
    var props = chip.dropdownProperties || {};
    var option = statusOption_(props.selectedOptionId) || statusOption_(props.displayValue);
    return option ? option.label : normalizeStatus_(props.displayValue);
  }
  return normalizeStatus_(getCellText_(cell)) || (oldLayout ? STATUS_DEFAULT : '');
}

/** The Status choice (see STATUS_OPTIONS) with this ID or this label in any case, or null. */
function statusOption_(idOrLabel) {
  var want = String(idOrLabel || '').toLowerCase();
  return STATUS_OPTIONS.filter(function (o) { return o.id === idOrLabel || o.label.toLowerCase() === want; })[0] || null;
}

/**
 * The weekday a few typed words mean, or '': "Tue", "tuesday", "TUES.", "Tue 11/17", "W", "by
 * Friday". A single "T" or "S" could be two days, so it is none.
 */
function weekdayFromText_(text) {
  var letters = String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  var names = SCHEDULE_WEEKDAY_NAMES.map(function (name) { return name.toLowerCase(); });
  // It starts like a weekday ("tues", "wed", "thursday the 12th") or is the start of one ("th", "f").
  var starts = SCHEDULE_WEEKDAY_NAMES.filter(function (name, i) {
    return letters.indexOf(names[i].slice(0, 3)) === 0 || (letters && names[i].indexOf(letters) === 0);
  });
  if (starts.length === 1) return starts[0];
  // Or a whole weekday name is somewhere in it ("by Friday").
  return SCHEDULE_WEEKDAY_NAMES.filter(function (name, i) { return letters.indexOf(names[i]) >= 0; })[0] || '';
}

/** "8:00 AM" from "Tue 11/17, 8:00 am" or " (due 8:00 am)"; the usual 11:59 PM if no time is written. */
function dueTimeFromText_(text) {
  var m = /(\d{1,2}:\d{2})\s*([ap])m/i.exec(String(text || ''));
  return m ? m[1] + ' ' + m[2].toUpperCase() + 'M' : END_OF_DAY_TIME;
}
var END_OF_DAY_TIME = '11:59 PM';

/** '' for the usual 11:59 pm; any other due time the way the planner shows it ("8:00 am"). */
function shownDueTime_(dueTime) {
  var t = cellText_(dueTime);
  return !t || scheduleTimeToMinutes_(t) === scheduleTimeToMinutes_(END_OF_DAY_TIME) ? '' : t.toLowerCase();
}

/**
 * Status and Notes changed in a week tab between two reads of it: { status: {url}, notes: {url} }
 * with the new values. Rows that weren't in the first read don't count, and neither does a Status
 * cell that now says nothing. If both tables changed, By Class wins.
 */
function changedSince_(beforeTab, nowTab) {
  var before = {};
  eachAssignmentCopy_(beforeTab, function (url, kind, status, note) {
    before[kind + ' ' + url] = { status: status, note: note };
  });
  var now = [];
  eachAssignmentCopy_(nowTab, function (url, kind, status, note) {
    now.push({ url: url, kind: kind, status: status, note: note });
  });
  var out = { status: {}, notes: {} };
  now.sort(function (a, b) { return (a.kind === 'day' ? 0 : 1) - (b.kind === 'day' ? 0 : 1); }).forEach(function (c) {
    var b = before[c.kind + ' ' + c.url];
    if (!b) return;
    if (c.status !== b.status && c.status !== '') out.status[c.url] = c.status;
    if (c.note !== b.note) out.notes[c.url] = c.note;
  });
  return out;
}

/** Puts changes from changedSince_ into `saved`; gives back how many values changed. */
/** Puts changes from changedSince_ into `saved`; gives back how many values changed. */
function applyChanges_(saved, changes) {
  var n = 0;
  Object.keys(changes.notes).forEach(function (u) { saved.notes[u] = changes.notes[u]; n++; });
  Object.keys(changes.status).forEach(function (u) {
    var settled = settleStatus_(changes.status[u], saved.notes[u]);
    saved.status[u] = settled.status;
    saved.notes[u] = settled.note;
    n++;
  });
  return n;
}

/** Calls fn(url, 'class' | 'day', status, note) for every assignment row in a week tab. */
function eachAssignmentCopy_(tabJson, fn) {
  eachAssignmentRow_(tabJson, function (row) { fn(row.url, row.kind, row.status, row.note); });
}

/**
 * The Status a piece of text means: one of the three choices (see STATUS_OPTIONS) for their own
 * names and for the words staff typed before Status was a dropdown ("Complete", "done"); any other
 * text comes back as typed, without symbols in front. '' for nothing.
 */
function normalizeStatus_(text) {
  var t = String(text || '').replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim();
  var option = statusOption_(t);
  if (option) return option.label;
  var word = t.toLowerCase();
  return Object.prototype.hasOwnProperty.call(OLD_STATUS_WORDS, word) ? OLD_STATUS_WORDS[word] : t;
}

/**
 * Status is one of three choices. Anything else staff typed in a Status cell before it was a
 * dropdown isn't lost: it moves to the start of the row's note ("Status was: Waiting on teacher.")
 * and the Status becomes the first choice. Gives back { status, note }.
 */
function settleStatus_(status, note) {
  var text = String(note || '');
  var option = statusOption_(status);
  if (option || !status) return { status: option ? option.label : STATUS_DEFAULT, note: text };
  var moved = OLD_STATUS_NOTE_PREFIX + status + '.';
  if (text.indexOf(moved) === 0) return { status: STATUS_DEFAULT, note: text };
  return { status: STATUS_DEFAULT, note: moved + (text ? ' ' + text : '') };
}

// ---- What AutoPlanner wrote last time, per Doc (one Script Property, "written.<docId>") ----------
// { "<assignment id>": "<week yyyymmdd><Status><Notes fingerprint>" }, e.g. "20261005I1x9k2" for the
// week of Oct 5, "In progress" and a note. The three Statuses are one letter (N, I, D). Records
// written before Status was a dropdown are still read: C for "Complete", and any other text staff
// typed, kept between "|"s. About 28 characters per assignment. The record only covers the current
// and upcoming weeks, so it doesn't grow over the year.

function assignmentKey_(url) {
  var m = /\/assignments\/(\d+)/.exec(String(url || ''));
  return m ? m[1] : String(url || '');
}

/** A short fingerprint of a note (FNV-1a), so notes themselves are never stored outside the Doc. */
function noteFingerprint_(note) {
  var s = String(note || '');
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return s ? h.toString(36) : '';
}

var WRITTEN_STATUS_CODES = { 'Need to Start': 'N', 'In progress': 'I', 'Done/Submitted': 'D' };

/** "<week yyyymmdd><Status code><Notes fingerprint>" from { w, s, n }. */
function encodeWritten_(record) {
  var code = WRITTEN_STATUS_CODES[record.s] || '|' + String(record.s || '').replace(/\|/g, '') + '|';
  return String(record.w || '').replace(/-/g, '') + code + (record.n || '');
}

/** { w, s, n } from an encoded record (or a record in the first, longer format). */
function decodeWritten_(v) {
  if (v && typeof v === 'object') return { w: v.w, s: normalizeStatus_(v.s) || STATUS_DEFAULT, n: v.n };
  var str = String(v || '');
  var w = str.slice(0, 4) + '-' + str.slice(4, 6) + '-' + str.slice(6, 8);
  var rest = str.slice(8);
  if (rest.charAt(0) === '|') {
    var end = rest.indexOf('|', 1);
    return { w: w, s: normalizeStatus_(rest.slice(1, end)) || STATUS_DEFAULT, n: rest.slice(end + 1) };
  }
  var names = { N: 'Need to Start', I: 'In progress', C: 'Done/Submitted', D: 'Done/Submitted' };
  return { w: w, s: names[rest.charAt(0)] || STATUS_DEFAULT, n: rest.slice(1) };
}

// A Script Property holds 9 KB, so a big record is split over "written.<docId>", "written.<docId>.1"
// and so on (about 290 assignments each).
var WRITTEN_PART_CHARS = 8000;
var WRITTEN_MAX_PARTS = 10;

function writtenPartKey_(docId, i) {
  return 'written.' + docId + (i ? '.' + i : '');
}

/** { "<assignment id>": { w, s, n } } for this Doc. */
function readWritten_(docId) {
  var props = PropertiesService.getScriptProperties();
  var out = {};
  for (var i = 0; i < WRITTEN_MAX_PARTS; i++) {
    var json = props.getProperty(writtenPartKey_(docId, i));
    if (!json) break;
    var raw;
    try {
      raw = JSON.parse(json) || {};
    } catch (e) {
      raw = {};
    }
    Object.keys(raw).forEach(function (k) { out[k] = decodeWritten_(raw[k]); });
  }
  return out;
}

/** Saves { "<assignment id>": { w, s, n } } in the compact form, in as many parts as it needs. */
function saveWritten_(docId, map) {
  var props = PropertiesService.getScriptProperties();
  var parts = [{}];
  var size = 2;
  Object.keys(map).forEach(function (k) {
    var v = encodeWritten_(map[k]);
    var add = k.length + v.length + 6;
    if (size + add > WRITTEN_PART_CHARS) {
      parts.push({});
      size = 2;
    }
    parts[parts.length - 1][k] = v;
    size += add;
  });
  if (parts.length > WRITTEN_MAX_PARTS) {
    console.warn('The "last written" record for ' + docId + ' needs ' + parts.length + ' parts; not kept.');
    parts = [];
  }
  for (var i = 0; i < WRITTEN_MAX_PARTS; i++) {
    if (i < parts.length) props.setProperty(writtenPartKey_(docId, i), JSON.stringify(parts[i]));
    else props.deleteProperty(writtenPartKey_(docId, i));
  }
}

/** Removes a Doc's record (every part). */
function deleteWritten_(docId) {
  var props = PropertiesService.getScriptProperties();
  for (var i = 0; i < WRITTEN_MAX_PARTS; i++) props.deleteProperty(writtenPartKey_(docId, i));
}

/** Records one value as written (selfTest uses it after putting a test value back). */
function recordWritten_(docId, url, week, status, note) {
  var map = readWritten_(docId);
  map[assignmentKey_(url)] = { w: week, s: status, n: noteFingerprint_(note) };
  saveWritten_(docId, map);
}

function addWeekChildTab_(docId, parentTabId, title, insertIndex) {
  var idx =
    typeof insertIndex === 'number' && insertIndex >= 0 ? insertIndex : 0;
  var resp = docsBatchUpdate_(docId, [
    {
      addDocumentTab: {
        tabProperties: {
          title: title,
          parentTabId: parentTabId,
          index: idx,
        },
      },
    },
  ]);

  var reply = resp.replies && resp.replies[0];
  var inner = reply && reply.addDocumentTab;
  if (!inner || !inner.tabProperties || !inner.tabProperties.tabId) {
    throw new Error(
      'addDocumentTab failed — check Docs API service is enabled. Raw: ' +
        JSON.stringify(resp).substring(0, 400)
    );
  }
  return inner.tabProperties.tabId;
}

// --- Docs API helpers (tabs / colors / tables) ---------------------------------

function hexToRgbColor_(hex) {
  var h = String(hex || '').replace(/^#/, '');
  if (h.length !== 6) {
    return { red: 0, green: 0, blue: 0 };
  }
  return {
    red: parseInt(h.substring(0, 2), 16) / 255,
    green: parseInt(h.substring(2, 4), 16) / 255,
    blue: parseInt(h.substring(4, 6), 16) / 255,
  };
}

/** Docs API OptionalColor: `{ color: { rgbColor: RgbColor } }` — not bare `rgbColor`. */
function optionalColorFromHex_(hex) {
  return {
    color: {
      rgbColor: hexToRgbColor_(hex),
    },
  };
}

function batchUpdateChunked_(docId, requests) {
  if (!requests || !requests.length) return;
  for (var i = 0; i < requests.length; i += BATCH_CHUNK) {
    if (i > 0) sleepDocsChunkGap_();
    docsBatchUpdate_(docId, requests.slice(i, i + BATCH_CHUNK));
  }
}

function paragraphIsEffectivelyEmpty_(paragraph) {
  var text = '';
  (paragraph.elements || []).forEach(function (el) {
    if (el.textRun && el.textRun.content) text += el.textRun.content;
  });
  return text.replace(/\s/g, '').length === 0;
}

function tabBodyPlainText_(body) {
  var t = '';
  (body.content || []).forEach(function (el) {
    if (el.paragraph) {
      (el.paragraph.elements || []).forEach(function (pe) {
        if (pe.textRun && pe.textRun.content) t += pe.textRun.content;
      });
    }
  });
  return t;
}

function isFiniteNumber_(n) {
  return typeof n === 'number' && !isNaN(n) && isFinite(n);
}

/** Structural indices sometimes deserialize as strings from the advanced service. */
function toDocIndex_(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && /^-?\d+$/.test(String(v).trim())) {
    return parseInt(v, 10);
  }
  return NaN;
}

/** Bounds from paragraph.TextRuns when the StructuralElement omits start/end (nested tabs). */
function spanFromParagraphElements_(paragraph) {
  var minS = null;
  var maxE = null;
  (paragraph.elements || []).forEach(function (pe) {
    var ps = toDocIndex_(pe.startIndex);
    var pe_ = toDocIndex_(pe.endIndex);
    if (!isFiniteNumber_(ps) || !isFiniteNumber_(pe_)) return;
    if (minS === null || ps < minS) minS = ps;
    if (maxE === null || pe_ > maxE) maxE = pe_;
  });
  if (minS === null || maxE === null || maxE <= minS) return null;
  return { start: minS, end: maxE };
}

function structuralContentBounds_(el) {
  var s = toDocIndex_(el.startIndex);
  var e = toDocIndex_(el.endIndex);
  if (isFiniteNumber_(s) && isFiniteNumber_(e) && e > s) {
    return { start: s, end: e };
  }
  if (el.paragraph) {
    var sp = spanFromParagraphElements_(el.paragraph);
    if (sp) return sp;
  }
  return null;
}

/**
 * Find one valid deleteContentRange for tab body (walk backward).
 * Skips paragraphs that only contain whitespace/newline — those cannot be removed without
 * violating segment newline rules, so earlier blocks are deleted first.
 */
function pickNextTabBodyDeletionRequest_(content, tabId) {
  if (!content || !content.length) return null;
  var i = content.length - 1;
  while (i >= 0) {
    var el = content[i];
    var bounds = structuralContentBounds_(el);
    if (!bounds) {
      i--;
      continue;
    }
    var s = bounds.start;
    var e = bounds.end;

    if (el.paragraph && paragraphIsEffectivelyEmpty_(el.paragraph)) {
      i--;
      continue;
    }

    if (el.paragraph) {
      var exclusiveEnd = e - 1;
      if (exclusiveEnd <= s) {
        i--;
        continue;
      }
      return {
        deleteContentRange: {
          range: {
            segmentId: '',
            tabId: tabId,
            startIndex: s,
            endIndex: exclusiveEnd,
          },
        },
      };
    }

    var ws = toDocIndex_(el.startIndex);
    var we = toDocIndex_(el.endIndex);
    if (!isFiniteNumber_(ws) || !isFiniteNumber_(we) || we <= ws) {
      i--;
      continue;
    }
    return {
      deleteContentRange: {
        range: {
          segmentId: '',
          tabId: tabId,
          startIndex: ws,
          endIndex: we,
        },
      },
    };
  }
  return null;
}

function tabBodyStillNeedsClearing_(body) {
  var content = body.content || [];
  for (var j = 0; j < content.length; j++) {
    var el = content[j];
    if (!el.paragraph) return true;
    if (!paragraphIsEffectivelyEmpty_(el.paragraph)) return true;
  }
  return false;
}

/**
 * Remove tab body content without deleting the mandatory trailing newline of the segment.
 * Full paragraph deletes [startIndex, endIndex) hit "cannot include the newline at end of segment".
 * @returns {boolean} false if the tab still has content but no safe delete range (caller should deleteTab + recreate).
 */
function clearTabBodyDocsApi_(docId, tabId) {
  var iterations = 0;
  while (iterations++ < 80) {
    var doc = docsGet_(docId);
    var tab = findTabJsonById_(doc, tabId);
    if (!tab || !tab.documentTab || !tab.documentTab.body) return true;
    var content = tab.documentTab.body.content || [];

    if (content.length === 0) return true;
    if (
      content.length === 1 &&
      content[0].paragraph &&
      paragraphIsEffectivelyEmpty_(content[0].paragraph)
    ) {
      return true;
    }

    var req = pickNextTabBodyDeletionRequest_(content, tabId);
    if (!req) {
      if (!tabBodyStillNeedsClearing_(tab.documentTab.body)) return true;
      return false;
    }

    docsBatchUpdate_(docId, [req]);
    /* Spread writes so we do not burst past per-minute Docs write quota. */
    Utilities.sleep(100);
  }
  throw new Error('Timed out clearing tab body — try again.');
}

// ---- The CLC Planner home tab: a one-page summary, rebuilt from scratch on every update ----
//
// Layout (same fonts, colors and table values as the week tabs; see LAYOUT at the top):
//   Student name (Heading 1)
//   CLC PLANNER · SUPPORTED STUDY HALL (9 pt, #666666) / Last updated ... (10 pt, #444444)
//   ── THIS WEEK · OCT 5 – OCT 11 (Heading 4 with a thin rule above)
//      "N assignments this week · M due today or tomorrow." and "Open this week →" (a tab link)
//      Class | This week | Next due table (full width: 288 | 80 | 100 pt at 468 pt)
//   ── HOW THIS DOC WORKS (Heading 4 with a thin rule above), a numbered list of 3 lines
//   Footer (9 pt, #666666)
var HOME_SUBTITLE = 'CLC PLANNER · SUPPORTED STUDY HALL';
var HOME_FOOTER = 'Built by the Pomfret Civic AI Club · Questions: Cayden Auyang or Luke Ryan';
var HOME_HOW_LINES = [
  'Each week has its own tab in the left sidebar.',
  'Click a Status to change it. To add your own to-do, type in the "' + ADD_TODO_TEXT + '" row under any day. Notes, your own to-dos and the Weekend plan are yours: AutoPlanner never changes them.',
  'It updates every day at about 7 pm and midnight. Edits anywhere else get replaced.',
];
var HOME_CLASS_HEADERS = ['Class', 'This week', 'Next due'];
var HOME_CLASS_WIDTHS = [288, 80, 100];
var HOME_RULE_FG = '#BFBFBF'; // thin gray rules (the text color at about 25% on white)

/**
 * Rebuilds the home tab. Runs after the week tabs, so "Open this week" can link to its tab. Uses
 * `readDoc` (the last week's final read) when given; if Docs refuses the edit because someone
 * changed the home tab since that read, it reads the Doc again and tries once more.
 */
function rebuildHomeTab_(docId, parentTabId, data, courses, colorMap, now, staffCounts, readDoc) {
  if (readDoc) {
    try {
      return rebuildHomeTabFrom_(readDoc, docId, parentTabId, data, courses, colorMap, now, staffCounts);
    } catch (err) {
      if (docsApiIsQuotaError_(err)) throw err;
      console.warn('Home tab: rebuilding from a fresh read (' + err + ')');
    }
  }
  return rebuildHomeTabFrom_(docsGet_(docId), docId, parentTabId, data, courses, colorMap, now, staffCounts);
}

function rebuildHomeTabFrom_(doc, docId, parentTabId, data, courses, colorMap, now, staffCounts) {
  var tab = findTabJsonById_(doc, parentTabId);
  if (!tab || !tab.documentTab || !tab.documentTab.body) return;
  var summary = homeSummary_(data, courses, now || new Date());
  summary.staffCount = (staffCounts && staffCounts[summary.weekKey]) || 0;
  var weekTab = findChildTabIdByTitle_(tab, buildWeekTabTitle_(summary.weekKey, summary.weekRange));
  var requests = homeClearRequests_(tab, parentTabId).concat(
    buildHomeTabRequests_(parentTabId, summary, weekTab, tabContentWidth_(tab), colorMap)
  );
  batchUpdateChunked_(docId, requests);
}

/** Deletes everything in the tab and resets the one paragraph that is left to plain text. */
function homeClearRequests_(tab, tabId) {
  var content = tab.documentTab.body.content || [];
  var end = content.length ? toDocIndex_(content[content.length - 1].endIndex) : 2;
  var reqs = [];
  if (end > 2) {
    reqs.push({ deleteContentRange: { range: { tabId: tabId, startIndex: 1, endIndex: end - 1 } } });
  }
  reqs.push({ deleteParagraphBullets: { range: { tabId: tabId, startIndex: 1, endIndex: 2 } } });
  reqs.push({
    updateParagraphStyle: {
      range: { tabId: tabId, startIndex: 1, endIndex: 2 },
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      fields: 'namedStyleType,alignment,borderTop,borderBottom,spaceAbove,spaceBelow,indentStart,indentFirstLine',
    },
  });
  return reqs;
}

/** "ADV Calculus III-Browne-G" becomes "ADV Calculus III" (teacher and section dropped). */
function shortCourseName_(name) {
  var m = /^(.*\S)-[A-Z][A-Za-z'’.]+(?: [A-Z][A-Za-z'’.]+)?-[A-Z][A-Z0-9]?$/.exec(String(name || ''));
  return m && m[1].length >= 3 ? m[1] : String(name || '');
}

/** Everything the home tab shows, worked out from the schedule (pure, so it can be tested). */
function homeSummary_(data, courses, now) {
  var today = Utilities.formatDate(now, SCHEDULE_TIME_ZONE, 'yyyy-MM-dd');
  var monday = scheduleWeekStart_(today);
  // Saturday and Sunday (New York time) look ahead to the coming week.
  var weekend = scheduleWeekdayIndex_(today) >= 5;
  var weekKey = weekend ? scheduleAddDays_(monday, 7) : monday;
  var saturday = scheduleAddDays_(monday, 5);
  var sunday = scheduleAddDays_(monday, 6);
  var all = [];
  Object.keys(data.weeks || {}).forEach(function (k) {
    (data.weeks[k].days || []).forEach(function (d) {
      (d.assignments || []).forEach(function (a) { all.push(a); });
    });
  });
  var thisWeek = all.filter(function (a) { return a.week_start === weekKey; });
  var shortNames = courses.map(shortCourseName_);
  // Keep the full names if shortening would make two classes look the same.
  var unique = shortNames.every(function (n, i) { return shortNames.indexOf(n) === i; });
  var rows = courses.map(function (course, i) {
    var mine = all.filter(function (a) { return (cellText_(a.course) || '(No Course)') === course; });
    var next = mine.filter(function (a) { return a.due_date >= today; })
      .map(function (a) { return a.due_date; }).sort()[0];
    return {
      course: course,
      name: unique ? shortNames[i] : course,
      count: mine.filter(function (a) { return a.week_start === weekKey; }).length,
      next: next ? Utilities.formatDate(new Date(scheduleDateToMs_(next) + 12 * 3600000), 'UTC', 'EEE, MMM d') : '—',
    };
  });
  var weekRange = scheduleShortDate_(weekKey) + ' – ' + scheduleShortDate_(scheduleAddDays_(weekKey, 6));
  return {
    name: cellText_(data.studentFullName || data.student_full_name) || 'Student',
    teacherName: cellText_(data.teacherName),
    updated: Utilities.formatDate(now, SCHEDULE_TIME_ZONE, "EEEE, MMM d 'at' h:mm a"),
    weekend: weekend,
    weekKey: weekKey,
    weekRange: weekRange,
    heading: weekend
      ? ('Coming week · Mon ' + scheduleShortDate_(weekKey) + ' – Sun ' + scheduleShortDate_(scheduleAddDays_(weekKey, 6))).toUpperCase()
      : ('This week · ' + weekRange).toUpperCase(),
    weekCount: thisWeek.length,
    // Weekdays: due today or tomorrow. Weekends: due this Saturday or Sunday.
    soonCount: all.filter(function (a) {
      return weekend
        ? (a.due_date === saturday || a.due_date === sunday) && a.due_date >= today
        : a.days_until_due === 0 || a.days_until_due === 1;
    }).length,
    rows: rows,
  };
}

/**
 * Every request that writes the home tab, in order, starting from one empty paragraph at index 1.
 * Pure, like buildWeekTabRequests_: text first, then the class table, then the rest of the text.
 */
function buildHomeTabRequests_(tabId, summary, weekTabId, contentWidth, colorMap) {
  var reqs = [];
  var range = function (s, e) { return { tabId: tabId, startIndex: s, endIndex: e }; };
  var color = function (hex) { return optionalColorFromHex_(hex); };
  var pt = function (n) { return { magnitude: n, unit: 'PT' }; };
  var rule = { color: color(HOME_RULE_FG), width: pt(0.75), dashStyle: 'SOLID', padding: pt(8) };
  var resetFields = 'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,link,baselineOffset';
  var para = function (s, e, style, fields) {
    reqs.push({ updateParagraphStyle: { range: range(s, e), paragraphStyle: style, fields: fields } });
  };
  var text = function (s, e, style, fields) {
    if (e > s) reqs.push({ updateTextStyle: { range: range(s, e), textStyle: style, fields: fields } });
  };

  // Writes lines at `at` (the start of an empty paragraph), clears inherited styles, and gives
  // back where each line starts.
  function insertLines(at, lines) {
    reqs.push({ insertText: { text: lines.join('\n'), location: { tabId: tabId, index: at } } });
    var starts = [];
    var pos = at;
    lines.forEach(function (line) { starts.push(pos); pos += line.length + 1; });
    text(at, pos - 1, {}, resetFields);
    para(at, pos, { namedStyleType: 'NORMAL_TEXT' }, 'namedStyleType,borderTop,spaceAbove,spaceBelow');
    return starts;
  }

  // 1. Name, caps line, last updated, this week.
  var plural = function (n) { return n + ' assignment' + (n === 1 ? '' : 's'); };
  var summaryLine;
  if (summary.weekend) {
    summaryLine = (summary.weekCount ? plural(summary.weekCount) + ' in the coming week' : 'Nothing is due in the coming week') +
      ' · ' + (summary.soonCount ? summary.soonCount + ' due this weekend.' : 'Nothing due this weekend.');
  } else {
    summaryLine = summary.weekCount
      ? plural(summary.weekCount) + ' this week · ' + summary.soonCount + ' due today or tomorrow.'
      : 'Nothing is due this week. ' + summary.soonCount + ' due today or tomorrow.';
  }
  // The to-dos and Weekend plan rows staff added to this week, if any.
  if (summary.staffCount) summaryLine = summaryLine.replace(/\.$/, '') + ' · ' + summary.staffCount + ' added by staff.';
  var a = [summary.name, HOME_SUBTITLE];
  // The student's CLC teacher, if they have one (nothing for Unassigned).
  var iTeacher = summary.teacherName ? a.push('CLC teacher: ' + summary.teacherName) - 1 : -1;
  var iUpdated = a.push('Last updated ' + summary.updated) - 1;
  var iHeading = a.push(summary.heading) - 1;
  var iSummary = a.push(summaryLine) - 1;
  var iLink = weekTabId ? a.push(summary.weekend ? 'Open the coming week →' : 'Open this week →') - 1 : -1;
  if (!summary.rows.length) a.push('No current classes found in Canvas.');
  var aStart = insertLines(1, a);
  var lineEnd = function (i) { return aStart[i] + a[i].length; };
  para(aStart[0], lineEnd(0) + 1, { namedStyleType: 'HEADING_1' }, 'namedStyleType');
  text(aStart[1], lineEnd(1), { fontSize: pt(9), foregroundColor: color(MUTED_FG), bold: true }, 'fontSize,foregroundColor,bold');
  if (iTeacher >= 0) text(aStart[iTeacher], lineEnd(iTeacher), { fontSize: pt(10), foregroundColor: color(HELP_FG) }, 'fontSize,foregroundColor');
  text(aStart[iUpdated], lineEnd(iUpdated), { fontSize: pt(10), foregroundColor: color(HELP_FG) }, 'fontSize,foregroundColor');
  para(aStart[iHeading], lineEnd(iHeading) + 1, { namedStyleType: 'HEADING_4', borderTop: rule, spaceAbove: pt(18) }, 'namedStyleType,borderTop,spaceAbove');
  text(aStart[iSummary], lineEnd(iSummary), { foregroundColor: color(DATA_FG) }, 'foregroundColor');
  if (iLink >= 0) {
    text(aStart[iLink], lineEnd(iLink), { link: { tabId: weekTabId }, foregroundColor: color(LINK_FG) }, 'link,foregroundColor');
    para(aStart[iLink], lineEnd(iLink) + 1, { spaceBelow: pt(8) }, 'spaceBelow');
  } else {
    para(aStart[iSummary], lineEnd(iSummary) + 1, { spaceBelow: pt(8) }, 'spaceBelow');
  }
  var at = lineEnd(a.length - 1); // the newline of the last line: the table goes right under it

  // 2. Class | This week | Next due.
  var next;
  if (summary.rows.length) {
    var headers = HOME_CLASS_HEADERS.slice();
    if (summary.weekend) headers[1] = 'Coming week';
    next = appendHomeClassTable_(reqs, tabId, at, summary.rows, scaledColumnWidths_(HOME_CLASS_WIDTHS, contentWidth), colorMap, headers);
  } else {
    // No table: split off an empty paragraph for the rest.
    reqs.push({ insertText: { text: '\n', location: { tabId: tabId, index: at } } });
    next = at + 1;
  }

  // 3. How this Doc works and the footer: written into the paragraph after the table.
  var b = ['HOW THIS DOC WORKS'].concat(HOME_HOW_LINES, [HOME_FOOTER]);
  var bStart = insertLines(next, b);
  var bEnd = function (i) { return bStart[i] + b[i].length; };
  para(bStart[0], bEnd(0) + 1, { namedStyleType: 'HEADING_4', borderTop: rule, spaceAbove: pt(18) }, 'namedStyleType,borderTop,spaceAbove');
  reqs.push({ createParagraphBullets: { range: range(bStart[1], bEnd(3) + 1), bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } });
  text(bStart[1], bEnd(3), { foregroundColor: color(DATA_FG) }, 'foregroundColor');
  para(bStart[4], bEnd(4) + 1, { spaceAbove: pt(28) }, 'spaceAbove');
  text(bStart[4], bEnd(4), { fontSize: pt(9), foregroundColor: color(MUTED_FG) }, 'fontSize,foregroundColor');
  return reqs;
}

/**
 * The home tab's class table: a header row, then one row per class, at index `at` (the newline
 * of the paragraph above it). Same cell values as the week tables. Returns the index of the
 * empty paragraph Docs adds after it.
 */
function appendHomeClassTable_(reqs, tabId, at, rows, widths, colorMap, headers) {
  var C = 3;
  var R = rows.length + 1;
  var tableStart = at + 1;
  var emptyAfter = at + 3 + R * (2 * C + 1);
  var texts = [(headers || HOME_CLASS_HEADERS).slice()].concat(rows.map(function (r) {
    return [cellText_(r.name), String(r.count), r.next];
  }));
  var emptyIndex = function (r, c) { return at + 4 + r * (2 * C + 1) + 2 * c; };
  var range = function (s, e) { return { tabId: tabId, startIndex: s, endIndex: e }; };
  var loc = { tabId: tabId, index: tableStart };

  reqs.push({ insertTable: { rows: R, columns: C, location: { tabId: tabId, index: at } } });
  reqs.push({ updateParagraphStyle: { range: range(emptyAfter, emptyAfter + 1), paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
  for (var r = R - 1; r >= 0; r--) {
    for (var c = C - 1; c >= 0; c--) {
      if (texts[r][c]) reqs.push({ insertText: { text: texts[r][c], location: { tabId: tabId, index: emptyIndex(r, c) } } });
    }
  }
  var start = [];
  var shift = 0;
  for (r = 0; r < R; r++) {
    start.push([]);
    for (c = 0; c < C; c++) {
      start[r].push(emptyIndex(r, c) + shift);
      shift += texts[r][c].length;
    }
  }
  var cellEnd = function (r, c) { return start[r][c] + texts[r][c].length; };

  reqs.push(cellStyleRequest_(tabId, tableStart, 0, 0, R, C, {
    paddingTop: { magnitude: CELL_PAD_TOP_BOTTOM_PT, unit: 'PT' },
    paddingBottom: { magnitude: CELL_PAD_TOP_BOTTOM_PT, unit: 'PT' },
    paddingLeft: { magnitude: CELL_PAD_SIDE_PT, unit: 'PT' },
    paddingRight: { magnitude: CELL_PAD_SIDE_PT, unit: 'PT' },
    contentAlignment: 'MIDDLE',
  }, 'paddingTop,paddingBottom,paddingLeft,paddingRight,contentAlignment'));
  widths.forEach(function (w, i) {
    reqs.push({
      updateTableColumnProperties: {
        tableStartLocation: loc,
        columnIndices: [i],
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: w, unit: 'PT' } },
        fields: 'widthType,width',
      },
    });
  });
  reqs.push(textStyleRequest_(range(start[0][0], cellEnd(R - 1, C - 1) + 1), {
    fontSize: { magnitude: TABLE_FONT_PT, unit: 'PT' },
    foregroundColor: optionalColorFromHex_(DATA_FG),
  }, 'fontSize,foregroundColor'));
  // Header row, as in the week tables.
  reqs.push(cellStyleRequest_(tabId, tableStart, 0, 0, 1, C, { backgroundColor: optionalColorFromHex_(HEADER_BG) }, 'backgroundColor'));
  reqs.push(textStyleRequest_(range(start[0][0], cellEnd(0, C - 1)), { bold: true, foregroundColor: optionalColorFromHex_(HEADER_FG) }, 'bold,foregroundColor'));
  // Class name on its class color; the two other columns centered.
  for (r = 0; r < R; r++) {
    reqs.push({ updateParagraphStyle: { range: range(start[r][1], cellEnd(r, C - 1) + 1), paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } });
    if (r > 0) {
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 0, 1, 1, { backgroundColor: optionalColorFromHex_(colorMap[rows[r - 1].course] || '#EAEDED') }, 'backgroundColor'));
    }
  }
  reqs.push({
    updateTableRowStyle: {
      tableStartLocation: loc,
      rowIndices: [0],
      tableRowStyle: { minRowHeight: { magnitude: ROW_MIN_HEIGHT_PT, unit: 'PT' } },
      fields: 'minRowHeight',
    },
  });
  return emptyAfter + shift;
}

function cellParagraphInsertIndex_(cell) {
  var content = cell.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].paragraph) {
      var s = toDocIndex_(content[i].startIndex);
      if (isFiniteNumber_(s)) return s;
      var inner = spanFromParagraphElements_(content[i].paragraph);
      if (inner) return inner.start;
    }
  }
  throw new Error('Table cell has no paragraph (unexpected).');
}

/** Find the paragraph in a tab body whose plain text matches `text` (newline-trimmed). */
function findParagraphByText_(tabJson, text) {
  if (!tabJson || !tabJson.documentTab || !tabJson.documentTab.body) return null;
  var content = tabJson.documentTab.body.content || [];
  for (var i = 0; i < content.length; i++) {
    var p = content[i].paragraph;
    if (!p) continue;
    var t = '';
    (p.elements || []).forEach(function (el) {
      if (el.textRun && el.textRun.content) t += el.textRun.content;
    });
    if (t.replace(/\n+$/, '').trim() === text) return content[i];
  }
  return null;
}

function getCellTextRange_(cell) {
  var minS = null;
  var maxE = null;
  (cell.content || []).forEach(function (se) {
    if (!se.paragraph) return;
    (se.paragraph.elements || []).forEach(function (pe) {
      if (!pe.textRun || pe.endIndex === undefined) return;
      if (minS === null || pe.startIndex < minS) minS = pe.startIndex;
      if (maxE === null || pe.endIndex > maxE) maxE = pe.endIndex;
    });
  });
  if (minS === null) return null;
  return { startIndex: minS, endIndex: maxE };
}

/**
 * True if the week tab already has a table or substantial body — replace the tab
 * instead of clearing paragraph-by-paragraph (avoids hundreds of Docs writes / quota).
 */
function tabBodyHasHeavyContent_(tabJson) {
  if (!tabJson || !tabJson.documentTab || !tabJson.documentTab.body) return false;
  var content = tabJson.documentTab.body.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].table) return true;
  }
  if (content.length > 3) return true;
  // A tab that already has the Status dropdown can't be given it again, so it's replaced too.
  if (Object.keys(tabJson.documentTab.dropdownDefinitions || {}).length) return true;
  var plain = tabBodyPlainText_(tabJson.documentTab.body).replace(/\s/g, '');
  return plain.length > 60;
}

/**
 * Writes one week tab from scratch: By Day, the Weekend plan and By Class (see weekTabBlocks_),
 * with the Status and Notes in `saved` and everything staff added to the tab themselves.
 * If `out` is given, out.doc is a read of the Doc as it is afterwards (or null), so the next week
 * doesn't have to read it again. Returns how many to-dos and weekend rows staff have in the tab.
 */
function fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData, courses, colorMap, saved, snapshot, readDoc, out) {
  if (out) out.doc = null;
  var docProbe = readDoc || docsGet_(docId);
  var tabProbe = findTabJsonById_(docProbe, tabId);
  // Status and Notes from all current and upcoming weeks (see collectSavedData_), or this tab's own.
  var savedData = saved || readExistingDataFromTab_(tabProbe);
  // Anything typed into this tab since the update started (`snapshot` is the CLC Planner tab as it
  // was then) wins. `saved` is shared by the whole update, so it also follows a moved assignment.
  var before = snapshot ? findTabJsonById_({ tabs: [snapshot] }, tabId) : null;
  if (before && tabProbe) applyChanges_(savedData, changedSince_(before, tabProbe));
  var width = tabContentWidth_(tabProbe);
  // Staff's own to-dos and Weekend plan, read from the tab now so they're written back exactly.
  var staff = readStaffWork_(tabProbe);

  var parentJson = findTabJsonById_(docProbe, parentTabId);
  var oldTabId = null;
  if (tabBodyHasHeavyContent_(tabProbe) || !clearTabBodyDocsApi_(docId, tabId)) {
    // Write the new tab just below the old one, under a temporary title (every title in a Doc must
    // be different). The old tab is deleted only once the new one is complete, so if an update
    // stops halfway the old tab, with its Status and Notes, is still there; the next update deletes
    // the half-written "(updating)" tab and starts again.
    var tempTitle = tabTitle + UPDATING_SUFFIX;
    var stale = findTabByTitleAnywhere_(docProbe, tempTitle);
    if (stale) docsBatchUpdate_(docId, [{ deleteTab: { tabId: stale.tabProperties.tabId } }]);
    var kids = parentJson.childTabs || [];
    var at = kids.map(function (t) { return t.tabProperties.tabId; }).indexOf(tabId);
    oldTabId = tabId;
    tabId = addWeekChildTab_(docId, parentTabId, tempTitle, at >= 0 ? at + 1 : nextChildTabInsertIndex_(parentJson));
    sleepDocsChunkGap_();
  }

  batchUpdateChunked_(docId, buildWeekTabRequests_(tabId, weekKey, weekData, courses, colorMap, savedData, width, staff));

  if (oldTabId) {
    // A last look at the old tab: if staff changed it while the new one was being written (a
    // Status, a note, one of their own to-dos or its Status, the Weekend plan), write the new one
    // again with their edits (once; the window is only a few seconds).
    var lastRead = docsGet_(docId);
    var oldNow = findTabJsonById_(lastRead, oldTabId);
    var staffNow = oldNow ? readStaffWork_(oldNow) : staff;
    var staffChanged = JSON.stringify(staffNow) !== JSON.stringify(staff);
    if (staffChanged) staff = staffNow;
    if (oldNow && (applyChanges_(savedData, changedSince_(tabProbe, oldNow)) || staffChanged)) {
      lastRead = null; // the tab is written again below, so this read is out of date
      docsBatchUpdate_(docId, [{ deleteTab: { tabId: tabId } }]);
      tabId = addWeekChildTab_(docId, parentTabId, tempTitle, at >= 0 ? at + 1 : nextChildTabInsertIndex_(parentJson));
      sleepDocsChunkGap_();
      batchUpdateChunked_(docId, buildWeekTabRequests_(tabId, weekKey, weekData, courses, colorMap, savedData, width, staff));
    }
    // One batch, all or nothing (checked live): the old tab goes, and the new one takes its title
    // and its place in the sidebar.
    docsBatchUpdate_(docId, [
      { deleteTab: { tabId: oldTabId } },
      { updateDocumentTabProperties: { tabProperties: { tabId: tabId, title: tabTitle }, fields: 'title' } },
    ]);
    if (out && lastRead) out.doc = swapInRead_(lastRead, parentTabId, oldTabId, tabId, tabTitle);
  }
  return countStaffWork_(staff);
}

/**
 * A read taken just before a week's swap, changed the way the swap changed the Doc: the old tab
 * gone and the new one renamed (positions come from the order of the tabs, so nothing else moves).
 * Anything staff type after this read is caught by the next week's own last look, as before.
 */
function swapInRead_(docJson, parentTabId, oldTabId, newTabId, title) {
  var parent = findTabJsonById_(docJson, parentTabId);
  var kids = (parent && parent.childTabs) || [];
  var oldAt = -1;
  var fresh = null;
  kids.forEach(function (t, i) {
    if (t.tabProperties.tabId === oldTabId) oldAt = i;
    if (t.tabProperties.tabId === newTabId) fresh = t;
  });
  if (oldAt < 0 || !fresh) return null;
  kids.splice(oldAt, 1);
  fresh.tabProperties.title = title;
  return docJson;
}

/** Usable page width in points (page width minus margins); 468 on US Letter with 1" margins. */
function tabContentWidth_(tabJson) {
  var style = tabJson && tabJson.documentTab && tabJson.documentTab.documentStyle;
  var mag = function (v) { return v && typeof v.magnitude === 'number' ? v.magnitude : null; };
  var width = style && mag(style.pageSize && style.pageSize.width);
  var left = style ? mag(style.marginLeft) : null;
  var right = style ? mag(style.marginRight) : null;
  var w = width !== null && left !== null && right !== null ? width - left - right : LAYOUT_BASE_WIDTH_PT;
  return w >= 200 && w <= 1200 ? w : LAYOUT_BASE_WIDTH_PT;
}

/** The layout's column widths scaled to the page; they always add up to exactly `contentWidth`. */
function scaledColumnWidths_(baseWidths, contentWidth) {
  var factor = contentWidth / LAYOUT_BASE_WIDTH_PT;
  var widths = baseWidths.map(function (w) { return Math.round(w * factor * 2) / 2; });
  var others = widths.slice(0, -1).reduce(function (a, b) { return a + b; }, 0);
  // The last column takes exactly what's left, so the table is never wider than the page.
  widths[widths.length - 1] = Math.round((contentWidth - others) * 100) / 100;
  return widths;
}

/** Text that is safe to put in one cell: no line breaks or control characters. */
function cellText_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every Docs API request for one week tab, in order. Pure: it reads nothing, so the whole tab is
 * written in a few batchUpdate calls. The tab has just been created or cleared, so it holds one
 * empty paragraph at index 1 and no Status dropdown yet. `staff` is what readStaffWork_ found in
 * the tab before; it's written back exactly.
 */
function buildWeekTabRequests_(tabId, weekKey, weekData, courses, colorMap, saved, contentWidth, staff) {
  return weekTabRequestsFromBlocks_(tabId, weekTabBlocks_(weekKey, weekData, courses, colorMap, saved, contentWidth, staff));
}

/**
 * The Docs requests that write `blocks` (see weekTabBlocks_) into a tab that has just been created
 * or cleared, after its Status dropdown. Old Past weeks are rewritten with it too (see
 * pastWeekBlocks_), so every week tab is written the same way.
 */
function weekTabRequestsFromBlocks_(tabId, blocks) {
  var reqs = [statusDropdownRequest_(tabId)];
  var range = function (s, e) { return { tabId: tabId, startIndex: s, endIndex: e }; };
  var at = 1; // the newline of the last paragraph written so far
  var afterTable = false;
  var i = 0;
  while (i < blocks.length) {
    if (blocks[i].table) {
      // A table is followed by exactly one empty paragraph. The next table or line goes in at
      // that paragraph, so the spacing is the same after every table.
      at = appendTable_(reqs, tabId, at, blocks[i].table);
      afterTable = true;
      i++;
      continue;
    }
    // Lines that follow each other are typed in one go: into the tab's empty first paragraph, or
    // on new lines below the empty paragraph after a table.
    var lines = [];
    while (i < blocks.length && !blocks[i].table) lines.push(blocks[i++]);
    var text = lines.map(function (l) { return l.line; }).join('\n');
    reqs.push({ insertText: { text: (afterTable ? '\n' : '') + text, location: { tabId: tabId, index: at } } });
    var pos = afterTable ? at + 1 : at;
    lines.forEach(function (l) {
      var look = LINE_LOOKS[l.look];
      reqs.push({ updateParagraphStyle: { range: range(pos, pos + l.line.length + 1), paragraphStyle: { namedStyleType: look.named }, fields: 'namedStyleType' } });
      if (look.style) reqs.push(textStyleRequest_(range(pos, pos + l.line.length), look.style(), look.fields));
      pos += l.line.length + 1;
    });
    at = pos - 1;
    afterTable = false;
  }
  return reqs;
}

// How each kind of line outside the tables looks: its paragraph style and, for some, a text style.
var LINE_LOOKS = {
  h2: { named: 'HEADING_2' },
  h3: { named: 'HEADING_3' },
  count: {
    named: 'NORMAL_TEXT',
    style: function () { return { italic: true, foregroundColor: optionalColorFromHex_(DATA_FG) }; },
    fields: 'italic,foregroundColor',
  },
  help: {
    named: 'NORMAL_TEXT',
    style: function () { return { fontSize: { magnitude: HELP_FONT_PT, unit: 'PT' }, foregroundColor: optionalColorFromHex_(HELP_FG) }; },
    fields: 'fontSize,foregroundColor',
  },
  muted: {
    named: 'NORMAL_TEXT',
    style: function () { return { fontSize: { magnitude: HELP_FONT_PT, unit: 'PT' }, italic: true, foregroundColor: optionalColorFromHex_(MUTED_FG) }; },
    fields: 'fontSize,italic,foregroundColor',
  },
};

/** Creates the Status dropdown (its three choices and their colors) in one tab. */
function statusDropdownRequest_(tabId) {
  return {
    createDropdownDefinition: {
      tabId: tabId,
      dropdownDefinition: {
        dropdownDefinitionId: STATUS_DROPDOWN_ID,
        dropdownDefinitionProperties: {
          title: STATUS_DROPDOWN_TITLE,
          options: STATUS_OPTIONS.map(function (o) {
            return {
              optionId: o.id,
              displayValue: o.label,
              textStyle: { backgroundColor: optionalColorFromHex_(o.bg), foregroundColor: optionalColorFromHex_(o.fg) },
            };
          }),
        },
      },
    },
  };
}

/**
 * Everything a week tab shows, top to bottom, as a list of blocks:
 *   { line, look }   one line of text; look is a key of LINE_LOOKS
 *   { table }        a table (see appendTable_)
 * buildWeekTabRequests_ turns the blocks into Docs requests. Keeping the two steps apart keeps the
 * "what goes where" rules below free of position math.
 */
function weekTabBlocks_(weekKey, weekData, courses, colorMap, saved, contentWidth, staff) {
  var days = weekData.days || [];
  var work = staff || readStaffWork_(null);
  var blocks = [
    { line: 'Week of ' + (weekData.week_label || weekKey), look: 'h2' },
    { line: COUNT_LINE_PREFIX + countAssignmentsInWeek_(days), look: 'count' },
    { line: BY_DAY_TITLE, look: 'h3' },
    { line: BY_DAY_HELP_LINE, look: 'help' },
    { table: byDayTable_(days, colorMap, saved, contentWidth, work.days) },
    { line: WEEKEND_TITLE, look: 'h3' },
    { line: WEEKEND_HELP_LINE, look: 'help' },
  ];
  WEEKEND_TABLES.forEach(function (w) {
    blocks.push({ table: weekendPlanTable_(w, work.weekend[w.day], contentWidth) });
  });

  // By Class: one table for each class with something due, A to Z, then one line naming the rest.
  blocks.push({ line: BY_CLASS_TITLE, look: 'h3' });
  var nothingDue = [];
  var tables = 0;
  groupAssignmentsByCourse_(days, courses).forEach(function (group) {
    if (!group.assignments.length) return nothingDue.push(group.course);
    blocks.push({ table: byClassTable_(group, colorMap, saved, contentWidth) });
    tables++;
  });
  if (!tables) blocks.push({ line: NO_ASSIGNMENTS_TEXT, look: 'muted' });
  else if (nothingDue.length) blocks.push({ line: NOTHING_DUE_PREFIX + nothingDue.join(', ') + '.', look: 'muted' });
  return blocks;
}

/**
 * The By Day table: the column names, then for each day its row, its Canvas work (by due time), the
 * to-dos staff added (staffDays[day], in their order) and one blank row to type a new to-do in.
 * Monday to Friday are always there. Saturday and Sunday are only listed when something is in them,
 * and get no blank row: the Weekend plan is the place to plan those.
 */
function byDayTable_(days, colorMap, saved, contentWidth, staffDays) {
  var columns = BY_DAY_HEADERS.length;
  var canvas = assignmentsByDay_(days);
  var rows = [headerRow_(BY_DAY_HEADERS, HEADER_BG)];
  SCHEDULE_WEEKDAY_NAMES.forEach(function (day, i) {
    var todos = (staffDays && staffDays[day]) || [];
    var schoolDay = i < 5;
    if (!schoolDay && !canvas[day].length && !todos.length) return;
    rows.push(groupRow_(day, DAY_ROW_BG, columns));
    canvas[day].forEach(function (a) {
      var course = cellText_(a.course) || '(No Course)';
      rows.push(canvasRow_(a, true, { text: course, bg: colorMap[course] || '#EAEDED' }, saved));
    });
    todos.forEach(function (todo) { rows.push(staffRow_(todo)); });
    if (schoolDay) rows.push({ look: 'plain', cells: [richText_(ADD_TODO_TEXT, mutedStyle_()), richText_(''), richText_(''), richText_('')] });
  });
  return { rows: rows, widths: scaledColumnWidths_(BY_DAY_WIDTHS, contentWidth), center: [1, 2] };
}

/** One class's By Class table: its name in its color, the column names, then its assignments. */
function byClassTable_(group, colorMap, saved, contentWidth) {
  var rows = [
    groupRow_(group.course, colorMap[group.course] || '#EAEDED', BY_CLASS_HEADERS.length),
    headerRow_(BY_CLASS_HEADERS, HEADER_BG),
  ];
  group.assignments.forEach(function (a) {
    rows.push(canvasRow_(a, false, { text: dueText_(a) }, saved));
  });
  return { rows: rows, widths: scaledColumnWidths_(BY_CLASS_WIDTHS, contentWidth), center: [1, 2] };
}

/**
 * One Weekend plan table: "Saturday | Assignment | Notes" in the day's color, then the rows staff
 * had there (`rows`, see readStaffWork_) exactly as read, or Morning, Afternoon, Evening.
 */
function weekendPlanTable_(weekendDay, rows, contentWidth) {
  var half = Math.round((contentWidth - WEEKEND_LABEL_WIDTH_PT) * 50) / 100;
  var last = Math.round((contentWidth - WEEKEND_LABEL_WIDTH_PT - half) * 100) / 100;
  var out = [headerRow_([weekendDay.day].concat(WEEKEND_HEADERS), weekendDay.bg)];
  (rows && rows.length ? rows : emptyWeekendRows_()).forEach(function (cells) {
    out.push({ look: 'plain', cells: cells });
  });
  return { rows: out, widths: [WEEKEND_LABEL_WIDTH_PT, half, last], center: null };
}

function headerRow_(names, bg) {
  return { look: 'header', bg: bg, cells: names.map(function (name) { return richText_(name); }) };
}

/** A class or day name on a row of its own, merged across all `columns`. */
function groupRow_(name, bg, columns) {
  var cells = [richText_(cellText_(name))];
  while (cells.length < columns) cells.push(richText_(''));
  return { look: 'group', bg: bg, cells: cells };
}

/**
 * One Canvas assignment's row: Assignment, `second` (the Class cell in By Day, the Due cell in By
 * Class), the Status chip and the note. Status and note come from `saved`, by the Canvas link.
 */
function canvasRow_(a, timeAfterTitle, second, saved) {
  var url = a.url || '';
  var note = cellText_((url && saved.notes[url]) || '');
  return {
    look: 'plain',
    cells: [
      assignmentCell_(a, timeAfterTitle),
      second,
      { chip: statusChip_((url && saved.status[url]) || STATUS_DEFAULT) },
      richText_(note),
    ],
  };
}

/**
 * The Assignment cell of a Canvas row: the title, linked to Canvas; in By Day, the time when it
 * isn't due at 11:59 pm ("Lab report (due 8:00 am)"); and for a kept row (see keptAssignments_) a
 * second line in gray italic that says why it's still here.
 */
function assignmentCell_(a, timeAfterTitle) {
  var title = cellText_(a.assignment) || 'Untitled Assignment';
  var time = timeAfterTitle ? shownDueTime_(a.due_time) : '';
  var cell = richText_(title, a.url ? { link: { url: a.url }, foregroundColor: optionalColorFromHex_(LINK_FG) } : null);
  if (time) cell = richJoin_(cell, richText_(' (due ' + time + ')'));
  var reason = cellText_(a.kept_reason);
  if (reason) cell = richJoin_(richJoin_(cell, richText_('\n')), richText_(reason, mutedStyle_()));
  return cell;
}

/** "Tue 11/17" for an assignment's due date; "Tue 11/17, 8:00 am" when it isn't due at 11:59 pm. */
function dueText_(a) {
  var date = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(a.due_date || ''));
  var day = cellText_(a.day);
  var text = date ? day.slice(0, 3) + ' ' + Number(date[1]) + '/' + Number(date[2]) : day;
  var time = shownDueTime_(a.due_time);
  return time ? text + ', ' + time : text;
}

/**
 * One of staff's own to-dos in By Day (see staffRowFromCells_), written back as it was read. An
 * empty Class cell says "Added by staff" and an empty Assignment cell "+ Add a to-do", both in gray
 * italic; every to-do has a Status chip.
 */
function staffRow_(todo) {
  var words = function (cell, placeholder) {
    return richHasText_(cell) ? cell : richText_(placeholder, mutedStyle_());
  };
  return {
    look: 'plain',
    cells: [
      words(todo.cells[0], ADD_TODO_TEXT),
      words(todo.cells[1], ADDED_BY_STAFF_TEXT),
      { chip: statusChip_(todo.status) },
      todo.cells[2],
    ],
  };
}

/** The ID of the Status choice with this label (the first choice if there's no such label). */
function statusChip_(status) {
  return (statusOption_(status) || STATUS_OPTIONS[0]).id;
}

/** The look of AutoPlanner's own words inside a table: "+ Add a to-do", "Added by staff", "Not on Canvas". */
function mutedStyle_() {
  return { italic: true, foregroundColor: optionalColorFromHex_(MUTED_FG) };
}

// ---- What staff typed ------------------------------------------------------------------------------
// Staff's own to-dos (By Day) and the Weekend plan are read as "rich cells" and written back exactly:
// { text, runs: [{ s, e, style }] } is a cell's text (paragraph breaks are "\n") and the text styles
// on parts of it (see readRichCell_).

/**
 * Everything in a week tab that belongs to staff:
 *   days:    { Monday: [row, ...], ... Sunday: [...] } the to-dos staff added under each day of By
 *            Day, in their order. A row is { cells: [assignment, class, notes], status }.
 *   weekend: { Saturday: [[label, assignment, notes], ...], Sunday: [...] } the rows under the header
 *            row of each Weekend plan table. null = the tab has no such table.
 * Week tabs from before November 2026 had an "Added by staff" table instead; its rows are moved in
 * here (see moveOldStaffRows_).
 */
function readStaffWork_(tabJson) {
  var work = { days: {}, weekend: {} };
  SCHEDULE_WEEKDAY_NAMES.forEach(function (d) { work.days[d] = []; });
  WEEKEND_TABLES.forEach(function (w) { work.weekend[w.day] = null; });
  var tables = weekTabTables_(tabJson);
  var fromClass = classTableRows_(tables);
  tables.forEach(function (t) {
    if (t.layout.kind === 'day' && !t.layout.old) {
      eachDayTableRow_(t, fromClass, function () {}, function (cells, day) {
        var row = staffRowFromCells_(cells);
        if (row) work.days[day || SCHEDULE_WEEKDAY_NAMES[0]].push(row);
      });
    }
    if (t.layout.kind === 'weekend') {
      // A table whose first cell no longer names its day is the first weekend day without a table.
      var free = WEEKEND_TABLES.filter(function (w) { return !work.weekend[w.day]; })[0];
      var day = t.layout.day || (free ? free.day : WEEKEND_TABLES[WEEKEND_TABLES.length - 1].day);
      var rows = t.rows.slice(1).map(function (row) {
        var cells = row.tableCells || [];
        return [0, 1, 2].map(function (c) { return readRichCell_(cells[c]); });
      });
      work.weekend[day] = (work.weekend[day] || []).concat(rows);
    }
  });
  moveOldStaffRows_(tabJson, work);
  return work;
}

function richHasText_(cell) {
  return cell.text.replace(/\s/g, '') !== '';
}

/**
 * The to-do in one By Day row that isn't Canvas work: { cells: [assignment, class, notes], status },
 * or null for a blank row (nothing in it but AutoPlanner's own gray words).
 */
function staffRowFromCells_(cells) {
  var assignment = withoutPlaceholder_(readRichCell_(cells[0]), ADD_TODO_TEXT);
  var klass = withoutPlaceholder_(readRichCell_(cells[1]), ADDED_BY_STAFF_TEXT);
  var notes = readRichCell_(cells[3]);
  // Typing only a class or a note in the "+ Add a to-do" row still makes a to-do. Clearing the
  // Assignment cell of a to-do removes it.
  var besideWords = assignment.found && (richHasText_(klass.cell) || richHasText_(notes));
  if (!richHasText_(assignment.cell) && !besideWords) return null;
  var status = cellStatus_(cells[2], false);
  if (status && !statusOption_(status)) {
    // Typed in the Status cell instead of choosing: kept at the start of the note.
    notes = richJoin_(richText_(OLD_STATUS_NOTE_PREFIX + status + '.' + (richHasText_(notes) ? ' ' : '')), notes);
    status = '';
  }
  return {
    cells: [withoutBorrowedLook_(assignment.cell), withoutBorrowedLook_(klass.cell), notes],
    status: status || STATUS_DEFAULT,
  };
}

/**
 * Before November 2026 every week tab ended with an "Added by staff" table (Assignment, Class, Day,
 * Status, Notes). Each of its rows moves into By Day under its day ("Tue", "tuesday", "TUES" ...),
 * after the to-dos already there. A Saturday or Sunday row goes into that day's first Weekend plan
 * row (Morning). A row with no day AutoPlanner can read goes under Monday, and what its Day cell
 * said is kept at the start of its note. Nothing typed is lost.
 */
function moveOldStaffRows_(tabJson, work) {
  var table = findOldStaffTable_(tabJson);
  ((table && table.tableRows) || []).slice(1).forEach(function (row) {
    var cells = [];
    for (var c = 0; c < OLD_STAFF_COLUMNS; c++) cells.push(readRichCell_((row.tableCells || [])[c]));
    if (!cells.some(richHasText_)) return;
    var dayText = cellText_(cells[2].text);
    var day = weekdayFromText_(dayText);
    var statusText = cellText_(cells[3].text);
    var status = normalizeStatus_(statusText);
    var option = statusOption_(status);
    var front = !day && dayText ? DAY_WAS_PREFIX + dayText + '. ' : '';
    var notesWith = function (words) {
      return richJoin_(richText_(richHasText_(cells[4]) ? words : words.replace(/ $/, '')), cells[4]);
    };
    if (weekendTable_(day)) {
      // The Weekend plan has no Status column: anything but the first choice is kept in Notes.
      if (status && status !== STATUS_DEFAULT) front += OLD_STATUS_NOTE_PREFIX + statusText + '. ';
      var rows = work.weekend[day] || (work.weekend[day] = emptyWeekendRows_());
      if (!rows.length) rows.push(emptyWeekendRows_()[0]);
      var what = richHasText_(cells[1]) ? richJoin_(richJoin_(cells[0], richText_(' (')), richJoin_(cells[1], richText_(')'))) : cells[0];
      rows[0][1] = richAddParagraph_(rows[0][1], what);
      rows[0][2] = richAddParagraph_(rows[0][2], notesWith(front));
      return;
    }
    if (status && !option) front += OLD_STATUS_NOTE_PREFIX + status + '. ';
    work.days[day || SCHEDULE_WEEKDAY_NAMES[0]].push({
      cells: [cells[0], cells[1], notesWith(front)],
      status: option ? option.label : STATUS_DEFAULT,
    });
  });
}

/** A Weekend plan table's rows when nothing has been typed yet: Morning, Afternoon, Evening. */
function emptyWeekendRows_() {
  return WEEKEND_ROWS.map(function (label) { return [richText_(label, { bold: true }), richText_(''), richText_('')]; });
}

/**
 * The old "Added by staff" table of a week tab, or null: the table under the "Added by staff"
 * heading or, if staff removed the heading from a tab in the old layout, its last 5-column table.
 */
function findOldStaffTable_(tabJson) {
  var content = (tabJson && tabJson.documentTab && tabJson.documentTab.body && tabJson.documentTab.body.content) || [];
  var afterHeading = false;
  var oldLayout = false;
  var five = null;
  for (var i = 0; i < content.length; i++) {
    var el = content[i];
    if (el.paragraph && paragraphPlainText_(el.paragraph).trim() === ADDED_BY_STAFF_TEXT) afterHeading = true;
    if (!el.table) continue;
    if (afterHeading) return el.table;
    if ((el.table.columns || 0) >= 6) oldLayout = true;
    if ((el.table.columns || 0) === OLD_STAFF_COLUMNS) five = el.table;
  }
  return oldLayout ? five : null;
}

/** How many to-dos and Weekend plan rows staff have filled in (for the home tab). */
function countStaffWork_(work) {
  var n = 0;
  Object.keys((work && work.days) || {}).forEach(function (d) { n += work.days[d].length; });
  Object.keys((work && work.weekend) || {}).forEach(function (d) {
    (work.weekend[d] || []).forEach(function (row) {
      if (richHasText_(row[1]) || richHasText_(row[2])) n++;
    });
  });
  return n;
}

/** A rich cell of plain text, all in one style if one is given. */
function richText_(text, style) {
  var t = String(text || '');
  return { text: t, runs: style && t ? [{ s: 0, e: t.length, style: style }] : [] };
}

/** Characters `from` up to `to` of a rich cell. */
function richSlice_(cell, from, to) {
  var runs = [];
  cell.runs.forEach(function (r) {
    var s = Math.max(r.s, from), e = Math.min(r.e, to);
    if (e > s) runs.push({ s: s - from, e: e - from, style: r.style });
  });
  return { text: cell.text.slice(from, to), runs: runs };
}

/** Two rich cells, one straight after the other. */
function richJoin_(a, b) {
  var moved = b.runs.map(function (r) { return { s: r.s + a.text.length, e: r.e + a.text.length, style: r.style }; });
  return { text: a.text + b.text, runs: a.runs.concat(moved) };
}

/** `more` as a new paragraph at the end of a rich cell (or on its own, if the cell is empty). */
function richAddParagraph_(cell, more) {
  if (!richHasText_(more)) return cell;
  return richHasText_(cell) ? richJoin_(richJoin_(cell, richText_('\n')), more) : more;
}

/** A rich cell without the white space at its two ends. */
function richTrim_(cell) {
  var end = cell.text.replace(/\s+$/, '').length;
  var start = Math.min(end, cell.text.length - cell.text.replace(/^\s+/, '').length);
  return richSlice_(cell, start, end);
}

/**
 * A cell without AutoPlanner's own gray words ("+ Add a to-do", "Added by staff"), for when staff
 * typed next to them instead of over them: { cell, found }.
 */
function withoutPlaceholder_(cell, words) {
  var i = cell.text.indexOf(words);
  if (i < 0) return { cell: cell, found: false };
  var rest = richJoin_(richSlice_(cell, 0, i), richSlice_(cell, i + words.length, cell.text.length));
  return { cell: richTrim_(rest), found: true };
}

/**
 * Text staff type can come out in a look they didn't choose. Typed over AutoPlanner's gray italic
 * words, it's gray and italic as well. Typed in a row inserted below an assignment, it's blue and
 * underlined, because a new row copies the look of the link above it (checked in a real Doc,
 * 2026-11-10). This gives that text the table's usual look. A real link, and every other style
 * staff chose, is kept.
 */
function withoutBorrowedLook_(cell) {
  var colorIs = function (style, hex) {
    var rgb = style.foregroundColor && style.foregroundColor.color.rgbColor;
    var want = hexToRgbColor_(hex);
    return !!rgb && ['red', 'green', 'blue'].every(function (k) { return Math.abs((rgb[k] || 0) - want[k]) < 0.01; });
  };
  var runs = [];
  cell.runs.forEach(function (r) {
    var borrowed = [];
    if (r.style.italic && colorIs(r.style, MUTED_FG)) borrowed = ['italic', 'foregroundColor'];
    var linkBlue = colorIs(r.style, LINK_FG) || colorIs(r.style, GOOGLE_LINK_FG);
    if (r.style.underline && linkBlue && !r.style.link) borrowed = ['underline', 'foregroundColor'];
    if (!borrowed.length) return runs.push(r);
    var style = {};
    Object.keys(r.style).forEach(function (k) { if (borrowed.indexOf(k) < 0) style[k] = r.style[k]; });
    if (Object.keys(style).length) runs.push({ s: r.s, e: r.e, style: style });
  });
  return { text: cell.text, runs: runs };
}

function paragraphPlainText_(paragraph) {
  return (paragraph.elements || []).map(function (pe) { return pe.textRun ? pe.textRun.content || '' : ''; }).join('');
}

// Text styles carried over from a staff cell. Characters Docs would strip on insert are left out
// here, so every position after them stays right.
var RICH_STYLE_FIELDS = ['bold', 'italic', 'underline', 'strikethrough'];
var DOCS_STRIPPED_CHARS = /[\u0000-\u0008\u000c-\u001f\ue000-\uf8ff]/g;

function readRichCell_(cell) {
  var text = '';
  var runs = [];
  ((cell && cell.content) || []).forEach(function (se) {
    if (!se.paragraph) return;
    (se.paragraph.elements || []).forEach(function (pe) {
      if (!pe.textRun) return;
      var t = String(pe.textRun.content || '').replace(DOCS_STRIPPED_CHARS, '');
      var style = staffRunStyle_(pe.textRun.textStyle);
      if (t && style) runs.push({ s: text.length, e: text.length + t.length, style: style });
      text += t;
    });
  });
  // The last paragraph's newline belongs to the cell itself.
  if (text.slice(-1) === '\n') text = text.slice(0, -1);
  runs.forEach(function (r) { r.e = Math.min(r.e, text.length); });
  return { text: text, runs: runs.filter(function (r) { return r.e > r.s; }) };
}

function staffRunStyle_(ts) {
  if (!ts) return null;
  var out = {};
  RICH_STYLE_FIELDS.forEach(function (f) { if (ts[f]) out[f] = true; });
  if (ts.link && (ts.link.url || ts.link.tabId)) out.link = ts.link.url ? { url: ts.link.url } : { tabId: ts.link.tabId };
  ['foregroundColor', 'backgroundColor'].forEach(function (f) {
    var rgb = ts[f] && ts[f].color && ts[f].color.rgbColor;
    if (rgb) out[f] = { color: { rgbColor: { red: rgb.red || 0, green: rgb.green || 0, blue: rgb.blue || 0 } } };
  });
  return Object.keys(out).length ? out : null;
}

function textStyleRequest_(range, textStyle, fields) {
  return { updateTextStyle: { range: range, textStyle: textStyle, fields: fields } };
}

function cellStyleRequest_(tabId, tableStart, row, col, rowSpan, colSpan, style, fields) {
  return {
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: { tableStartLocation: { tabId: tabId, index: tableStart }, rowIndex: row, columnIndex: col },
        rowSpan: rowSpan,
        columnSpan: colSpan,
      },
      tableCellStyle: style,
      fields: fields,
    },
  };
}

/**
 * Adds one table at index `at` (the newline of the paragraph it goes under), fills it, styles it,
 * and returns the index of the empty paragraph Docs puts after it.
 *   table.rows:   [{ look, bg, cells }]. look is 'group' (a class or day name: one bold cell merged
 *                 across the table), 'header' (column names) or 'plain'. bg colors the whole row.
 *   a cell:       { text, runs, chip, bg }. text and runs are a rich cell (see readRichCell_): the
 *                 text, with paragraph breaks as "\n", and the styles on parts of it. A Status cell
 *                 has chip instead: the ID of the chosen option. bg colors just this cell.
 *   table.widths: one width in pt for each column.
 *   table.center: [first, last] column of the centered ones, or null to leave every column left.
 * Positions follow from how Docs numbers a fresh table (checked against the live API): a table
 * inserted at index i starts at i + 1, cell (r, c) holds an empty paragraph at
 * i + 4 + r*(2C + 1) + 2c, and the empty paragraph Docs adds after the table sits at
 * i + 3 + R*(2C + 1). Merging cells doesn't move any index. A chip takes up one index.
 */
function appendTable_(reqs, tabId, at, table) {
  var rows = table.rows;
  var R = rows.length;
  var C = table.widths.length;
  var tableStart = at + 1;
  var emptyAfter = at + 3 + R * (2 * C + 1);
  var emptyIndex = function (r, c) { return at + 4 + r * (2 * C + 1) + 2 * c; };
  var cellAt = function (r, c) { return rows[r].cells[c] || {}; };
  var size = function (r, c) { return cellAt(r, c).chip ? 1 : (cellAt(r, c).text || '').length; };
  var range = function (s, e) { return { tabId: tabId, startIndex: s, endIndex: e }; };
  var color = function (hex) { return optionalColorFromHex_(hex); };

  reqs.push({ insertTable: { rows: R, columns: C, location: { tabId: tabId, index: at } } });
  // The new paragraph after the table copies the heading above it; make it plain text.
  reqs.push({ updateParagraphStyle: { range: range(emptyAfter, emptyAfter + 1), paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });

  // Fill from the last cell to the first, so each insert only shifts cells already filled.
  for (var r = R - 1; r >= 0; r--) {
    for (var c = C - 1; c >= 0; c--) {
      var cell = cellAt(r, c);
      var where = { tabId: tabId, index: emptyIndex(r, c) };
      if (cell.chip) {
        reqs.push({ insertDropdown: { location: where, dropdownDefinitionId: STATUS_DROPDOWN_ID, selectedOptionId: cell.chip } });
      } else if (cell.text) {
        reqs.push({ insertText: { text: cell.text, location: where } });
      }
    }
  }

  // Where each cell's text starts once everything before it is filled.
  var start = [];
  var shift = 0;
  for (r = 0; r < R; r++) {
    start.push([]);
    for (c = 0; c < C; c++) {
      start[r].push(emptyIndex(r, c) + shift);
      shift += size(r, c);
    }
  }
  var cellEnd = function (r, c) { return start[r][c] + size(r, c); };

  // Whole table: padding, vertical centering, column widths, font size and text color.
  reqs.push(cellStyleRequest_(tabId, tableStart, 0, 0, R, C, {
    paddingTop: { magnitude: CELL_PAD_TOP_BOTTOM_PT, unit: 'PT' },
    paddingBottom: { magnitude: CELL_PAD_TOP_BOTTOM_PT, unit: 'PT' },
    paddingLeft: { magnitude: CELL_PAD_SIDE_PT, unit: 'PT' },
    paddingRight: { magnitude: CELL_PAD_SIDE_PT, unit: 'PT' },
    contentAlignment: 'MIDDLE',
  }, 'paddingTop,paddingBottom,paddingLeft,paddingRight,contentAlignment'));
  table.widths.forEach(function (w, i) {
    reqs.push({
      updateTableColumnProperties: {
        tableStartLocation: { tabId: tabId, index: tableStart },
        columnIndices: [i],
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: w, unit: 'PT' } },
        fields: 'widthType,width',
      },
    });
  });
  reqs.push(textStyleRequest_(range(start[0][0], cellEnd(R - 1, C - 1) + 1), {
    fontSize: { magnitude: TABLE_FONT_PT, unit: 'PT' },
    foregroundColor: color(DATA_FG),
  }, 'fontSize,foregroundColor'));

  var tallRows = [];
  rows.forEach(function (row, r) {
    if (row.bg) reqs.push(cellStyleRequest_(tabId, tableStart, r, 0, 1, C, { backgroundColor: color(row.bg) }, 'backgroundColor'));
    if (row.look === 'group') {
      if (size(r, 0)) reqs.push(textStyleRequest_(range(start[r][0], cellEnd(r, 0)), { bold: true }, 'bold'));
      reqs.push({
        mergeTableCells: {
          tableRange: {
            tableCellLocation: { tableStartLocation: { tabId: tabId, index: tableStart }, rowIndex: r, columnIndex: 0 },
            rowSpan: 1,
            columnSpan: C,
          },
        },
      });
      tallRows.push(r);
      return;
    }
    if (row.look === 'header') {
      reqs.push(textStyleRequest_(range(start[r][0], cellEnd(r, C - 1)), { bold: true, foregroundColor: color(HEADER_FG) }, 'bold,foregroundColor'));
      tallRows.push(r);
    }
    if (table.center) {
      var centered = range(start[r][table.center[0]], cellEnd(r, table.center[1]) + 1);
      reqs.push({ updateParagraphStyle: { range: centered, paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } });
    }
    if (row.look === 'header') return;
    for (var c = 0; c < C; c++) {
      var cell = cellAt(r, c);
      if (cell.bg) reqs.push(cellStyleRequest_(tabId, tableStart, r, c, 1, 1, { backgroundColor: color(cell.bg) }, 'backgroundColor'));
      (cell.chip ? [] : cell.runs || []).forEach(function (run) {
        reqs.push(textStyleRequest_(range(start[r][c] + run.s, start[r][c] + run.e), run.style, Object.keys(run.style).join(',')));
      });
    }
  });
  if (tallRows.length) {
    reqs.push({
      updateTableRowStyle: {
        tableStartLocation: { tabId: tabId, index: tableStart },
        rowIndices: tallRows,
        tableRowStyle: { minRowHeight: { magnitude: ROW_MIN_HEIGHT_PT, unit: 'PT' } },
        fields: 'minRowHeight',
      },
    });
  }
  return emptyAfter + shift;
}

/** One color per class, the same in every week (classes sorted A to Z, colors never repeat). */
function buildCourseColorMap_(courseNames, previous) {
  var names = courseNames.slice().sort(function (a, b) {
    return a.localeCompare(b);
  });

  var map = {};
  var usedIndex = {};
  // A class keeps the color it had (so it doesn't change when the class list does, for example at
  // the semester change); only new classes get one.
  names.forEach(function (name) {
    var idx = previous && previous[name] ? COURSE_COLORS.indexOf(previous[name]) : -1;
    if (idx >= 0 && !usedIndex[idx]) {
      usedIndex[idx] = true;
      map[name] = COURSE_COLORS[idx];
    }
  });

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (map[name]) continue;
    var preferred = hashString_(name) % COURSE_COLORS.length;
    var idx = preferred;
    var guard = 0;
    while (usedIndex[idx] && guard < COURSE_COLORS.length) {
      idx = (idx + 1) % COURSE_COLORS.length;
      guard++;
    }
    if (guard >= COURSE_COLORS.length) {
      idx = i % COURSE_COLORS.length;
    }
    usedIndex[idx] = true;
    map[name] = COURSE_COLORS[idx];
  }
  return map;
}

/** Every class the student takes (from Canvas), plus any class that only appears on assignments. */
function plannerCourseList_(data) {
  var names = (data.courses || []).map(cellText_).filter(function (n) { return n; });
  Object.keys(data.weeks || {}).forEach(function (k) {
    (data.weeks[k].days || []).forEach(function (d) {
      (d.assignments || []).forEach(function (a) {
        var c = cellText_(a.course) || '(No Course)';
        if (names.indexOf(c) === -1) names.push(c);
      });
    });
  });
  return names.sort(function (a, b) {
    var x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function hashString_(str) {
  var hash = 0;
  var s = String(str || '');
  for (var i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

function getCellText_(cell) {
  var text = '';
  (cell.content || []).forEach(function (se) {
    if (!se.paragraph) return;
    (se.paragraph.elements || []).forEach(function (pe) {
      if (pe.textRun) text += (pe.textRun.content || '');
    });
  });
  return text.replace(/\n$/, '').trim();
}

function getCellLinkUrl_(cell) {
  var url = null;
  (cell.content || []).forEach(function (se) {
    if (!se.paragraph || url) return;
    (se.paragraph.elements || []).forEach(function (pe) {
      if (!url && pe.textRun && pe.textRun.textStyle && pe.textRun.textStyle.link) {
        url = pe.textRun.textStyle.link.url || null;
      }
    });
  });
  return url;
}

/**
 * Status and Notes from one week tab, by Canvas link: { notes: {url}, status: {url} }. Every
 * assignment is in the tab twice (By Class and By Day): a chosen Status in one table beats the first
 * choice in the other, and a Status cell that says nothing is skipped. Both layouts are read (see
 * tableLayout_).
 */
function readExistingDataFromTab_(tabJson) {
  var result = { notes: {}, status: {} };
  var raw = {};
  eachAssignmentRow_(tabJson, function (row) {
    if (row.note) result.notes[row.url] = row.note;
    if (row.status && (row.status !== STATUS_DEFAULT || !raw[row.url])) raw[row.url] = row.status;
  });
  Object.keys(raw).forEach(function (url) {
    var settled = settleStatus_(raw[url], result.notes[url]);
    result.status[url] = settled.status;
    if (settled.note) result.notes[url] = settled.note;
  });
  return result;
}

/** One group per class (every class, even with nothing due this week), assignments by due time. */
function groupAssignmentsByCourse_(days, courses) {
  var groups = {};
  (courses || []).forEach(function (c) { groups[c] = []; });
  (days || []).forEach(function (dayObj) {
    (dayObj.assignments || []).forEach(function (a) {
      var course = cellText_(a.course) || '(No Course)';
      if (!groups[course]) groups[course] = [];
      groups[course].push(a);
    });
  });
  var names = Object.keys(groups).sort(function (a, b) {
    var x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return names.map(function (course) {
    var list = groups[course].slice().sort(function (a, b) {
      var da = String(a.due_date || ''), db = String(b.due_date || '');
      if (da !== db) return da < db ? -1 : 1;
      var ta = scheduleTimeToMinutes_(a.due_time), tb = scheduleTimeToMinutes_(b.due_time);
      if (ta !== tb) return ta - tb;
      var na = String(a.assignment || ''), nb = String(b.assignment || '');
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    return { course: course, assignments: list };
  });
}

/**
 * Canvas assignments by the day they're due: { Monday: [...], ... Sunday: [...] }. Within a day
 * they're sorted by due time (as a real time), then title.
 */
function assignmentsByDay_(days) {
  var byDay = {};
  SCHEDULE_WEEKDAY_NAMES.forEach(function (name) { byDay[name] = []; });
  (days || []).forEach(function (dayObj) {
    (dayObj.assignments || []).forEach(function (a) {
      var day = [dayObj.day, a.day].filter(function (d) { return scheduleHasKey_(byDay, d); })[0];
      byDay[day || SCHEDULE_WEEKDAY_NAMES[0]].push(a);
    });
  });
  SCHEDULE_WEEKDAY_NAMES.forEach(function (name) {
    byDay[name].sort(function (a, b) {
      // Compare real times: as text, "10:25 AM" would come before "8:30 AM".
      var ta = scheduleTimeToMinutes_(a.due_time), tb = scheduleTimeToMinutes_(b.due_time);
      if (ta !== tb) return ta - tb;
      var na = String(a.assignment || '').toLowerCase(), nb = String(b.assignment || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  });
  return byDay;
}

// ---- Old Past weeks in this layout (reformatPastWeeks in App.gs, run once by the owner) ---------
// Weeks filed before November 2026 keep the layout they were filed in: Priority and Due Time
// columns, colored rows, typed Statuses, By Class before By Day and an "Added by staff" table.
// reformatPastWeeks rewrites each of them in this layout using only what is written in that tab
// (never Canvas, Script Properties or saved Statuses, which have all changed since): every title,
// link, class, day, due time, Status, note and staff row stays as it was. Only the tables and their
// look change. A new copy is built next to the old tab, read back and compared with the old one, and
// it only takes the old tab's place if every row matches. A week AutoPlanner can't read with
// confidence is left as it is and reported. Normal updates never touch Past weeks.
//
// A week is read into one plain record (see readOldPastWeek_ and readNewPastWeek_):
//   heading, count:  the "Week of ..." heading and the "Assignments in this week: N" line, as written
//   classes:         [{ name, color, rows }] the By Class tables that have rows, in their old order
//   nothingDue:      the line naming the classes with nothing due ("Nothing due this week: Art."), or ''
//   days:            { Monday: { rows, staff }, ... Sunday } By Day: the Canvas rows under each day,
//                    in their old order, then the rows from "Added by staff"
//   a Canvas row:    { title (the Assignment cell, rich), url, middle (By Class: the day it was due;
//                    By Day: the class), time (only when not 11:59 PM, as the old cell had it),
//                    reason (why a kept row stayed: "Not on Canvas"), status, note (rich) }
//   a staff row:     { cells: [assignment, class, notes] (rich), status }, as staffRow_ takes it
// Status and note are what the new tab shows: a Status typed by hand that isn't one of the old
// choices is the first choice, and the note starts with "Status was: <text>. ".

var OLD_BY_CLASS_HEADERS = ['Assignment', 'Day', 'Due Time', 'Priority', 'Status', 'Notes'];
var OLD_BY_DAY_HEADERS = ['Assignment', 'Course', 'Due Time', 'Priority', 'Status', 'Notes'];
var OLD_STAFF_HEADERS = ['Assignment', 'Class', 'Day', 'Status', 'Notes'];
// What the Priority column said. It was a column label, not something anyone typed: the one piece of
// text that goes away.
var OLD_PRIORITY_LABELS = ['Past due', 'Today', 'Tomorrow', 'Due Soon', 'This Week', 'Upcoming'];
// The lines above and inside the old tables, by AutoPlanner (not kept: the new layout has its own).
var OLD_TAB_LINES = [
  'Status: type Not started, In progress, or Complete. Notes: type anything you like. AutoPlanner never changes these two columns.',
  BY_CLASS_TITLE,
  BY_DAY_TITLE,
  ADDED_BY_STAFF_TEXT,
  'Add anything not on Canvas here. AutoPlanner never changes this table.',
];
var COUNT_LINE_PREFIX = 'Assignments in this week: ';
var DAY_WAS_PREFIX = 'Day was: ';
var OLD_DEFAULT_COLOR = '#EAEDED';
var TIME_TEXT = /^\d{1,2}:\d{2}\s?[AaPp][Mm]$/;
// A week is only started with at least this long left in the run (a week takes well under a minute).
var REFORMAT_RESERVE_MS = 90 * 1000;

function tabBodyContent_(tabJson) {
  return (tabJson && tabJson.documentTab && tabJson.documentTab.body && tabJson.documentTab.body.content) || [];
}

function rowTexts_(row) {
  return ((row && row.tableCells) || []).map(function (c) { return getCellText_(c); });
}

function sameList_(a, b) {
  return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
}

function emptyPastWeek_() {
  var week = { heading: '', count: '', classes: [], nothingDue: '', days: {} };
  SCHEDULE_WEEKDAY_NAMES.forEach(function (d) { week.days[d] = { rows: [], staff: [] }; });
  return week;
}

/** '#RRGGBB' for a Docs color, or '' for none. */
function colorHex_(optionalColor) {
  var rgb = optionalColor && optionalColor.color && optionalColor.color.rgbColor;
  if (!rgb) return '';
  return '#' + ['red', 'green', 'blue'].map(function (k) {
    var v = Math.round((rgb[k] || 0) * 255).toString(16).toUpperCase();
    return v.length < 2 ? '0' + v : v;
  }).join('');
}

function cellBackground_(cell) {
  return colorHex_(cell && cell.tableCellStyle && cell.tableCellStyle.backgroundColor);
}

/** The first thing in a tab AutoPlanner can't copy cell by cell, said in words; '' if none. */
function firstUncopyable_(content) {
  var problem = '';
  var stripped = new RegExp(DOCS_STRIPPED_CHARS.source); // without the "g", so test() keeps no state
  var paragraphOk = function (p) {
    // A list or checklist would lose its bullets and its ticks.
    if (p.bullet) problem = 'it has a list or checklist';
    (p.elements || []).forEach(function (pe) {
      if (problem) return;
      var link = pe.textRun && pe.textRun.textStyle && pe.textRun.textStyle.link;
      if (!pe.textRun) problem = 'it holds something other than text (a chip, picture or smart link)';
      else if (stripped.test(String(pe.textRun.content || ''))) problem = 'it holds characters AutoPlanner can\'t copy';
      else if (link && !link.url && !link.tabId) problem = 'it has a link to a heading or bookmark';
    });
  };
  content.forEach(function (el) {
    if (problem) return;
    if (el.paragraph) return paragraphOk(el.paragraph);
    if (el.sectionBreak) return;
    if (!el.table) { problem = 'it holds something other than text and tables'; return; }
    (el.table.tableRows || []).forEach(function (row) {
      (row.tableCells || []).forEach(function (cell) {
        (cell.content || []).forEach(function (se) {
          if (problem) return;
          if (se.paragraph) paragraphOk(se.paragraph);
          else problem = 'a cell holds a table or something else that isn\'t text';
        });
      });
    });
  });
  return problem;
}

/** 'class', 'day' or 'staff' for a table AutoPlanner wrote before November 2026, or ''. */
/** A table's first two rows in words, for a log line: "Art" / "Assignment | Day | ...". */
function describeTable_(table) {
  return (table.tableRows || []).slice(0, 2).map(function (row) {
    return '"' + rowTexts_(row).filter(function (x) { return x; }).join(' | ') + '"';
  }).filter(function (x) { return x !== '""'; }).join(' / ');
}

function oldTableKind_(table) {
  var rows = table.tableRows || [];
  if (table.columns === 6 && rows.length && sameList_(rowTexts_(rows[0]), OLD_BY_DAY_HEADERS)) return 'day';
  if (table.columns === 6 && rows.length > 1 && sameList_(rowTexts_(rows[1]), OLD_BY_CLASS_HEADERS)) return 'class';
  if (table.columns === OLD_STAFF_COLUMNS && rows.length && sameList_(rowTexts_(rows[0]), OLD_STAFF_HEADERS)) return 'staff';
  return '';
}

function isKeptReason_(text) {
  return text === KEPT_NOT_ON_CANVAS || text === KEPT_NO_DUE_DATE || /^Now due \S/.test(text);
}

/**
 * What a Status cell typed by hand means now: { status, was }. Not started, In progress and
 * Complete (in any case, with any spaces) and the other words in OLD_STATUS_WORDS become that
 * choice; an empty cell is the first choice; anything else is the first choice and `was` keeps the
 * text exactly, for the front of the note.
 */
function pastStatus_(text) {
  var typed = String(text || '').trim();
  var t = typed.replace(/\s+/g, ' ');
  if (!t) return { status: STATUS_DEFAULT, was: '' };
  var option = statusOption_(t);
  if (option) return { status: option.label, was: '' };
  var word = t.toLowerCase();
  if (scheduleHasKey_(OLD_STATUS_WORDS, word)) return { status: OLD_STATUS_WORDS[word], was: '' };
  return { status: STATUS_DEFAULT, was: typed };
}

/** `words` at the front of a note, with a space before what was there. */
function noteWithFront_(words, note) {
  if (!words) return note;
  return richJoin_(richText_(richHasText_(note) ? words : words.replace(/ $/, '')), note);
}

/** A rich cell, or an empty one when it holds only spaces. */
function wordsOrEmpty_(cell) {
  return richHasText_(cell) ? cell : richText_('');
}

/**
 * True when a typed day says just the day it means and no more: "Thu", "thurs.", "THURSDAY". Then
 * the row goes under that day and nothing else needs keeping. Otherwise ("Thu after lunch") the
 * words go in the note too, so none are lost.
 */
function plainDaySpelling_(text, day) {
  var t = String(text || '').trim().toLowerCase().replace(/\.$/, '');
  return t.length >= 2 && day.toLowerCase().indexOf(t) === 0;
}

/**
 * One assignment row of an old By Class or By Day table: { row, priorityDropped, statusWas } or
 * { problem } when a cell says something AutoPlanner never wrote there.
 */
function oldCanvasRow_(cells) {
  var time = cellText_(getCellText_(cells[2]));
  var priority = cellText_(getCellText_(cells[3]));
  if (time && !TIME_TEXT.test(time)) return { problem: 'a Due Time cell says "' + time + '"' };
  var reason = isKeptReason_(priority) ? priority : '';
  if (priority && !reason && OLD_PRIORITY_LABELS.indexOf(priority) < 0) return { problem: 'a Priority cell says "' + priority + '"' };
  var status = pastStatus_(readRichCell_(cells[4]).text);
  var shown = time && time.replace(/\s+/g, '').toUpperCase() !== END_OF_DAY_TIME.replace(/\s+/g, '') ? time : '';
  return {
    row: {
      title: readRichCell_(cells[0]),
      url: getCellLinkUrl_(cells[0]) || '',
      middle: cellText_(getCellText_(cells[1])),
      time: shown,
      reason: reason,
      status: status.status,
      note: noteWithFront_(status.was ? OLD_STATUS_NOTE_PREFIX + status.was + '. ' : '', readRichCell_(cells[5])),
      color: cellBackground_(cells[1]),
    },
    priorityDropped: !!priority && !reason,
    statusWas: !!status.was,
  };
}

/**
 * Reads a week in Past weeks:
 *   { state: 'old', week, stats }   it has the layout from before November 2026 (see the record above)
 *   { state: 'new' }                it already has this layout
 *   { state: 'skip', reason }       AutoPlanner can't read it with confidence, so it isn't changed
 * stats counts what the rewrite would do, for the log.
 */
function readOldPastWeek_(tabJson) {
  var skip = function (reason) { return { state: 'skip', reason: reason }; };
  var content = tabBodyContent_(tabJson);
  var tables = content.filter(function (el) { return el.table; }).map(function (el) { return el.table; });
  var lines = content.filter(function (el) { return el.paragraph; }).map(function (el) {
    return paragraphPlainText_(el.paragraph).replace(/\n$/, '').trim();
  }).filter(function (t) { return t; });
  var kinds = tables.map(oldTableKind_);
  var oldOnes = kinds.filter(function (k) { return k; }).length;
  var staffHeading = lines.indexOf(ADDED_BY_STAFF_TEXT) >= 0;
  if (!oldOnes && !staffHeading && tables.some(function (t) { return t.columns >= 5; })) {
    var unknown = tables.filter(function (t) { return t.columns >= 5; })[0];
    return skip('it has a table AutoPlanner doesn\'t know (first rows: ' + describeTable_(unknown) + ')');
  }
  if (!oldOnes && !staffHeading) {
    // This layout with nothing due at all has no tables, just "By Day" and "By Class" lines.
    var bothHeadings = lines.indexOf(BY_DAY_TITLE) >= 0 && lines.indexOf(BY_CLASS_TITLE) >= 0 && lines.indexOf(OLD_TAB_LINES[0]) < 0;
    var known = tables.length ? tables.every(function (t) { return tableLayout_(t); }) : bothHeadings;
    return known ? { state: 'new' } : skip(tables.length ? 'AutoPlanner can\'t tell which layout it has' : 'it has no tables');
  }
  if (oldOnes < tables.length) {
    var odd = tables[kinds.indexOf('')];
    return skip(odd.columns <= 4 ? 'it has tables in both layouts' : 'it has a table AutoPlanner doesn\'t know (first rows: ' + describeTable_(odd) + ')');
  }
  var uncopyable = firstUncopyable_(content);
  if (uncopyable) return skip(uncopyable);
  if (kinds.filter(function (k) { return k === 'day'; }).length !== 1) return skip('it doesn\'t have exactly one By Day table');
  if (kinds.filter(function (k) { return k === 'staff'; }).length > 1) return skip('it has two "Added by staff" tables');

  var week = emptyPastWeek_();
  var stats = { assignments: 0, chips: {}, notes: 0, staffRows: 0, kept: {}, priorityDropped: 0, statusWas: 0, dayWas: 0, emptyRows: 0 };
  week.heading = lines[0] || '';
  if (week.heading.indexOf('Week of ') !== 0) return skip('it has no "Week of" heading at the top');
  var rest = lines.slice(1);
  if (rest.length && rest[0].indexOf(COUNT_LINE_PREFIX) === 0) week.count = rest.shift();
  for (var i = 0; i < rest.length; i++) {
    if (OLD_TAB_LINES.indexOf(rest[i]) < 0) return skip('it has text outside the tables: "' + rest[i].slice(0, 60) + '"');
  }

  var problem = '';
  var count = function (row, result) {
    stats.chips[row.status] = (stats.chips[row.status] || 0) + 1;
    if (richHasText_(row.note)) stats.notes++;
    if (result && result.priorityDropped) stats.priorityDropped++;
    if (result && result.statusWas) stats.statusWas++;
  };
  var nothingDue = [];
  var classLinks = [];
  var dayLinks = [];
  tables.forEach(function (table, t) {
    if (problem) return;
    var rows = table.tableRows || [];
    var kind = kinds[t];
    if (kind === 'class') {
      var head = rows[0].tableCells || [];
      var name = cellText_(getCellText_(head[0]));
      if (!name || getCellLinkUrl_(head[0]) || rowTexts_(rows[0]).slice(1).some(function (x) { return x; })) {
        problem = 'a By Class table doesn\'t start with its class name';
        return;
      }
      var group = { name: name, color: cellBackground_(head[0]) || OLD_DEFAULT_COLOR, rows: [] };
      rows.slice(2).forEach(function (row) {
        if (problem) return;
        var texts = rowTexts_(row);
        if (texts.every(function (x) { return !x; })) { stats.emptyRows++; return; }
        if (texts[0] === NO_ASSIGNMENTS_TEXT && !texts.slice(1).some(function (x) { return x; })) return;
        var read = oldCanvasRow_(row.tableCells);
        if (read.problem) { problem = read.problem; return; }
        group.rows.push(read.row);
        classLinks.push(read.row.url || '\u0000' + cellText_(read.row.title.text));
        stats.assignments++;
        if (read.row.reason) stats.kept[read.row.reason] = (stats.kept[read.row.reason] || 0) + 1;
        count(read.row, read);
      });
      if (group.rows.length) week.classes.push(group);
      else nothingDue.push(name);
      return;
    }
    if (kind === 'day') {
      var day = '';
      rows.slice(1).forEach(function (row) {
        if (problem) return;
        var cells = row.tableCells || [];
        var texts = rowTexts_(row);
        if (texts.every(function (x) { return !x; })) { stats.emptyRows++; return; }
        var others = texts.slice(1).some(function (x) { return x; });
        if (!others && SCHEDULE_WEEKDAY_NAMES.indexOf(texts[0]) >= 0 && !getCellLinkUrl_(cells[0])) { day = texts[0]; return; }
        if (texts[0] === NO_ASSIGNMENTS_TEXT && !others) return;
        if (!day) { problem = 'By Day has a row above its first day'; return; }
        var read = oldCanvasRow_(cells);
        if (read.problem) { problem = read.problem; return; }
        week.days[day].rows.push(read.row);
        dayLinks.push(read.row.url || '\u0000' + cellText_(read.row.title.text));
        count(read.row, read);
      });
      return;
    }
    // "Added by staff": each row goes under its day in By Day, as moveOldStaffRows_ places it.
    rows.slice(1).forEach(function (row) {
      var cells = [];
      for (var c = 0; c < OLD_STAFF_COLUMNS; c++) cells.push(wordsOrEmpty_(readRichCell_((row.tableCells || [])[c])));
      if (!cells.some(richHasText_)) { stats.emptyRows++; return; }
      var dayText = cells[2].text.trim();
      var day = weekdayFromText_(dayText);
      var front = dayText && !(day && plainDaySpelling_(dayText, day)) ? DAY_WAS_PREFIX + dayText + '. ' : '';
      if (front) stats.dayWas++;
      var status = pastStatus_(cells[3].text);
      if (status.was) front += OLD_STATUS_NOTE_PREFIX + status.was + '. ';
      var staffRow = { cells: [cells[0], cells[1], noteWithFront_(front, cells[4])], status: status.status };
      week.days[day || SCHEDULE_WEEKDAY_NAMES[0]].staff.push(staffRow);
      stats.staffRows++;
      count({ status: staffRow.status, note: staffRow.cells[2] }, { statusWas: !!status.was });
    });
  });
  if (problem) return skip(problem);
  if (classLinks.slice().sort().join('\n') !== dayLinks.slice().sort().join('\n')) {
    return skip('By Class and By Day don\'t list the same assignments');
  }
  if (nothingDue.length) week.nothingDue = NOTHING_DUE_PREFIX + nothingDue.join(', ') + '.';
  return { state: 'old', week: week, stats: stats };
}

/**
 * The Assignment cell of a Canvas row in a rewritten past week (see assignmentCell_): the old title
 * with its link and look, the time as the old cell had it ("8:00 AM"), and the kept row's reason.
 */
function pastAssignmentCell_(row, timeAfterTitle) {
  var cell = row.title;
  if (timeAfterTitle && row.time) cell = richJoin_(cell, richText_(' (due ' + row.time + ')'));
  if (row.reason) cell = richJoin_(richJoin_(cell, richText_('\n')), richText_(row.reason, mutedStyle_()));
  return cell;
}

function pastDueText_(row) {
  return [row.middle, row.time].filter(function (x) { return x; }).join(', ');
}

/**
 * A past week in this layout, from its record (see readOldPastWeek_): the heading and count line as
 * written, By Day with only the days that have rows (no "+ Add a to-do" rows and no help line: the
 * week is over), then By Class. No Weekend plan: those weeks never had one, and an empty one would
 * be new content.
 */
function pastWeekBlocks_(week, contentWidth) {
  var colors = {};
  week.classes.forEach(function (g) { colors[g.name] = g.color; });
  var blocks = [{ line: week.heading, look: 'h2' }];
  if (week.count) blocks.push({ line: week.count, look: 'count' });
  blocks.push({ line: BY_DAY_TITLE, look: 'h3' });
  var rows = [headerRow_(BY_DAY_HEADERS, HEADER_BG)];
  SCHEDULE_WEEKDAY_NAMES.forEach(function (day) {
    var d = week.days[day];
    if (!d.rows.length && !d.staff.length) return;
    rows.push(groupRow_(day, DAY_ROW_BG, BY_DAY_HEADERS.length));
    d.rows.forEach(function (r) {
      var cls = { text: r.middle, runs: [], bg: colors[r.middle] || r.color || OLD_DEFAULT_COLOR };
      rows.push({ look: 'plain', cells: [pastAssignmentCell_(r, true), cls, { chip: statusChip_(r.status) }, r.note] });
    });
    d.staff.forEach(function (s) {
      var row = staffRow_(s);
      // The week is over: an empty Assignment cell stays empty instead of saying "+ Add a to-do".
      if (!richHasText_(s.cells[0])) row.cells[0] = richText_('');
      rows.push(row);
    });
  });
  if (rows.length > 1) blocks.push({ table: { rows: rows, widths: scaledColumnWidths_(BY_DAY_WIDTHS, contentWidth), center: [1, 2] } });
  else blocks.push({ line: NO_ASSIGNMENTS_TEXT, look: 'muted' });

  blocks.push({ line: BY_CLASS_TITLE, look: 'h3' });
  week.classes.forEach(function (g) {
    var table = [groupRow_(g.name, g.color, BY_CLASS_HEADERS.length), headerRow_(BY_CLASS_HEADERS, HEADER_BG)];
    g.rows.forEach(function (r) {
      table.push({ look: 'plain', cells: [pastAssignmentCell_(r, false), richText_(pastDueText_(r)), { chip: statusChip_(r.status) }, r.note] });
    });
    blocks.push({ table: { rows: table, widths: scaledColumnWidths_(BY_CLASS_WIDTHS, contentWidth), center: [1, 2] } });
  });
  if (week.nothingDue) blocks.push({ line: week.nothingDue, look: 'muted' });
  else if (!week.classes.length) blocks.push({ line: NO_ASSIGNMENTS_TEXT, look: 'muted' });
  return blocks;
}

/** True when every character of a rich cell is in AutoPlanner's gray italic (mutedStyle_). */
function richIsMuted_(cell) {
  if (!cell.text) return false;
  var covered = 0;
  cell.runs.forEach(function (r) {
    if (r.style.italic && colorHex_(r.style.foregroundColor) === MUTED_FG) covered += r.e - r.s;
  });
  return covered >= cell.text.length;
}

/** A rewritten Assignment cell taken apart again: { title, time, reason } (see pastAssignmentCell_). */
function splitPastAssignmentCell_(cell, timeAfterTitle) {
  var out = { title: cell, time: '', reason: '' };
  var cut = cell.text.lastIndexOf('\n');
  if (cut >= 0) {
    var last = richSlice_(cell, cut + 1, cell.text.length);
    if (isKeptReason_(last.text) && richIsMuted_(last)) {
      out.reason = last.text;
      out.title = richSlice_(cell, 0, cut);
    }
  }
  var m = timeAfterTitle ? / \(due ([^)]*)\)$/.exec(out.title.text) : null;
  if (m && TIME_TEXT.test(m[1])) {
    var at = out.title.text.length - m[0].length;
    var suffixLinked = out.title.runs.some(function (r) { return r.e > at && r.style.link; });
    if (!suffixLinked) {
      out.time = m[1];
      out.title = richSlice_(out.title, 0, at);
    }
  }
  return out;
}

/** A Canvas row of a rewritten past week, read back into the record's form. */
function newPastCanvasRow_(cells, inByDay) {
  var parts = splitPastAssignmentCell_(readRichCell_(cells[0]), inByDay);
  var second = cellText_(getCellText_(cells[1]));
  var row = {
    title: parts.title,
    url: getCellLinkUrl_(cells[0]) || '',
    middle: second,
    time: parts.time,
    reason: parts.reason,
    status: cellStatus_(cells[2], false),
    note: readRichCell_(cells[3]),
  };
  if (!inByDay) {
    // "Tuesday, 8:00 AM": the day as it was written, then the time.
    var m = /^(.*), (\d{1,2}:\d{2}\s?[AaPp][Mm])$/.exec(second);
    if (m) { row.middle = m[1]; row.time = m[2]; } else if (TIME_TEXT.test(second)) { row.middle = ''; row.time = second; }
  }
  return row;
}

/**
 * Reads a week in this layout back into the record readOldPastWeek_ makes, so the two can be
 * compared: { week } or { problem }. In By Day, the Canvas rows are found the way updates find
 * them (see eachDayTableRow_): for each By Class row, the By Day row with its link, best under its
 * own day and with its title. Every other row is a staff row.
 */
function readNewPastWeek_(tabJson) {
  var week = emptyPastWeek_();
  var content = tabBodyContent_(tabJson);
  var lines = [];
  var dayRows = null;
  var problem = '';
  content.forEach(function (el) {
    if (el.paragraph) {
      var text = paragraphPlainText_(el.paragraph).replace(/\n$/, '').trim();
      if (text) lines.push(text);
      return;
    }
    if (!el.table || problem) return;
    var rows = el.table.tableRows || [];
    if (rows.length && sameList_(rowTexts_(rows[0]), BY_DAY_HEADERS)) {
      if (dayRows) problem = 'it has two By Day tables';
      dayRows = rows;
      return;
    }
    if (rows.length > 1 && sameList_(rowTexts_(rows[1]), BY_CLASS_HEADERS)) {
      var group = { name: cellText_(getCellText_(rows[0].tableCells[0])), color: cellBackground_(rows[0].tableCells[0]), rows: [] };
      rows.slice(2).forEach(function (row) { group.rows.push(newPastCanvasRow_(row.tableCells || [], false)); });
      week.classes.push(group);
      return;
    }
    problem = 'it has a table that isn\'t By Day or By Class';
  });
  if (problem) return { problem: problem };
  week.heading = lines[0] || '';
  if (lines[1] && lines[1].indexOf(COUNT_LINE_PREFIX) === 0) week.count = lines[1];
  week.nothingDue = lines.filter(function (l) { return l.indexOf(NOTHING_DUE_PREFIX) === 0; })[0] || '';

  var found = [];
  var day = '';
  (dayRows || []).slice(1).forEach(function (row) {
    var cells = row.tableCells || [];
    var name = dayRowName_(cells, { old: false });
    if (name) { day = name; return; }
    var canvas = newPastCanvasRow_(cells, true);
    found.push({ day: day || SCHEDULE_WEEKDAY_NAMES[0], cells: cells, canvas: canvas, claimed: false });
  });
  week.classes.forEach(function (g) {
    g.rows.forEach(function (cr) {
      var best = null;
      var bestFit = -1;
      found.forEach(function (f) {
        var same = cr.url ? f.canvas.url === cr.url : !f.canvas.url && f.canvas.title.text === cr.title.text;
        if (f.claimed || !same) return;
        var fit = (f.day === weekdayFromText_(cr.middle) ? 2 : 0) + (f.canvas.title.text === cr.title.text ? 1 : 0);
        if (fit > bestFit) { best = f; bestFit = fit; }
      });
      if (best) best.claimed = true;
    });
  });
  found.forEach(function (f) {
    if (f.claimed) return week.days[f.day].rows.push(f.canvas);
    week.days[f.day].staff.push({
      cells: [
        withoutPlaceholder_(readRichCell_(f.cells[0]), ADD_TODO_TEXT).cell,
        withoutPlaceholder_(readRichCell_(f.cells[1]), ADDED_BY_STAFF_TEXT).cell,
        readRichCell_(f.cells[3]),
      ],
      status: cellStatus_(f.cells[2], false),
    });
  });
  return { week: week };
}

/**
 * A rich cell as one string: its text, then the look of each stretch. The table's own text color is
 * left out (Docs may or may not store it on each run), so only what someone could see differs.
 */
function richKey_(cell) {
  var marks = [];
  for (var i = 0; i < cell.text.length; i++) marks.push('');
  cell.runs.forEach(function (r) {
    var st = r.style;
    var parts = [];
    RICH_STYLE_FIELDS.forEach(function (f) { if (st[f]) parts.push(f); });
    if (st.link) parts.push('link ' + (st.link.url || ('tab ' + st.link.tabId)));
    var fg = colorHex_(st.foregroundColor);
    if (fg && fg !== DATA_FG) parts.push('color ' + fg);
    var bg = colorHex_(st.backgroundColor);
    if (bg) parts.push('highlight ' + bg);
    for (var k = r.s; k < r.e && k < marks.length; k++) marks[k] = parts.join(',');
  });
  var out = [];
  marks.forEach(function (m, k) {
    if (k === 0 || m !== marks[k - 1]) out.push(k + ':' + (m || 'plain'));
  });
  return cell.text + ' [' + out.join(' ') + ']';
}

/**
 * The first difference between two week records, in words ('' when they match): every title, link,
 * class, day, due time, kept-row reason, Status, note (with its look) and staff row, in order.
 */
function pastWeekDifference_(want, got) {
  var diff = '';
  var check = function (where, a, b) {
    if (!diff && a !== b) diff = where + ': "' + String(a).slice(0, 80) + '" became "' + String(b).slice(0, 80) + '"';
  };
  var rich = function (where, a, b) { check(where, richKey_(a), richKey_(b)); };
  var rows = function (where, a, b) {
    check(where + ', number of rows', a.length, b.length);
    a.forEach(function (r, i) {
      if (diff || !b[i]) return;
      var at = where + ', row ' + (i + 1) + ' ("' + cellText_(r.title.text).slice(0, 40) + '")';
      rich(at + ', title', r.title, b[i].title);
      check(at + ', link', r.url, b[i].url);
      check(at + ', ' + (where.indexOf('By Day') === 0 ? 'class' : 'day'), r.middle, b[i].middle);
      check(at + ', due time', r.time, b[i].time);
      check(at + ', why it was kept', r.reason, b[i].reason);
      check(at + ', Status', r.status, b[i].status);
      rich(at + ', note', r.note, b[i].note);
    });
  };
  check('heading', want.heading, got.heading);
  check('count line', want.count, got.count);
  check('number of By Class tables', want.classes.length, got.classes.length);
  want.classes.forEach(function (g, i) {
    if (diff || !got.classes[i]) return;
    check('By Class table ' + (i + 1) + ', class', g.name, got.classes[i].name);
    rows('By Class, ' + g.name, g.rows, got.classes[i].rows);
  });
  check('the line naming classes with nothing due', want.nothingDue, got.nothingDue);
  SCHEDULE_WEEKDAY_NAMES.forEach(function (day) {
    var a = want.days[day];
    var b = got.days[day];
    rows('By Day, ' + day, a.rows, b.rows);
    check('By Day, ' + day + ', number of staff rows', a.staff.length, b.staff.length);
    a.staff.forEach(function (s, i) {
      if (diff || !b.staff[i]) return;
      var at = 'By Day, ' + day + ', staff row ' + (i + 1) + ' ("' + cellText_(s.cells[0].text).slice(0, 40) + '")';
      ['assignment', 'class', 'note'].forEach(function (what, c) { rich(at + ', ' + what, s.cells[c], b.staff[i].cells[c]); });
      check(at + ', Status', s.status, b.staff[i].status);
    });
  });
  return diff;
}

/**
 * Rewrites one old week in Past weeks: builds the new copy next to it under a temporary title, reads
 * the Doc back in full, and compares the copy with `week` (the record read from the old tab before).
 * Only if they match does the copy take the old tab's title and place, in one batch. Otherwise the
 * copy is deleted and the old tab stays exactly as it was. Gives back { ok, problem, read } where
 * `read` is the Doc as it is afterwards (null if unknown).
 */
function reformatPastWeekTab_(docId, docJson, pastTabId, weekTabId, week) {
  var past = findTabJsonById_(docJson, pastTabId);
  var weekTab = findTabJsonById_(docJson, weekTabId);
  var title = weekTab.tabProperties.title;
  var temp = title + UPDATING_SUFFIX;
  var at = (past.childTabs || []).map(function (t) { return t.tabProperties.tabId; }).indexOf(weekTabId);
  var stale = findTabByTitleAnywhere_(docJson, temp);
  if (stale) docsBatchUpdate_(docId, [{ deleteTab: { tabId: stale.tabProperties.tabId } }]);
  var newId = addWeekChildTab_(docId, pastTabId, temp, at + 1);
  var problem = '';
  var read = null;
  try {
    sleepDocsChunkGap_();
    batchUpdateChunked_(docId, weekTabRequestsFromBlocks_(newId, pastWeekBlocks_(week, tabContentWidth_(weekTab))));
    read = docsGet_(docId, { includeTabsContent: true });
    // The old tab once more: if someone typed in it meanwhile, the copy is out of date.
    var oldNow = readOldPastWeek_(findTabJsonById_(read, weekTabId));
    if (oldNow.state !== 'old' || pastWeekDifference_(week, oldNow.week)) {
      problem = 'the week changed while it was being rewritten (run reformatPastWeeks again)';
    } else {
      var built = readNewPastWeek_(findTabJsonById_(read, newId));
      problem = built.problem || pastWeekDifference_(week, built.week);
    }
  } catch (err) {
    problem = String((err && err.message) || err);
  }
  if (problem) {
    try {
      docsBatchUpdate_(docId, [{ deleteTab: { tabId: newId } }]);
    } catch (err2) {
      problem += '. The copy "' + temp + '" could not be deleted; the next reformatPastWeeks run deletes it';
    }
    return { ok: false, problem: problem, read: null };
  }
  docsBatchUpdate_(docId, [
    { deleteTab: { tabId: weekTabId } },
    { updateDocumentTabProperties: { tabProperties: { tabId: newId, title: title }, fields: 'title' } },
  ]);
  return { ok: true, problem: '', read: swapInRead_(read, pastTabId, weekTabId, newId, title) };
}

/**
 * The text quoted by each comment in a Doc (Drive keeps comments, not the Docs API), or null if
 * Drive didn't say. A tab that is replaced loses its comments' places in the text; they stay in
 * the Doc's comment list. Counted for the log, so it's known whether any existed.
 */
function docCommentQuotes_(docId) {
  var quotes = [];
  var page = '';
  try {
    do {
      var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(docId) +
        '/comments?pageSize=100&includeDeleted=false&fields=nextPageToken,comments(quotedFileContent(value))' +
        (page ? '&pageToken=' + encodeURIComponent(page) : '');
      var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return null;
      var body = JSON.parse(res.getContentText());
      (body.comments || []).forEach(function (c) { quotes.push(String((c.quotedFileContent && c.quotedFileContent.value) || '')); });
      page = body.nextPageToken || '';
    } while (page);
  } catch (err) {
    return null;
  }
  return quotes;
}

/** All the text in a tab, tables included. */
function tabAllText_(tabJson) {
  var parts = [];
  var paragraph = function (p) { parts.push(paragraphPlainText_(p)); };
  tabBodyContent_(tabJson).forEach(function (el) {
    if (el.paragraph) paragraph(el.paragraph);
    (el.table ? el.table.tableRows || [] : []).forEach(function (row) {
      (row.tableCells || []).forEach(function (cell) {
        (cell.content || []).forEach(function (se) { if (se.paragraph) paragraph(se.paragraph); });
      });
    });
  });
  return parts.join(' ');
}

/** How many of `quotes` quote text that is in this tab (null if the comments aren't known). */
function commentsInTab_(quotes, tabJson) {
  if (!quotes) return null;
  var squash = function (t) {
    return String(t).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  };
  var text = squash(tabAllText_(tabJson));
  return quotes.filter(function (q) { var t = squash(q); return t && text.indexOf(t) >= 0; }).length;
}

/**
 * Every week in one Doc's Past weeks, newest first: [{ title, result, detail, stats, comments }],
 * where result is 'WOULD CONVERT' or 'CONVERTED', 'ALREADY NEW', 'SKIP' or 'FAILED'. opts:
 *   dryRun:      change nothing
 *   msLeft():    how long the run may still take; it stops between weeks when that's under
 *                REFORMAT_RESERVE_MS, and says so with { stopped: true }
 *   beforeWeek(): called before a week is written (App.gs keeps the student's row held with it)
 * Copies left by a run that was cut off are deleted first (their week is still there, untouched).
 */
function reformatPastWeeksInDoc_(docId, opts) {
  var o = opts || {};
  var out = { weeks: [], stopped: false, leftovers: 0 };
  var read = docsGet_(docId, { includeTabsContent: true });
  var past = findTabByTitleAnywhere_(read, PAST_WEEKS_TITLE);
  if (!past) return out;
  var pastId = past.tabProperties.tabId;
  var isLeftover = function (t) {
    var title = t.tabProperties.title || '';
    var base = title.slice(0, -UPDATING_SUFFIX.length);
    return title.slice(-UPDATING_SUFFIX.length) === UPDATING_SUFFIX && !!findChildTabIdByTitle_(past, base);
  };
  var leftovers = (past.childTabs || []).filter(isLeftover);
  out.leftovers = leftovers.length;
  if (leftovers.length && !o.dryRun) {
    docsBatchUpdate_(docId, leftovers.map(function (t) { return { deleteTab: { tabId: t.tabProperties.tabId } }; }));
    read = docsGet_(docId, { includeTabsContent: true });
    past = findTabJsonById_(read, pastId);
  }
  var quotes = docCommentQuotes_(docId);
  var ids = (past.childTabs || []).filter(function (t) { return o.dryRun ? !isLeftover(t) : true; })
    .map(function (t) { return t.tabProperties.tabId; });
  for (var i = 0; i < ids.length; i++) {
    var tab = findTabJsonById_(read, ids[i]);
    if (!tab) continue;
    var found = readOldPastWeek_(tab);
    var entry = { title: tab.tabProperties.title, result: '', detail: '', stats: found.stats || null, comments: commentsInTab_(quotes, tab) };
    out.weeks.push(entry);
    if (found.state === 'new') { entry.result = 'ALREADY NEW'; continue; }
    if (found.state === 'skip') { entry.result = 'SKIP'; entry.detail = found.reason; continue; }
    if (o.dryRun) { entry.result = 'WOULD CONVERT'; continue; }
    if (o.msLeft && o.msLeft() < REFORMAT_RESERVE_MS) {
      out.weeks.pop();
      out.stopped = true;
      break;
    }
    if (o.beforeWeek) o.beforeWeek();
    var done = reformatPastWeekTab_(docId, read, pastId, ids[i], found.week);
    entry.result = done.ok ? 'CONVERTED' : 'FAILED';
    entry.detail = done.problem;
    read = done.read || docsGet_(docId, { includeTabsContent: true });
  }
  return out;
}

/** What one week's log line says after its result: "6 assignments, Statuses: ...". */
function pastWeekStatsText_(stats, comments) {
  var parts = [];
  if (stats) {
    var list = function (counts) {
      return Object.keys(counts).map(function (k) { return counts[k] + ' ' + k; }).join(', ') || 'none';
    };
    parts.push(stats.assignments + ' assignment' + (stats.assignments === 1 ? '' : 's'));
    parts.push('Status chips: ' + list(stats.chips));
    parts.push(stats.notes + ' row' + (stats.notes === 1 ? '' : 's') + ' with a note');
    parts.push(stats.staffRows + ' staff row' + (stats.staffRows === 1 ? '' : 's'));
    parts.push('kept rows: ' + list(stats.kept));
    parts.push(stats.priorityDropped + ' Priority label' + (stats.priorityDropped === 1 ? '' : 's') + ' dropped');
    parts.push(stats.statusWas + ' "Status was" note' + (stats.statusWas === 1 ? '' : 's'));
    if (stats.dayWas) parts.push(stats.dayWas + ' "Day was" note' + (stats.dayWas === 1 ? '' : 's'));
    if (stats.emptyRows) parts.push(stats.emptyRows + ' empty row' + (stats.emptyRows === 1 ? '' : 's') + ' left out');
  }
  parts.push('comments: ' + (comments === null || comments === undefined ? 'unknown (Drive did not list them)' : comments));
  return parts.join(' · ');
}
