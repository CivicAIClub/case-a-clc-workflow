'use strict';
// A stateful fake of the Google Docs API's tab handling, shared by the tests. Like the real API
// (checked live): every tab title in a Doc must be different, at any level; a batch is all or
// nothing; requests run in order; a tab can hold one Status dropdown with a given ID. Text requests
// are recorded per tab (not rendered); with withRendering, each week tab is laid out the way the real
// writer lays it out, so Status chips, Notes, to-dos and the Weekend plan round-trip through updates
// and staff edits. Every read numbers the content the way Google does (see numberTab), and inside
// asStaff(fn) the requests that edit by position (type, delete, insert or delete a table row, add a
// table, pick a Status) really change the laid-out tab, so code that edits a Doc the way a person
// would can run here unchanged. fakeDocs(tabs, { execute: true }) goes one step further: every
// request is carried out by position, the way Google would (text, chips, text and cell styles,
// merged cells, column widths), so a tab the real writer builds can be read back and checked. All
// data is made up.

const { applyFieldMask } = require('./field-mask');

const tcell = (text, link) => ({ content: [{ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: link ? { link: { url: link } } : {} } }] } }] });

function fakeDocs(tabs, options) {
  const st = { tabs, written: {}, batches: [], n: 0, chips: 0, failOnFill: false, staff: 0, execute: !!(options && options.execute) };
  const all = () => { const out = []; const walk = (ts) => ts.forEach((t) => { out.push(t); walk(t.childTabs || []); }); walk(st.tabs); return out; };
  const find = (id) => all().find((t) => t.tabProperties.tabId === id);
  const kidsOf = (parentId) => (parentId ? (find(parentId).childTabs = find(parentId).childTabs || []) : st.tabs);
  const detach = (t) => { const k = kidsOf(t.tabProperties.parentTabId); k.splice(k.indexOf(t), 1); };
  const unique = (title, id) => {
    if (all().some((t) => t.tabProperties.title === title && t.tabProperties.tabId !== id)) throw new Error('Invalid requests[0].addDocumentTab: Tab title must be unique');
  };
  const apply = (r) => {
    if (r.addDocumentTab) {
      const p = r.addDocumentTab.tabProperties;
      unique(p.title);
      const t = { tabProperties: { tabId: 't.n' + (++st.n), title: p.title, parentTabId: p.parentTabId },
        documentTab: { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } }, childTabs: [] };
      const k = kidsOf(p.parentTabId);
      k.splice(p.index === undefined ? k.length : p.index, 0, t);
      return { addDocumentTab: { tabProperties: { tabId: t.tabProperties.tabId } } };
    }
    if (r.deleteTab) { detach(find(r.deleteTab.tabId)); return {}; }
    if (r.updateDocumentTabProperties) {
      const p = r.updateDocumentTabProperties.tabProperties;
      const t = find(p.tabId);
      const fields = r.updateDocumentTabProperties.fields;
      if (/title/.test(fields)) { unique(p.title, p.tabId); t.tabProperties.title = p.title; }
      if (/parentTabId/.test(fields)) { detach(t); t.tabProperties.parentTabId = p.parentTabId; const k = kidsOf(p.parentTabId); k.splice(p.index, 0, t); }
      return {};
    }
    if (r.createDropdownDefinition) {
      const t = find(r.createDropdownDefinition.tabId);
      const def = r.createDropdownDefinition.dropdownDefinition;
      if (!t) throw new Error('No tab ' + r.createDropdownDefinition.tabId);
      const defs = (t.documentTab.dropdownDefinitions = t.documentTab.dropdownDefinitions || {});
      // Google's own words for a second definition with the same ID in one tab (checked live 2026-11-10).
      if (defs[def.dropdownDefinitionId]) throw new Error('Invalid requests[0].createDropdownDefinition: An entity with ID ' + def.dropdownDefinitionId + ' already exists.');
      defs[def.dropdownDefinitionId] = JSON.parse(JSON.stringify(def));
      return { createDropdownDefinition: { dropdownDefinitionId: def.dropdownDefinitionId } };
    }
    if (r.insertDropdown) {
      // A chip needs its dropdown in the same tab (checked live 2026-11-10). The chosen label is
      // recorded with the tab's text, so a test can see what a chip was set to.
      const d = r.insertDropdown;
      const t = find(d.location.tabId);
      if (!t) throw new Error('No tab ' + d.location.tabId);
      const def = (t.documentTab.dropdownDefinitions || {})[d.dropdownDefinitionId];
      if (!def) throw new Error('Invalid requests[0].insertDropdown: Dropdown definition with ID ' + d.dropdownDefinitionId + ' not found.');
      const option = def.dropdownDefinitionProperties.options.find((o) => o.optionId === d.selectedOptionId);
      if (!option) throw new Error('Invalid requests[0].insertDropdown: no option ' + d.selectedOptionId);
      (st.written[d.location.tabId] = st.written[d.location.tabId] || []).push(option.displayValue);
      if (st.execute) return applyEdit(find, r);
      return { insertDropdown: { dropdownId: 'kix.chip' + (++st.chips) } };
    }
    if (r.updateDropdownProperties) {
      const d = r.updateDropdownProperties;
      const t = find(d.tabId);
      if (!t) throw new Error('No tab ' + d.tabId);
      setChip(t, d.dropdownId, d.dropdownProperties.selectedOptionId);
      return {};
    }
    if (st.staff) {
      const done = applyEdit(find, r);
      if (done) return done;
    }
    const loc = r.insertText && r.insertText.location;
    if (st.execute) {
      if (loc && find(loc.tabId) && st.failOnFill && /\(updating\)$/.test(find(loc.tabId).tabProperties.title)) throw new Error('Exceeded maximum execution time');
      const done = applyEdit(find, r);
      if (done) {
        if (loc) (st.written[loc.tabId] = st.written[loc.tabId] || []).push(r.insertText.text);
        return done;
      }
    }
    if (loc) {
      if (!find(loc.tabId)) throw new Error('No tab ' + loc.tabId);
      if (st.failOnFill && /\(updating\)$/.test(find(loc.tabId).tabProperties.title)) throw new Error('Exceeded maximum execution time');
      (st.written[loc.tabId] = st.written[loc.tabId] || []).push(r.insertText.text);
    }
    return {};
  };
  st.service = { Documents: {
    // A read with a fields mask returns only those fields, as Google's does.
    get: (id, opts) => {
      const json = JSON.parse(JSON.stringify({ tabs: st.tabs }));
      const number = (ts) => ts.forEach((t) => { numberTab(t); number(t.childTabs || []); });
      number(json.tabs);
      return opts && opts.fields ? applyFieldMask(json, String(opts.fields)) : json;
    },
    batchUpdate: (body) => {
      const backup = JSON.stringify(st.tabs);
      try {
        const replies = body.requests.map(apply);
        st.batches.push(body.requests.map((r) => Object.keys(r)[0]));
        return { replies };
      } catch (e) { st.tabs = JSON.parse(backup); throw e; }
    },
  } };
  // Runs fn with position edits switched on: what selfTest's own edits and a person's typing do.
  st.asStaff = (fn) => { st.staff++; try { return fn(); } finally { st.staff--; } };
  st.titles = (parentId) => kidsOf(parentId).map((t) => t.tabProperties.title);
  st.titleAnywhere = (re) => all().filter((t) => re.test(t.tabProperties.title)).map((t) => t.tabProperties.title);
  st.find = find;
  return st;
}

