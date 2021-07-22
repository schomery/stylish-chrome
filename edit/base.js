/* global $ $$ $create setupLivePrefs waitForSelector */// dom.js
/* global API */// msg.js
/* global CODEMIRROR_THEMES */
/* global CodeMirror */
/* global MozDocMapper */// sections-util.js
/* global initBeautifyButton */// beautify.js
/* global prefs */
/* global t */// localization.js
/* global
  FIREFOX
  debounce
  getOwnTab
  sessionStore
  tryJSONparse
  tryURL
*/// toolbox.js
'use strict';

/**
 * @type Editor
 * @namespace Editor
 */
const editor = {
  style: null,
  dirty: DirtyReporter(),
  isUsercss: false,
  isWindowed: false,
  lazyKeymaps: {
    emacs: '/vendor/codemirror/keymap/emacs',
    vim: '/vendor/codemirror/keymap/vim',
  },
  livePreview: null,
  /** @type {'customName'|'name'} */
  nameTarget: 'name',
  previewDelay: 200, // Chrome devtools uses 200
  scrollInfo: null,

  onStyleUpdated() {
    document.documentElement.classList.toggle('is-new-style', !editor.style.id);
  },

  updateTitle(isDirty = editor.dirty.isDirty()) {
    const {customName, name} = editor.style;
    document.title = `${
      isDirty ? '* ' : ''
    }${
      customName || name || t('styleMissingName')
    } - Stylus`; // the suffix enables external utilities to process our windows e.g. pin on top
  },
};

//#region pre-init

const baseInit = (() => {
  const domReady = waitForSelector('#sections');

  return {
    domReady,
    ready: Promise.all([
      domReady,
      loadStyle(),
      prefs.ready.then(() =>
        Promise.all([
          loadTheme(),
          loadKeymaps(),
        ])),
    ]),
  };

  /** Preloads vim/emacs keymap only if it's the active one, otherwise will load later */
  function loadKeymaps() {
    const km = prefs.get('editor.keyMap');
    return /emacs/i.test(km) && require([editor.lazyKeymaps.emacs]) ||
      /vim/i.test(km) && require([editor.lazyKeymaps.vim]);
  }

  async function loadStyle() {
    const params = new URLSearchParams(location.search);
    const id = Number(params.get('id'));
    const style = id && await API.styles.get(id) || {
      name: params.get('domain') ||
        tryURL(params.get('url-prefix')).hostname ||
        '',
      enabled: true,
      sections: [
        MozDocMapper.toSection([...params], {code: ''}),
      ],
    };
    // switching the mode here to show the correct page ASAP, usually before DOMContentLoaded
    editor.isUsercss = Boolean(style.usercssData || !style.id && prefs.get('newStyleAsUsercss'));
    editor.style = style;
    editor.onStyleUpdated();
    editor.updateTitle(false);
    document.documentElement.classList.toggle('usercss', editor.isUsercss);
    sessionStore.justEditedStyleId = style.id || '';
    // no such style so let's clear the invalid URL parameters
    if (!style.id) history.replaceState({}, '', location.pathname);
  }

  /** Preloads the theme so CodeMirror can use the correct metrics in its first render */
  async function loadTheme() {
    const theme = prefs.get('editor.theme');
    if (!CODEMIRROR_THEMES.includes(theme)) {
      prefs.set('editor.theme', 'default');
      return;
    }
    if (theme !== 'default') {
      const el = $('#cm-theme');
      const el2 = await require([`/vendor/codemirror/theme/${theme}.css`]);
      el2.id = el.id;
      el.remove();
      // FF containers take more time to load CSS
      for (let retry = 0; !el2.sheet && ++retry <= 10;) {
        await new Promise(requestAnimationFrame);
      }
    }
  }
})();

//#endregion
//#region init layout/resize

baseInit.domReady.then(() => {
  let headerHeight;
  detectLayout(true);
  window.on('resize', () => detectLayout());

  function detectLayout(now) {
    const compact = window.innerWidth <= 850;
    if (compact) {
      document.body.classList.add('compact-layout');
      if (!editor.isUsercss) {
        if (now) fixedHeader();
        else debounce(fixedHeader, 250);
        window.on('scroll', fixedHeader, {passive: true});
      }
    } else {
      document.body.classList.remove('compact-layout', 'fixed-header');
      window.off('scroll', fixedHeader);
    }
    for (const el of $$('details[data-pref]')) {
      el.open = compact ? false : prefs.get(el.dataset.pref);
    }
  }

  function fixedHeader() {
    const headerFixed = $('.fixed-header');
    if (!headerFixed) headerHeight = $('#header').clientHeight;
    const scrollPoint = headerHeight - 43;
    if (window.scrollY >= scrollPoint && !headerFixed) {
      $('body').style.setProperty('--fixed-padding', ` ${headerHeight}px`);
      $('body').classList.add('fixed-header');
    } else if (window.scrollY < scrollPoint && headerFixed) {
      $('body').classList.remove('fixed-header');
    }
  }
});

