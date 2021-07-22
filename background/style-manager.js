/* global API msg */// msg.js
/* global CHROME URLS stringAsRegExp tryRegExp tryURL */// toolbox.js
/* global bgReady compareRevision */// common.js
/* global calcStyleDigest styleCodeEmpty styleSectionGlobal */// sections-util.js
/* global db */
/* global prefs */
/* global tabMan */
/* global usercssMan */
'use strict';

/*
This style manager is a layer between content script and the DB. When a style
is added/updated, it broadcast a message to content script and the content
script would try to fetch the new code.

The live preview feature relies on `runtime.connect` and `port.onDisconnect`
to cleanup the temporary code. See livePreview in /edit.
*/

const styleMan = (() => {

  //#region Declarations

  /** @typedef {{
    style: StyleObj
    preview?: StyleObj
    appliesTo: Set<string>
  }} StyleMapData */
  /** @type {Map<number,StyleMapData>} */
  const dataMap = new Map();
  const uuidIndex = new Map();
  /** @typedef {Object<styleId,{id: number, code: string[]}>} StyleSectionsToApply */
  /** @type {Map<string,{maybeMatch: Set<styleId>, sections: StyleSectionsToApply}>} */
  const cachedStyleForUrl = createCache({
    onDeleted(url, cache) {
      for (const section of Object.values(cache.sections)) {
        const data = id2data(section.id);
        if (data) data.appliesTo.delete(url);
      }
    },
  });
  const BAD_MATCHER = {test: () => false};
  const compileRe = createCompiler(text => `^(${text})$`);
  const compileSloppyRe = createCompiler(text => `^${text}$`);
  const compileExclusion = createCompiler(buildExclusion);
  const uuidv4 = crypto.randomUUID ? crypto.randomUUID.bind(crypto) : (() => {
    const seeds = crypto.getRandomValues(new Uint16Array(8));
    // 00001111-2222-M333-N444-555566667777
    seeds[3] = seeds[3] & 0x0FFF | 0x4000; // UUID version 4, M = 4
    seeds[4] = seeds[4] & 0x3FFF | 0x8000; // UUID variant 1, N = 8..0xB
    return Array.from(seeds, hex4dashed).join('');
  });
  const MISSING_PROPS = {
    name: style => `ID: ${style.id}`,
    _id: () => uuidv4(),
    _rev: () => Date.now(),
    _usw: () => ({}),
  };
  const DELETE_IF_NULL = ['id', 'customName', 'md5Url', 'originalMd5'];
  /** @type {Promise|boolean} will be `true` to avoid wasting a microtask tick on each `await` */
  let ready = init();

  chrome.runtime.onConnect.addListener(handleLivePreview);

  //#endregion
  //#region Exports

  return {

    /** @returns {Promise<number>} style id */
    async delete(id, reason) {
      if (ready.then) await ready;
      const data = id2data(id);
      const {style, appliesTo} = data;
      await db.exec('delete', id);
      if (reason !== 'sync') {
        API.sync.delete(style._id, Date.now());
      }
      for (const url of appliesTo) {
        const cache = cachedStyleForUrl.get(url);
        if (cache) delete cache.sections[id];
      }
      dataMap.delete(id);
      uuidIndex.delete(style._id);
      if (style._usw && style._usw.token) {
        // Must be called after the style is deleted from dataMap
        API.usw.revoke(id);
      }
      await msg.broadcast({
        method: 'styleDeleted',
        style: {id},
      });
      return id;
    },

    /** @returns {Promise<number>} style id */
    async deleteByUUID(_id, rev) {
      if (ready.then) await ready;
      const id = uuidIndex.get(_id);
      const oldDoc = id && id2style(id);
      if (oldDoc && compareRevision(oldDoc._rev, rev) <= 0) {
        // FIXME: does it make sense to set reason to 'sync' in deleteByUUID?
        return styleMan.delete(id, 'sync');
      }
    },

    /** @returns {Promise<StyleObj>} */
    async editSave(style) {
      if (ready.then) await ready;
      style = mergeWithMapped(style);
      style.updateDate = Date.now();
      return saveStyle(style, {reason: 'editSave'});
    },

    /** @returns {Promise<?StyleObj>} */
    async find(filter) {
      if (ready.then) await ready;
      const filterEntries = Object.entries(filter);
      for (const {style} of dataMap.values()) {
        if (filterEntries.every(([key, val]) => style[key] === val)) {
          return style;
        }
      }
      return null;
    },

    /** @returns {Promise<StyleObj[]>} */
    async getAll() {
      if (ready.then) await ready;
      return Array.from(dataMap.values(), data2style);
    },

    /** @returns {Promise<StyleObj>} */
    async getByUUID(uuid) {
      if (ready.then) await ready;
      return id2style(uuidIndex.get(uuid));
    },

    /** @returns {Promise<StyleSectionsToApply>} */
    async getSectionsByUrl(url, id, isInitialApply) {
      if (ready.then) await ready;
      if (isInitialApply && prefs.get('disableAll')) {
        return {disableAll: true};
      }
      if (CHROME && this && this.sender) {
        /* Chrome hides text frament from location.href of the page e.g. #:~:text=foo
           so we'll use the real URL reported by webNavigation API.
           TODO: if FF will do the same, this won't work as is: FF reports onCommitted too late */
        const {tab, frameId} = this.sender;
        url = tab && tabMan.get(tab.id, 'url', frameId) || url;
      }
      let cache = cachedStyleForUrl.get(url);
      if (!cache) {
        cache = {
          sections: {},
          maybeMatch: new Set(),
        };
        buildCache(cache, url, dataMap.values());
        cachedStyleForUrl.set(url, cache);
      } else if (cache.maybeMatch.size) {
        buildCache(cache, url, Array.from(cache.maybeMatch, id2data).filter(Boolean));
      }
      return id
        ? cache.sections[id] ? {[id]: cache.sections[id]} : {}
        : cache.sections;
    },

    /** @returns {Promise<StyleObj>} */
    async get(id) {
      if (ready.then) await ready;
      return id2style(id);
    },

    /** @returns {Promise<StylesByUrlResult[]>} */
    async getByUrl(url, id = null) {
      if (ready.then) await ready;
      // FIXME: do we want to cache this? Who would like to open popup rapidly
      // or search the DB with the same URL?
      const result = [];
      const styles = id
        ? [id2style(id)].filter(Boolean)
        : Array.from(dataMap.values(), data2style);
      const query = createMatchQuery(url);
      for (const style of styles) {
        let excluded = false;
        let sloppy = false;
        let sectionMatched = false;
        const match = urlMatchStyle(query, style);
        // TODO: enable this when the function starts returning false
        // if (match === false) {
        // continue;
        // }
        if (match === 'excluded') {
          excluded = true;
        }
        for (const section of style.sections) {
          if (styleSectionGlobal(section) && styleCodeEmpty(section.code)) {
            continue;
          }
          const match = urlMatchSection(query, section);
          if (match) {
            if (match === 'sloppy') {
              sloppy = true;
            }
            sectionMatched = true;
            break;
          }
        }
        if (sectionMatched) {
          result.push(/** @namespace StylesByUrlResult */ {style, excluded, sloppy});
        }
      }
      return result;
    },

    /** @returns {Promise<StyleObj[]>} */
    async importMany(items) {
      if (ready.then) await ready;
      for (const style of items) {
        beforeSave(style);
        if (style.sourceCode && style.usercssData) {
          await usercssMan.buildCode(style);
        }
      }
      const events = await db.exec('putMany', items);
      return Promise.all(items.map((item, i) => {
        afterSave(item, events[i]);
        return handleSave(item, {reason: 'import'});
      }));
    },

    /** @returns {Promise<StyleObj>} */
    async install(style, reason = null) {
      if (ready.then) await ready;
      reason = reason || dataMap.has(style.id) ? 'update' : 'install';
      style = mergeWithMapped(style);
      const url = !style.url && style.updateUrl && (
        URLS.extractUsoArchiveInstallUrl(style.updateUrl) ||
        URLS.extractGreasyForkInstallUrl(style.updateUrl) ||
        URLS.extractUSwInstallUrl(style.updateUrl)
      );
      if (url) style.url = style.installationUrl = url;
      style.originalDigest = await calcStyleDigest(style);
      // FIXME: update updateDate? what about usercss config?
      return saveStyle(style, {reason});
    },

    /** @returns {Promise<?StyleObj>} */
    async putByUUID(doc) {
      if (ready.then) await ready;
      const id = uuidIndex.get(doc._id);
      if (id) {
        doc.id = id;
      } else {
        delete doc.id;
      }
      const oldDoc = id && id2style(id);
      let diff = -1;
      if (oldDoc) {
        diff = compareRevision(oldDoc._rev, doc._rev);
        if (diff > 0) {
          API.sync.put(oldDoc._id, oldDoc._rev);
          return;
        }
      }
      if (diff < 0) {
        doc.id = await db.exec('put', doc);
        uuidIndex.set(doc._id, doc.id);
        return handleSave(doc, {reason: 'sync'});
      }
    },

    save: saveStyle,

    /** @returns {Promise<number>} style id */
    async toggle(id, enabled) {
      if (ready.then) await ready;
      const style = Object.assign({}, id2style(id), {enabled});
      await saveStyle(style, {reason: 'toggle', codeIsUpdated: false});
      return id;
    },

    // using bind() to skip step-into when debugging

    /** @returns {Promise<StyleObj>} */
    addExclusion: addIncludeExclude.bind(null, 'exclusions'),
    /** @returns {Promise<StyleObj>} */
    addInclusion: addIncludeExclude.bind(null, 'inclusions'),
    /** @returns {Promise<?StyleObj>} */
    removeExclusion: removeIncludeExclude.bind(null, 'exclusions'),
    /** @returns {Promise<?StyleObj>} */
    removeInclusion: removeIncludeExclude.bind(null, 'inclusions'),
  };

  //#endregion
  //#region Implementation

  /** @returns {StyleMapData} */
  function id2data(id) {
    return dataMap.get(id);
  }

  /** @returns {?StyleObj} */
  function id2style(id) {
    return (dataMap.get(id) || {}).style;
  }

  /** @returns {?StyleObj} */
  function data2style(data) {
    return data && data.style;
  }

  /** @returns {StyleObj} */
  function createNewStyle() {
    return /** @namespace StyleObj */ {
      enabled: true,
      updateUrl: null,
      md5Url: null,
      url: null,
      originalMd5: null,
      installDate: Date.now(),
    };
  }

  /** @returns {void} */
  function storeInMap(style) {
    dataMap.set(style.id, {
      style,
      appliesTo: new Set(),
    });
  }

  /** @returns {StyleObj} */
  function mergeWithMapped(style) {
    return Object.assign({},
      id2style(style.id) || createNewStyle(),
      style);
  }

  function handleLivePreview(port) {
    if (port.name !== 'livePreview') {
      return;
    }
    let id;
    port.onMessage.addListener(style => {
      if (!id) id = style.id;
      const data = id2data(id);
      data.preview = style;
      broadcastStyleUpdated(style, 'editPreview');
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (id) {
        const data = id2data(id);
        if (data) {
          data.preview = null;
          broadcastStyleUpdated(data.style, 'editPreviewEnd');
        }
      }
    });
  }

  async function addIncludeExclude(type, id, rule) {
    if (ready.then) await ready;
    const style = Object.assign({}, id2style(id));
    const list = style[type] || (style[type] = []);
    if (list.includes(rule)) {
      throw new Error('The rule already exists');
    }
    style[type] = list.concat([rule]);
    return saveStyle(style, {reason: 'styleSettings'});
  }

  async function removeIncludeExclude(type, id, rule) {
    if (ready.then) await ready;
    const style = Object.assign({}, id2style(id));
    const list = style[type];
    if (!list || !list.includes(rule)) {
      return;
    }
    style[type] = list.filter(r => r !== rule);
    return saveStyle(style, {reason: 'styleSettings'});
  }

  function broadcastStyleUpdated(style, reason, method = 'styleUpdated', codeIsUpdated = true) {
    const {id} = style;
    const data = id2data(id);
    const excluded = new Set();
    const updated = new Set();
    for (const [url, cache] of cachedStyleForUrl.entries()) {
      if (!data.appliesTo.has(url)) {
        cache.maybeMatch.add(id);
        continue;
      }
      const code = getAppliedCode(createMatchQuery(url), style);
      if (code) {
        updated.add(url);
        cache.sections[id] = {id, code};
      } else {
        excluded.add(url);
        delete cache.sections[id];
      }
    }
    data.appliesTo = updated;
    return msg.broadcast({
      method,
      reason,
      codeIsUpdated,
      style: {
        id,
        md5Url: style.md5Url,
        enabled: style.enabled,
      },
    });
  }

  function beforeSave(style) {
    if (!style.name) {
      throw new Error('Style name is empty');
    }
    for (const key of DELETE_IF_NULL) {
      if (style[key] == null) {
        delete style[key];
      }
    }
    if (!style._id) {
      style._id = uuidv4();
    }
    style._rev = Date.now();
    fixUsoMd5Issue(style);
  }

  function afterSave(style, newId) {
    if (style.id == null) {
      style.id = newId;
    }
    uuidIndex.set(style._id, style.id);
    API.sync.put(style._id, style._rev);
  }

  async function saveStyle(style, handlingOptions) {
    beforeSave(style);
    const newId = await db.exec('put', style);
    afterSave(style, newId);
    return handleSave(style, handlingOptions);
  }

  function handleSave(style, {reason, codeIsUpdated, broadcast = true}) {
    const data = id2data(style.id);
    const method = data ? 'styleUpdated' : 'styleAdded';
    if (!data) {
      storeInMap(style);
    } else {
      data.style = style;
    }
    if (broadcast) broadcastStyleUpdated(style, reason, method, codeIsUpdated);
    return style;
  }

  // get styles matching a URL, including sloppy regexps and excluded items.
  function getAppliedCode(query, data) {
    if (urlMatchStyle(query, data) !== true) {
      return;
    }
    const code = [];
    for (const section of data.sections) {
      if (urlMatchSection(query, section) === true && !styleCodeEmpty(section.code)) {
        code.push(section.code);
      }
    }
    return code.length && code;
  }

  async function init() {
    const styles = await db.exec('getAll') || [];
    const updated = styles.filter(fixOldStyleProps);
    if (updated.length) {
      await db.exec('putMany', updated);
    }
    for (const style of styles) {
      fixUsoMd5Issue(style);
      storeInMap(style);
      uuidIndex.set(style._id, style.id);
    }
    ready = true;
    bgReady._resolveStyles();
  }

  function fixOldStyleProps(style) {
    let res = 0;
    for (const key in MISSING_PROPS) {
      if (!style[key]) {
        style[key] = MISSING_PROPS[key](style);
        res = 1;
      }
    }
    /* Upgrade the old way of customizing local names */
    const {originalName} = style;
    if (originalName) {
      if (originalName !== style.name) {
        style.customName = style.name;
        style.name = originalName;
      }
      delete style.originalName;
      res = 1;
    }
    return res;
  }

  function urlMatchStyle(query, style) {
    if (
      style.exclusions &&
      style.exclusions.some(e => compileExclusion(e).test(query.urlWithoutParams))
    ) {
      return 'excluded';
    }
    if (!style.enabled) {
      return 'disabled';
    }
    return true;
  }

  function urlMatchSection(query, section) {
    if (
      section.domains &&
      section.domains.some(d => d === query.domain || query.domain.endsWith(`.${d}`))
    ) {
      return true;
    }
    if (section.urlPrefixes && section.urlPrefixes.some(p => p && query.url.startsWith(p))) {
      return true;
    }
    // as per spec the fragment portion is ignored in @-moz-document:
    // https://www.w3.org/TR/2012/WD-css3-conditional-20120911/#url-of-doc
    // but the spec is outdated and doesn't account for SPA sites
    // so we only respect it for `url()` function
    if (section.urls && (
      section.urls.includes(query.url) ||
      section.urls.includes(query.urlWithoutHash)
    )) {
      return true;
    }
    if (section.regexps && section.regexps.some(r => compileRe(r).test(query.url))) {
      return true;
    }
    /*
    According to CSS4 @document specification the entire URL must match.
    Stylish-for-Chrome implemented it incorrectly since the very beginning.
    We'll detect styles that abuse the bug by finding the sections that
    would have been applied by Stylish but not by us as we follow the spec.
    */
    if (section.regexps && section.regexps.some(r => compileSloppyRe(r).test(query.url))) {
      return 'sloppy';
    }
    // TODO: check for invalid regexps?
    return styleSectionGlobal(section);
  }

  function createCompiler(compile) {
    // FIXME: FIFO cache doesn't work well here, if we want to match many
    // regexps more than the cache size, we will never hit the cache because
    // the first cache is deleted. So we use a simple map but it leaks memory.
    const cache = new Map();
    return text => {
      let re = cache.get(text);
      if (!re) {
        re = tryRegExp(compile(text));
        if (!re) {
          re = BAD_MATCHER;
        }
        cache.set(text, re);
      }
      return re;
    };
  }

  function compileGlob(text) {
    return stringAsRegExp(text, '', true)
      .replace(/\\\\\\\*|\\\*/g, m => m.length > 2 ? m : '.*');
  }

  function buildExclusion(text) {
    // match pattern
    const match = text.match(/^(\*|[\w-]+):\/\/(\*\.)?([\w.]+\/.*)/);
    if (!match) {
      return '^' + compileGlob(text) + '$';
    }
    return '^' +
      (match[1] === '*' ? '[\\w-]+' : match[1]) +
      '://' +
      (match[2] ? '(?:[\\w.]+\\.)?' : '') +
      compileGlob(match[3]) +
      '$';
  }

  // The md5Url provided by USO includes a duplicate "update" subdomain (see #523),
  // This fixes any already installed styles containing this error
  function fixUsoMd5Issue(style) {
    if (style && style.md5Url && style.md5Url.includes('update.update.userstyles')) {
      style.md5Url = style.md5Url.replace('update.update.userstyles', 'update.userstyles');
    }
  }

  function createMatchQuery(url) {
    let urlWithoutHash;
    let urlWithoutParams;
    let domain;
    return {
      url,
      get urlWithoutHash() {
        if (!urlWithoutHash) {
          urlWithoutHash = url.split('#')[0];
        }
        return urlWithoutHash;
      },
      get urlWithoutParams() {
        if (!urlWithoutParams) {
          const u = tryURL(url);
          urlWithoutParams = u.origin + u.pathname;
        }
        return urlWithoutParams;
      },
      get domain() {
        if (!domain) {
          const u = tryURL(url);
          domain = u.hostname;
        }
        return domain;
      },
    };
  }

  function buildCache(cache, url, styleList) {
    const query = createMatchQuery(url);
    for (const {style, appliesTo, preview} of styleList) {
      const code = getAppliedCode(query, preview || style);
      if (code) {
        const id = style.id;
        cache.sections[id] = {id, code};
        appliesTo.add(url);
      }
    }
  }

  /** uuidv4 helper: converts to a 4-digit hex string and adds "-" at required positions */
  function hex4dashed(num, i) {
    return (num + 0x10000).toString(16).slice(-4) + (i >= 1 && i <= 4 ? '-' : '');
  }

  //#endregion
})();