// The three Status choices, written out here on purpose (not read from Code.gs), so a renamed or
// reordered choice fails a test.
const STATUS_IDS = { 'Need to Start': 'dropdownItem.need', 'In progress': 'dropdownItem.progress', 'Done/Submitted': 'dropdownItem.done' };
const TEXT_FG = { color: { rgbColor: { red: 33 / 255, green: 33 / 255, blue: 33 / 255 } } }; // #212121
const MUTED_LOOK = { italic: true, foregroundColor: { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } } }; // #666666
// The look of an assignment's link without the link itself: what a row inserted below one starts with.
const LINK_LOOK = { underline: true, foregroundColor: { color: { rgbColor: { red: 26 / 255, green: 115 / 255, blue: 232 / 255 } } } }; // #1a73e8
const rich = (c) => (typeof c === 'string' ? { text: c, runs: [] } : c);
const ADD_TODO = '+ Add a to-do';

const para = (text) => ({ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: {} } }] } });

// A cell from { text, runs }: one paragraph per line and one text run per styled stretch, as the
// Docs API returns them. `base` is the style every run starts from (the table's own text style).
function richCell(cell, base) {
  const text = cell.text || '';
  const runs = cell.runs || [];
  const content = [];
  let offset = 0;
  text.split('\n').forEach((line) => {
    const from = offset;
    const to = offset + line.length;
    const cuts = new Set([from, to]);
    runs.forEach((r) => [r.s, r.e].forEach((at) => { if (at > from && at < to) cuts.add(at); }));
    const points = [...cuts].sort((a, b) => a - b);
    const elements = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const [s, e] = [points[i], points[i + 1]];
      const style = Object.assign({}, base || {});
      runs.filter((r) => r.s <= s && e <= r.e).forEach((r) => Object.assign(style, r.style));
      elements.push({ textRun: { content: text.slice(s, e), textStyle: style } });
    }
    if (!elements.length) elements.push({ textRun: { content: '', textStyle: Object.assign({}, base || {}) } });
    elements[elements.length - 1].textRun.content += '\n';
    content.push({ paragraph: { elements } });
    offset = to + 1;
  });
  return { content };
}

