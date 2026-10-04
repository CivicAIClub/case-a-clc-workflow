'use strict';
// Tests for apps_script/Code.gs (the Doc writer): the shared-folder rules and keeping Status.
// The Docs API is faked; all names are made up.
const test = require('node:test');
const assert = require('node:assert');
const { createSandbox, toPlain } = require('./helpers/gas-sandbox');
const { fakeServices } = require('./helpers/gas-services');

function setup(props, opts) {
  const svc = fakeServices({ owner: 'owner@pomfret.org', props: props || {} });
  const calls = [];
  const emptyTab = () => ({
    tabs: [{
      tabProperties: { tabId: 't.0', title: 'Tab 1' },
      documentTab: { body: { content: [{ startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } }] } },
    }],
  });
  const globals = Object.assign({}, svc.globals, {
    DocumentApp: {
      create: (name) => {
        calls.push(['create', name]);
        svc.addFile('NEW_DOC', name, null);
        return { getId: () => 'NEW_DOC', getUrl: () => 'https://docs/NEW_DOC' };
      },
      openById: (id) => {
        calls.push(['openById', id]);
        return { setName: (n) => calls.push(['setName', n]), getUrl: () => 'https://docs/' + id };
      },
    },
    Docs: { Documents: { get: () => emptyTab(), batchUpdate: () => ({ replies: [] }) } },
  });
  if (opts && opts.badFolder) {
    globals.DriveApp = Object.assign({}, globals.DriveApp, {
      getFolderById: () => { throw new Error('No item with the given ID could be found'); },
    });
  }
  const sb = createSandbox({ files: ['apps_script/Code.gs'], globals });
  return { svc, ctx: sb.context, calls, names: () => calls.map((c) => c[0]) };
}

const base = { weeks: {}, total_assignments: 0, generated_at: 'x', studentFullName: 'Test Student' };

test('no folder set: a new Doc stays in My Drive', () => {
  const t = setup();
  assert.deepStrictEqual(toPlain(t.ctx.upsertPlannerDocument_(base)), { docUrl: 'https://docs/NEW_DOC', documentId: 'NEW_DOC' });
  assert.strictEqual(t.svc.files.NEW_DOC.parent, null);
});

test('folder set (as a URL): the new Doc is created and moved into it', () => {
  const t = setup({ DOCS_FOLDER_ID: 'https://drive.google.com/drive/folders/FOLDER123?usp=sharing' });
  t.ctx.upsertPlannerDocument_(base);
  assert.strictEqual(t.svc.files.NEW_DOC.parent, 'FOLDER123');
  assert.deepStrictEqual(t.calls[0], ['create', 'Test Student - CLC Assignments']);
});

test('folder set: a Doc inside it is updated in place', () => {
  const t = setup({ DOCS_FOLDER_ID: 'FOLDER123' });
  t.svc.addFile('IN_DOC', 'Test Student - CLC Assignments', 'FOLDER123');
  assert.strictEqual(t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'IN_DOC' }, base)).documentId, 'IN_DOC');
  assert.ok(t.names().includes('openById') && !t.names().includes('create'));
});

test('folder set: a Doc outside it, or an unknown ID, is refused before it is opened', () => {
  const t = setup({ DOCS_FOLDER_ID: 'FOLDER123' });
  t.svc.addFile('OUT_DOC', 'Secret plans', 'OTHER');
  assert.throws(
    () => t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'OUT_DOC' }, base)),
    (err) => /only updates Docs in the "AutoPlanner – CLC Student Planners" folder/.test(err.message) &&
      !/Secret plans/.test(err.message)
  );
  assert.throws(() => t.ctx.upsertPlannerDocument_(Object.assign({ documentId: 'NOPE' }, base)), /Could not open the saved Google Doc/);
  assert.ok(!t.names().includes('openById') && !t.names().includes('setName'));
});

test('folder ID that cannot be opened: clear error, and no stray Doc is created', () => {
  const t = setup({ DOCS_FOLDER_ID: 'BAD' }, { badFolder: true });
  assert.throws(() => t.ctx.upsertPlannerDocument_(base), /DOCS_FOLDER_ID is set, but this account cannot open/);
  assert.ok(!t.names().includes('create'));
});

test('a Status typed in either table survives, and the untouched default never overwrites it', () => {
  const t = setup();
  const URL = 'https://pomfret.instructure.com/courses/1/assignments/1';
  const cell = (text, link) => ({ content: [{ paragraph: { elements: [{ textRun: { content: text + '\n', textStyle: link ? { link: { url: link } } : {} } }] } }] });
  const row = (status, note) => ({ tableCells: [cell('Essay draft', URL), cell('x'), cell('x'), cell('x'), cell(status), cell(note)] });
  const table = (status, note) => ({ table: { columns: 6, tableRows: [row(status, note)] } });
  const read = (content) => toPlain(t.ctx.readExistingDataFromTab_({ documentTab: { body: { content } } }));
  assert.strictEqual(read([table('✅ Complete', ''), table('⬜ Not started', '')]).status[URL], '✅ Complete');
  assert.strictEqual(read([table('⬜ Not started', ''), table('✅ Complete', '')]).status[URL], '✅ Complete');
  assert.strictEqual(read([table('⬜ Not started', 'Needs extension'), table('⬜ Not started', '')]).notes[URL], 'Needs extension');
});