/** Creates a FIFO limit-size map. */
function createCache({size = 1000, onDeleted} = {}) {
  const map = new Map();
  const buffer = Array(size);
  let index = 0;
  let lastIndex = 0;
  return {
    get(id) {
      const item = map.get(id);
      return item && item.data;
    },
    set(id, data) {
      if (map.size === size) {
        // full
        map.delete(buffer[lastIndex].id);
        if (onDeleted) {
          onDeleted(buffer[lastIndex].id, buffer[lastIndex].data);
        }
        lastIndex = (lastIndex + 1) % size;
      }
      const item = {id, data, index};
      map.set(id, item);
      buffer[index] = item;
      index = (index + 1) % size;
    },
    delete(id) {
      const item = map.get(id);
      if (!item) {
        return false;
      }
      map.delete(item.id);
      const lastItem = buffer[lastIndex];
      lastItem.index = item.index;
      buffer[item.index] = lastItem;
      lastIndex = (lastIndex + 1) % size;
      if (onDeleted) {
        onDeleted(item.id, item.data);
      }
      return true;
    },
    clear() {
      map.clear();
      index = lastIndex = 0;
    },
    has: id => map.has(id),
    *entries() {
      for (const [id, item] of map) {
        yield [id, item.data];
      }
    },
    *values() {
      for (const item of map.values()) {
        yield item.data;
      }
    },
    get size() {
      return map.size;
    },
  };
}
