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

/** Docs.Documents.get with retries when Google returns quota / rate limit errors. */
function docsGet_(docId, opts) {
  var options = opts || { includeTabsContent: true };
  var lastErr;
  for (var attempt = 0; attempt < 7; attempt++) {
    try {
      return Docs.Documents.get(docId, options);
    } catch (e) {
      lastErr = e;
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
  try {
    return DriveApp.getFolderById(id);
  } catch (err) {
    throw new Error(
      'DOCS_FOLDER_ID is set, but this account cannot open that Drive folder: ' + err
    );
  }
}

/** Throws unless the Doc's Drive file sits directly in `folder`. Checked before any edit. */
function assertDocIsInFolder_(docId, folder) {
  var file;
  try {
    file = DriveApp.getFileById(docId);
  } catch (err) {
    throw new Error('Could not open the saved Google Doc (' + docId + '): ' + err);
  }
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
  seedParentTabHomeDocsApi_(docId, parentTabId);

  var weeks = data.weeks || {};
  var weekKeys = Object.keys(weeks).sort();
  // Every class gets a table each week, in the same color every week.
  var courses = plannerCourseList_(data);
  var colorMap = buildCourseColorMap_(courses);

  if (weekKeys.length === 0) {
    return { docUrl: doc.getUrl(), documentId: docId };
  }

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

    fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData, courses, colorMap);
    sleepDocsChunkGap_();
  });

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

/** Next sibling index under the parent tab (append = chronological order top → bottom). */
function nextChildTabInsertIndex_(parentTabJson) {
  return (parentTabJson && parentTabJson.childTabs
    ? parentTabJson.childTabs.length
    : 0);
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

/**
 * The CLC Planner home tab: title, the Status/Notes help line, and how the tabs work. In an older
 * Doc that already has text there, only the help line is added (once), right under the title.
 */
function seedParentTabHomeDocsApi_(docId, parentTabId) {
  var tab = findTabJsonById_(docsGet_(docId), parentTabId);
  if (!tab || !tab.documentTab || !tab.documentTab.body) return;
  var body = tab.documentTab.body;
  var plain = tabBodyPlainText_(body);
  var range = function (s, e) { return { tabId: parentTabId, startIndex: s, endIndex: e }; };
  var named = function (s, e, type) {
    return { updateParagraphStyle: { range: range(s, e), paragraphStyle: { namedStyleType: type }, fields: 'namedStyleType' } };
  };

  if (plain.replace(/\s/g, '').length === 0) {
    var lines = [
      PARENT_TAB_TITLE,
      STATUS_HELP_LINE,
      'Open nested tabs under this document tab for each week (Document tabs sidebar). ' +
        'Re-running AutoPlanner refreshes an existing week tab or adds a new one.',
    ];
    var starts = [];
    var pos = 1;
    lines.forEach(function (l) { starts.push(pos); pos += l.length + 1; });
    docsBatchUpdate_(docId, [
      { insertText: { text: lines.join('\n') + '\n', location: { tabId: parentTabId, index: 1 } } },
      named(starts[0], starts[0] + lines[0].length + 1, 'HEADING_1'),
      named(starts[1], starts[1] + lines[1].length + 1, 'NORMAL_TEXT'),
      named(starts[2], starts[2] + lines[2].length + 1, 'NORMAL_TEXT'),
    ]);
    return;
  }
  if (plain.indexOf(STATUS_HELP_LINE) !== -1) return;

  // Put the line on its own paragraph right after the title (or at the very top if there is none).
  var title = findParagraphByText_(tab, PARENT_TAB_TITLE);
  var bounds = title ? structuralContentBounds_(title) : null;
  var at = bounds ? bounds.end - 1 : 1;
  var text = bounds ? '\n' + STATUS_HELP_LINE : STATUS_HELP_LINE + '\n';
  var lineStart = bounds ? at + 1 : 1;
  docsBatchUpdate_(docId, [
    { insertText: { text: text, location: { tabId: parentTabId, index: at } } },
    named(lineStart, lineStart + STATUS_HELP_LINE.length + 1, 'NORMAL_TEXT'),
  ]);
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
function fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData, courses, colorMap) {
  var docProbe = docsGet_(docId);
  var tabProbe = findTabJsonById_(docProbe, tabId);
  var savedData = readExistingDataFromTab_(tabProbe);

  if (tabBodyHasHeavyContent_(tabProbe) || !clearTabBodyDocsApi_(docId, tabId)) {
    docsBatchUpdate_(docId, [{ deleteTab: { tabId: tabId } }]);
    var parentJson = findTabJsonById_(docsGet_(docId), parentTabId);
    tabId = addWeekChildTab_(docId, parentTabId, tabTitle, nextChildTabInsertIndex_(parentJson));
    sleepDocsChunkGap_();
  }

  var requests = buildWeekTabRequests_(
    tabId, weekKey, weekData, courses, colorMap, savedData, tabContentWidth_(tabProbe)
  );
  batchUpdateChunked_(docId, requests);
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
