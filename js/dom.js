/* global FIREFOX debounce */// toolbox.js
/* global prefs */
'use strict';

/* exported
  $createLink
  $isTextInput
  $remove
  $$remove
  animateElement
  getEventKeyName
  messageBoxProxy
  moveFocus
  scrollElementIntoView
  setupLivePrefs
  toggleDataset
  waitForSheet
*/

Object.assign(EventTarget.prototype, {
  on: addEventListener,
  off: removeEventListener,
});

//#region Exports

// Makes the focus outline appear on keyboard tabbing, but not on mouse clicks.
const focusAccessibility = {
  // last event's focusedViaClick
  lastFocusedViaClick: false,
  // to avoid a full layout recalc due to changes on body/root
  // we modify the closest focusable element (like input or button or anything with tabindex=0)
  closest(el) {
    let labelSeen;
    for (; el; el = el.parentElement) {
      if (el.localName === 'label' && el.control && !labelSeen) {
        el = el.control;
        labelSeen = true;
      }
      if (el.tabIndex >= 0) return el;
    }
  },
};

/**
 * Autoloads message-box.js
 * @alias messageBox
 */
window.messageBoxProxy = new Proxy({}, {
  get(_, name) {
    return async (...args) => {
      await require([
        '/js/dlg/message-box', /* global messageBox */
        '/js/dlg/message-box.css',
      ]);
      window.messageBoxProxy = messageBox;
      return messageBox[name](...args);
    };
  },
});

function $(selector, base = document) {
  // we have ids with . like #manage.onlyEnabled which looks like #id.class
  // so since getElementById is superfast we'll try it anyway
  const byId = selector.startsWith('#') && document.getElementById(selector.slice(1));
  return byId || base.querySelector(selector);
}

function $$(selector, base = document) {
  return [...base.querySelectorAll(selector)];
}

function $isTextInput(el = {}) {
  return el.localName === 'textarea' ||
    el.localName === 'input' && /^(text|search|number)$/.test(el.type);
}

function $remove(selector, base = document) {
  const el = selector && typeof selector === 'string' ? $(selector, base) : selector;
  if (el) {
    el.remove();
  }
}

function $$remove(selector, base = document) {
  for (const el of base.querySelectorAll(selector)) {
    el.remove();
  }
}

/*
 $create('tag#id.class.class', ?[children])
 $create('tag#id.class.class', ?textContentOrChildNode)
 $create('tag#id.class.class', {properties}, ?[children])
 $create('tag#id.class.class', {properties}, ?textContentOrChildNode)
 tag is 'div' by default, #id and .class are optional

 $create([children])

 $create({propertiesAndOptions})
 $create({propertiesAndOptions}, ?[children])
 tag:              string, default 'div'
 appendChild:      element/string or an array of elements/strings
 dataset:          object
 any DOM property: assigned as is

 tag may include namespace like 'ns:tag'
 */
function $create(selector = 'div', properties, children) {
  let ns, tag, opt;
  if (typeof selector === 'string') {
    if (Array.isArray(properties) ||
        properties instanceof Node ||
        typeof properties !== 'object') {
      opt = {};
      children = properties;
    } else {
      opt = properties || {};
      children = children || opt.appendChild;
    }
    const idStart = (selector.indexOf('#') + 1 || selector.length + 1) - 1;
    const classStart = (selector.indexOf('.') + 1 || selector.length + 1) - 1;
    const id = selector.slice(idStart + 1, classStart);
    if (id) {
      opt.id = id;
    }
    const cls = selector.slice(classStart + 1);
    if (cls) {
      opt[selector.includes(':') ? 'class' : 'className'] =
        cls.includes('.') ? cls.replace(/\./g, ' ') : cls;
    }
    tag = selector.slice(0, Math.min(idStart, classStart));
  } else if (Array.isArray(selector)) {
    tag = 'div';
    opt = {};
    children = selector;
  } else {
    opt = selector;
    tag = opt.tag;
    children = opt.appendChild || properties;
  }
  if (tag && tag.includes(':')) {
    [ns, tag] = tag.split(':');
    if (ns === 'SVG' || ns === 'svg') {
      ns = 'http://www.w3.org/2000/svg';
    }
  }
  const element = ns ? document.createElementNS(ns, tag) :
    tag === 'fragment' ? document.createDocumentFragment() :
      document.createElement(tag || 'div');
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) {
      element.appendChild(child instanceof Node ? child : document.createTextNode(child));
    }
  }
  for (const [key, val] of Object.entries(opt)) {
    switch (key) {
      case 'dataset':
        Object.assign(element.dataset, val);
        break;
      case 'attributes':
        Object.entries(val).forEach(attr => element.setAttribute(...attr));
        break;
      case 'style': {
        const t = typeof val;
        if (t === 'string') element.style.cssText = val;
        if (t === 'object') Object.assign(element.style, val);
        break;
      }
      case 'tag':
      case 'appendChild':
        break;
      default: {
        if (ns) {
          const i = key.indexOf(':') + 1;
          const attrNS = i && `http://www.w3.org/1999/${key.slice(0, i - 1)}`;
          element.setAttributeNS(attrNS || null, key, val);
        } else {
          element[key] = val;
        }
      }
    }
  }
  return element;
}

