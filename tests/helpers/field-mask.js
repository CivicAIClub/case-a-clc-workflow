'use strict';
// Google's partial-response "fields" masks, applied to plain JSON the way the API does:
// "a,b(c,d/e)" keeps a, and b with only c and d.e; a mask applies to every element of an array.
// The fake Docs API uses it so tests see exactly what a masked read returns.

function parseMask(mask) {
  let i = 0;
  function list() {
    const tree = {};
    for (;;) {
      let name = '';
      while (i < mask.length && !',()/'.includes(mask[i])) name += mask[i++];
      name = name.trim();
      if (!name) throw new Error('bad fields mask at ' + i + ': ' + mask);
      let node = tree;
      let key = name;
      // a/b/c is a(b(c))
      while (mask[i] === '/') {
        i++;
        node[key] = node[key] && node[key] !== true ? node[key] : {};
        node = node[key];
        key = '';
        while (i < mask.length && !',()/'.includes(mask[i])) key += mask[i++];
        key = key.trim();
      }
      if (mask[i] === '(') {
        i++;
        const sub = list();
        if (mask[i] !== ')') throw new Error('unclosed ( in fields mask: ' + mask);
        i++;
        node[key] = node[key] && node[key] !== true ? Object.assign(node[key], sub) : sub;
      } else {
        node[key] = true;
      }
      if (mask[i] === ',') { i++; continue; }
      return tree;
    }
  }
  const tree = list();
  if (i !== mask.length) throw new Error('bad fields mask at ' + i + ': ' + mask);
  return tree;
}

function applyTree(value, tree) {
  if (tree === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => applyTree(v, tree));
  const out = {};
  for (const key of Object.keys(tree)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = applyTree(value[key], tree[key]);
  }
  return out;
}

/** The JSON a read with this fields mask returns. */
function applyFieldMask(json, mask) {
  return applyTree(json, parseMask(mask));
}

module.exports = { parseMask, applyFieldMask };
