'use strict';
// Realistic tab content: the JSON a real Docs API read with DOCS_GET_FIELDS returns for a tab,
// with start/end indices, merged cells kept as cells, day rows, "No assignments" rows, heading
// paragraphs and the text styles seen in tests/fixtures/live-week-tab-read.json. Built from the
// same inputs buildWeekTabRequests_ gets. Validated against the masked live fixture (calibrate.js).

const C_DATA = () => ({ color: { rgbColor: { blue: 0.12941177, green: 0.12941177, red: 0.12941177 } } });
const C_WHITE = () => ({ color: { rgbColor: { blue: 1, green: 1, red: 1 } } });
const C_MUTED = () => ({ color: { rgbColor: { blue: 0.4, green: 0.4, red: 0.4 } } });
const C_HELP = () => ({ color: { rgbColor: { blue: 0.26666668, green: 0.26666668, red: 0.26666668 } } });
const C_LINK = () => ({ color: { rgbColor: { blue: 0.9098039, green: 0.4509804, red: 0.101960786 } } });

const DOC_STYLE = () => ({ pageSize: { height: { magnitude: 792, unit: 'PT' }, width: { magnitude: 612, unit: 'PT' } },
  marginLeft: { magnitude: 72, unit: 'PT' }, marginRight: { magnitude: 72, unit: 'PT' } });