let chipCount = 0;
// A Status cell holding a dropdown chip set to `status` (one of the three choices).
function chipCell(status) {
  if (!STATUS_IDS[status]) throw new Error('not a Status choice: ' + status);
  return { content: [{ paragraph: { elements: [
    { dropdown: { dropdownId: 'kix.chip' + (++chipCount), dropdownProperties: { dropdownDefinitionId: 'kix.clc_status', selectedOptionId: STATUS_IDS[status], displayValue: status } } },
    { textRun: { content: '\n', textStyle: {} } },
  ] } }] };
}
const typed = (c) => richCell(rich(c), { foregroundColor: TEXT_FG });

// Lays out a week tab from the writer's own list of blocks (weekTabBlocks_ in Code.gs) the way the
// requests lay it out in a real Doc: a paragraph per line, the tables with their header and day rows
// in bold, a chip in every Status cell, and one empty paragraph after each table.
function renderBlocks(blocks) {
  const labelOf = (id) => Object.keys(STATUS_IDS).find((label) => STATUS_IDS[label] === id);
  const content = [];
  blocks.forEach((b) => {
    if (b.line !== undefined) return content.push(para(b.line));
    const columns = b.table.widths.length;
    const tableRows = b.table.rows.map((row) => {
      const tableCells = [];
      for (let c = 0; c < columns; c++) {
        const cell = row.cells[c] || { text: '', runs: [] };
        if (cell.chip) { tableCells.push(chipCell(labelOf(cell.chip))); continue; }
        const base = { foregroundColor: TEXT_FG };
        if (row.look === 'header' || (row.look === 'group' && c === 0)) base.bold = true;
        tableCells.push(richCell(cell, base));
      }
      return { tableCells };
    });
    content.push({ table: { rows: tableRows.length, columns, tableRows } }, para(''));
  });
  return content;
}

// From here on, an update's week tabs are really laid out in the fake Doc (see renderBlocks).
function withRendering(t, docs) {
  const realBuild = t.ctx.buildWeekTabRequests_;
  t.ctx.buildWeekTabRequests_ = (tabId, weekKey, weekData, courses, colorMap, saved, width, staff) => {
    const blocks = JSON.parse(JSON.stringify(t.ctx.weekTabBlocks_(weekKey, weekData, courses, colorMap, saved, width, staff)));
    docs.find(tabId).documentTab.body.content = renderBlocks(blocks);
    return realBuild(tabId, weekKey, weekData, courses, colorMap, saved, width, staff);
  };
}

// ---- Positions, and edits made by position ----

/**
 * Numbers a tab's content the way the Docs API does. The rules were checked against a live read
 * (tests/fixtures/live-week-tab-read-2026-11.json): the body starts at 1, every character counts 1
 * and so does a chip, and a table, each of its rows and each of its cells take 1 before what is
 * inside them, plus 1 at the table's end.
 */
function numberTab(tab) {
  const body = tab.documentTab && tab.documentTab.body;
  if (!body || !body.content) return tab;
  let at = 1;
  const paragraph = (el) => {
    el.startIndex = at;
    el.paragraph.elements.forEach((e) => {
      e.startIndex = at;
      at += e.textRun ? e.textRun.content.length : 1;
      e.endIndex = at;
    });
    el.endIndex = at;
  };
  body.content.forEach((el) => {
    if (el.paragraph) return paragraph(el);
    if (!el.table) return; // the section break at the top of a real read
    el.startIndex = at++;
    el.table.tableRows.forEach((row) => {
      row.startIndex = at++;
      row.tableCells.forEach((cell) => {
        cell.startIndex = at++;
        cell.content.forEach(paragraph);
        cell.endIndex = at;
      });
      row.endIndex = at;
    });
    el.endIndex = ++at;
  });
  return tab;
}

/** Picks a choice in the chip with this ID, as updateDropdownProperties does. */
function setChip(tab, dropdownId, optionId) {
  let chip = null;
  paragraphsIn(tab.documentTab.body).forEach((p) => p.el.paragraph.elements.forEach((e) => {
    if (e.dropdown && e.dropdown.dropdownId === dropdownId) chip = e.dropdown;
  }));
  if (!chip) throw new Error('Invalid requests[0].updateDropdownProperties: Dropdown with ID ' + dropdownId + ' not found.');
  const def = (tab.documentTab.dropdownDefinitions || {})[chip.dropdownProperties.dropdownDefinitionId];
  const option = def && def.dropdownDefinitionProperties.options.find((o) => o.optionId === optionId);
  if (!option) throw new Error('Invalid requests[0].updateDropdownProperties: no option ' + optionId);
  chip.dropdownProperties.selectedOptionId = optionId;
  chip.dropdownProperties.displayValue = option.displayValue;
}

// Every paragraph of a tab, in the body and in table cells, with the list it sits in.
function paragraphsIn(body) {
  const out = [];
  const add = (list) => list.forEach((el, i) => { if (el.paragraph) out.push({ list, i, el }); });
  add(body.content || []);
  (body.content || []).forEach((el) => {
    if (el.table) el.table.tableRows.forEach((row) => row.tableCells.forEach((cell) => add(cell.content)));
  });
  return out;
}