//#endregion
//#region init header

baseInit.ready.then(() => {
  initBeautifyButton($('#beautify'));
  initKeymapElement();
  initNameArea();
  initThemeElement();
  setupLivePrefs();

  require(Object.values(editor.lazyKeymaps), () => {
    initKeymapElement();
    prefs.subscribe('editor.keyMap', showHotkeyInTooltip, {runNow: true});
    window.on('showHotkeyInTooltip', showHotkeyInTooltip);
  });

  function findKeyForCommand(command, map) {
    if (typeof map === 'string') map = CodeMirror.keyMap[map];
    let key = Object.keys(map).find(k => map[k] === command);
    if (key) {
      return key;
    }
    for (const ft of Array.isArray(map.fallthrough) ? map.fallthrough : [map.fallthrough]) {
      key = ft && findKeyForCommand(command, ft);
      if (key) {
        return key;
      }
    }
    return '';
  }

  function initNameArea() {
    const nameEl = $('#name');
    const resetEl = $('#reset-name');
    const isCustomName = editor.style.updateUrl || editor.isUsercss;
    editor.nameTarget = isCustomName ? 'customName' : 'name';
    nameEl.placeholder = t(editor.isUsercss ? 'usercssEditorNamePlaceholder' : 'styleMissingName');
    nameEl.title = isCustomName ? t('customNameHint') : '';
    nameEl.on('input', () => {
      editor.updateName(true);
      resetEl.hidden = false;
    });
    resetEl.hidden = !editor.style.customName;
    resetEl.onclick = () => {
      const {style} = editor;
      nameEl.focus();
      nameEl.select();
      // trying to make it undoable via Ctrl-Z
      if (!document.execCommand('insertText', false, style.name)) {
        nameEl.value = style.name;
        editor.updateName(true);
      }
      style.customName = null; // to delete it from db
      resetEl.hidden = true;
    };
    const enabledEl = $('#enabled');
    enabledEl.onchange = () => editor.updateEnabledness(enabledEl.checked);
  }

  function initThemeElement() {
    $('#editor.theme').append(...[
      $create('option', {value: 'default'}, t('defaultTheme')),
      ...CODEMIRROR_THEMES.map(s => $create('option', s)),
    ]);
    // move the theme after built-in CSS so that its same-specificity selectors win
    document.head.appendChild($('#cm-theme'));
  }

  function initKeymapElement() {
    // move 'pc' or 'mac' prefix to the end of the displayed label
    const maps = Object.keys(CodeMirror.keyMap)
      .map(name => ({
        value: name,
        name: name.replace(/^(pc|mac)(.+)/, (s, arch, baseName) =>
          baseName.toLowerCase() + '-' + (arch === 'mac' ? 'Mac' : 'PC')),
      }))
      .sort((a, b) => a.name < b.name && -1 || a.name > b.name && 1);

    const fragment = document.createDocumentFragment();
    let bin = fragment;
    let groupName;
    // group suffixed maps in <optgroup>
    maps.forEach(({value, name}, i) => {
      groupName = !name.includes('-') ? name : groupName;
      const groupWithNext = maps[i + 1] && maps[i + 1].name.startsWith(groupName);
      if (groupWithNext) {
        if (bin === fragment) {
          bin = fragment.appendChild($create('optgroup', {label: name.split('-')[0]}));
        }
      }
      const el = bin.appendChild($create('option', {value}, name));
      if (value === prefs.defaults['editor.keyMap']) {
        el.dataset.default = '';
        el.title = t('defaultTheme');
      }
      if (!groupWithNext) bin = fragment;
    });
    const selector = $('#editor.keyMap');
    selector.textContent = '';
    selector.appendChild(fragment);
    selector.value = prefs.get('editor.keyMap');
  }

  function showHotkeyInTooltip(_, mapName = prefs.get('editor.keyMap')) {
    const extraKeys = CodeMirror.defaults.extraKeys;
    for (const el of $$('[data-hotkey-tooltip]')) {
      if (el._hotkeyTooltipKeyMap !== mapName) {
        el._hotkeyTooltipKeyMap = mapName;
        const title = el._hotkeyTooltipTitle = el._hotkeyTooltipTitle || el.title;
        const cmd = el.dataset.hotkeyTooltip;
        const key = cmd[0] === '=' ? cmd.slice(1) :
          findKeyForCommand(cmd, mapName) ||
          extraKeys && findKeyForCommand(cmd, extraKeys);
        const newTitle = title + (title && key ? '\n' : '') + (key || '');
        if (el.title !== newTitle) el.title = newTitle;
      }
    }
  }
});