const el = (text, style) => ({ startIndex: 0, endIndex: 0, textRun: { content: text, textStyle: style || {} } });
const para = (elements) => ({ startIndex: 0, endIndex: 0, paragraph: { elements } });
const p1 = (text, style) => para([el(text, style)]);
const cell = (paras) => ({ startIndex: 0, endIndex: 0, content: paras });
const row = (cells) => ({ startIndex: 0, endIndex: 0, tableCells: cells });
const table = (rows, C) => ({ startIndex: 0, endIndex: 0, table: { rows: rows.length, columns: C, tableRows: rows } });
const sectionBreak = () => ({ endIndex: 1, sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS' } } });

const plainCell = (text, style) => cell([p1((text || '') + '\n', style || { foregroundColor: C_DATA() })]);
const emptyCell = () => plainCell('', { foregroundColor: C_DATA() });

/** Sets every startIndex/endIndex from the text, the way Docs numbers a body. Returns the end index. */
function reindex(content) {
  let pos = 0;
  const doPara = (se) => {
    se.startIndex = pos;
    se.paragraph.elements.forEach((e) => { e.startIndex = pos; pos += e.textRun.content.length; e.endIndex = pos; });
    se.endIndex = pos;
  };
  content.forEach((se) => {
    if (se.sectionBreak) { se.endIndex = 1; pos = 1; return; }
    if (se.paragraph) return doPara(se);
    if (se.table) {
      se.startIndex = pos; pos += 1;
      se.table.tableRows.forEach((r) => {
        r.startIndex = pos; pos += 1;
        r.tableCells.forEach((c) => {
          c.startIndex = pos; pos += 1;
          c.content.forEach(doPara);
          c.endIndex = pos;
        });
        r.endIndex = pos;
      });
      pos += 1;
      se.endIndex = pos;
    }
  });
  return pos;
}

function emptyTabContent() {
  const c = [sectionBreak(), p1('\n', {})];
  reindex(c);
  return c;
}

function textTabContent(text) {
  const c = [sectionBreak(), p1(text + '\n', {})];
  reindex(c);
  return c;
}

// A 6-column table like appendTable_ writes: rows of kind title/group/header/empty/item.
function sixTable(rows) {
  return table(rows.map((r) => {
    if (r.kind === 'title' || r.kind === 'group') {
      return row([plainCell(r.cells[0], { bold: true, foregroundColor: C_DATA() })].concat([1, 2, 3, 4, 5].map(emptyCell)));
    }
    if (r.kind === 'empty') {
      return row([plainCell(r.cells[0], { italic: true, foregroundColor: C_MUTED() })].concat([1, 2, 3, 4, 5].map(emptyCell)));
    }
    if (r.kind === 'header') {
      return row(r.cells.map((h) => plainCell(h, { bold: true, foregroundColor: C_WHITE() })));
    }
    // item
    const first = r.url && r.cells[0]
      ? cell([para([el(r.cells[0], { underline: true, link: { url: r.url }, foregroundColor: C_LINK() }), el('\n', { foregroundColor: C_LINK() })])])
      : plainCell(r.cells[0]);
    return row([first].concat(r.cells.slice(1).map((t) => plainCell(t))));
  }), 6);
}

// One staff cell { text, runs } as Docs returns it after appendStaffTable_ wrote it: the table's
// DATA color everywhere, plus each run's own styles. Paragraph breaks in the text become paragraphs.
function staffCell(c) {
  const text = (c && c.text) || '';
  const runs = (c && c.runs) || [];
  const cuts = new Set([0, text.length]);
  runs.forEach((r) => { cuts.add(r.s); cuts.add(r.e); });
  text.split('').forEach((ch, i) => { if (ch === '\n') { cuts.add(i); cuts.add(i + 1); } });
  const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  const paras = [];
  let cur = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [s, e] = [pts[i], pts[i + 1]];
    const piece = text.slice(s, e);
    if (piece === '\n') { cur.push(el('\n', { foregroundColor: C_DATA() })); paras.push(para(cur)); cur = []; continue; }
    const style = { foregroundColor: C_DATA() };
    runs.filter((r) => r.s <= s && e <= r.e).forEach((r) => {
      Object.assign(style, JSON.parse(JSON.stringify(r.style)));
      if (r.style.link && style.underline === undefined) style.underline = true;
    });
    cur.push(el(piece, style));
  }
  cur.push(el('\n', { foregroundColor: C_DATA() }));
  // merge the last newline into the previous run when it has the plain style (as Docs shows it)
  if (cur.length >= 2) {
    const prev = cur[cur.length - 2];
    const ps = prev.textRun.textStyle;
    if (Object.keys(ps).length === 1 && ps.foregroundColor && JSON.stringify(ps) === JSON.stringify({ foregroundColor: C_DATA() })) {
      prev.textRun.content += '\n';
      cur.pop();
    }
  }
  paras.push(para(cur));
  return cell(paras);
}

function staffTable(staffRows, headers) {
  const data = staffRows && staffRows.length ? staffRows : [0, 1].map(() => [0, 1, 2, 3, 4].map(() => ({ text: '', runs: [] })));
  const rows = [row(headers.map((h) => plainCell(h, { bold: true, foregroundColor: C_WHITE() })))];
  data.forEach((r) => rows.push(row([0, 1, 2, 3, 4].map((c) => staffCell(r[c] || { text: '', runs: [] })))));
  return table(rows, 5);
}

/**
 * The week tab's body content, from the same inputs as buildWeekTabRequests_ (ctx: the sandbox,
 * for the real grouping helpers). Mirrors the layout the requests produce.
 */
function renderWeekTab(ctx, weekKey, weekData, courses, saved, staffRows) {
  const P = (x) => JSON.parse(JSON.stringify(x));
  const days = P(weekData.days || []);
  const cellText = (v) => ctx.cellText_(v);
  const content = [sectionBreak()];
  content.push(p1('Week of ' + (weekData.week_label || weekKey) + '\n', {}));
  content.push(p1('Assignments in this week: ' + ctx.countAssignmentsInWeek_(days) + '\n', { italic: true, foregroundColor: C_DATA() }));
  content.push(p1(ctx.STATUS_HELP_LINE + '\n', { foregroundColor: C_HELP() }));
  content.push(p1('By Class\n', {}));
  const item = (a, middle) => {
    const url = a.url || '';
    const status = (url && saved.status[url]) || ctx.STATUS_DEFAULT;
    const note = (url && saved.notes[url]) || '';
    return { kind: 'item', cells: [a.assignment, middle, a.due_time, a.priority, status, note].map(cellText), url };
  };
  P(ctx.groupAssignmentsByCourse_(days, courses)).forEach((g) => {
    const rows = [{ kind: 'title', cells: [cellText(g.course)] }, { kind: 'header', cells: P(ctx.BY_CLASS_HEADERS) }];
    if (!g.assignments.length) rows.push({ kind: 'empty', cells: [ctx.NO_ASSIGNMENTS_TEXT] });
    g.assignments.forEach((a) => rows.push(item(a, a.day)));
    content.push(sixTable(rows));
    content.push(p1('\n', {}));
  });
  content.push(p1('By Day\n', {}));
  const dayRows = [{ kind: 'header', cells: P(ctx.BY_DAY_HEADERS) }];
  P(ctx.flattenAndGroupByDay_(days)).forEach((g) => {
    dayRows.push({ kind: 'group', cells: [cellText(g.day)] });
    g.assignments.forEach((a) => dayRows.push(item(a, a.course)));
  });
  if (dayRows.length === 1) dayRows.push({ kind: 'empty', cells: [ctx.NO_ASSIGNMENTS_TEXT] });
  content.push(sixTable(dayRows));
  content.push(p1('\n', {}));
  content.push(p1(ctx.STAFF_TITLE + '\n', {}));
  content.push(p1(ctx.STAFF_HELP_LINE + '\n', { foregroundColor: C_HELP() }));
  content.push(staffTable(staffRows, P(ctx.STAFF_HEADERS)));
  content.push(p1('\n', {}));
  reindex(content);
  return content;
}

/** The home tab, approximately as buildHomeTabRequests_ lays it out (no live fixture for it). */
function renderHomeTab(ctx, summary, weekTabId) {
  const content = [sectionBreak()];
  const plural = (n) => n + ' assignment' + (n === 1 ? '' : 's');
  let summaryLine;
  if (summary.weekend) {
    summaryLine = (summary.weekCount ? plural(summary.weekCount) + ' in the coming week' : 'Nothing is due in the coming week') +
      ' · ' + (summary.soonCount ? summary.soonCount + ' due this weekend.' : 'Nothing due this weekend.');
  } else {
    summaryLine = summary.weekCount
      ? plural(summary.weekCount) + ' this week · ' + summary.soonCount + ' due today or tomorrow.'
      : 'Nothing is due this week. ' + summary.soonCount + ' due today or tomorrow.';
  }
  if (summary.staffCount) summaryLine = summaryLine.replace(/\.$/, '') + ' · ' + summary.staffCount + ' added by staff.';
  content.push(p1(summary.name + '\n', {}));
  content.push(p1(ctx.HOME_SUBTITLE + '\n', { bold: true, foregroundColor: C_MUTED() }));
  if (summary.teacherName) content.push(p1('CLC teacher: ' + summary.teacherName + '\n', { foregroundColor: C_HELP() }));
  content.push(p1('Last updated ' + summary.updated + '\n', { foregroundColor: C_HELP() }));
  content.push(p1(summary.heading + '\n', {}));
  content.push(p1(summaryLine + '\n', { foregroundColor: C_DATA() }));
  if (weekTabId) content.push(para([el(summary.weekend ? 'Open the coming week →' : 'Open this week →', { underline: true, link: { tabId: weekTabId }, foregroundColor: C_LINK() }), el('\n', {})]));
  if (!summary.rows.length) {
    content.push(p1('No current classes found in Canvas.\n', {}));
    content.push(p1('\n', {}));
  } else {
    const headers = ctx.HOME_CLASS_HEADERS.slice();
    if (summary.weekend) headers[1] = 'Coming week';
    const rows = [row(headers.map((h) => plainCell(h, { bold: true, foregroundColor: C_WHITE() })))];
    summary.rows.forEach((r) => rows.push(row([plainCell(ctx.cellText_(r.name)), plainCell(String(r.count)), plainCell(r.next)])));
    content.push(table(rows, 3));
  }
  const legend = [];
  ctx.HOME_PRIORITY_RULES.forEach((r, i) => {
    if (i) legend.push(el('   ', { foregroundColor: C_DATA() }));
    legend.push(el(ctx.HOME_SWATCH, { backgroundColor: { color: { rgbColor: { red: 0.6, green: 0.6, blue: 0.6 } } }, foregroundColor: C_DATA() }));
    legend.push(el(' ' + r[1], { foregroundColor: C_DATA() }));
  });
  legend.push(el('\n', {}));
  content.push(p1('HOW THIS DOC WORKS\n', {}));
  ctx.HOME_HOW_LINES.forEach((l) => content.push(p1(l + '\n', { foregroundColor: C_DATA() })));
  content.push(p1('PRIORITY COLORS\n', {}));
  content.push(para(legend));
  content.push(p1(ctx.HOME_FOOTER + '\n', { foregroundColor: C_MUTED() }));
  reindex(content);
  return content;
}

// ---- Reading cells (by link) and typing into them, the way staff do in the real Doc -------------
function cellText(c) {
  let t = '';
  (c.content || []).forEach((se) => (se.paragraph ? se.paragraph.elements : []).forEach((e) => { if (e.textRun) t += e.textRun.content; }));
  return t.replace(/\n$/, '');
}
function cellLink(c) {
  for (const se of c.content || []) {
    for (const e of (se.paragraph ? se.paragraph.elements : [])) {
      if (e.textRun && e.textRun.textStyle && e.textRun.textStyle.link && e.textRun.textStyle.link.url) return e.textRun.textStyle.link.url;
    }
  }
  return null;
}
function isDayTable(t) {
  return t.tableRows.slice(0, 2).some((r) => r.tableCells.length > 1 && cellText(r.tableCells[1]) === 'Course');
}
/** Every assignment row in a week tab: { url, kind: 'class'|'day', status, note, title }. */
function assignmentRows(content) {
  const out = [];
  (content || []).forEach((se) => {
    if (!se.table || se.table.columns < 6) return;
    const day = isDayTable(se.table);
    se.table.tableRows.forEach((r) => {
      if (r.tableCells.length < 6) return;
      const url = cellLink(r.tableCells[0]);
      if (!url) return;
      out.push({ url, kind: day ? 'day' : 'class', title: cellText(r.tableCells[0]), middle: cellText(r.tableCells[1]),
        priority: cellText(r.tableCells[3]), status: cellText(r.tableCells[4]), note: cellText(r.tableCells[5]), row: r });
    });
  });
  return out;
}
/** Staff type a Status and a Note into one table's row for this link. Returns rows changed. */
function typeStatusNote(content, url, kind, status, note) {
  let n = 0;
  assignmentRows(content).forEach((a) => {
    if (a.url !== url || a.kind !== kind) return;
    a.row.tableCells[4] = plainCell(status);
    a.row.tableCells[5] = plainCell(note);
    n++;
  });
  if (n) reindex(content);
  return n;
}
function staffTableOf(content) {
  let after = false;
  for (const se of content) {
    if (se.paragraph && se.paragraph.elements.map((e) => e.textRun ? e.textRun.content : '').join('').trim() === 'Added by staff') after = true;
    else if (se.table && after) return se.table;
  }
  const five = content.filter((se) => se.table && se.table.columns === 5);
  return five.length ? five[five.length - 1].table : null;
}
/** Staff type plain text into row r (0 = first under the header) of "Added by staff". */
function typeStaffRow(content, r, texts) {
  const t = staffTableOf(content);
  if (!t) return false;
  while (t.tableRows.length < r + 2) t.tableRows.push(row([0, 1, 2, 3, 4].map(emptyCell)));
  t.tableRows[r + 1] = row(texts.map((x) => plainCell(x)));
  t.rows = t.tableRows.length;
  reindex(content);
  return true;
}
function staffRowTexts(content) {
  const t = staffTableOf(content);
  if (!t) return null;
  return t.tableRows.slice(1).map((r) => r.tableCells.map(cellText));
}
function endIndexOf(content) {
  const last = content[content.length - 1];
  return last ? last.endIndex : 0;
}

module.exports = { reindex, emptyTabContent, textTabContent, renderWeekTab, renderHomeTab, assignmentRows, typeStatusNote,
  typeStaffRow, staffRowTexts, staffTableOf, endIndexOf, cellText, cellLink, DOC_STYLE, staffCell, plainCell };
