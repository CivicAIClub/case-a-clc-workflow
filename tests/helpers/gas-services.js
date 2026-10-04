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

  const LockService = {
    getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }),
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
    const o = { kind, value, title: '', setTitle: (t) => { o.title = t; return o; }, addMetaTag: () => o };
    return o;
  }
  const HtmlService = {
    createHtmlOutputFromFile: (name) => output('file', name),
    createHtmlOutput: (html) => output('html', html),
  };

  // Drive: one shared folder (id FOLDER123) holding `files`; other files live elsewhere.
  const files = {};
  const folder = {
    getId: () => 'FOLDER123',
    getName: () => 'AutoPlanner – CLC Student Planners',
    searchFiles: (query) => {
      const m = /title = '((?:[^'\\]|\\.)*)'/.exec(query);
      const title = m ? m[1].replace(/\\(.)/g, '$1') : null;
      const found = Object.values(files).filter(
        (f) => f.parent === 'FOLDER123' && !f.trashed && f.name === title
      );
      let i = 0;
      return { hasNext: () => i < found.length, next: () => wrapFile(found[i++]) };
    },
  };
  function wrapFile(f) {
    return {
      getId: () => f.id,
      getName: () => f.name,
      getLastUpdated: () => f.updated || new Date(0),
      isTrashed: () => !!f.trashed,
      getParents: () => {
        const ps = f.parent ? [f.parent] : [];
        let i = 0;
        return { hasNext: () => i < ps.length, next: () => ({ getId: () => ps[i++] }) };
      },
      moveTo: (dest) => { f.parent = dest.getId(); },
    };
  }
  const DriveApp = {
    getFolderById: (id) => {
      if (id !== 'FOLDER123') throw new Error('No item with the given ID could be found');
      return folder;
    },
    getFileById: (id) => {
      if (!files[id]) throw new Error('No item with the given ID could be found');
      return wrapFile(files[id]);
    },
  };

  const Utilities = {
    formatDate,
    sleep: (ms) => { sleepCalls.push(ms); },
    getUuid: () => 'uuid-' + (++uuidCounter),
  };

  return {
    globals: { PropertiesService, LockService, Session, ScriptApp, HtmlService, DriveApp, Utilities },
    props,
    triggers,
    files,
    sleepCalls,
    setActive: (email) => { active = email; },
    addFile: (id, name, parent, extra) => { files[id] = Object.assign({ id, name, parent }, extra || {}); },
  };
}

module.exports = { fakeServices };
