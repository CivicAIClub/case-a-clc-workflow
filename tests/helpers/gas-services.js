'use strict';
/**
 * gas-services.js: pretend versions of the Google services App.gs uses, for tests.
 *
 *   const svc = fakeServices({ owner: 'owner@pomfret.org', active: 'owner@pomfret.org' });
 *   const sb = createSandbox({ files: [...], globals: svc.globals });
 *   svc.setActive('staff@pomfret.org');   // who is "signed in" for the next call
 *
 * Provides PropertiesService (in memory), LockService, Session, ScriptApp (triggers),
 * HtmlService, DriveApp (one shared folder plus files), and Utilities with getUuid.
 */
const { formatDate } = require('./gas-sandbox');

function fakeServices(options) {
  const opts = options || {};
  const props = Object.assign({}, opts.props || {});
  let active = opts.active === undefined ? opts.owner : opts.active;
  const owner = opts.owner || 'owner@pomfret.org';
  const triggers = [];
  let uidCounter = 0;
  let uuidCounter = 0;
  const sleepCalls = [];

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
      getProperties: () => Object.assign({}, props),
    }),
  };

  // Strict on purpose: taking the script lock while it's already held (nesting) throws, so tests
  // catch code that would wait on itself in Apps Script.
  let lockHeld = false;
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        if (lockHeld) throw new Error('nested script lock');
        lockHeld = true;
        return true;
      },
      waitLock: () => {
        if (lockHeld) throw new Error('nested script lock');
        lockHeld = true;
      },
      releaseLock: () => { lockHeld = false; },
    }),
  };

  const Session = {
    getActiveUser: () => ({ getEmail: () => active || '' }),
    getEffectiveUser: () => ({ getEmail: () => owner }),
  };

  function makeTrigger(handler, config) {
    const uid = 'trigger-' + (++uidCounter);
    const t = { uid, handler, config, getUniqueId: () => uid, getHandlerFunction: () => handler };
    triggers.push(t);
    return t;
  }
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => {
      const i = triggers.indexOf(t);
      if (i !== -1) triggers.splice(i, 1);
    },
    newTrigger: (handler) => {
      const config = {};
      const builder = {
        timeBased: () => builder,
        atHour: (h) => { config.atHour = h; return builder; },
        nearMinute: (m) => { config.nearMinute = m; return builder; },
        everyDays: (n) => { config.everyDays = n; return builder; },
        inTimezone: (tz) => { config.timeZone = tz; return builder; },
        after: (ms) => { config.after = ms; return builder; },
        at: (d) => { config.at = d; return builder; },
        create: () => makeTrigger(handler, config),
      };
      return builder;
    },
  };

  function output(kind, value) {
    const o = { kind, value, title: '', setTitle: (t) => { o.title = t; return o; }, addMetaTag: () => o, getContent: () => value };
    return o;
  }
  const HtmlService = {
    createHtmlOutputFromFile: (name) => output('file', name),
    createHtmlOutput: (html) => output('html', html),
  };

  // Drive: the shared folder (id FOLDER123) and any folders created inside it, holding `files`;
  // other files live elsewhere (a parent that isn't a known folder). Like DriveApp, lookups by
  // name include trashed items; moving a file changes its parent.
  const files = {};
  const folderState = { trashed: false };
  const folders = { FOLDER123: { id: 'FOLDER123', name: 'AutoPlanner – CLC Student Planners', parent: 'ROOT', state: folderState } };
  let folderCounter = 0;
  const iter = (list, wrap) => { let i = 0; return { hasNext: () => i < list.length, next: () => wrap(list[i++]) }; };
  function wrapFolder(fd) {
    const trashed = () => !!(fd.state ? fd.state.trashed : fd.trashed);
    return {
      getId: () => fd.id,
      getName: () => fd.name,
      setName: (n) => { fd.name = n; },
      isTrashed: trashed,
      getParents: () => iter(folders[fd.parent] ? [folders[fd.parent]] : [], wrapFolder),
      createFolder: (name) => {
        const id = 'FOLDER-' + (++folderCounter);
        folders[id] = { id, name, parent: fd.id, trashed: false };
        return wrapFolder(folders[id]);
      },
      getFoldersByName: (name) => iter(Object.values(folders).filter((x) => x.parent === fd.id && x.name === name), wrapFolder),
      getFolders: () => iter(Object.values(folders).filter((x) => x.parent === fd.id), wrapFolder),
      getFilesByType: () => iter(Object.values(files).filter((f) => f.parent === fd.id && !f.trashed), wrapFile),
      getFiles: () => iter(Object.values(files).filter((f) => f.parent === fd.id && !f.trashed), wrapFile),
      searchFiles: (query) => {
        const m = /title = '((?:[^'\\]|\\.)*)'/.exec(query);
        const title = m ? m[1].replace(/\\(.)/g, '$1') : null;
        return iter(Object.values(files).filter((f) => f.parent === fd.id && !f.trashed && f.name === title), wrapFile);
      },
    };
  }
  const folder = wrapFolder(folders.FOLDER123);
  function wrapFile(f) {
    return {
      getId: () => f.id,
      getName: () => f.name,
      getLastUpdated: () => f.updated || new Date(0),
      isTrashed: () => !!f.trashed,
      getParents: () => iter(f.parent ? [f.parent] : [], (pid) => (folders[pid] ? wrapFolder(folders[pid]) : { getId: () => pid, getName: () => pid, getParents: () => iter([], (x) => x) })),
      moveTo: (dest) => { f.parent = dest.getId(); },
    };
  }
  const DriveApp = {
    getFolderById: (id) => {
      if (!folders[id]) throw new Error('No item with the given ID could be found');
      return wrapFolder(folders[id]);
    },
    getFileById: (id) => {
      if (!files[id]) throw new Error('No item with the given ID could be found');
      return wrapFile(files[id]);
    },
  };
  const MimeType = { GOOGLE_DOCS: 'application/vnd.google-apps.document' };

  const Utilities = {
    formatDate,
    sleep: (ms) => { sleepCalls.push(ms); },
    getUuid: () => 'uuid-' + (++uuidCounter),
  };

  return {
    globals: { PropertiesService, LockService, Session, ScriptApp, HtmlService, DriveApp, Utilities, MimeType },
    props,
    triggers,
    files,
    sleepCalls,
    setActive: (email) => { active = email; },
    addFile: (id, name, parent, extra) => { files[id] = Object.assign({ id, name, parent }, extra || {}); },
    folderState,
    folders,
  };
}

module.exports = { fakeServices };
