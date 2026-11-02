'use strict';
// A stateful fake of the Docs API for the year simulation. Same tab rules as tests/helpers/fake-docs.js
// (unique titles at any level, all-or-nothing batches, requests in order), plus:
//   - tab content is "realistic" (lib/realistic.js): what a real read with DOCS_GET_FIELDS returns;
//   - every read's JSON size is measured exactly, and the simulated clock moves by the time model;
//   - a per-tab index model (end index from the request stream) is kept and checked against the content;
//   - requests that point at tables or links are checked against where the content really has them.
const real = require('./realistic');

const WRITE_MS = 1400;
const READ_BASE_MS = 500;
const READ_MS_PER_KB = 6.5;

function createSimDocs(opts) {
  const { clock, rng, onAnomaly, exactReads } = opts;
  const docs = new Map(); // docId -> { id, title, tabs, L: Map(tabId -> end index), rendered: Set, pending: Map }
  const tabOwner = new Map(); // tabId -> docId
  const contentLen = new WeakMap(); // content array -> { ver, len }
  const contentVer = new WeakMap();
  let metrics = null; // set per update: { reads: [], writes: [] }
  let lastDocId = null; // the Doc the last Docs call was about (an update works on one Doc at a time)
  const writeTimes = [];
  const readTimes = [];

  const newTabId = () => {
    let s = 't.';
    for (let i = 0; i < 12; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rng() * 36)];
    return s;
  };
  const newTab = (id, title, parentTabId) => ({
    tabProperties: parentTabId ? { tabId: id, title, parentTabId } : { tabId: id, title },
    documentTab: { documentStyle: real.DOC_STYLE(), body: { content: real.emptyTabContent() } },
    childTabs: [],
  });

  function createDoc(id, title) {
    const doc = { id, title, tabs: [newTab('t.0', 'Tab 1')], L: new Map([['t.0', 2]]), rendered: new Set(), pending: new Map() };
    docs.set(id, doc);
    return doc;
  }
  const all = (doc) => { const out = []; const walk = (ts) => ts.forEach((t) => { out.push(t); walk(t.childTabs || []); }); walk(doc.tabs); return out; };
  const find = (doc, id) => all(doc).find((t) => t.tabProperties.tabId === id) || null;
  const kidsOf = (doc, parentId) => {
    if (!parentId) return doc.tabs;
    const p = find(doc, parentId);
    if (!p) throw new Error('Invalid requests: parent tab ' + parentId + ' not found');
    return (p.childTabs = p.childTabs || []);
  };
  const detach = (doc, t) => { const k = kidsOf(doc, t.tabProperties.parentTabId); k.splice(k.indexOf(t), 1); };
  const unique = (doc, title, id) => {
    if (all(doc).some((t) => t.tabProperties.title === title && t.tabProperties.tabId !== id)) {
      throw new Error('Invalid requests[0].addDocumentTab: Tab title must be unique');
    }
  };
  const anomaly = (doc, kind, detail) => onAnomaly && onAnomaly({ doc: doc && doc.id, kind, detail, at: clock.T });

  function bumpContent(content) { contentVer.set(content, (contentVer.get(content) || 0) + 1); }
  function lenOf(content) {
    const ver = contentVer.get(content) || 0;
    const c = contentLen.get(content);
    if (c && c.ver === ver) return c.len;
    const len = JSON.stringify(content).length;
    contentLen.set(content, { ver, len });
    return len;
  }

  // ---- checks of requests against the realistic content ---------------------------------------
  const tableRefOf = (r) => {
    if (r.updateTableCellStyle) return { loc: r.updateTableCellStyle.tableRange.tableCellLocation.tableStartLocation, row: r.updateTableCellStyle.tableRange.tableCellLocation.rowIndex, col: r.updateTableCellStyle.tableRange.tableCellLocation.columnIndex, rs: r.updateTableCellStyle.tableRange.rowSpan, cs: r.updateTableCellStyle.tableRange.columnSpan };
    if (r.mergeTableCells) return { loc: r.mergeTableCells.tableRange.tableCellLocation.tableStartLocation, row: r.mergeTableCells.tableRange.tableCellLocation.rowIndex, col: r.mergeTableCells.tableRange.tableCellLocation.columnIndex, rs: r.mergeTableCells.tableRange.rowSpan, cs: r.mergeTableCells.tableRange.columnSpan };
    if (r.updateTableColumnProperties) return { loc: r.updateTableColumnProperties.tableStartLocation, col: Math.max(...r.updateTableColumnProperties.columnIndices), row: 0, rs: 1, cs: 1 };
    if (r.updateTableRowStyle) return { loc: r.updateTableRowStyle.tableStartLocation, row: Math.max(...r.updateTableRowStyle.rowIndices), col: 0, rs: 1, cs: 1 };
    return null;
  };
  function checkAgainstContent(doc, tabId, reqs, withLinks) {
    const tab = find(doc, tabId);
    if (!tab) return;
    const content = tab.documentTab.body.content;
    const tables = new Map();
    content.forEach((se) => { if (se.table) tables.set(se.startIndex, se.table); });
    let bad = 0;
    reqs.forEach((r) => {
      const ref = tableRefOf(r);
      if (!ref) return;
      const t = tables.get(ref.loc.index);
      if (!t) { bad++; if (bad < 3) anomaly(doc, 'table-ref-not-a-table', { tab: tab.tabProperties.title, index: ref.loc.index, req: Object.keys(r)[0] }); return; }
      if (ref.row + (ref.rs || 1) > t.rows || ref.col + (ref.cs || 1) > t.columns) {
        bad++; if (bad < 3) anomaly(doc, 'table-ref-out-of-range', { tab: tab.tabProperties.title, ref, rows: t.rows, cols: t.columns });
      }
    });
    if (!withLinks) return;
    // Every link range the requests style must be exactly an assignment's text in a first cell.
    const want = new Map();
    real.assignmentRows(content).forEach((a) => {
      const e0 = a.row.tableCells[0].content[0].paragraph.elements[0];
      const k = a.url;
      (want.get(k) || want.set(k, []).get(k)).push(e0.startIndex + '-' + (e0.startIndex + a.title.length));
    });
    const got = new Map();
    reqs.forEach((r) => {
      const u = r.updateTextStyle && r.updateTextStyle.textStyle.link && r.updateTextStyle.textStyle.link.url;
      if (!u) return;
      const rg = r.updateTextStyle.range;
      (got.get(u) || got.set(u, []).get(u)).push(rg.startIndex + '-' + rg.endIndex);
    });
    for (const [u, ranges] of want) {
      const g = (got.get(u) || []).slice().sort().join(',');
      if (g !== ranges.slice().sort().join(',')) { anomaly(doc, 'link-range-mismatch', { tab: tab.tabProperties.title, url: u, want: ranges, got: got.get(u) || [] }); break; }
    }
  }
  function flushPending(doc) {
    for (const [tabId, p] of doc.pending) {
      const tab = find(doc, tabId);
      if (!tab) { doc.pending.delete(tabId); continue; }
      const end = real.endIndexOf(tab.documentTab.body.content);
      const L = doc.L.get(tabId);
      if (L !== end) {
        // Not (yet) fully written: a partial write left behind (an "(updating)" tab cut off).
        if (!/\(updating\)$/.test(tab.tabProperties.title)) anomaly(doc, 'index-model-vs-content', { tab: tab.tabProperties.title, model: L, content: end });
        doc.pending.delete(tabId);
        continue;
      }
      checkAgainstContent(doc, tabId, p.reqs, p.links);
      doc.pending.delete(tabId);
    }
  }

  // ---- requests ----------------------------------------------------------------------------------
  function locTab(r) {
    const k = Object.keys(r)[0];
    const b = r[k];
    if (!b || typeof b !== 'object') return null;
    if (b.location) return b.location.tabId;
    if (b.range) return b.range.tabId;
    if (b.tableStartLocation) return b.tableStartLocation.tabId;
    if (b.tableRange) return b.tableRange.tableCellLocation.tableStartLocation.tabId;
    return null;
  }
  function apply(doc, r, L, touched) {
    if (r.addDocumentTab) {
      const p = r.addDocumentTab.tabProperties;
      unique(doc, p.title);
      const id = newTabId();
      const t = newTab(id, p.title, p.parentTabId);
      const k = kidsOf(doc, p.parentTabId);
      k.splice(p.index === undefined ? k.length : Math.min(p.index, k.length), 0, t);
      L.set(id, 2);
      tabOwner.set(id, doc.id);
      return { addDocumentTab: { tabProperties: { tabId: id, title: p.title } } };
    }
    if (r.deleteTab) {
      const t = find(doc, r.deleteTab.tabId);
      if (!t) throw new Error('Invalid requests: deleteTab: tab not found');
      detach(doc, t);
      return {};
    }
    if (r.updateDocumentTabProperties) {
      const p = r.updateDocumentTabProperties.tabProperties;
      const t = find(doc, p.tabId);
      if (!t) throw new Error('Invalid requests: updateDocumentTabProperties: tab not found');
      const fields = r.updateDocumentTabProperties.fields;
      if (/title/.test(fields)) { unique(doc, p.title, p.tabId); t.tabProperties.title = p.title; }
      if (/parentTabId/.test(fields)) {
        detach(doc, t);
        t.tabProperties.parentTabId = p.parentTabId;
        const k = kidsOf(doc, p.parentTabId);
        k.splice(Math.min(p.index || 0, k.length), 0, t);
      }
      return {};
    }
    const tabId = locTab(r);
    if (tabId !== null) {
      const t = find(doc, tabId);
      if (!t) throw new Error('Invalid requests: ' + Object.keys(r)[0] + ': tab ' + tabId + ' not found');
      touched.add(tabId);
      let len = L.get(tabId);
      if (len === undefined) len = real.endIndexOf(t.documentTab.body.content);
      const k = Object.keys(r)[0];
      const b = r[k];
      if (b.location) {
        const i = b.location.index;
        if (!(i >= 1 && i <= len - 1)) anomaly(doc, 'insert-out-of-bounds', { req: k, index: i, len, tab: t.tabProperties.title });
      }
      if (b.range && !(b.range.startIndex >= 1 && b.range.endIndex <= len && b.range.endIndex >= b.range.startIndex)) {
        anomaly(doc, 'range-out-of-bounds', { req: k, range: [b.range.startIndex, b.range.endIndex], len, tab: t.tabProperties.title });
      }
      if (r.insertText) {
        len += r.insertText.text.length;
        if (!doc.rendered.has(tabId)) {
          const c = t.documentTab.body.content;
          if (c.length === 2 && c[1].paragraph && c[1].paragraph.elements[0].textRun.content === '\n' && r.insertText.location.index === 1) {
            t.documentTab.body.content = real.textTabContent(r.insertText.text);
          } else {
            anomaly(doc, 'text-into-unrendered-tab', { tab: t.tabProperties.title });
          }
        }
      } else if (r.insertTable) {
        len += 3 + r.insertTable.rows * (2 * r.insertTable.columns + 1);
      } else if (r.deleteContentRange) {
        if (r.deleteContentRange.range.endIndex > len - 1) anomaly(doc, 'delete-includes-final-newline', { tab: t.tabProperties.title });
        len -= r.deleteContentRange.range.endIndex - r.deleteContentRange.range.startIndex;
      }
      L.set(tabId, len);
    }
    return {};
  }

  function batchUpdate(body, docId) {
    const doc = docs.get(docId);
    if (!doc) throw new Error('Requested entity was not found.');
    lastDocId = docId;
    const requests = body.requests || [];
    // Structure snapshot, for all-or-nothing.
    const snapTabs = all(doc).map((t) => [t, Object.assign({}, t.tabProperties), (t.childTabs || []).slice(), t.documentTab.body.content]);
    const snapRoots = doc.tabs.slice();
    const L = new Map(doc.L);
    const touched = new Set();
    let replies;
    try {
      replies = requests.map((r) => apply(doc, r, L, touched));
    } catch (e) {
      snapTabs.forEach(([t, props, kids, content]) => { t.tabProperties = props; t.childTabs = kids; t.documentTab.body.content = content; });
      doc.tabs = snapRoots;
      if (metrics) metrics.writes.push({ n: requests.length, failed: true });
      clock.advance(WRITE_MS, 'write');
      throw e;
    }
    // Commit: index model, and checks of edits to complete tabs (e.g. the Past weeks gray).
    doc.L = L;
    let total = 0;
    all(doc).forEach((t) => { total += L.has(t.tabProperties.tabId) ? L.get(t.tabProperties.tabId) : real.endIndexOf(t.documentTab.body.content); });
    doc.peakModel = Math.max(doc.peakModel || 0, total);
    doc.peakTabs = Math.max(doc.peakTabs || 0, all(doc).length);
    touched.forEach((tabId) => {
      const p = doc.pending.get(tabId);
      const reqs = requests.filter((r) => locTab(r) === tabId);
      if (p) p.reqs.push(...reqs);
      else {
        const t = find(doc, tabId);
        if (t && L.get(tabId) === real.endIndexOf(t.documentTab.body.content)) checkAgainstContent(doc, tabId, reqs, false);
      }
    });
    if (metrics) metrics.writes.push({ n: requests.length, kinds: summarizeKinds(requests) });
    writeTimes.push(clock.T);
    clock.advance(WRITE_MS, 'write');
    return { replies };
  }
  const summarizeKinds = (reqs) => {
    const k = {};
    reqs.forEach((r) => { const n = Object.keys(r)[0]; k[n] = (k[n] || 0) + 1; });
    return k;
  };

  function copyTab(t, level, index, parentId, full) {
    const tp = { tabId: t.tabProperties.tabId, title: t.tabProperties.title, index };
    if (parentId) { tp.parentTabId = parentId; tp.nestingLevel = level - 1; }
    const out = { tabProperties: tp };
    if (full || level <= 2) {
      out.documentTab = { documentStyle: t.documentTab.documentStyle, body: { content: t.documentTab.body.content } };
      const kids = t.childTabs || [];
      out.childTabs = kids.map((c, i) => copyTab(c, level + 1, i, tp.tabId, full));
    }
    return out;
  }
  function readSize(json) {
    let extra = 0;
    const s = JSON.stringify(json, function (key, value) {
      // A tab body's content (it starts with the section break): its length is cached per version.
      if (key === 'content' && Array.isArray(value) && value.length && value[0].sectionBreak) {
        extra += lenOf(value) - 2;
        return [];
      }
      return value;
    });
    return s.length + extra;
  }

  function get(docId, opts) {
    const doc = docs.get(docId);
    if (!doc) throw new Error('Requested entity was not found.');
    lastDocId = docId;
    flushPending(doc);
    const masked = !!(opts && opts.fields);
    // DOCS_GET_FIELDS_WITH_PAST asks for content at all three tab levels (Past weeks' content too).
    const deep = masked && (String(opts.fields).match(/documentTab\(/g) || []).length >= 3;
    const json = { tabs: doc.tabs.map((t, i) => copyTab(t, 1, i, null, !masked || deep)) };
    let size = readSize(json);
    if (!masked) { size = Math.round(size * 4.7); anomaly(doc, 'full-read', {}); }
    const ms = READ_BASE_MS + READ_MS_PER_KB * size / 1024;
    if (metrics) metrics.reads.push({ chars: size, ms });
    readTimes.push(clock.T);
    clock.advance(ms, 'read');
    return exactReads ? JSON.parse(JSON.stringify(json)) : json;
  }

  // ---- rendering hooks (installed on the sandbox) -------------------------------------------------
  function installRendering(ctx) {
    const realBuild = ctx.buildWeekTabRequests_;
    ctx.buildWeekTabRequests_ = function (tabId, weekKey, weekData, courses, colorMap, saved, width, staffRows) {
      const reqs = realBuild(tabId, weekKey, weekData, courses, colorMap, saved, width, staffRows);
      const doc = docs.get(tabOwner.get(tabId));
      const tab = doc && find(doc, tabId);
      if (tab) {
        tab.documentTab.body.content = real.renderWeekTab(ctx, weekKey, weekData, courses, saved, staffRows);
        doc.rendered.add(tabId);
        doc.pending.set(tabId, { reqs: [], links: true });
      }
      return reqs;
    };
    const realHome = ctx.buildHomeTabRequests_;
    ctx.buildHomeTabRequests_ = function (tabId, summary, weekTabId, contentWidth, colorMap) {
      const reqs = realHome(tabId, summary, weekTabId, contentWidth, colorMap);
      const doc = docs.get(lastDocId);
      const tab = doc && find(doc, tabId);
      if (tab) {
        tab.documentTab.body.content = real.renderHomeTab(ctx, summary, weekTabId);
        doc.rendered.add(tabId);
        doc.pending.set(tabId, { reqs: [], links: false });
      } else {
        anomaly(doc, 'home-render-no-tab', { tabId });
      }
      return reqs;
    };
  }

  // ---- staff edits on the live Doc ------------------------------------------------------------------
  function editTab(doc, tab, fn) {
    const content = tab.documentTab.body.content;
    const before = real.endIndexOf(content);
    const r = fn(content);
    const after = real.endIndexOf(content);
    bumpContent(content);
    const id = tab.tabProperties.tabId;
    doc.L.set(id, (doc.L.has(id) ? doc.L.get(id) : before) + (after - before));
    return r;
  }

  function docSize(doc) {
    let model = 0;
    let content = 0;
    let tabs = 0;
    all(doc).forEach((t) => {
      tabs++;
      const end = real.endIndexOf(t.documentTab.body.content);
      content += end;
      model += doc.L.has(t.tabProperties.tabId) ? doc.L.get(t.tabProperties.tabId) : end;
    });
    return { model, content, tabs };
  }

  return {
    docs, createDoc, get, batchUpdate, installRendering, find, all, editTab, docSize, flushPending,
    setMetrics: (m) => { metrics = m; }, writeTimes, readTimes, lenOf,
    service: { Documents: { get: (id, o) => get(id, o), batchUpdate: (b, id) => batchUpdate(b, id) } },
  };
}

module.exports = { createSimDocs, WRITE_MS, READ_BASE_MS, READ_MS_PER_KB };