// A line break typed inside a paragraph starts a new paragraph.
function splitLines(p) {
  const lines = [[]];
  p.el.paragraph.elements.forEach((e) => {
    if (!e.textRun) return lines[lines.length - 1].push(e);
    const parts = e.textRun.content.split('\n');
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const content = part + (last ? '' : '\n');
      if (content) lines[lines.length - 1].push({ textRun: { content, textStyle: Object.assign({}, e.textRun.textStyle) } });
      if (!last) lines.push([]);
    });
  });
  if (lines.pop().length) throw new Error('a paragraph must end with a line break');
  p.list.splice(p.i, 1, ...lines.map((elements) => ({ paragraph: Object.assign({}, p.el.paragraph, { elements }) })));
}

// What "Insert row below" puts under a cell (seen in a real Doc, 2026-11-10): an empty cell that
// keeps the look of the text above it without its link, or a chip of its own on the first choice.
function copiedCell(cell) {
  const first = elementsOf(cell)[0] || {};
  if (first.dropdown) return chipCell('Need to Start');
  const style = Object.assign({}, (first.textRun && first.textRun.textStyle) || {});
  delete style.link;
  return { content: [{ paragraph: { elements: [{ textRun: { content: '\n', textStyle: style } }] } }] };
}

/**
 * Applies one request that edits a laid-out tab by position, the way a real Doc would: insertText,
 * deleteContentRange (inside one paragraph), updateTextStyle, insertTableRow, deleteTableRow and
 * insertTable; and, for the execute mode, insertDropdown, updateParagraphStyle and the table style
 * requests. Returns the reply, or null for any other request. Errors use Google's own words where
 * a test depends on them.
 */
