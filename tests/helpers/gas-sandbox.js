'use strict';
/**
 * gas-sandbox.js: run Apps Script (.gs) files inside Node for testing.
 *
 * Apps Script files all share one global scope, so we load them into a single Node `vm`
 * context and add pretend ("mock") versions of the Google services they use.
 *
 * Usage:
 *   const { createSandbox, toPlain } = require('./helpers/gas-sandbox');
 *   const sb = createSandbox({
 *     files: ['apps_script/Canvas.gs'], // relative to repo root
 *     fetchHandler: (url, params) => ({ code: 200, body: [], headers: { Link: '...' } }),
 *     globals: { PropertiesService: {...} },  // extra or replacement globals
 *   });
 *   sb.context.someFunction_();   // call anything the .gs files defined
 *
 * Mocks provided:
 *   Utilities.formatDate(date, timeZone, pattern)  real time-zone math via Intl; supports the
 *       Java SimpleDateFormat letters y M d E u H h m s a and 'quoted text'
 *   Utilities.sleep(ms)      records ms in sb.sleepCalls, does not wait
 *   UrlFetchApp.fetch / fetchAll   answered by the fetch handler (see below)
 *   Logger.log               records messages in sb.logs
 *   console                  Node's console
 *
 * Fetch handler: (url, params) => ({ code = 200, body = '', headers = {} }).
 *   body may be a string or any value (non-strings are JSON.stringify'd).
 *   Throw from the handler to simulate a network failure (DNS error, timeout).
 *   Like the real UrlFetchApp, a 4xx/5xx answer throws unless params.muteHttpExceptions
 *   is true, and fetchAll throws if any one of its requests throws.
 *   Change the handler later with sb.setFetchHandler(fn).
 *
 * Recorded fetch traffic:
 *   sb.fetchCalls    [{ url, params, method: 'fetch'|'fetchAll', batch }] one per request
 *   sb.fetchBatches  [{ method, urls }] one per fetch()/fetchAll() call; `batch` above is
 *                    the index into this list
 *
 * Objects created inside the sandbox come from a different JavaScript "realm", so
 * assert.deepStrictEqual sees different prototypes. Pass them through toPlain() first.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Copy a value out of the sandbox realm into plain Node objects (for deepStrictEqual).
function toPlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pad(n, width) {
  let s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

// Wall-clock parts of `date` in `timeZone` (weekday: 1 = Monday ... 7 = Sunday).
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'short', hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS_SHORT.indexOf(p.weekday) + 1,
  };
}

function formatField(letter, count, t) {
  switch (letter) {
    case 'y': return count === 2 ? pad(t.year % 100, 2) : pad(t.year, count);
    case 'M':
      if (count >= 4) return MONTHS_LONG[t.month - 1];
      if (count === 3) return MONTHS_SHORT[t.month - 1];
      return pad(t.month, count);
    case 'd': return pad(t.day, count);
    case 'E': return count >= 4 ? WEEKDAYS_LONG[t.weekday - 1] : WEEKDAYS_SHORT[t.weekday - 1];
    case 'u': return pad(t.weekday, count);
    case 'H': return pad(t.hour, count);
    case 'h': return pad(t.hour % 12 || 12, count);
    case 'm': return pad(t.minute, count);
    case 's': return pad(t.second, count);
    case 'a': return t.hour < 12 ? 'AM' : 'PM';
    default:
      throw new Error(`Utilities.formatDate mock: pattern letter "${letter}" is not supported`);
  }
}

// Mock of Utilities.formatDate using Java SimpleDateFormat pattern rules.
function formatDate(date, timeZone, pattern) {
  if (!date || typeof date.getTime !== 'function' || Number.isNaN(date.getTime())) {
    throw new TypeError('Utilities.formatDate mock: first argument must be a valid Date');
  }
  if (typeof timeZone !== 'string' || typeof pattern !== 'string') {
    throw new TypeError('Utilities.formatDate mock: timeZone and pattern must be strings');
  }
  const t = localParts(new Date(date.getTime()), timeZone);
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "'") {
      // '' is a literal quote; otherwise copy text up to the closing quote.
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      i++;
      while (i < pattern.length) {
        if (pattern[i] === "'" && pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (pattern[i] === "'") { i++; break; }
        out += pattern[i++];
      }
    } else if (/[A-Za-z]/.test(ch)) {
      let count = 1;
      while (pattern[i + count] === ch) count++;
      out += formatField(ch, count, t);
      i += count;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function makeResponse(url, spec) {
  const s = spec || {};
  const code = s.code === undefined ? 200 : s.code;
  const body = s.body === undefined ? '' : s.body;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = Object.assign({}, s.headers || {});
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getAllHeaders: () => Object.assign({}, headers),
    getHeaders: () => Object.assign({}, headers),
    toString: () => `MockHTTPResponse(${code} ${url})`,
  };
}

function createSandbox(options) {
  const opts = options || {};
  const fetchCalls = [];
  const fetchBatches = [];
  const sleepCalls = [];
  const logs = [];
  let handler = opts.fetchHandler || (() => {
    throw new Error('gas-sandbox: no fetchHandler set');
  });

  // Run one request through the handler. Returns { response } or { error }.
  function answer(url, params, method, batch) {
    fetchCalls.push({ url, params, method, batch });
    let spec;
    try {
      spec = handler(url, params || {});
    } catch (error) {
      return { error };
    }
    const response = makeResponse(url, spec);
    const code = response.getResponseCode();
    if (code >= 400 && !(params && params.muteHttpExceptions)) {
      return { error: new Error(`Request failed for ${url} returned code ${code}`) };
    }
    return { response };
  }

  const UrlFetchApp = {
    fetch(url, params) {
      const batch = fetchBatches.push({ method: 'fetch', urls: [url] }) - 1;
      const result = answer(url, params, 'fetch', batch);
      if (result.error) throw result.error;
      return result.response;
    },
    fetchAll(requests) {
      const list = Array.from(requests || []);
      const batch = fetchBatches.push({ method: 'fetchAll', urls: list.map((r) => r.url) }) - 1;
      const results = list.map((r) => answer(r.url, r, 'fetchAll', batch));
      const failed = results.find((r) => r.error);
      if (failed) throw failed.error;
      return results.map((r) => r.response);
    },
  };

  const Utilities = {
    formatDate,
    sleep(ms) { sleepCalls.push(ms); },
  };

  const Logger = {
    log(...args) {
      logs.push(args.map(String).join(' '));
      return Logger;
    },
  };

  const context = vm.createContext(Object.assign(
    { Utilities, UrlFetchApp, Logger, console },
    opts.globals || {},
  ));

  for (const file of opts.files || []) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  return {
    context,
    fetchCalls,
    fetchBatches,
    sleepCalls,
    logs,
    setFetchHandler(fn) { handler = fn; },
  };
}

module.exports = { createSandbox, toPlain, formatDate, REPO_ROOT };
