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

/**
 * Each week tab now contains TWO stacked tables:
 *   - "By Class": assignments grouped by course, with a Day column for context.
 *   - "By Day":   assignments grouped by day, with a Course column for context.
 * Both tables include Status (manually edited, default ⬜ Not started) and Notes.
 * Status + Notes are preserved across re-runs by Canvas assignment URL.
 */
var BY_CLASS_HEADERS = ['Assignment', 'Day', 'Due Time', 'Priority', 'Status', 'Notes'];
var BY_CLASS_WIDTHS  = [160, 50, 55, 65, 80, 100];

var BY_DAY_HEADERS   = ['Assignment', 'Course', 'Due Time', 'Priority', 'Status', 'Notes'];
var BY_DAY_WIDTHS    = [160, 95, 55, 65, 80, 100];

/* Default value for new Status cells. Teacher edits to "🟡 In progress" or "✅ Complete". */
var STATUS_DEFAULT = '⬜ Not started';

/* White background marks columns the teacher manually edits (Status, Notes). */
var EDITABLE_BG = '#FFFFFF';

var BATCH_CHUNK = 45;

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
 * Single batchUpdate (≤50 requests per Google Docs API limit).
 * @returns {*} API reply (e.g. for addDocumentTab replies)
 */
function docsBatchUpdate_(docId, requests) {
  if (!requests || !requests.length) return null;
  if (requests.length > 50) {
    throw new Error('docsBatchUpdate_: chunk > 50 requests');
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

    fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData);
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

/** One-time helper text on the parent tab (Docs API only). */
function seedParentTabHomeDocsApi_(docId, parentTabId) {
  var doc = docsGet_(docId);
  var tab = findTabJsonById_(doc, parentTabId);
  if (!tab || !tab.documentTab || !tab.documentTab.body) return;
  if (tabBodyPlainText_(tab.documentTab.body).replace(/\s/g, '').length > 0) return;

  docsBatchUpdate_(docId, [
    {
      insertText: {
        text: PARENT_TAB_TITLE + '\n',
        endOfSegmentLocation: { tabId: parentTabId },
      },
    },
    {
      insertText: {
        text:
          'Open nested tabs under this document tab for each week (Document tabs sidebar). ' +
          'Re-running AutoPlanner refreshes an existing week tab or adds a new one.\n',
        endOfSegmentLocation: { tabId: parentTabId },
      },
    },
    {
      insertText: {
        text: '\n',
        endOfSegmentLocation: { tabId: parentTabId },
      },
    },
  ]);

  doc = docsGet_(docId);
  tab = findTabJsonById_(doc, parentTabId);
  var bodyContent = tab.documentTab.body.content || [];
  var p0 = bodyContent[0];
  var h1bounds = p0 && p0.paragraph ? structuralContentBounds_(p0) : null;
  if (h1bounds) {
    docsBatchUpdate_(docId, [
      {
        updateParagraphStyle: {
          range: {
            segmentId: '',
            tabId: parentTabId,
            startIndex: h1bounds.start,
            endIndex: h1bounds.end,
          },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType',
        },
      },
    ]);
  }
}

function findLastTableStructInTab_(docJson, tabId) {
  var tab = findTabJsonById_(docJson, tabId);
  if (!tab || !tab.documentTab || !tab.documentTab.body) return null;
  var content = tab.documentTab.body.content || [];
  for (var i = content.length - 1; i >= 0; i--) {
    if (content[i].table) {
      var si = toDocIndex_(content[i].startIndex);
      if (!isFiniteNumber_(si)) return null;
      return { startIndex: si, table: content[i].table };
    }
  }
  return null;
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

function fillWeekTabDocsApi_(docId, parentTabId, tabTitle, tabId, weekKey, weekData) {
  var docProbe = docsGet_(docId);
  var tabProbe = findTabJsonById_(docProbe, tabId);
  var savedData = readExistingDataFromTab_(tabProbe);

  if (tabBodyHasHeavyContent_(tabProbe)) {
    docsBatchUpdate_(docId, [{ deleteTab: { tabId: tabId } }]);
    var docAfterHeavy = docsGet_(docId);
    var pjHeavy = findTabJsonById_(docAfterHeavy, parentTabId);
    tabId = addWeekChildTab_(
      docId,
      parentTabId,
      tabTitle,
      nextChildTabInsertIndex_(pjHeavy)
    );
    sleepDocsChunkGap_();
  } else {
    var cleared = clearTabBodyDocsApi_(docId, tabId);
    if (!cleared) {
      docsBatchUpdate_(docId, [{ deleteTab: { tabId: tabId } }]);
      var docAfterDel = docsGet_(docId);
      var pjAfterDel = findTabJsonById_(docAfterDel, parentTabId);
      tabId = addWeekChildTab_(
        docId,
        parentTabId,
        tabTitle,
        nextChildTabInsertIndex_(pjAfterDel)
      );
      sleepDocsChunkGap_();
    }
  }

  var days = weekData.days || [];
  var weekHeading = 'Week of ' + (weekData.week_label || weekKey);
  var subtitle = 'Assignments in this week: ' + countAssignmentsInWeek_(days);

  docsBatchUpdate_(docId, [
    { insertText: { text: weekHeading + '\n', endOfSegmentLocation: { tabId: tabId } } },
    { insertText: { text: subtitle + '\n',    endOfSegmentLocation: { tabId: tabId } } },
    { insertText: { text: '\n',                endOfSegmentLocation: { tabId: tabId } } },
  ]);

  // Style week heading + subtitle. The tab was just cleared/created, so the first two
  // paragraphs ARE the ones we just inserted.
  var doc = docsGet_(docId);
  var tab = findTabJsonById_(doc, tabId);
  var paras = tab.documentTab.body.content || [];
  var pTitle = paras[0];
  var pSub = paras[1];
  var styleReqs = [];
  var titleBounds = pTitle && pTitle.paragraph ? structuralContentBounds_(pTitle) : null;
  var subBounds   = pSub   && pSub.paragraph   ? structuralContentBounds_(pSub)   : null;
  if (titleBounds) {
    styleReqs.push({
      updateParagraphStyle: {
        range: { segmentId: '', tabId: tabId, startIndex: titleBounds.start, endIndex: titleBounds.end },
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType',
      },
    });
  }
  if (subBounds) {
    styleReqs.push({
      updateTextStyle: {
        range: { segmentId: '', tabId: tabId, startIndex: subBounds.start, endIndex: subBounds.end },
        textStyle: { italic: true, foregroundColor: optionalColorFromHex_(DATA_FG) },
        fields: 'italic,foregroundColor',
      },
    });
  }
  if (styleReqs.length) docsBatchUpdate_(docId, styleReqs);

  if (countAssignmentsInWeek_(days) === 0) return;

  var courseColorMap = buildCourseColorMap_(days);

  // Two stacked tables: By Class first, then By Day.
  // Both share courseColorMap so the same course is the same color in both views.
  writeTableSection_(docId, tabId, 'By Class', 'class', days, courseColorMap, savedData);
  writeTableSection_(docId, tabId, 'By Day',   'day',   days, courseColorMap, savedData);
}

/**
 * Append a section heading + table to a week tab.
 *
 * @param mode 'class' (group by course, Day in col 1) or 'day' (group by day, Course in col 1).
 * @param savedData {notes: {url:text}, status: {url:text}} preserved from previous run.
 *
 * Layout invariants for both modes:
 *   col 0: Assignment (link)
 *   col 1: Day (class mode) or Course (day mode)
 *   col 2: Due Time
 *   col 3: Priority
 *   col 4: Status (white bg, editable, defaults to STATUS_DEFAULT)
 *   col 5: Notes  (white bg, editable, blank by default)
 */
function writeTableSection_(docId, tabId, sectionTitle, mode, days, courseColorMap, savedData) {
  var headers = (mode === 'class') ? BY_CLASS_HEADERS : BY_DAY_HEADERS;
  var widths  = (mode === 'class') ? BY_CLASS_WIDTHS  : BY_DAY_WIDTHS;
  var groups  = (mode === 'class') ? flattenAndGroupByCourse_(days) : flattenAndGroupByDay_(days);

  // 1. Insert section heading paragraph.
  docsBatchUpdate_(docId, [
    { insertText: { text: sectionTitle + '\n', endOfSegmentLocation: { tabId: tabId } } },
  ]);

  // 2. Style the section heading as HEADING_3. Find by text since it's now embedded mid-tab.
  var doc = docsGet_(docId);
  var tab = findTabJsonById_(doc, tabId);
  var headingPara = findParagraphByText_(tab, sectionTitle);
  var headBounds = headingPara && headingPara.paragraph ? structuralContentBounds_(headingPara) : null;
  if (headBounds) {
    docsBatchUpdate_(docId, [
      {
        updateParagraphStyle: {
          range: { segmentId: '', tabId: tabId, startIndex: headBounds.start, endIndex: headBounds.end },
          paragraphStyle: { namedStyleType: 'HEADING_3' },
          fields: 'namedStyleType',
        },
      },
    ]);
  }

  // 3. Calculate row count: 1 header + per group (1 group-header + N assignments).
  var numRows = 1;
  groups.forEach(function (g) { numRows += 1 + g.assignments.length; });
  if (numRows <= 1) return;

  // 4. Insert table at end of segment.
  docsBatchUpdate_(docId, [
    {
      insertTable: {
        rows: numRows,
        columns: headers.length,
        endOfSegmentLocation: { tabId: tabId },
      },
    },
  ]);

  // 5. Re-fetch to find the new table (always the LAST table now since insertTable appended).
  doc = docsGet_(docId);
  var tblWrap = findLastTableStructInTab_(doc, tabId);
  if (!tblWrap || !tblWrap.table || !tblWrap.table.tableRows) {
    throw new Error('insertTable failed for ' + sectionTitle);
  }
  var tableJson = tblWrap.table;
  var tableStartIndex = tblWrap.startIndex;
  var tabIdForLoc = tabId;

  // 6. Build text inserts for every cell. Header row first, then groups.
  var inserts = [];
  var r = 0;

  headers.forEach(function (h, c) {
    var cell = tableJson.tableRows[r].tableCells[c];
    inserts.push({ idx: cellParagraphInsertIndex_(cell), text: String(h) });
  });
  r++;

  groups.forEach(function (group) {
    var groupLabel = (mode === 'class') ? group.course : group.day;
    headers.forEach(function (_, c) {
      var cell = tableJson.tableRows[r].tableCells[c];
      inserts.push({ idx: cellParagraphInsertIndex_(cell), text: c === 0 ? groupLabel : '' });
    });
    r++;

    group.assignments.forEach(function (a) {
      headers.forEach(function (_, c) {
        var cell = tableJson.tableRows[r].tableCells[c];
        var txt = '';
        if      (c === 0) txt = a.assignment || '';
        else if (c === 1) txt = (mode === 'class') ? (a.day || '') : (a.course || '');
        else if (c === 2) txt = a.due_time || '';
        else if (c === 3) txt = a.priority || '';
        else if (c === 4) txt = (a.url && savedData.status[a.url]) ? savedData.status[a.url] : STATUS_DEFAULT;
        else if (c === 5) txt = (a.url && savedData.notes[a.url])  ? savedData.notes[a.url]  : '';
        inserts.push({ idx: cellParagraphInsertIndex_(cell), text: txt });
      });
      r++;
    });
  });

  // Sort descending so earlier inserts don't shift later indices.
  inserts.sort(function (a, b) { return b.idx - a.idx; });

  var insertReqs = inserts
    .filter(function (it) { return String(it.text || '').length > 0; })
    .map(function (it) {
      return {
        insertText: {
          text: String(it.text),
          location: { tabId: tabIdForLoc, index: it.idx },
        },
      };
    });
  batchUpdateChunked_(docId, insertReqs);

  // 7. Re-fetch table for styling (text inserts shift cell ranges).
  doc = docsGet_(docId);
  tblWrap = findLastTableStructInTab_(doc, tabId);
  tableJson = tblWrap.table;

  var decorReqs = [];

  // Header row: dark bg + white bold text across all columns.
  decorReqs.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { tabId: tabIdForLoc, index: tableStartIndex },
          rowIndex: 0, columnIndex: 0,
        },
        rowSpan: 1, columnSpan: headers.length,
      },
      tableCellStyle: { backgroundColor: optionalColorFromHex_(HEADER_BG) },
      fields: 'backgroundColor',
    },
  });
  for (var c = 0; c < headers.length; c++) {
    var hCell = tableJson.tableRows[0].tableCells[c];
    var hr = getCellTextRange_(hCell);
    if (hr && hr.endIndex > hr.startIndex) {
      decorReqs.push({
        updateTextStyle: {
          range: { tabId: tabIdForLoc, startIndex: hr.startIndex, endIndex: hr.endIndex },
          textStyle: { bold: true, foregroundColor: optionalColorFromHex_(HEADER_FG) },
          fields: 'bold,foregroundColor',
        },
      });
    }
  }

  // Group-header rows + assignment rows.
  var rowPtr = 1;
  groups.forEach(function (group) {
    // Group-header background: course color in class mode, gray in day mode.
    var groupBgHex = (mode === 'class')
      ? (courseColorMap[group.course] || '#EAEDED')
      : DAY_ROW_BG;

    decorReqs.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { tabId: tabIdForLoc, index: tableStartIndex },
            rowIndex: rowPtr, columnIndex: 0,
          },
          rowSpan: 1, columnSpan: headers.length,
        },
        tableCellStyle: { backgroundColor: optionalColorFromHex_(groupBgHex) },
        fields: 'backgroundColor',
      },
    });
    var groupCell = tableJson.tableRows[rowPtr].tableCells[0];
    var cr = getCellTextRange_(groupCell);
    if (cr && cr.endIndex > cr.startIndex) {
      decorReqs.push({
        updateTextStyle: {
          range: { tabId: tabIdForLoc, startIndex: cr.startIndex, endIndex: cr.endIndex },
          textStyle: { bold: true, foregroundColor: optionalColorFromHex_(DATA_FG) },
          fields: 'bold,foregroundColor',
        },
      });
    }
    rowPtr++;

    group.assignments.forEach(function (a) {
      // Per-row colors: course color tints first 3 cols (regardless of mode), priority color
      // tints col 3, Status + Notes get white bg to signal "edit me".
      var rowBgHex   = courseColorMap[a.course] || '#EAEDED';
      var priorityBg = PRIORITY_COLORS[a.priority] || '#EEEEEE';

      decorReqs.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { tabId: tabIdForLoc, index: tableStartIndex },
              rowIndex: rowPtr, columnIndex: 0,
            },
            rowSpan: 1, columnSpan: 3,
          },
          tableCellStyle: { backgroundColor: optionalColorFromHex_(rowBgHex) },
          fields: 'backgroundColor',
        },
      });
      decorReqs.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { tabId: tabIdForLoc, index: tableStartIndex },
              rowIndex: rowPtr, columnIndex: 3,
            },
            rowSpan: 1, columnSpan: 1,
          },
          tableCellStyle: { backgroundColor: optionalColorFromHex_(priorityBg) },
          fields: 'backgroundColor',
        },
      });
      // Status + Notes (cols 4 and 5): white background, editable.
      decorReqs.push({
        updateTableCellStyle: {
          tableRange: {
            tableCellLocation: {
              tableStartLocation: { tabId: tabIdForLoc, index: tableStartIndex },
              rowIndex: rowPtr, columnIndex: 4,
            },
            rowSpan: 1, columnSpan: 2,
          },
          tableCellStyle: { backgroundColor: optionalColorFromHex_(EDITABLE_BG) },
          fields: 'backgroundColor',
        },
      });

      var cAssign = tableJson.tableRows[rowPtr].tableCells[0];
      var cMid    = tableJson.tableRows[rowPtr].tableCells[1]; // Day (class) or Course (day)
      var cTime   = tableJson.tableRows[rowPtr].tableCells[2];
      var cPri    = tableJson.tableRows[rowPtr].tableCells[3];
      var cStatus = tableJson.tableRows[rowPtr].tableCells[4];
      var cNotes  = tableJson.tableRows[rowPtr].tableCells[5];

      // Assignment cell: link styling if URL present, else dark text.
      var rAssign = getCellTextRange_(cAssign);
      if (rAssign && rAssign.endIndex > rAssign.startIndex) {
        var tsAssign = { foregroundColor: optionalColorFromHex_(DATA_FG) };
        var fieldsAssign = 'foregroundColor';
        if (a.url) {
          tsAssign.link = { url: a.url };
          tsAssign.foregroundColor = optionalColorFromHex_(LINK_FG);
          fieldsAssign = 'foregroundColor,link';
        }
        decorReqs.push({
          updateTextStyle: {
            range: { tabId: tabIdForLoc, startIndex: rAssign.startIndex, endIndex: rAssign.endIndex },
            textStyle: tsAssign, fields: fieldsAssign,
          },
        });
      }

      // All other cells: dark text on whatever background was set above.
      [cMid, cTime, cPri, cStatus, cNotes].forEach(function (cell) {
        var rg = getCellTextRange_(cell);
        if (rg && rg.endIndex > rg.startIndex) {
          decorReqs.push({
            updateTextStyle: {
              range: { tabId: tabIdForLoc, startIndex: rg.startIndex, endIndex: rg.endIndex },
              textStyle: { foregroundColor: optionalColorFromHex_(DATA_FG) },
              fields: 'foregroundColor',
            },
          });
        }
      });

      rowPtr++;
    });
  });

  batchUpdateChunked_(docId, decorReqs);

  // 8. Set fixed column widths so the table doesn't expand to page width.
  var widthReqs = [];
  for (var wi = 0; wi < widths.length; wi++) {
    widthReqs.push({
      updateTableColumnProperties: {
        tableStartLocation: { tabId: tabIdForLoc, index: tableStartIndex },
        columnIndices: [wi],
        tableColumnProperties: {
          widthType: 'FIXED_WIDTH',
          width: { magnitude: widths[wi], unit: 'PT' },
        },
        fields: 'widthType,width',
      },
    });
  }
  batchUpdateChunked_(docId, widthReqs);

  // 9. Trailing blank paragraph for visual breathing room before next section.
  docsBatchUpdate_(docId, [
    { insertText: { text: '\n', endOfSegmentLocation: { tabId: tabId } } },
  ]);

  sleepDocsChunkGap_();
}