function applyEdit(find, r) {
  const kind = Object.keys(r)[0];
  const q = r[kind];
  const tableStart = (x) => x.tableStartLocation || x.tableRange.tableCellLocation.tableStartLocation;
  const place = { insertText: (x) => x.location, insertTable: (x) => x.location, deleteContentRange: (x) => x.range,
    updateTextStyle: (x) => x.range, insertTableRow: (x) => x.tableCellLocation.tableStartLocation,
    deleteTableRow: (x) => x.tableCellLocation.tableStartLocation, insertDropdown: (x) => x.location,
    updateParagraphStyle: (x) => x.range, updateTableCellStyle: tableStart, mergeTableCells: tableStart,
    updateTableColumnProperties: tableStart, updateTableRowStyle: tableStart }[kind];
  if (!place) return null;
  const tab = find(place(q).tabId);
  if (!tab) throw new Error('No tab ' + place(q).tabId);
  numberTab(tab);
  const body = tab.documentTab.body;
  const paragraphAt = (index) => {
    const hit = paragraphsIn(body).find((p) => p.el.startIndex <= index && index < p.el.endIndex);
    if (!hit) throw new Error('Invalid requests[0].' + kind + ': Index ' + index + ' must be less than the end index of the referenced segment.');
    return hit;
  };
  const tableAt = (location) => {
    const el = body.content.find((x) => x.table && x.startIndex === location.tableStartLocation.index);
    if (!el) throw new Error('Invalid requests[0].' + kind + ': Invalid table start location. Must specify the start index of the table.');
    if (location.rowIndex !== undefined && !el.table.tableRows[location.rowIndex]) throw new Error('Invalid requests[0].' + kind + ': the table has no row ' + location.rowIndex);
    return el.table;
  };
  const pick = (style, fields) => {
    const out = {};
    String(fields).split(',').forEach((f) => { if (style[f] !== undefined) out[f] = style[f]; });
    return out;
  };
  // Every paragraph that overlaps [startIndex, endIndex), for the requests that may span several.
  const paragraphsOver = (range) => paragraphsIn(body).filter((p) => p.el.startIndex < range.endIndex && range.startIndex < p.el.endIndex);

  if (kind === 'insertDropdown') {
    const index = q.location.index;
    const p = paragraphAt(index);
    const els = p.el.paragraph.elements;
    const k = els.findIndex((e) => e.startIndex <= index && index < e.endIndex);
    const def = (tab.documentTab.dropdownDefinitions || {})[q.dropdownDefinitionId];
    const option = def.dropdownDefinitionProperties.options.find((o) => o.optionId === q.selectedOptionId);
    const chip = { dropdown: { dropdownId: 'kix.chip' + (++chipCount), dropdownProperties: {
      dropdownDefinitionId: q.dropdownDefinitionId, selectedOptionId: q.selectedOptionId, displayValue: option.displayValue } } };
    const e = els[k];
    const offset = index - e.startIndex;
    if (e.textRun && offset > 0) {
      const after = { textRun: { content: e.textRun.content.slice(offset), textStyle: Object.assign({}, e.textRun.textStyle) } };
      e.textRun.content = e.textRun.content.slice(0, offset);
      els.splice(k + 1, 0, chip, after);
    } else {
      els.splice(k, 0, chip);
    }
    return { insertDropdown: { dropdownId: chip.dropdown.dropdownId } };
  }

  if (kind === 'updateParagraphStyle') {
    paragraphsOver(q.range).forEach((p) => {
      p.el.paragraph.paragraphStyle = Object.assign({}, p.el.paragraph.paragraphStyle || {}, pick(q.paragraphStyle, q.fields));
    });
    return {};
  }

  if (kind === 'updateTableCellStyle' || kind === 'mergeTableCells') {
    const where = q.tableRange.tableCellLocation;
    const table = tableAt(where);
    const { rowSpan, columnSpan } = q.tableRange;
    for (let row = where.rowIndex; row < where.rowIndex + rowSpan; row++) {
      for (let col = where.columnIndex; col < where.columnIndex + columnSpan; col++) {
        const cell = table.tableRows[row].tableCells[col];
        const now = cell.tableCellStyle || { rowSpan: 1, columnSpan: 1 };
        cell.tableCellStyle = kind === 'mergeTableCells'
          ? Object.assign({}, now, { columnSpan: col === where.columnIndex ? columnSpan : 1 })
          : Object.assign({}, now, pick(q.tableCellStyle, q.fields));
      }
    }
    return {};
  }

  if (kind === 'updateTableColumnProperties') {
    const table = tableAt({ tableStartLocation: q.tableStartLocation });
    const columns = ((table.tableStyle = table.tableStyle || {}).tableColumnProperties = table.tableStyle.tableColumnProperties || []);
    q.columnIndices.forEach((i) => { columns[i] = Object.assign({}, columns[i] || {}, pick(q.tableColumnProperties, q.fields)); });
    return {};
  }

  if (kind === 'updateTableRowStyle') {
    const table = tableAt({ tableStartLocation: q.tableStartLocation });
    q.rowIndices.forEach((i) => { table.tableRows[i].tableRowStyle = Object.assign({}, table.tableRows[i].tableRowStyle || {}, pick(q.tableRowStyle, q.fields)); });
    return {};
  }

  if (kind === 'updateTextStyle') {
    if (!(q.range.endIndex > q.range.startIndex)) throw new Error('Invalid requests[0].updateTextStyle: The range should not be empty.');
    const fields = String(q.fields).split(',');
    paragraphsOver(q.range).forEach((p) => {
      const out = [];
      p.el.paragraph.elements.forEach((e) => {
        const from = Math.max(q.range.startIndex, e.startIndex);
        const to = Math.min(q.range.endIndex, e.endIndex);
        if (from >= to || !e.textRun) return out.push(e);
        const piece = (a, b, inRange) => {
          if (a >= b) return;
          const textStyle = Object.assign({}, e.textRun.textStyle);
          if (inRange) fields.forEach((f) => { if (q.textStyle[f] === undefined) delete textStyle[f]; else textStyle[f] = q.textStyle[f]; });
          out.push({ textRun: { content: e.textRun.content.slice(a - e.startIndex, b - e.startIndex), textStyle } });
        };
        piece(e.startIndex, from, false);
        piece(from, to, true);
        piece(to, e.endIndex, false);
      });
      p.el.paragraph.elements = out;
    });
    return {};
  }

  if (kind === 'insertText') {
    const index = q.location.index;
    const p = paragraphAt(index);
    const els = p.el.paragraph.elements;
    let k = els.findIndex((e) => e.startIndex <= index && index < e.endIndex);
    let offset = index - els[k].startIndex;
    // Typed text takes the look of the text just before it; at the start of a line, of what follows.
    if (offset === 0 && k > 0 && els[k - 1].textRun) { k--; offset = els[k].textRun.content.length; }
    if (!els[k].textRun) els.splice(k, 0, { textRun: { content: '', textStyle: {} } }); // in front of a chip
    const run = els[k].textRun;
    run.content = run.content.slice(0, offset) + q.text + run.content.slice(offset);
    splitLines(p);
    return {};
  }

  if (kind === 'deleteContentRange') {
    const { startIndex, endIndex } = q.range;
    if (!(endIndex > startIndex)) throw new Error('Invalid requests[0].' + kind + ': The range should not be empty.');
    const p = paragraphAt(startIndex);
    if (endIndex > p.el.endIndex) throw new Error('the fake Docs API only edits inside one paragraph');
    const deleting = kind === 'deleteContentRange';
    if (deleting && endIndex === p.el.endIndex) {
      if (p.i < p.list.length - 1) throw new Error('the fake Docs API only edits inside one paragraph');
      throw new Error('Invalid requests[0].deleteContentRange: The range cannot include the newline character at the end of the segment.');
    }
    const fields = deleting ? [] : String(q.fields).split(',');
    const out = [];
    p.el.paragraph.elements.forEach((e) => {
      const from = Math.max(startIndex, e.startIndex);
      const to = Math.min(endIndex, e.endIndex);
      if (from >= to) return out.push(e);
      if (!e.textRun) { if (!deleting) out.push(e); return; }
      const piece = (a, b, inRange) => {
        if (a >= b || (inRange && deleting)) return;
        const textStyle = Object.assign({}, e.textRun.textStyle);
        if (inRange) fields.forEach((f) => { if (q.textStyle[f] === undefined) delete textStyle[f]; else textStyle[f] = q.textStyle[f]; });
        out.push({ textRun: { content: e.textRun.content.slice(a - e.startIndex, b - e.startIndex), textStyle } });
      };
      piece(e.startIndex, from, false);
      piece(from, to, true);
      piece(to, e.endIndex, false);
    });
    p.el.paragraph.elements = out;
    return {};
  }

  if (kind === 'insertTableRow') {
    const table = tableAt(q.tableCellLocation);
    const row = q.tableCellLocation.rowIndex;
    table.tableRows.splice(row + (q.insertBelow ? 1 : 0), 0, { tableCells: table.tableRows[row].tableCells.map(copiedCell) });
    table.rows = table.tableRows.length;
    return {};
  }

  if (kind === 'deleteTableRow') {
    const table = tableAt(q.tableCellLocation);
    table.tableRows.splice(q.tableCellLocation.rowIndex, 1);
    table.rows = table.tableRows.length;
    return {};
  }

  // insertTable: Google puts a line break in before the table, cutting the paragraph in two.
  const at = body.content.findIndex((x) => x.paragraph && x.startIndex <= q.location.index && q.location.index < x.endIndex);
  if (at < 0) throw new Error('Invalid requests[0].insertTable: Index ' + q.location.index + ' is not inside a paragraph of the body.');
  applyEdit(find, { insertText: { text: '\n', location: q.location } });
  const emptyCell = () => ({ content: [{ paragraph: { elements: [{ textRun: { content: '\n', textStyle: {} } }] } }] });
  const tableRows = Array.from({ length: q.rows }, () => ({ tableCells: Array.from({ length: q.columns }, emptyCell) }));
  body.content.splice(at + 1, 0, { table: { rows: q.rows, columns: q.columns, tableRows } });
  return {};
}

