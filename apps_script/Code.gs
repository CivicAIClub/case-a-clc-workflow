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
 *   Width:     every table spans the full text width (page width minus margins: 468 pt on
 *              US Letter with 1" margins). The column widths below are for 468 pt and are
 *              scaled to other page sizes, always adding up to the full width.
 *   By Class:  Assignment 128 | Day 64 | Due Time 56 | Priority 60 | Status 64 | Notes 96 (pt)
 *   By Day:    Assignment 120 | Course 80 | Due Time 56 | Priority 60 | Status 64 | Notes 88 (pt)
 *   Alignment: Assignment and Notes left; Day, Course, Due Time, Priority and Status centered;
 *              every cell vertically centered.
 *   Padding:   4 pt top and bottom, 5 pt left and right, in every cell.
 *   Text:      10 pt, #212121 in tables; assignment links #1a73e8.
 *   Header row (column names): #434343 background, bold white text, at least 22 pt tall.
 *   Class heading row (By Class) and day row (By Day): merged across the full width, bold,
 *              at least 22 pt tall; the class color (COURSE_COLORS), or #B7B7B7 for days.
 *   Assignment row: class color on the first three cells, priority color (PRIORITY_COLORS)
 *              on Priority, white Status and Notes.
 *   "No assignments due this week." row: merged, white, italic #666666.
 *   Spacing:   each heading sits directly on its table; exactly one empty paragraph after
 *              every table. The Status/Notes help line above the tables is 10 pt, #444444.
 */
var LAYOUT_BASE_WIDTH_PT = 468;
var BY_CLASS_WIDTHS = [128, 64, 56, 60, 64, 96];
var BY_DAY_WIDTHS = [120, 80, 56, 60, 64, 88];
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

var PRIORITY_COLORS = {
  Today: '#FF9999',
  Tomorrow: '#FFB347',
  'Due Soon': '#FFD966',
  'This Week': '#93C47D',
  Upcoming: '#A4C2F4',
  'Past due': '#E0E0E0', // earlier this week; the same gray as Priority in Past weeks
};

var HEADER_BG = '#434343';
var HEADER_FG = '#FFFFFF';
var DAY_ROW_BG = '#B7B7B7';

/*
 * Each week tab has:
 *   - a heading, the assignment count, and the Status/Notes help line;
 *   - "By Class": one table for EVERY class the student is enrolled in (a class with nothing due
 *     shows "No assignments due this week.");
 *   - "By Day": one table with every assignment, grouped by day.
 * Status and Notes are typed by staff and preserved across updates, keyed by the Canvas link.
 */
var BY_CLASS_HEADERS = ['Assignment', 'Day', 'Due Time', 'Priority', 'Status', 'Notes'];
var BY_DAY_HEADERS = ['Assignment', 'Course', 'Due Time', 'Priority', 'Status', 'Notes'];

/* Default Status. Staff type Not started, In progress, or Complete (plain text, no symbols). */
var STATUS_DEFAULT = 'Not started';
var STATUS_HELP_LINE =
  'Status: type Not started, In progress, or Complete. Notes: type anything you like. ' +
  'AutoPlanner never changes these two columns.';
var NO_ASSIGNMENTS_TEXT = 'No assignments due this week.';

/* White background marks columns the teacher manually edits (Status, Notes). */
var EDITABLE_BG = '#FFFFFF';
var MUTED_FG = '#666666';

/* Requests per batchUpdate call; one call counts once against the per-minute write quota. */
var BATCH_CHUNK = 200;

/** Brief pause between chunked write RPCs to stay under per-minute write quota. */
var DOCS_CHUNK_GAP_MS = 450;

function sleepDocsChunkGap_() {
  Utilities.sleep(DOCS_CHUNK_GAP_MS);
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
 * Reads leave out the content of the week tabs inside "Past weeks" (the third tab level): nothing
 * reads them, and they grow all year, so a full read would get slower and bigger every week. Their
 * titles and IDs are still there. Pass opts (e.g. { includeTabsContent: true }) for a full read.
 */
var DOCS_GET_FIELDS = 'tabs(tabProperties,documentTab,childTabs(tabProperties,documentTab,childTabs(tabProperties)))';
var docsGetFieldsRejected_ = false; // set if Google ever refuses DOCS_GET_FIELDS; then reads are full

/** Docs.Documents.get with retries when Google returns quota / rate limit errors. */
function docsGet_(docId, opts) {
  var options = opts ||
    (docsGetFieldsRejected_ ? { includeTabsContent: true } : { includeTabsContent: true, fields: DOCS_GET_FIELDS });
  var lastErr;
  var fellBack = false;
  for (var attempt = 0; attempt < 7; attempt++) {
    try {
      var doc = Docs.Documents.get(docId, options);
      // The full read worked where the shorter one didn't: use full reads for the rest of this run.
      if (fellBack) docsGetFieldsRejected_ = true;
      return doc;
    } catch (e) {
      lastErr = e;
      if (options.fields && !docsApiIsQuotaError_(e)) {
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
  if (!requests || !requests.length) return null;
  if (requests.length > 500) {
    throw new Error('docsBatchUpdate_: chunk > 500 requests');
  }
  var lastErr;
  for (var attempt = 0; attempt < 7; attempt++) {
    try {
      return Docs.Documents.batchUpdate({ requests: requests }, docId);
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
  if (!file) throw new Error(DOC_GONE_PREFIX + ' (' + docId + '): ' + lastErr);
  if (file.isTrashed()) throw new Error(DOC_GONE_PREFIX + ' (' + docId + '): it is in the trash.');
  return file;
}

/** Throws unless the Doc's Drive file sits directly in `folder`. Checked before any edit. */
function assertDocIsInFolder_(docId, folder) {
  var file = savedDocFile_(docId);
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return;
  }
  // The message never names the Doc, so it can't reveal the title of a Doc outside the folder.
  throw new Error(
    'AutoPlanner only updates Docs in the "' + folder.getName() + '" folder, and this ' +
      "student's Doc is not in it. Move the Doc back into that folder and try again."
  );
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
      DriveApp.getFileById(docId).moveTo(folder);
    }
  }

  var parentTabId = prepareParentTab_(docId, isNew);
  // Weeks that have ended move into "Past weeks" first; they are never rebuilt or read again.
  archivePastWeeks_(docId, parentTabId, Utilities.formatDate(new Date(), SCHEDULE_TIME_ZONE, 'yyyy-MM-dd'));

  var weeks = data.weeks || {};
  var weekKeys = Object.keys(weeks).sort();
  // Every class gets a table each week, in the same color every week.
  var courses = plannerCourseList_(data);
  var colorMap = buildCourseColorMap_(courses);

  if (weekKeys.length === 0) {
    rebuildHomeTab_(docId, parentTabId, data, courses, colorMap, new Date());
    return { docUrl: doc.getUrl(), documentId: docId };
  }

  // Read every current and upcoming week's Status and Notes before any tab is rebuilt, so they
  // follow an assignment that moved to another week.
  var saved = collectSavedData_(findTabJsonById_(docsGet_(docId), parentTabId));

  weekKeys.forEach(function (weekKey) {
    var weekData = weeks[weekKey];
    var tabTitle = buildWeekTabTitle_(weekKey, weekData.week_label);

    var resource = docsGet_(docId);
    var parentJson = findTabJsonById_(resource, parentTabId);
    var existingWeekTabId =
      parentJson && findChildTabIdByTitle_(parentJson, tabTitle);

    var tabId;
    if (existingWeekTabId) {
      tabId = existingWeekTabId;
    } else {
      tabId = addWeekChildTab_(
        docId,
        parentTabId,
        tabTitle,
        nextChildTabInsertIndex_(parentJson)
      );
    }

    fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData, courses, colorMap, saved);
    sleepDocsChunkGap_();
  });

  // The home tab last, so its "Open this week" link can point at this week's (new) tab.
  rebuildHomeTab_(docId, parentTabId, data, courses, colorMap, new Date());

  return { docUrl: DocumentApp.openById(docId).getUrl(), documentId: docId };
}

function buildWeekTabTitle_(weekKey, weekLabel) {
  var y = String(weekKey).split('-')[0] || '';
  var label = weekLabel || weekKey;
  var t = 'Week of ' + label + ', ' + y;
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

/** Rename default root tab on first create; otherwise locate CLC Planner or first root tab. */
function prepareParentTab_(docId, isNew) {
  var resource = docsGet_(docId);
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
  if (named) return named;

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
// A past week's Priority colors no longer mean anything, so its Priority cells turn this gray.
var PAST_PRIORITY_BG = '#E0E0E0';

/** "Week of Oct 5 – Oct 11, 2026" gives '2026-10-05' (its Monday); any other tab title gives null. */
function weekKeyFromTabTitle_(title) {
  var m = /^Week of ([A-Z][a-z]{2}) (\d{1,2}) \u2013 [A-Z][a-z]{2} \d{1,2}, (\d{4})$/.exec(String(title || ''));
  if (!m) return null;
  var month = SCHEDULE_MONTH_NAMES.indexOf(m[1]);
  if (month === -1) return null;
  return m[3] + '-' + ('0' + (month + 1)).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

/**
 * Moves every week tab that has ended (its Sunday is before `today`, New York time) into the
 * "Past weeks" tab, newest first. Creates "Past weeks" for the first past week. Moving the tab is
 * the only change: a past week's content is never read, edited, rebuilt or deleted.
 * Returns how many tabs moved.
 */
function archivePastWeeks_(docId, parentTabId, today) {
  var parent = findTabJsonById_(docsGet_(docId), parentTabId);
  var ended = endedWeekTabs_(parent, today);
  if (!ended.length) return 0;
  var pastId = findChildTabIdByTitle_(parent, PAST_WEEKS_TITLE);
  if (!pastId) {
    pastId = addWeekChildTab_(docId, parentTabId, PAST_WEEKS_TITLE, parent.childTabs.length);
    docsBatchUpdate_(docId, [{ insertText: { text: PAST_WEEKS_LINE, location: { tabId: pastId, index: 1 } } }]);
  }
  // Gray each week's Priority cells, then move it. Nothing in it changes after this. The gray is
  // only a look, so if Google refuses it the week still moves.
  var gray = [];
  ended.forEach(function (w) {
    var tab = parent.childTabs.filter(function (t) { return t.tabProperties.tabId === w.id; })[0];
    gray = gray.concat(pastPriorityGrayRequests_(tab));
  });
  try {
    docsBatchUpdate_(docId, gray);
  } catch (err) {
    console.warn('Past weeks: Priority not grayed: ' + err);
  }
  docsBatchUpdate_(docId, archiveMoveRequests_(ended, pastId));
  return ended.length;
}

/**
 * Requests that turn one ended week's Priority cells gray (PAST_PRIORITY_BG), keeping their text.
 * Only cells under a "Priority" heading that hold a priority are changed: class names, day rows,
 * "No assignments" rows, Status and Notes are never touched.
 */
function pastPriorityGrayRequests_(tabJson) {
  var reqs = [];
  if (!tabJson || !tabJson.documentTab || !tabJson.tabProperties) return reqs;
  var tabId = tabJson.tabProperties.tabId;
  (tabJson.documentTab.body.content || []).forEach(function (el) {
    if (!el.table) return;
    var rows = el.table.tableRows || [];
    var header = -1;
    var col = -1;
    for (var r = 0; r < rows.length && col < 0; r++) {
      var cells = rows[r].tableCells || [];
      for (var c = 0; c < cells.length; c++) {
        if (getCellText_(cells[c]) === 'Priority') { header = r; col = c; break; }
      }
    }
    if (col < 0) return;
    // Neighbouring priority rows share one request.
    var start = -1;
    var flush = function (end) {
      if (start < 0) return;
      reqs.push(cellStyleRequest_(tabId, toDocIndex_(el.startIndex), start, col, end - start + 1, 1,
        { backgroundColor: optionalColorFromHex_(PAST_PRIORITY_BG) }, 'backgroundColor'));
      start = -1;
    };
    for (var i = header + 1; i < rows.length; i++) {
      var rowCells = rows[i].tableCells || [];
      var hasPriority = rowCells.length > col && getCellText_(rowCells[col]) !== '';
      if (hasPriority && start < 0) start = i;
      if (!hasPriority) flush(i - 1);
    }
    flush(rows.length - 1);
  });
  return reqs;
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
 * Status and Notes from every current and upcoming week tab, by Canvas link, so they follow an
 * assignment whose due date moves to another week. "Past weeks" is never read. When a link has
 * values in two weeks, a typed Status beats the default, and between two typed values the most
 * recent week's wins (Notes the same way).
 */
function collectSavedData_(parentTabJson) {
  var result = { notes: {}, status: {} };
  ((parentTabJson && parentTabJson.childTabs) || []).map(function (t) {
    return { key: weekKeyFromTabTitle_((t.tabProperties || {}).title), tab: t };
  }).filter(function (w) {
    return w.key;
  }).sort(function (a, b) {
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }).forEach(function (w) {
    var d = readExistingDataFromTab_(w.tab);
    Object.keys(d.status).forEach(function (url) {
      var cur = result.status[url];
      if (!cur || cur === STATUS_DEFAULT || d.status[url] !== STATUS_DEFAULT) result.status[url] = d.status[url];
    });
    Object.keys(d.notes).forEach(function (url) { result.notes[url] = d.notes[url]; });
  });
  return result;
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
//   PRIORITY COLORS (Heading 4): a swatch for each priority with its rule
//   Footer (9 pt, #666666)
var HOME_SUBTITLE = 'CLC PLANNER · SUPPORTED STUDY HALL';
var HOME_FOOTER = 'Built by the Pomfret Civic AI Club · Questions: Cayden Auyang or Luke Ryan';
var HOME_HOW_LINES = [
  'Each week has its own tab in the left sidebar.',
  'Status: type Not started, In progress, or Complete. Notes: type anything. AutoPlanner never changes these two columns.',
  'It updates every day at about 7 pm and midnight. Edits anywhere else get replaced.',
];
// The priority rules from schedulePriority_ in Canvas.gs (days until the due date).
var HOME_PRIORITY_RULES = [
  ['Today', 'Today'],
  ['Tomorrow', 'Tomorrow'],
  ['Due Soon', 'Due Soon, 2–3 days'],
  ['This Week', 'This Week, 4–7 days'],
  ['Upcoming', 'Upcoming, 8+ days'],
];
var HOME_CLASS_HEADERS = ['Class', 'This week', 'Next due'];
var HOME_CLASS_WIDTHS = [288, 80, 100];
var HOME_RULE_FG = '#BFBFBF'; // thin gray rules (the text color at about 25% on white)
var HOME_SWATCH = '   '; // three no-break spaces, shaded with the priority color

/** Rebuilds the home tab. Runs after the week tabs, so "Open this week" can link to its tab. */
function rebuildHomeTab_(docId, parentTabId, data, courses, colorMap, now) {
  var doc = docsGet_(docId);
  var tab = findTabJsonById_(doc, parentTabId);
  if (!tab || !tab.documentTab || !tab.documentTab.body) return;
  var summary = homeSummary_(data, courses, now || new Date());
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
  var a = [summary.name, HOME_SUBTITLE, 'Last updated ' + summary.updated, summary.heading, summaryLine];
  if (weekTabId) a.push(summary.weekend ? 'Open the coming week →' : 'Open this week →');
  if (!summary.rows.length) a.push('No current classes found in Canvas.');
  var aStart = insertLines(1, a);
  var lineEnd = function (i) { return aStart[i] + a[i].length; };
  para(aStart[0], lineEnd(0) + 1, { namedStyleType: 'HEADING_1' }, 'namedStyleType');
  text(aStart[1], lineEnd(1), { fontSize: pt(9), foregroundColor: color(MUTED_FG), bold: true }, 'fontSize,foregroundColor,bold');
  text(aStart[2], lineEnd(2), { fontSize: pt(10), foregroundColor: color(HELP_FG) }, 'fontSize,foregroundColor');
  para(aStart[3], lineEnd(3) + 1, { namedStyleType: 'HEADING_4', borderTop: rule, spaceAbove: pt(18) }, 'namedStyleType,borderTop,spaceAbove');
  text(aStart[4], lineEnd(4), { foregroundColor: color(DATA_FG) }, 'foregroundColor');
  if (weekTabId) {
    text(aStart[5], lineEnd(5), { link: { tabId: weekTabId }, foregroundColor: color(LINK_FG) }, 'link,foregroundColor');
    para(aStart[5], lineEnd(5) + 1, { spaceBelow: pt(8) }, 'spaceBelow');
  } else {
    para(aStart[4], lineEnd(4) + 1, { spaceBelow: pt(8) }, 'spaceBelow');
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

  // 3. How this Doc works, priority colors, footer: written into the paragraph after the table.
  var legend = [];
  HOME_PRIORITY_RULES.forEach(function (r, i) { legend.push((i ? '   ' : '') + HOME_SWATCH + ' ' + r[1]); });
  var b = ['HOW THIS DOC WORKS'].concat(HOME_HOW_LINES, ['PRIORITY COLORS', legend.join(''), HOME_FOOTER]);
  var bStart = insertLines(next, b);
  var bEnd = function (i) { return bStart[i] + b[i].length; };
  para(bStart[0], bEnd(0) + 1, { namedStyleType: 'HEADING_4', borderTop: rule, spaceAbove: pt(18) }, 'namedStyleType,borderTop,spaceAbove');
  reqs.push({ createParagraphBullets: { range: range(bStart[1], bEnd(3) + 1), bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } });
  text(bStart[1], bEnd(3), { foregroundColor: color(DATA_FG) }, 'foregroundColor');
  para(bStart[4], bEnd(4) + 1, { namedStyleType: 'HEADING_4' }, 'namedStyleType');
  text(bStart[5], bEnd(5), { fontSize: pt(10), foregroundColor: color(DATA_FG) }, 'fontSize,foregroundColor');
  var pos = bStart[5];
  HOME_PRIORITY_RULES.forEach(function (r, i) {
    if (i) pos += 3;
    text(pos, pos + HOME_SWATCH.length, { backgroundColor: color(PRIORITY_COLORS[r[0]]) }, 'backgroundColor');
    pos += HOME_SWATCH.length + 1 + r[1].length;
  });
  para(bStart[6], bEnd(6) + 1, { spaceAbove: pt(28) }, 'spaceAbove');
  text(bStart[6], bEnd(6), { fontSize: pt(9), foregroundColor: color(MUTED_FG) }, 'fontSize,foregroundColor');
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
  // Class name on its class color; the two number columns centered.
  for (r = 0; r < R; r++) {
    reqs.push({ updateParagraphStyle: { range: range(start[r][1], cellEnd(r, C - 1) + 1), paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } });
    if (r > 0) {
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 0, 1, 1, { backgroundColor: optionalColorFromHex_(colorMap[rows[r - 1].course] || '#EAEDED') }, 'backgroundColor'));
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 1, 1, 2, { backgroundColor: optionalColorFromHex_(EDITABLE_BG) }, 'backgroundColor'));
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
  var plain = tabBodyPlainText_(tabJson.documentTab.body).replace(/\s/g, '');
  return plain.length > 60;
}

/**
 * Writes one week tab from scratch: a heading, the help line, one table per class, and the By Day
 * table. The tab has just been created or cleared, so it holds one empty paragraph at index 1.
 */
function fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData, courses, colorMap, saved) {
  var docProbe = docsGet_(docId);
  var tabProbe = findTabJsonById_(docProbe, tabId);
  // Status and Notes from all current and upcoming weeks (see collectSavedData_), or this tab's own.
  var savedData = saved || readExistingDataFromTab_(tabProbe);

  var parentJson = findTabJsonById_(docProbe, parentTabId);
  if (tabBodyHasHeavyContent_(tabProbe) || !clearTabBodyDocsApi_(docId, tabId)) {
    // Write a new tab just above the old one, and delete the old one only once the new one is
    // complete: if an update stops halfway, the old tab, with its Status and Notes, is still there.
    var kids = parentJson.childTabs || [];
    var at = kids.map(function (t) { return t.tabProperties.tabId; }).indexOf(tabId);
    tabId = addWeekChildTab_(docId, parentTabId, tabTitle, at >= 0 ? at : nextChildTabInsertIndex_(parentJson));
    sleepDocsChunkGap_();
  }

  var requests = buildWeekTabRequests_(
    tabId, weekKey, weekData, courses, colorMap, savedData, tabContentWidth_(tabProbe)
  );
  batchUpdateChunked_(docId, requests);

  // The new tab is complete: remove the old one, and any copy an earlier stopped update left.
  var leftovers = (parentJson.childTabs || []).filter(function (t) {
    return t.tabProperties.title === tabTitle && t.tabProperties.tabId !== tabId;
  });
  if (leftovers.length) {
    docsBatchUpdate_(docId, leftovers.map(function (t) { return { deleteTab: { tabId: t.tabProperties.tabId } }; }));
  }
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
 * written in a few batchUpdate calls. Positions follow from how Docs numbers a fresh table
 * (checked against the live API): a table inserted at index i starts at i + 1, cell (r, c) holds
 * an empty paragraph at i + 4 + r*(2C + 1) + 2c, and the empty paragraph Docs adds after the
 * table sits at i + 3 + R*(2C + 1). Merging cells doesn't move any index.
 */
function buildWeekTabRequests_(tabId, weekKey, weekData, courses, colorMap, saved, contentWidth) {
  var reqs = [];
  var days = weekData.days || [];
  var range = function (s, e) { return { tabId: tabId, startIndex: s, endIndex: e }; };
  var named = function (s, e, type) {
    reqs.push({ updateParagraphStyle: { range: range(s, e), paragraphStyle: { namedStyleType: type }, fields: 'namedStyleType' } });
  };

  // 1. The text above the tables, typed into the tab's empty paragraph at index 1.
  var lines = [
    'Week of ' + (weekData.week_label || weekKey),
    'Assignments in this week: ' + countAssignmentsInWeek_(days),
    STATUS_HELP_LINE,
    'By Class',
  ];
  reqs.push({ insertText: { text: lines.join('\n'), location: { tabId: tabId, index: 1 } } });
  var starts = [];
  var pos = 1;
  lines.forEach(function (line) { starts.push(pos); pos += line.length + 1; });
  named(starts[0], starts[0] + lines[0].length + 1, 'HEADING_2');
  named(starts[1], starts[1] + lines[1].length + 1, 'NORMAL_TEXT');
  named(starts[2], starts[2] + lines[2].length + 1, 'NORMAL_TEXT');
  named(starts[3], starts[3] + lines[3].length + 1, 'HEADING_3');
  reqs.push(textStyleRequest_(range(starts[1], starts[1] + lines[1].length), { italic: true, foregroundColor: optionalColorFromHex_(DATA_FG) }, 'italic,foregroundColor'));
  reqs.push(textStyleRequest_(range(starts[2], starts[2] + lines[2].length), { fontSize: { magnitude: HELP_FONT_PT, unit: 'PT' }, foregroundColor: optionalColorFromHex_(HELP_FG) }, 'fontSize,foregroundColor'));
  var at = pos - 1; // the "By Class" heading's newline: the first table goes right under it

  // 2. One table per class, A to Z. Each is followed by exactly one empty paragraph, and the
  //    next table is inserted at that paragraph, so the spacing is the same after every table.
  var classWidths = scaledColumnWidths_(BY_CLASS_WIDTHS, contentWidth);
  var groups = groupAssignmentsByCourse_(days, courses);
  groups.forEach(function (g) {
    var color = colorMap[g.course] || '#EAEDED';
    var rows = [
      { kind: 'title', cells: [g.course], bg: color },
      { kind: 'header', cells: BY_CLASS_HEADERS.slice() },
    ];
    if (!g.assignments.length) rows.push({ kind: 'empty', cells: [NO_ASSIGNMENTS_TEXT] });
    g.assignments.forEach(function (a) {
      rows.push(assignmentRow_(a, a.day, color, saved));
    });
    at = appendTable_(reqs, tabId, at, rows, classWidths);
  });

  // 3. "By Day": a spacer paragraph, the heading, then one table grouped by day.
  reqs.push({ insertText: { text: '\nBy Day', location: { tabId: tabId, index: at } } });
  named(at + 1, at + 8, 'HEADING_3');
  at += 7;
  var dayRows = [{ kind: 'header', cells: BY_DAY_HEADERS.slice() }];
  flattenAndGroupByDay_(days).forEach(function (g) {
    dayRows.push({ kind: 'group', cells: [g.day], bg: DAY_ROW_BG });
    g.assignments.forEach(function (a) {
      dayRows.push(assignmentRow_(a, a.course, colorMap[a.course] || '#EAEDED', saved));
    });
  });
  appendTable_(reqs, tabId, at, dayRows, scaledColumnWidths_(BY_DAY_WIDTHS, contentWidth));
  return reqs;
}

/** One assignment's row. `middle` is the Day (By Class) or the Course (By Day). */
function assignmentRow_(a, middle, color, saved) {
  var url = a.url || '';
  var status = (url && saved.status[url]) || STATUS_DEFAULT;
  var note = (url && saved.notes[url]) || '';
  return {
    kind: 'item',
    cells: [a.assignment, middle, a.due_time, a.priority, status, note],
    bg: color,
    priorityBg: PRIORITY_COLORS[a.priority] || '#EEEEEE',
    url: url,
  };
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
 * Adds one 6-column table at index `at` (the newline of the paragraph it goes under), fills it,
 * styles it, and returns the index of the empty paragraph Docs puts after it.
 * Row kinds: 'title' (class name), 'group' (day name), 'header' (column names), 'empty'
 * ("No assignments due this week."), 'item' (an assignment).
 */
function appendTable_(reqs, tabId, at, rows, widths) {
  var C = 6;
  var R = rows.length;
  var tableStart = at + 1;
  var emptyAfter = at + 3 + R * (2 * C + 1);
  var texts = rows.map(function (row) {
    var t = [];
    for (var c = 0; c < C; c++) t.push(cellText_(row.cells[c]));
    return t;
  });
  var emptyIndex = function (r, c) { return at + 4 + r * (2 * C + 1) + 2 * c; };

  reqs.push({ insertTable: { rows: R, columns: C, location: { tabId: tabId, index: at } } });
  // The new paragraph after the table copies the heading above it; make it plain text.
  reqs.push({ updateParagraphStyle: { range: { tabId: tabId, startIndex: emptyAfter, endIndex: emptyAfter + 1 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } });

  // Fill from the last cell to the first, so each insert only shifts cells already filled.
  for (var r = R - 1; r >= 0; r--) {
    for (var c = C - 1; c >= 0; c--) {
      if (texts[r][c]) reqs.push({ insertText: { text: texts[r][c], location: { tabId: tabId, index: emptyIndex(r, c) } } });
    }
  }

  // Where each cell's text starts once everything before it is filled.
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
  var range = function (s, e) { return { tabId: tabId, startIndex: s, endIndex: e }; };
  var color = function (hex) { return optionalColorFromHex_(hex); };

  // Whole table: padding, vertical centering, column widths, font size and text color.
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
    var rowText = range(start[r][0], cellEnd(r, C - 1));
    var centerCols = range(start[r][1], cellEnd(r, 4) + 1);
    if (row.kind === 'title' || row.kind === 'group' || row.kind === 'empty') {
      // A full-width row: merge it, color it, style its text.
      var bg = row.kind === 'empty' ? EDITABLE_BG : row.bg;
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 0, 1, C, { backgroundColor: color(bg) }, 'backgroundColor'));
      if (texts[r][0]) {
        reqs.push(textStyleRequest_(range(start[r][0], cellEnd(r, 0)),
          row.kind === 'empty' ? { italic: true, foregroundColor: color(MUTED_FG) } : { bold: true },
          row.kind === 'empty' ? 'italic,foregroundColor' : 'bold'));
      }
      reqs.push({
        mergeTableCells: {
          tableRange: {
            tableCellLocation: { tableStartLocation: { tabId: tabId, index: tableStart }, rowIndex: r, columnIndex: 0 },
            rowSpan: 1,
            columnSpan: C,
          },
        },
      });
      if (row.kind !== 'empty') tallRows.push(r);
    } else if (row.kind === 'header') {
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 0, 1, C, { backgroundColor: color(HEADER_BG) }, 'backgroundColor'));
      reqs.push(textStyleRequest_(rowText, { bold: true, foregroundColor: color(HEADER_FG) }, 'bold,foregroundColor'));
      reqs.push({ updateParagraphStyle: { range: centerCols, paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } });
      tallRows.push(r);
    } else {
      // Assignment: class color on the first three cells, priority color, white Status and Notes.
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 0, 1, 3, { backgroundColor: color(row.bg) }, 'backgroundColor'));
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 3, 1, 1, { backgroundColor: color(row.priorityBg) }, 'backgroundColor'));
      reqs.push(cellStyleRequest_(tabId, tableStart, r, 4, 1, 2, { backgroundColor: color(EDITABLE_BG) }, 'backgroundColor'));
      reqs.push({ updateParagraphStyle: { range: centerCols, paragraphStyle: { alignment: 'CENTER' }, fields: 'alignment' } });
      if (row.url && texts[r][0]) {
        reqs.push(textStyleRequest_(range(start[r][0], cellEnd(r, 0)), {
          link: { url: row.url },
          foregroundColor: color(LINK_FG),
        }, 'link,foregroundColor'));
      }
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
function buildCourseColorMap_(courseNames) {
  var names = courseNames.slice().sort(function (a, b) {
    return a.localeCompare(b);
  });

  var map = {};
  var usedIndex = {};

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
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

/** Old Docs used "⬜ Not started", "🟡 In progress", "✅ Complete": keep the words, drop the symbols. */
function normalizeStatus_(text) {
  var s = String(text || '').replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim();
  var known = { 'not started': 'Not started', 'in progress': 'In progress', complete: 'Complete' };
  return known[s.toLowerCase()] || s;
}

/**
 * Read all editable data (Notes, Status) from EVERY table in the tab, keyed by Canvas URL.
 * Every assignment appears twice (its class table and By Day). An untouched default in one table
 * must not overwrite a Status the teacher typed in the other.
 *
 * Column conventions (Notes = last column, Status = second-to-last):
 *   - Old 5-col table (Notes only): notes col = 4, no status
 *   - 6-col tables (Status + Notes): status col = 4, notes col = 5
 * Tables with < 5 columns are ignored. Rows without a Canvas link (headings) are skipped.
 */
function readExistingDataFromTab_(tabJson) {
  var result = { notes: {}, status: {} };
  try {
    if (!tabJson || !tabJson.documentTab) return result;
    var content = tabJson.documentTab.body.content || [];
    content.forEach(function (el) {
      if (!el.table) return;
      var tableStruct = el.table;
      var numCols = tableStruct.columns;
      if (numCols < 5) return;
      var notesColIdx = numCols - 1;
      var statusColIdx = numCols >= 6 ? numCols - 2 : -1;
      (tableStruct.tableRows || []).forEach(function (row) {
        var cells = row.tableCells || [];
        if (cells.length < numCols) return;
        var url = getCellLinkUrl_(cells[0]);
        if (!url) return; // header / heading row — no Canvas link
        var note = getCellText_(cells[notesColIdx]);
        if (note) result.notes[url] = note;
        if (statusColIdx >= 0) {
          var status = normalizeStatus_(getCellText_(cells[statusColIdx]));
          if (status && (status !== STATUS_DEFAULT || !result.status[url])) {
            result.status[url] = status;
          }
        }
      });
    });
  } catch (e) {}
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
 * Group assignments by day. Preserves the input day order (already chronological from the backend).
 * Within each day, sorts by due time (as a real time) then assignment title.
 * Skips days with zero assignments to keep the table tight.
 */
function flattenAndGroupByDay_(days) {
  var groups = [];
  (days || []).forEach(function (dayObj) {
    var assignments = (dayObj.assignments || []).slice();
    if (!assignments.length) return;
    assignments.sort(function (a, b) {
      // Compare real times: as text, "10:25 AM" would come before "8:30 AM".
      var ta = scheduleTimeToMinutes_(a.due_time), tb = scheduleTimeToMinutes_(b.due_time);
      if (ta !== tb) return ta - tb;
      return String(a.assignment || '').toLowerCase() < String(b.assignment || '').toLowerCase() ? -1 : 1;
    });
    groups.push({ day: dayObj.day || '', assignments: assignments });
  });
  return groups;
}