function buildCourseColorMap_(days) {
  var names = collectCourseNames_(days);
  names.sort(function (a, b) {
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
      while (usedIndex[idx]) {
        idx = (idx + 1) % COURSE_COLORS.length;
      }
    }
    usedIndex[idx] = true;
    map[name] = COURSE_COLORS[idx];
  }
  return map;
}

function collectCourseNames_(days) {
  var names = [];
  (days || []).forEach(function (dayObj) {
    (dayObj.assignments || []).forEach(function (a) {
      var c = a.course;
      if (c && names.indexOf(c) === -1) names.push(c);
    });
  });
  return names;
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
 * Read all editable data (Notes, Status) from EVERY table in the tab, keyed by Canvas URL.
 * Walks every table because the new layout has two (By Class + By Day) and old single-table tabs still need to be read for migration.
 *
 * Column conventions (Notes = last column, Status = second-to-last):
 *   - Old 5-col table (Notes only): notes col = 4, no status
 *   - New 6-col table (Status + Notes): status col = 4, notes col = 5
 * Tables with < 5 columns are ignored.
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
        if (!url) return; // header / group-header row — no Canvas link
        var note = getCellText_(cells[notesColIdx]);
        if (note) result.notes[url] = note;
        if (statusColIdx >= 0) {
          var status = getCellText_(cells[statusColIdx]);
          // Each assignment appears in both tables. An untouched default in one table must not
          // overwrite a Status the teacher typed in the other.
          if (status && (status !== STATUS_DEFAULT || !result.status[url])) {
            result.status[url] = status;
          }
        }
      });
    });
  } catch (e) {}
  return result;
}