function $createLink(href = '', content) {
  const opt = {
    tag: 'a',
    target: '_blank',
    rel: 'noopener',
  };
  if (typeof href === 'object') {
    Object.assign(opt, href);
  } else {
    opt.href = href;
  }
  opt.appendChild = opt.appendChild || content;
  return $create(opt);
}

/**
 * @param {HTMLElement} el
 * @param {string} [cls] - class name that defines or starts an animation
 * @param [removeExtraClasses] - class names to remove at animation end in the *same* paint frame,
 *        which is needed in e.g. Firefox as it may call resolve() in the next frame
 * @returns {Promise<void>}
 */
function animateElement(el, cls = 'highlight', ...removeExtraClasses) {
  return !el ? Promise.resolve(el) : new Promise(resolve => {
    let onDone = () => {
      el.classList.remove(cls, ...removeExtraClasses);
      onDone = null;
      resolve();
    };
    requestAnimationFrame(() => {
      if (onDone) {
        const style = getComputedStyle(el);
        if (style.animationName === 'none' || !parseFloat(style.animationDuration)) {
          el.off('animationend', onDone);
          onDone();
        }
      }
    });
    el.on('animationend', onDone, {once: true});
    el.classList.add(cls);
  });
}

function getEventKeyName(e, letterAsCode) {
  const mods =
    (e.shiftKey ? 'Shift-' : '') +
    (e.ctrlKey ? 'Ctrl-' : '') +
    (e.altKey ? 'Alt-' : '') +
    (e.metaKey ? 'Meta-' : '');
  return `${
    mods === e.key + '-' ? '' : mods
  }${
    e.key
      ? e.key.length === 1 && letterAsCode ? e.code : e.key
      : 'Mouse' + ('LMR'[e.button] || e.button)
  }`;
}

/**
 * Switches to the next/previous keyboard-focusable element.
 * Doesn't check `visibility` or `display` via getComputedStyle for simplicity.
 * @param {HTMLElement} rootElement
 * @param {Number} step - for exmaple 1 or -1 (or 0 to focus the first focusable el in the box)
 * @returns {HTMLElement|false|undefined} -
 *   HTMLElement: focus changed,
 *   false: focus unchanged,
 *   undefined: nothing to focus
 */
function moveFocus(rootElement, step) {
  const elements = [...rootElement.getElementsByTagName('*')];
  const activeEl = document.activeElement;
  const activeIndex = step ? Math.max(step < 0 ? 0 : -1, elements.indexOf(activeEl)) : -1;
  const num = elements.length;
  if (!step) step = 1;
  for (let i = 1; i < num; i++) {
    const el = elements[(activeIndex + i * step + num) % num];
    if (!el.disabled && el.tabIndex >= 0) {
      el.focus();
      return activeEl !== el && el;
    }
  }
}

function onDOMready() {
  return document.readyState !== 'loading'
    ? Promise.resolve()
    : new Promise(resolve => document.on('DOMContentLoaded', resolve, {once: true}));
}

