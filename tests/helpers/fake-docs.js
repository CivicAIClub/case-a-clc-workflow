'use strict';
// A stateful fake of the Google Docs API's tab handling, shared by the tests. Like the real API
// (checked live): every tab title in a Doc must be different, at any level; a batch is all or
// nothing; requests run in order. Text requests are recorded per tab (not rendered); with
// withRendering, each week tab's tables are laid out the way the real writer lays them out, so
// Status and Notes round-trip through updates and staff edits. All data is made up.

const { applyFieldMask } = require('./field-mask');

const tcell = (text, link) => ({ content: [{ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: link ? { link: { url: link } } : {} } }] } }] });

function fakeDocs(tabs) {
  const st = { tabs, written: {}, batches: [], n: 0, failOnFill: false };
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
    const loc = r.insertText && r.insertText.location;
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
  st.titles = (parentId) => kidsOf(parentId).map((t) => t.tabProperties.title);
  st.titleAnywhere = (re) => all().filter((t) => re.test(t.tabProperties.title)).map((t) => t.tabProperties.title);
  st.find = find;
  return st;
}

// The fake Doc lays out each week tab's tables (By Class per class, then By Day) the way the real
// writer does, so Status and Notes can round-trip through several updates and staff edits.
function withRendering(t, docs) {
  const realBuild = t.ctx.buildWeekTabRequests_;
  t.ctx.buildWeekTabRequests_ = (tabId, weekKey, weekData, courses, colorMap, saved, width, staffRows) => {
    const st = (u) => saved.status[u] || 'Not started';
    const nt = (u) => saved.notes[u] || '';
    const row = (a, middle) => ({ tableCells: [tcell(a.assignment, a.url), tcell(middle), tcell(a.due_time), tcell(a.priority), tcell(st(a.url)), tcell(nt(a.url))] });
    const content = [{ startIndex: 1, endIndex: 2, paragraph: { elements: [] } }];
    JSON.parse(JSON.stringify(t.ctx.groupAssignmentsByCourse_(weekData.days || [], courses))).forEach((g) => {
      const rows = [{ tableCells: [tcell(g.course)] }, { tableCells: ['Assignment', 'Day', 'Due Time', 'Priority', 'Status', 'Notes'].map((x) => tcell(x)) }];
      g.assignments.forEach((a) => rows.push(row(a, a.day)));
      content.push({ table: { columns: 6, tableRows: rows } });
    });
    const dayRows = [{ tableCells: ['Assignment', 'Course', 'Due Time', 'Priority', 'Status', 'Notes'].map((x) => tcell(x)) }];
    (weekData.days || []).forEach((d) => (d.assignments || []).forEach((a) => dayRows.push(row(a, a.course))));
    content.push({ table: { columns: 6, tableRows: dayRows } });
    // "Added by staff": heading, help line, then the 5-column table, rows exactly as given.
    const para = (text) => ({ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: {} } }] } });
    content.push(para(''), para('Added by staff'), para('Add anything not on Canvas here. AutoPlanner never changes this table.'));
    const rows = staffRows && staffRows.length ? staffRows : [0, 1].map(() => [0, 1, 2, 3, 4].map(() => ({ text: '', runs: [] })));
    content.push({ table: { columns: 5, tableRows: [{ tableCells: ['Assignment', 'Class', 'Day', 'Status', 'Notes'].map((x) => tcell(x)) }]
      .concat(rows.map((row) => ({ tableCells: row.map(richCell) }))) } });
    content.push(para(''));
    docs.find(tabId).documentTab.body.content = content;
    return realBuild(tabId, weekKey, weekData, courses, colorMap, saved, width, staffRows);
  };
}

// A cell from { text, runs }: one text run per styled stretch, as the Docs API returns them.
function richCell(cell) {
  const text = cell.text;
  const cuts = new Set([0, text.length]);
  (cell.runs || []).forEach((r) => { cuts.add(r.s); cuts.add(r.e); });
  const points = [...cuts].sort((a, b) => a - b);
  const elements = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [s, e] = [points[i], points[i + 1]];
    const style = {};
    (cell.runs || []).filter((r) => r.s <= s && e <= r.e).forEach((r) => Object.assign(style, r.style));
    elements.push({ textRun: { content: text.slice(s, e), textStyle: style } });
  }
  if (!elements.length) elements.push({ textRun: { content: '', textStyle: {} } });
  elements[elements.length - 1].textRun.content += '\n';
  return { content: [{ paragraph: { elements } }] };
}