function flattenAndGroupByCourse_(days) {
  var all = [];
  (days || []).forEach(function (dayObj) {
    (dayObj.assignments || []).forEach(function (a) { all.push(a); });
  });

  var courseOrder = [];
  var groups = {};
  all.forEach(function (a) {
    var course = a.course || '(No Course)';
    if (!groups[course]) { groups[course] = []; courseOrder.push(course); }
    groups[course].push(a);
  });

  courseOrder.forEach(function (course) {
    groups[course].sort(function (a, b) {
      var da = String(a.due_date || ''), db = String(b.due_date || '');
      if (da !== db) return da < db ? -1 : 1;
      return String(a.assignment || '').toLowerCase() < String(b.assignment || '').toLowerCase() ? -1 : 1;
    });
  });

  courseOrder.sort(function (cA, cB) {
    var minA = groups[cA][0] ? String(groups[cA][0].due_date || '') : '';
    var minB = groups[cB][0] ? String(groups[cB][0].due_date || '') : '';
    if (minA !== minB) return minA < minB ? -1 : 1;
    return cA.localeCompare(cB);
  });

  return courseOrder.map(function (course) {
    return { course: course, assignments: groups[course] };
  });
}

/**
 * Group assignments by day. Preserves the input day order (already chronological from the backend).
 * Within each day, sorts by due_time then assignment title.
 * Skips days with zero assignments to keep the table tight.
 */
function flattenAndGroupByDay_(days) {
  var groups = [];
  (days || []).forEach(function (dayObj) {
    var assignments = (dayObj.assignments || []).slice();
    if (!assignments.length) return;
    assignments.sort(function (a, b) {
      var ta = String(a.due_time || ''), tb = String(b.due_time || '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.assignment || '').toLowerCase() < String(b.assignment || '').toLowerCase() ? -1 : 1;
    });
    groups.push({ day: dayObj.day || '', assignments: assignments });
  });
  return groups;
}