function scrollElementIntoView(element, {invalidMarginRatio = 0} = {}) {
  // align to the top/bottom of the visible area if wasn't visible
  if (!element.parentNode) return;
  const {top, height} = element.getBoundingClientRect();
  const {top: parentTop, bottom: parentBottom} = element.parentNode.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  if (top < Math.max(parentTop, windowHeight * invalidMarginRatio) ||
      top > Math.min(parentBottom, windowHeight) - height - windowHeight * invalidMarginRatio) {
    window.scrollBy(0, top - windowHeight / 2 + height);
  }
}

/**
 * Accepts an array of pref names (values are fetched via prefs.get)
 * and establishes a two-way connection between the document elements and the actual prefs
 */
function setupLivePrefs(ids = prefs.knownKeys.filter(id => $('#' + id))) {
  let forceUpdate = true;
  prefs.subscribe(ids, updateElement, {runNow: true});
  forceUpdate = false;
  ids.forEach(id => $('#' + id).on('change', onChange));

  function onChange() {
    prefs.set(this.id, this[getPropName(this)]);
  }

  function getPropName(el) {
    return el.type === 'checkbox' ? 'checked'
      : el.type === 'number' ? 'valueAsNumber' :
        'value';
  }

  function isSame(el, propName, value) {
    return el[propName] === value ||
      typeof value === 'boolean' &&
      el.tagName === 'SELECT' &&
      el[propName] === `${value}`;
  }

  function updateElement(id, value) {
    const el = $('#' + id);
    if (el) {
      const prop = getPropName(el);
      if (!isSame(el, prop, value) || forceUpdate) {
        el[prop] = value;
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
    } else {
      prefs.unsubscribe(ids, updateElement);
    }
  }
}

function toggleDataset(el, prop, state) {
  if (state) {
    el.dataset[prop] = '';
  } else {
    delete el.dataset[prop];
  }
}

/**
 * @param {string} selector - beware of $ quirks with `#dotted.id` that won't work with $$
 * @param {Object} [opt]
 * @param {function(HTMLElement, HTMLElement[]):boolean} [opt.recur] - called on each match
   with (firstMatchingElement, allMatchingElements) parameters until stopOnDomReady,
   you can also return `false` to disconnect the observer
 * @param {boolean} [opt.stopOnDomReady] - stop observing on DOM ready
 * @returns {Promise<HTMLElement>} - resolves on first match
 */
function waitForSelector(selector, {recur, stopOnDomReady = true} = {}) {
  let el = $(selector);
  let elems, isResolved;
  return el && (!recur || recur(el, (elems = $$(selector))) === false)
    ? Promise.resolve(el)
    : new Promise(resolve => {
      const mo = new MutationObserver(() => {
        if (!el) el = $(selector);
        if (!el) return;
        if (!recur ||
            callRecur() === false ||
            stopOnDomReady && document.readyState === 'complete') {
          mo.disconnect();
        }
        if (!isResolved) {
          isResolved = true;
          resolve(el);
        }
      });
      mo.observe(document, {childList: true, subtree: true});
    });
  function callRecur() {
    const all = $$(selector); // simpler and faster than analyzing each node in `mutations`
    const added = !elems ? all : all.filter(el => !elems.includes(el));
    if (added.length) {
      elems = all;
      return recur(added[0], added);
    }
  }
}

/**
 * Forcing layout while the main stylesheet is still loading breaks page appearance
 * so we'll wait until it loads (0-1 frames in Chrome, Firefox occasionally needs 2-3).
 */
async function waitForSheet({
  href = location.pathname.replace('.html', '.css'),
  maxFrames = FIREFOX ? 10 : 1,
} = {}) {
  const el = $(`link[href$="${href}"]`);
  for (let i = 0; i < maxFrames && !el.sheet; i++) {
    await new Promise(requestAnimationFrame);
  }
}

//#endregion
//#region Internals

(() => {

  const Collapsible = {
    bindEvents(_, elems) {
      const prefKeys = [];
      for (const el of elems) {
        prefKeys.push(el.dataset.pref);
        ($('h2', el) || el).on('click', Collapsible.saveOnClick);
      }
      prefs.subscribe(prefKeys, Collapsible.updateOnPrefChange, {runNow: true});
    },
    canSave(el) {
      return !el.matches('.compact-layout .ignore-pref-if-compact');
    },
    async saveOnClick(event) {
      if (event.target.closest('.intercepts-click')) {
        event.preventDefault();
      } else {
        const el = event.target.closest('details');
        await new Promise(setTimeout);
        if (Collapsible.canSave(el)) {
          prefs.set(el.dataset.pref, el.open);
        }
      }
    },
    updateOnPrefChange(key, value) {
      const el = $(`details[data-pref="${key}"]`);
      if (el.open !== value && Collapsible.canSave(el)) {
        el.open = value;
      }
    },
  };

  window.on('mousedown', suppressFocusRingOnClick, {passive: true});
  window.on('keydown', keepFocusRingOnTabbing, {passive: true});

  if (!/^Win\d+/.test(navigator.platform)) {
    document.documentElement.classList.add('non-windows');
  }
  // set language for a) CSS :lang pseudo and b) hyphenation
  document.documentElement.setAttribute('lang', chrome.i18n.getUILanguage());
  document.on('keypress', clickDummyLinkOnEnter);
  document.on('wheel', changeFocusedInputOnWheel, {capture: true, passive: false});

  Promise.resolve().then(async () => {
    if (!chrome.app) addFaviconFF();
    await prefs.ready;
    waitForSelector('details[data-pref]', {recur: Collapsible.bindEvents});
  });

  onDOMready().then(() => {
    debounce(addTooltipsToEllipsized, 500);
    window.on('resize', () => debounce(addTooltipsToEllipsized, 100));
  });

  window.on('load', () => {
    const {sheet} = $('link[href^="global.css"]');
    for (let i = 0, rule; (rule = sheet.cssRules[i]); i++) {
      if (/#\\1\s?transition-suppressor/.test(rule.selectorText)) {
        sheet.deleteRule(i);
        break;
      }
    }
  }, {once: true});

  function addFaviconFF() {
    const iconset = ['', 'light/'][prefs.get('iconset')] || '';
    for (const size of [38, 32, 19, 16]) {
      document.head.appendChild($create('link', {
        rel: 'icon',
        href: `/images/icon/${iconset}${size}.png`,
        sizes: size + 'x' + size,
      }));
    }
  }

  function changeFocusedInputOnWheel(event) {
    const el = document.activeElement;
    if (!el || el !== event.target && !el.contains(event.target)) {
      return;
    }
    const isSelect = el.tagName === 'SELECT';
    if (isSelect || el.tagName === 'INPUT' && el.type === 'range') {
      const key = isSelect ? 'selectedIndex' : 'valueAsNumber';
      const old = el[key];
      const rawVal = old + Math.sign(event.deltaY) * (el.step || 1);
      el[key] = Math.max(el.min || 0, Math.min(el.max || el.length - 1, rawVal));
      if (el[key] !== old) {
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      event.preventDefault();
    }
    event.stopImmediatePropagation();
  }

  /** Displays a full text tooltip on buttons with ellipsis overflow and no inherent title */
  function addTooltipsToEllipsized() {
    for (const btn of document.getElementsByTagName('button')) {
      if (btn.title && !btn.titleIsForEllipsis) {
        continue;
      }
      const width = btn.offsetWidth;
      if (!width || btn.preresizeClientWidth === width) {
        continue;
      }
      btn.preresizeClientWidth = width;
      if (btn.scrollWidth > width) {
        const text = btn.textContent;
        btn.title = text.includes('\u00AD') ? text.replace(/\u00AD/g, '') : text;
        btn.titleIsForEllipsis = true;
      } else if (btn.title) {
        btn.title = '';
      }
    }
  }

  function clickDummyLinkOnEnter(e) {
    if (getEventKeyName(e) === 'Enter') {
      const a = e.target.closest('a');
      const isDummy = a && !a.href && a.tabIndex === 0;
      if (isDummy) a.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    }
  }

  function keepFocusRingOnTabbing(event) {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      focusAccessibility.lastFocusedViaClick = false;
      setTimeout(() => {
        let el = document.activeElement;
        if (el) {
          el = el.closest('[data-focused-via-click]');
          if (el) delete el.dataset.focusedViaClick;
        }
      });
    }
  }

  function suppressFocusRingOnClick({target}) {
    const el = focusAccessibility.closest(target);
    if (el) {
      focusAccessibility.lastFocusedViaClick = true;
      if (el.dataset.focusedViaClick === undefined) {
        el.dataset.focusedViaClick = '';
      }
    }
  }
})();

//#endregion