// ---- Looking at the fake Doc the way a person would ----

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const elementsOf = (cell) => [].concat(...((cell && cell.content) || []).map((p) => (p.paragraph && p.paragraph.elements) || []));
const textOf = (cell) => elementsOf(cell).map((e) => (e.textRun ? e.textRun.content : '')).join('').replace(/\n$/, '');
const linkOf = (cell) => {
  const el = elementsOf(cell).find((e) => e.textRun && e.textRun.textStyle && e.textRun.textStyle.link);
  return el ? el.textRun.textStyle.link.url : null;
};
const chipOf = (cell) => {
  const el = elementsOf(cell).find((e) => e.dropdown);
  return el ? el.dropdown.dropdownProperties.displayValue : null;
};
const statusOf = (cell) => chipOf(cell) || textOf(cell);
// The style names on each stretch of a cell's text, in order: ['bold,foregroundColor', ...].
const stylesOf = (cell) => elementsOf(cell).filter((e) => e.textRun && e.textRun.content !== '\n').map((e) => Object.keys(e.textRun.textStyle || {}).sort().join());

// Which table this is: 'day', 'class' or 'weekend'; 'old day', 'old class' or 'old staff' for the
// layout from before November 2026.
function kindOf(table) {
  const second = table.tableRows[0] && table.tableRows[0].tableCells[1] ? textOf(table.tableRows[0].tableCells[1]) : '';
  if (table.columns >= 6) return second === 'Course' ? 'old day' : 'old class';
  if (table.columns === 5) return 'old staff';
  if (table.columns === 3) return 'weekend';
  return second === 'Class' ? 'day' : 'class';
}
const weekTabs = (docs) => docs.service.Documents.get().tabs[0].childTabs;
// The week tab itself (not a copy), so a test can change it the way staff would.
function liveTab(docs, weekTitle) {
  const tab = weekTabs(docs).find((x) => x.tabProperties.title === weekTitle);
  if (!tab) throw new Error('no week tab called ' + weekTitle);
  return docs.find(tab.tabProperties.tabId);
}
const tablesIn = (tab, kind) => (tab.documentTab.body.content || []).filter((e) => e.table && (!kind || kindOf(e.table) === kind)).map((e) => e.table);

/**
 * Every row that links to assignment `u`, By Class copies first, then By Day:
 * { week, table: 'class' | 'day', title, reason (the gray line under a kept row's title), klass,
 *   due (By Class only), status, note }.
 */
function rowsOf(docs, u) {
  const out = [];
  weekTabs(docs).forEach((tab) => {
    const found = { class: [], day: [] };
    tablesIn(tab).forEach((table) => {
      const kind = kindOf(table);
      const which = kind.replace('old ', '');
      if (which !== 'class' && which !== 'day') return;
      const [statusAt, noteAt] = kind === which ? [2, 3] : [4, 5];
      table.tableRows.forEach((r) => {
        const c = r.tableCells;
        if (c.length <= noteAt || linkOf(c[0]) !== u) return;
        const lines = textOf(c[0]).split('\n');
        found[which].push({ week: tab.tabProperties.title, table: which, title: lines[0], reason: lines.slice(1).join('\n'),
          klass: which === 'day' ? textOf(c[1]) : textOf(table.tableRows[0].tableCells[0]), due: which === 'day' ? '' : textOf(c[1]),
          status: statusOf(c[statusAt]), note: textOf(c[noteAt]) });
      });
    });
    out.push(...found.class, ...found.day);
  });
  return out;
}
const copiesOf = (docs, u) => rowsOf(docs, u).map((r) => ({ week: r.week, table: r.table, status: r.status, note: r.note }));