/** Staff type into the "Added by staff" table of a week tab: row r (0 = first under the header). */
function staffWrites(docs, weekTitle, r, cells) {
  const tab = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === weekTitle);
  const live = docs.find(tab.tabProperties.tabId);
  const table = live.documentTab.body.content.filter((e) => e.table && e.table.columns === 5).pop().table;
  while (table.tableRows.length < r + 2) table.tableRows.push({ tableCells: [0, 1, 2, 3, 4].map(() => richCell({ text: '', runs: [] })) });
  table.tableRows[r + 1] = { tableCells: cells.map((c) => richCell(typeof c === 'string' ? { text: c, runs: [] } : c)) };
}

function copiesOf(docs, u) {
  const out = [];
  docs.service.Documents.get().tabs[0].childTabs.forEach((tab) => {
    (tab.documentTab.body.content || []).filter((e) => e.table).forEach((e) => {
      const isDay = e.table.tableRows[0].tableCells[1] && e.table.tableRows[0].tableCells[1].content[0].paragraph.elements[0].textRun.content === 'Course\n';
      e.table.tableRows.forEach((r) => {
        const c = r.tableCells;
        const link = c[0].content[0].paragraph.elements[0].textRun.textStyle;
        if (c.length === 6 && link && link.link && link.link.url === u) {
          const txt = (i) => c[i].content[0].paragraph.elements[0].textRun.content.replace(/\n$/, '');
          out.push({ week: tab.tabProperties.title, table: isDay ? 'day' : 'class', status: txt(4), note: txt(5) });
        }
      });
    });
  });
  return out;
}
/** Like copiesOf, with the middle cell (Day or Course), the Priority cell and the class table's title. */
function rowsOf(docs, u) {
  const out = [];
  const txt = (cell) => cell.content[0].paragraph.elements[0].textRun.content.replace(/\n$/, '');
  docs.service.Documents.get().tabs[0].childTabs.forEach((tab) => {
    (tab.documentTab.body.content || []).filter((e) => e.table && e.table.columns === 6).forEach((e) => {
      const rows = e.table.tableRows;
      const isDay = rows[0].tableCells[1] && txt(rows[0].tableCells[1]) === 'Course';
      rows.forEach((r) => {
        const c = r.tableCells;
        const link = c[0].content[0].paragraph.elements[0].textRun.textStyle;
        if (c.length === 6 && link && link.link && link.link.url === u) {
          out.push({ week: tab.tabProperties.title, table: isDay ? 'day' : 'class', klass: isDay ? txt(c[1]) : txt(rows[0].tableCells[0]),
            day: isDay ? '' : txt(c[1]), priority: txt(c[3]), status: txt(c[4]), note: txt(c[5]) });
        }
      });
    });
  });
  return out;
}
function staffTypes(docs, weekTitle, u, kind, status, note) {
  const tab = docs.service.Documents.get().tabs[0].childTabs.find((x) => x.tabProperties.title === weekTitle);
  const live = docs.find(tab.tabProperties.tabId);
  live.documentTab.body.content.filter((e) => e.table).forEach((e) => {
    const isDay = e.table.tableRows[0].tableCells[1] && e.table.tableRows[0].tableCells[1].content[0].paragraph.elements[0].textRun.content === 'Course\n';
    if ((kind === 'day') !== !!isDay) return;
    e.table.tableRows.forEach((r) => {
      const link = r.tableCells[0].content[0].paragraph.elements[0].textRun.textStyle;
      if (r.tableCells.length === 6 && link && link.link && link.link.url === u) { r.tableCells[4] = tcell(status); r.tableCells[5] = tcell(note); }
    });
  });
}


module.exports = { fakeDocs, withRendering, copiesOf, rowsOf, staffTypes, staffWrites, richCell, tcell };