//#endregion
//#region init windowed mode

(() => {
  let ownTabId;
  if (chrome.windows) {
    initWindowedMode();
    const pos = tryJSONparse(sessionStore.windowPos);
    delete sessionStore.windowPos;
    // resize the window on 'undo close'
    if (pos && pos.left != null) {
      chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, pos);
    }
  }

  getOwnTab().then(async tab => {
    ownTabId = tab.id;
    // use browser history back when 'back to manage' is clicked
    if (sessionStore['manageStylesHistory' + ownTabId] === location.href) {
      await baseInit.domReady;
      $('#cancel-button').onclick = event => {
        event.stopPropagation();
        event.preventDefault();
        history.back();
      };
    }
  });

  async function initWindowedMode() {
    chrome.tabs.onAttached.addListener(onTabAttached);
    const isSimple = (await browser.windows.getCurrent()).type === 'popup';
    if (isSimple) require(['/edit/embedded-popup']);
    editor.isWindowed = isSimple || (
      history.length === 1 &&
      await prefs.ready && prefs.get('openEditInWindow') &&
      (await browser.windows.getAll()).length > 1 &&
      (await browser.tabs.query({currentWindow: true})).length === 1
    );
  }

  async function onTabAttached(tabId, info) {
    if (tabId !== ownTabId) {
      return;
    }
    if (info.newPosition !== 0) {
      prefs.set('openEditInWindow', false);
      return;
    }
    const win = await browser.windows.get(info.newWindowId, {populate: true});
    // If there's only one tab in this window, it's been dragged to new window
    const openEditInWindow = win.tabs.length === 1;
    // FF-only because Chrome retardedly resets the size during dragging
    if (openEditInWindow && FIREFOX) {
      chrome.windows.update(info.newWindowId, prefs.get('windowPosition'));
    }
    prefs.set('openEditInWindow', openEditInWindow);
  }
})();

//#endregion
//#region internals

/** @returns DirtyReporter */
function DirtyReporter() {
  const data = new Map();
  const listeners = new Set();
  const notifyChange = wasDirty => {
    if (wasDirty !== (data.size > 0)) {
      listeners.forEach(cb => cb());
    }
  };
  /** @namespace DirtyReporter */
  return {
    add(obj, value) {
      const wasDirty = data.size > 0;
      const saved = data.get(obj);
      if (!saved) {
        data.set(obj, {type: 'add', newValue: value});
      } else if (saved.type === 'remove') {
        if (saved.savedValue === value) {
          data.delete(obj);
        } else {
          saved.newValue = value;
          saved.type = 'modify';
        }
      }
      notifyChange(wasDirty);
    },
    clear(obj) {
      const wasDirty = data.size > 0;
      if (obj === undefined) {
        data.clear();
      } else {
        data.delete(obj);
      }
      notifyChange(wasDirty);
    },
    has(key) {
      return data.has(key);
    },
    isDirty() {
      return data.size > 0;
    },
    modify(obj, oldValue, newValue) {
      const wasDirty = data.size > 0;
      const saved = data.get(obj);
      if (!saved) {
        if (oldValue !== newValue) {
          data.set(obj, {type: 'modify', savedValue: oldValue, newValue});
        }
      } else if (saved.type === 'modify') {
        if (saved.savedValue === newValue) {
          data.delete(obj);
        } else {
          saved.newValue = newValue;
        }
      } else if (saved.type === 'add') {
        saved.newValue = newValue;
      }
      notifyChange(wasDirty);
    },
    onChange(cb, add = true) {
      listeners[add ? 'add' : 'delete'](cb);
    },
    remove(obj, value) {
      const wasDirty = data.size > 0;
      const saved = data.get(obj);
      if (!saved) {
        data.set(obj, {type: 'remove', savedValue: value});
      } else if (saved.type === 'add') {
        data.delete(obj);
      } else if (saved.type === 'modify') {
        saved.type = 'remove';
      }
      notifyChange(wasDirty);
    },
  };
}

//#endregion