/**
 * Staff set the Status and Note of assignment `u` in one table ('class' or 'day') of a week. One of
 * the three choices is picked from the chip; anything else is typed (the way it was before the
 * dropdown, or over a chip staff deleted).
 */
function staffTypes(docs, weekTitle, u, kind, status, note) {
  tablesIn(liveTab(docs, weekTitle)).forEach((table) => {
    const k = kindOf(table);
    if (k.replace('old ', '') !== kind) return;
    const [statusAt, noteAt] = k === kind ? [2, 3] : [4, 5];
    table.tableRows.forEach((r) => {
      if (r.tableCells.length <= noteAt || linkOf(r.tableCells[0]) !== u) return;
      r.tableCells[statusAt] = k === kind && STATUS_IDS[status] ? chipCell(status) : typed(status);
      r.tableCells[noteAt] = typed(note);
    });
  });
}

/**
 * The rows under each day of a week's By Day table, top to bottom:
 * { day, kind: 'canvas' | 'todo' | 'blank', assignment, klass, status, chip (true if the Status cell
 *   holds a chip), notes }. A Canvas row is one whose link is also in a By Class table.
 */
function dayRowsOf(docs, weekTitle) {
  const tab = liveTab(docs, weekTitle);
  const classLinks = [].concat(...tablesIn(tab, 'class').map((t) => t.tableRows.map((r) => linkOf(r.tableCells[0])))).filter(Boolean);
  const out = [];
  let day = '';
  tablesIn(tab, 'day')[0].tableRows.slice(1).forEach((r) => {
    const c = r.tableCells;
    const text = textOf(c[0]);
    const more = c.slice(1).some((x) => textOf(x) || chipOf(x));
    if (DAYS.includes(text) && !more) { day = text; return; }
    const kind = classLinks.includes(linkOf(c[0])) ? 'canvas' : (text === ADD_TODO && !more ? 'blank' : 'todo');
    out.push({ day, kind, assignment: text, klass: textOf(c[1]), status: statusOf(c[2]), chip: !!chipOf(c[2]), notes: textOf(c[3]), row: r });
  });
  return out;
}
/** A short picture of By Day for asserting on: { Monday: ['canvas Essay', 'todo Pack bag', 'blank'], ... }. */
function dayPlan(docs, weekTitle) {
  const plan = {};
  dayRowsOf(docs, weekTitle).forEach((r) => { (plan[r.day] = plan[r.day] || []).push(r.kind === 'blank' ? 'blank' : r.kind + ' ' + r.assignment); });
  return plan;
}

// ---- Staff adding their own to-dos and weekend plans ----

const dayStart = (table, day) => {
  const at = table.tableRows.findIndex((r, i) => i > 0 && textOf(r.tableCells[0]) === day && !r.tableCells.slice(1).some((x) => textOf(x) || chipOf(x)));
  if (at < 0) throw new Error('By Day has no ' + day);
  return at;
};

/**
 * Staff type a to-do into a day's "+ Add a to-do" row: cells = [assignment, class, notes], each a
 * string or { text, runs }. What's typed over AutoPlanner's gray italic words comes out gray and
 * italic too, as in a real Doc. { beside: true } types next to those words instead of over them.
 */
function staffAddsTodo(docs, weekTitle, day, cells, how) {
  const table = tablesIn(liveTab(docs, weekTitle), 'day')[0];
  let at = dayStart(table, day) + 1;
  while (at < table.tableRows.length && textOf(table.tableRows[at].tableCells[0]) !== ADD_TODO) at++;
  if (at >= table.tableRows.length) throw new Error(day + ' has no blank row');
  const first = rich(cells[0] || '');
  const row = table.tableRows[at].tableCells;
  // Nothing to type in Assignment: its gray words stay, as when staff only type a class or a note.
  if (first.text) row[0] = richCell(how && how.beside ? { text: ADD_TODO + ' ' + first.text, runs: [] } : first, MUTED_LOOK);
  if (cells[1]) row[1] = typed(cells[1]);
  if (cells[2]) row[3] = typed(cells[2]);
}

/**
 * Staff choose "Insert row below" inside a day and fill the new row in. `under` is how many of the
 * day's rows sit above the new one (0 = right under the day's own row). The new row has no chip
 * unless `how.status` is given. { copied: true } makes it the row a real Doc gives below an
 * assignment (seen 2026-11-10): its own chip on Need to Start, and what's typed in Assignment takes
 * the look of the link above it (blue and underlined, but no link).
 */
function staffInsertsRow(docs, weekTitle, day, under, cells, how) {
  const opts = how || {};
  const status = opts.status || (opts.copied ? 'Need to Start' : '');
  const table = tablesIn(liveTab(docs, weekTitle), 'day')[0];
  const assignment = opts.copied ? richCell(rich(cells[0] || ''), LINK_LOOK) : typed(cells[0] || '');
  const row = { tableCells: [assignment, typed(cells[1] || ''), status ? chipCell(status) : typed(''), typed(cells[2] || '')] };
  table.tableRows.splice(dayStart(table, day) + 1 + under, 0, row);
  table.rows = table.tableRows.length;
}

/** The By Day row whose Assignment cell says `text` (the row itself: set its tableCells to change it). */
function dayRow(docs, weekTitle, text) {
  const hit = dayRowsOf(docs, weekTitle).find((r) => r.assignment === text);
  if (!hit) throw new Error('no By Day row says ' + text);
  return hit.row;
}

/** A week's Weekend plan as text: { Saturday: [[label, assignment, notes], ...], Sunday: [...] }. */
function weekendOf(docs, weekTitle) {
  const out = {};
  tablesIn(liveTab(docs, weekTitle), 'weekend').forEach((table) => {
    out[textOf(table.tableRows[0].tableCells[0])] = table.tableRows.slice(1).map((r) => r.tableCells.map(textOf));
  });
  return out;
}

/** Staff type into the Weekend plan: day 'Saturday' or 'Sunday', part 'Morning' ..., column 1 (Assignment) or 2 (Notes). */
function staffPlansWeekend(docs, weekTitle, day, part, column, cell) {
  const table = tablesIn(liveTab(docs, weekTitle), 'weekend').find((t) => textOf(t.tableRows[0].tableCells[0]) === day);
  const row = table.tableRows.find((r) => textOf(r.tableCells[0]) === part);
  row.tableCells[column] = typed(cell);
}

// ---- The layout from before November 2026 ----

/**
 * A week tab the way AutoPlanner wrote it before November 2026: a six-column table per class, By
 * Day, then the five-column "Added by staff" table. Tests use it to check that an old Doc is
 * brought into the new layout without losing anything.
 *   groups:    [{ course, assignments: [{ assignment, url, day, due_time, course }] }]
 *   saved:     { status: { url: text }, notes: { url: text } } (Status was typed then)
 *   staffRows: rows of five cells (strings or { text, runs }); two empty rows if left out
 */
function oldLayoutContent(groups, saved, staffRows) {
  const st = (u) => (saved && saved.status[u]) || 'Not started';
  const nt = (u) => (saved && saved.notes[u]) || '';
  const row = (a, middle) => ({ tableCells: [tcell(a.assignment, a.url), tcell(middle), tcell(a.due_time), tcell('Upcoming'), tcell(st(a.url)), tcell(nt(a.url))] });
  const content = [];
  const all = [];
  groups.forEach((g) => {
    const rows = [{ tableCells: [tcell(g.course)] }, { tableCells: ['Assignment', 'Day', 'Due Time', 'Priority', 'Status', 'Notes'].map((x) => tcell(x)) }];
    g.assignments.forEach((a) => { rows.push(row(a, a.day)); all.push(a); });
    content.push({ table: { columns: 6, tableRows: rows } });
  });
  const dayRows = [{ tableCells: ['Assignment', 'Course', 'Due Time', 'Priority', 'Status', 'Notes'].map((x) => tcell(x)) }];
  DAYS.forEach((d) => {
    const due = all.filter((a) => a.day === d);
    if (due.length) dayRows.push({ tableCells: [tcell(d)].concat([1, 2, 3, 4, 5].map(() => tcell(''))) });
    due.forEach((a) => dayRows.push(row(a, a.course)));
  });
  content.push({ table: { columns: 6, tableRows: dayRows } });
  content.push(para(''), para('Added by staff'), para('Add anything not on Canvas here. AutoPlanner never changes this table.'));
  const rows = staffRows && staffRows.length ? staffRows : [0, 1].map(() => ['', '', '', '', '']);
  content.push({ table: { columns: 5, tableRows: [{ tableCells: ['Assignment', 'Class', 'Day', 'Status', 'Notes'].map((x) => tcell(x)) }]
    .concat(rows.map((cells) => ({ tableCells: cells.map((c) => richCell(typeof c === 'string' ? { text: c, runs: [] } : c)) }))) } });
  content.push(para(''));
  return content;
}

module.exports = {
  fakeDocs, withRendering, renderBlocks, copiesOf, rowsOf, staffTypes, richCell, tcell, typed, chipCell, para,
  dayRowsOf, dayPlan, dayRow, staffAddsTodo, staffInsertsRow, weekendOf, staffPlansWeekend, oldLayoutContent,
  liveTab, tablesIn, kindOf, textOf, linkOf, chipOf, stylesOf, numberTab, ADD_TODO, MUTED_LOOK,
};
