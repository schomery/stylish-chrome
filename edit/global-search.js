/* global $ $$ $create $remove focusAccessibility toggleDataset */// dom.js
/* global CodeMirror */
/* global chromeLocal */// storage-util.js
/* global colorMimicry */
/* global debounce stringAsRegExp tryRegExp */// toolbox.js
/* global editor */
/* global t */// localization.js
'use strict';

(() => {
  require(['/edit/global-search.css']);

  //region Constants and state

  const INCREMENTAL_SEARCH_DELAY = 0;
  const ANNOTATE_SCROLLBAR_DELAY = 350;
  const ANNOTATE_SCROLLBAR_OPTIONS = {maxMatches: 10e3};
  const STORAGE_UPDATE_DELAY = 500;

  const DIALOG_SELECTOR = '#search-replace-dialog';
  const DIALOG_STYLE_SELECTOR = '#search-replace-dialog-style';
  const TARGET_CLASS = 'search-target-editor';
  const MATCH_CLASS = 'search-target-match';
  const MATCH_TOKEN_NAME = 'searching';
  const APPLIES_VALUE_CLASS = 'applies-value';

  const RX_MAYBE_REGEXP = /^\s*\/(.+?)\/([simguy]*)\s*$/;

  const state = {
    firstRun: true,
    // used for case-sensitive matching directly
    find: '',
    // used when /re/ is detected or for case-insensitive matching
    rx: null,
    // used by overlay and doSearchInApplies, equals to rx || stringAsRegExp(find)
    rx2: null,

    icase: true,
    reverse: false,
    lastFind: '',

    numFound: 0,
    numApplies: -1,

    replace: '',
    lastReplace: null,

    cm: null,
    input: null,
    input2: null,
    dialog: null,
    tally: null,
    originalFocus: null,

    undoHistory: [],

    searchInApplies: !document.documentElement.classList.contains('usercss'),
  };

  //endregion
  //region Events

  const ACTIONS = {
    key: {
      'Enter': event => {
        switch (document.activeElement) {
          case state.input:
            if (state.dialog.dataset.type === 'find') {
              const found = doSearch({canAdvance: false});
              if (found) {
                const target = $('.' + TARGET_CLASS);
                const cm = target.CodeMirror;
                /* Since this runs in `keydown` event we have to delay focusing
                 * to prevent CodeMirror from seeing and handling the key */
                setTimeout(() => (cm || target).focus());
                if (cm) {
                  const {from, to} = cm.state.search.searchPos;
                  cm.jumpToPos(from, to);
                }
              }
              destroyDialog({restoreFocus: !found});
              return;
            }
            // fallthrough
          case state.input2:
            doReplace();
            return;
        }
        return !focusAccessibility.closest(event.target);
      },
      'Esc': () => {
        destroyDialog({restoreFocus: true});
      },
    },
    click: {
      next: () => doSearch({reverse: false}),
      prev: () => doSearch({reverse: true}),
      close: () => destroyDialog({restoreFocus: true}),
      replace: () => doReplace(),
      replaceAll: () => doReplaceAll(),
      undo: () => doUndo(),
      clear() {
        setInputValue(this._input, '');
      },
      case() {
        state.icase = !state.icase;
        state.lastFind = '';
        toggleDataset(this, 'enabled', !state.icase);
        doSearch({canAdvance: false});
      },
    },
  };

  const EVENTS = {
    oninput() {
      state.find = state.input.value;
      debounce(doSearch, INCREMENTAL_SEARCH_DELAY, {canAdvance: false});
      adjustTextareaSize(this);
      if (!state.find) enableReplaceButtons(false);
    },
    onkeydown(event) {
      const action = ACTIONS.key[CodeMirror.keyName(event)];
      if (action && action(event) !== false) {
        event.preventDefault();
      }
    },
    onclick(event) {
      const el = event.target.closest('[data-action]');
      const action = el && ACTIONS.click[el.dataset.action];
      if (action && action.call(el, event) !== false) {
        event.preventDefault();
      }
    },
    onfocusout() {
      if (!state.dialog.contains(document.activeElement)) {
        state.dialog.on('focusin', EVENTS.onfocusin);
        state.dialog.off('focusout', EVENTS.onfocusout);
      }
    },
    onfocusin() {
      state.dialog.on('focusout', EVENTS.onfocusout);
      state.dialog.off('focusin', EVENTS.onfocusin);
      trimUndoHistory();
      enableUndoButton(state.undoHistory.length);
      if (state.find) doSearch({canAdvance: false});
    },
  };

  const DIALOG_PROPS = {
    dialog: {
      onclick: EVENTS.onclick,
      onkeydown: EVENTS.onkeydown,
    },
    input: {
      oninput: EVENTS.oninput,
    },
    input2: {
      oninput() {
        state.replace = this.value;
        adjustTextareaSize(this);
        debounce(writeStorage, STORAGE_UPDATE_DELAY);
      },
    },
  };

  //endregion
  //region Commands

  const COMMANDS = {
    find(cm, {reverse = false} = {}) {
      state.reverse = reverse;
      focusDialog('find', cm);
    },
    findNext: cm => doSearch({reverse: false, cm}),
    findPrev: cm => doSearch({reverse: true, cm}),
    replace(cm) {
      state.reverse = false;
      focusDialog('replace', cm);
    },
  };
  COMMANDS.replaceAll = COMMANDS.replace;

  //endregion

  Object.assign(CodeMirror.commands, COMMANDS);
  readStorage();

  //region Find

  function initState({initReplace} = {}) {
    const text = state.find;
    const textChanged = text !== state.lastFind;
    if (textChanged) {
      state.numFound = 0;
      state.numApplies = -1;
      state.lastFind = text;
      const match = text && text.match(RX_MAYBE_REGEXP);
      const unicodeFlag = 'unicode' in RegExp.prototype ? 'u' : '';
      const string2regexpFlags = (state.icase ? 'gi' : 'g') + unicodeFlag;
      state.rx = match && tryRegExp(match[1], 'g' + match[2].replace(/[guy]/g, '') + unicodeFlag) ||
        text && (state.icase || text.includes('\n')) && stringAsRegExp(text, string2regexpFlags);
      state.rx2 = state.rx || text && stringAsRegExp(text, string2regexpFlags);
      state.cursorOptions = {
        caseFold: !state.rx && state.icase,
        multiline: true,
      };
      debounce(writeStorage, STORAGE_UPDATE_DELAY);
    }
    if (initReplace && state.replace !== state.lastReplace) {
      state.lastReplace = state.replace;
      state.replaceValue = state.replace.replace(/(\\r)?\\n/g, '\n').replace(/\\t/g, '\t');
      state.replaceHasRefs = /\$[$&`'\d]/.test(state.replaceValue);
    }
    const cmFocused = document.activeElement && document.activeElement.closest('.CodeMirror');
    state.activeAppliesTo = $(`.${APPLIES_VALUE_CLASS}:focus, .${APPLIES_VALUE_CLASS}.${TARGET_CLASS}`);
    state.cmStart = editor.closestVisible(
      cmFocused && document.activeElement ||
      state.activeAppliesTo ||
      state.cm);
    const cmExtra = $('body > :not(#sections) .CodeMirror');
    state.editors = cmExtra ? [cmExtra.CodeMirror] : editor.getEditors();
  }


  function doSearch({
    reverse = state.reverse,
    canAdvance = true,
    inApplies = true,
    cm,
  } = {}) {
    if (cm) setActiveEditor(cm);
    state.reverse = reverse;
    if (!state.find && !dialogShown()) {
      focusDialog('find', state.cm);
      return;
    }
    initState();
    const {cmStart} = state;
    const {index, found, foundInCode} = state.find && doSearchInEditors({cmStart, canAdvance, inApplies}) || {};
    if (!foundInCode) clearMarker();
    if (!found) makeTargetVisible(null);
    const radiateFrom = foundInCode ? index : state.editors.indexOf(cmStart);
    setupOverlay(radiateArray(state.editors, radiateFrom));
    enableReplaceButtons(foundInCode);
    if (state.find) {
      const firstSuccessfulSearch = foundInCode && !state.numFound;
      debounce(showTally, 0, firstSuccessfulSearch ? 1 : undefined);
    } else {
      showTally(0, 0);
    }
    state.firstRun = false;
    return found;
  }


  function doSearchInEditors({cmStart, canAdvance, inApplies}) {
    const query = state.rx || state.find;
    const reverse = state.reverse;
    const BOF = {line: 0, ch: 0};
    const EOF = getEOF(cmStart);

    const start = state.editors.indexOf(cmStart);
    const total = state.editors.length;
    let i = 0;
    let wrapAround = 0;
    let pos, index, cm;

    if (inApplies && state.activeAppliesTo) {
      if (doSearchInApplies(state.cmStart, canAdvance)) {
        return {found: true};
      }
      if (reverse) pos = EOF; else i++;
    } else {
      pos = getContinuationPos({cm: cmStart, reverse: !canAdvance || reverse});
      wrapAround = !reverse ?
        CodeMirror.cmpPos(pos, BOF) > 0 :
        CodeMirror.cmpPos(pos, EOF) < 0;
    }

    for (; i < total + wrapAround; i++) {
      index = (start + i * (reverse ? -1 : 1) + total) % total;
      cm = state.editors[index];
      if (i) {
        pos = !reverse ? BOF : {line: cm.doc.size, ch: 0};
      }
      const cursor = cm.getSearchCursor(query, pos, state.cursorOptions);
      if (cursor.find(reverse)) {
        makeMatchVisible(cm, cursor);
        return {found: true, foundInCode: true, index};
      }
      const cmForNextApplies = !reverse ? cm : state.editors[index ? index - 1 : total - 1];
      if (inApplies && doSearchInApplies(cmForNextApplies)) {
        return {found: true};
      }
    }
  }


  function doSearchInApplies(cm, canAdvance) {
    if (!state.searchInApplies) return;
    const inputs = editor.getSearchableInputs(cm);
    if (state.reverse) inputs.reverse();
    inputs.splice(0, inputs.indexOf(state.activeAppliesTo));
    for (const input of inputs) {
      const value = input.value;
      if (input === state.activeAppliesTo) {
        state.rx2.lastIndex = input.selectionStart + canAdvance;
      } else {
        state.rx2.lastIndex = 0;
      }
      const match = state.rx2.exec(value);
      if (!match) {
        continue;
      }
      const end = match.index + match[0].length;
      // scroll selected part into view in long inputs,
      // works only outside of current event handlers chain, hence timeout=0
      setTimeout(() => {
        input.setSelectionRange(end, end);
        input.setSelectionRange(match.index, end);
      });
      const canFocus = !state.dialog || !state.dialog.contains(document.activeElement);
      makeTargetVisible(!canFocus && input);
      editor.scrollToEditor(cm);
      if (canFocus) input.focus();
      state.cm = cm;
      clearMarker();
      return true;
    }
  }

  //endregion
  //region Replace

  function doReplace() {
    initState({initReplace: true});
    const cm = state.cmStart;
    const generation = cm.changeGeneration();
    const pos = getContinuationPos({cm, reverse: true});
    const cursor = doReplaceInEditor({cm, pos});
    if (!cursor) {
      return;
    }

    if (cursor.findNext()) {
      clearMarker();
      makeMatchVisible(cm, cursor);
    } else {
      doSearchInEditors({cmStart: getNextEditor(cm)});
    }

    getStateSafe(cm).unclosedOp = false;
    if (cm.curOp) cm.endOperation();

    if (cursor) {
      state.undoHistory.push([[cm, generation]]);
      enableUndoButton(true);
    }
  }


  function doReplaceAll() {
    initState({initReplace: true});
    clearMarker();
    const generations = new Map(state.editors.map(cm => [cm, cm.changeGeneration()]));
    const found = state.editors.filter(cm => doReplaceInEditor({cm, all: true}));
    if (found.length) {
      state.lastFind = null;
      state.undoHistory.push(found.map(cm => [cm, generations.get(cm)]));
      enableUndoButton(true);
      doSearch({canAdvance: false});
    }
  }


  function doReplaceInEditor({cm, pos, all = false}) {
    const cursor = cm.getSearchCursor(state.rx || state.find, pos, state.cursorOptions);
    const replace = state.replaceValue;
    let found;

    cursor.find();
    while (cursor.atOccurrence) {
      found = true;
      if (!cm.curOp) {
        cm.startOperation();
        getStateSafe(cm).unclosedOp = true;
      }
      if (state.rx) {
        const text = cm.getRange(cursor.pos.from, cursor.pos.to);
        cursor.replace(state.replaceHasRefs ? text.replace(state.rx, replace) : replace);
      } else {
        cursor.replace(replace);
      }
      if (!all) {
        makeMatchVisible(cm, cursor);
        return cursor;
      }
      cursor.findNext();
    }
    if (all) {
      getStateSafe(cm).searchPos = null;
    }
    return found;
  }


  function doUndo() {
    let undoneSome;
    saveWindowScrollPos();
    for (const [cm, generation] of state.undoHistory.pop() || []) {
      if (document.body.contains(cm.display.wrapper) && !cm.isClean(generation)) {
        cm.undo();
        cm.getAllMarks().forEach(marker =>
          marker !== state.marker &&
          marker.className === MATCH_CLASS &&
          marker.clear());
        undoneSome = true;
      }
    }
    enableUndoButton(state.undoHistory.length);
    if (state.undoHistory.length) {
      focusUndoButton();
    } else {
      state.input.focus();
    }
    if (undoneSome) {
      state.lastFind = null;
      restoreWindowScrollPos();
      doSearch({
        reverse: false,
        canAdvance: false,
        inApplies: false,
      });
    }
  }

  //endregion
  //region Overlay


  function setupOverlay(queue, debounced) {
    if (!queue.length) {
      return;
    }
    if (queue.length > 1 || !debounced) {
      debounce(setupOverlay, 0, queue, true);
      if (!debounced) {
        return;
      }
    }

    let canContinue = true;
    while (queue.length && canContinue) {
      const cm = queue.shift();
      if (!document.body.contains(cm.display.wrapper)) {
        continue;
      }

      const cmState = getStateSafe(cm);
      const query = state.rx2;

      if ((cmState.overlay || {}).query === query) {
        if (cmState.unclosedOp && cm.curOp) cm.endOperation();
        cmState.unclosedOp = false;
        continue;
      }

      if (cmState.overlay) {
        if (!cm.curOp) cm.startOperation();
        cm.removeOverlay(cmState.overlay);
        cmState.overlay = null;
        canContinue = false;
      }

      const hasMatches = query && cm.getSearchCursor(query, null, state.cursorOptions).find();
      if (hasMatches) {
        if (!cm.curOp) cm.startOperation();
        cmState.overlay = {
          query,
          token: tokenize,
          numFound: 0,
          tallyShownTime: 0,
        };
        cm.addOverlay(cmState.overlay);
        canContinue = false;
      }

      if (cmState.annotate) {
        if (!cm.curOp) cm.startOperation();
        cmState.annotate.clear();
        cmState.annotate = null;
        canContinue = false;
      }
      if (cmState.annotateTimer) {
        clearTimeout(cmState.annotateTimer);
        cmState.annotateTimer = 0;
      }
      if (hasMatches) {
        cmState.annotateTimer = setTimeout(annotateScrollbar, ANNOTATE_SCROLLBAR_DELAY,
          cm, query, state.icase);
      }

      cmState.unclosedOp = false;
      if (cm.curOp) cm.endOperation();
    }

    if (!queue.length) debounce.unregister(setupOverlay);
  }


  function tokenize(stream) {
    this.query.lastIndex = stream.pos;
    const match = this.query.exec(stream.string);
    if (match && match.index === stream.pos) {
      this.numFound++;
      const t = performance.now();
      if (t - this.tallyShownTime > 10) {
        this.tallyShownTime = t;
        debounce(showTally);
      }
      stream.pos += match[0].length || 1;
      return MATCH_TOKEN_NAME;
    } else if (match) {
      stream.pos = match.index;
    } else {
      stream.skipToEnd();
    }
  }


  function annotateScrollbar(cm, query, icase) {
    getStateSafe(cm).annotate = cm.showMatchesOnScrollbar(query, icase, ANNOTATE_SCROLLBAR_OPTIONS);
    debounce(showTally);
  }

  //endregion
  //region Dialog

  function focusDialog(type, cm) {
    setActiveEditor(cm);

    const dialogFocused = state.dialog && state.dialog.contains(document.activeElement);
    let sel = dialogFocused ? '' : getSelection().toString() || cm && cm.getSelection();
    sel = !sel.includes('\n') && !sel.includes('\r') && sel;
    if (sel) state.find = sel;

    if (!dialogShown(type)) {
      destroyDialog();
      createDialog(type);
    } else if (sel) {
      setInputValue(state.input, sel);
    }

    state.input.focus();
    state.input.select();
    if (state.find) {
      doSearch({canAdvance: false});
    }
  }


  function dialogShown(type) {
    return document.body.contains(state.input) &&
      (!type || state.dialog.dataset.type === type);
  }


  function createDialog(type) {
    state.originalFocus = document.activeElement;
    state.firstRun = true;

    const dialog = state.dialog = t.template.searchReplaceDialog.cloneNode(true);
    Object.assign(dialog, DIALOG_PROPS.dialog);
    dialog.on('focusout', EVENTS.onfocusout);
    dialog.dataset.type = type;
    dialog.style.pointerEvents = 'auto';

    const content = $('[data-type="content"]', dialog);
    content.parentNode.replaceChild(t.template[type].cloneNode(true), content);

    createInput(0, 'input', state.find);
    createInput(1, 'input2', state.replace);
    toggleDataset($('[data-action="case"]', dialog), 'enabled', !state.icase);
    state.tally = $('[data-type="tally"]', dialog);

    const colors = {
      body: colorMimicry(document.body, {bg: 'backgroundColor'}),
      input: colorMimicry($('input:not(:disabled)'), {bg: 'backgroundColor'}),
      icon: colorMimicry($$('svg.info')[1], {fill: 'fill'}),
    };
    document.documentElement.appendChild(
      $(DIALOG_STYLE_SELECTOR) ||
      $create('style' + DIALOG_STYLE_SELECTOR)
    ).textContent = `
      #search-replace-dialog {
        background-color: ${colors.body.bg};
      }
      #search-replace-dialog textarea {
        color: ${colors.body.fore};
        background-color: ${colors.input.bg};
      }
      #search-replace-dialog svg {
        fill: ${colors.icon.fill};
      }
      #search-replace-dialog [data-action="case"] {
        color: ${colors.icon.fill};
      }
      #search-replace-dialog[data-type="replace"] button:hover svg,
      #search-replace-dialog svg:hover {
        fill: inherit;
      }
      #search-replace-dialog [data-action="case"]:hover {
        color: inherit;
      }
      #search-replace-dialog [data-action="clear"] {
        background-color: ${colors.input.bg.replace(/[^,]+$/, '') + '.75)'};
      }
    `;

    document.body.appendChild(dialog);
    dispatchEvent(new Event('showHotkeyInTooltip'));

    adjustTextareaSize(state.input);
    if (type === 'replace') {
      adjustTextareaSize(state.input2);
      enableReplaceButtons(state.find !== '');
      enableUndoButton(state.undoHistory.length);
    }

    return dialog;
  }


  function createInput(index, name, value) {
    const input = state[name] = $$('textarea', state.dialog)[index];
    if (!input) {
      return;
    }
    input.value = value;
    Object.assign(input, DIALOG_PROPS[name]);

    input.parentElement.appendChild(t.template.clearSearch.cloneNode(true));
    $('[data-action]', input.parentElement)._input = input;
  }


  function destroyDialog({restoreFocus = false} = {}) {
    state.input = null;
    $remove(DIALOG_SELECTOR);
    debounce.unregister(doSearch);
    makeTargetVisible(null);
    if (restoreFocus) {
      setTimeout(focusNoScroll, 0, state.originalFocus);
    } else {
      saveWindowScrollPos();
      restoreWindowScrollPos({immediately: false});
    }
  }


  function adjustTextareaSize(el) {
    const oldWidth = parseFloat(el.style.width) || el.clientWidth;
    const widthHistory = el._widthHistory = el._widthHistory || new Map();
    const knownWidth = widthHistory.get(el.value);
    let newWidth;
    if (knownWidth) {
      newWidth = knownWidth;
    } else {
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      newWidth = el.scrollWidth + (hasVerticalScrollbar ? el.scrollWidth - el.clientWidth : 0);
      newWidth += newWidth > oldWidth ? 50 : 0;
      widthHistory.set(el.value, newWidth);
    }
    if (newWidth !== oldWidth) {
      const dialogRightOffset = parseFloat(getComputedStyle(state.dialog).right);
      const dialogRight = state.dialog.getBoundingClientRect().right;
      const textRight = (state.input2 || state.input).getBoundingClientRect().right;
      newWidth = Math.min(newWidth,
        (window.innerWidth - dialogRightOffset - (dialogRight - textRight)) / (state.input2 ? 2 : 1) - 20);
      el.style.width = newWidth + 'px';
    }
    const numLines = el.value.split('\n').length;
    if (numLines !== Number(el.rows)) {
      el.rows = numLines;
    }
    el.style.overflowX = el.scrollWidth > el.clientWidth ? '' : 'hidden';
  }


  function enableReplaceButtons(enabled) {
    if (state.dialog && state.dialog.dataset.type === 'replace') {
      for (const el of $$('[data-action^="replace"]', state.dialog)) {
        el.disabled = !enabled;
      }
    }
  }


  function enableUndoButton(enabled) {
    if (state.dialog && state.dialog.dataset.type === 'replace') {
      for (const el of $$('[data-action="undo"]', state.dialog)) {
        el.disabled = !enabled;
      }
    }
  }


  function focusUndoButton() {
    for (const btn of $$('[data-action="undo"]', state.dialog)) {
      if (getComputedStyle(btn).display !== 'none') {
        btn.focus();
        break;
      }
    }
  }

  //endregion
  //region Utility

  function getStateSafe(cm) {
    return cm.state.search || (cm.state.search = {});
  }


  // determines search start position:
  // the cursor if it was moved or the last match
  function getContinuationPos({cm, reverse}) {
    const cmSearchState = getStateSafe(cm);
    const posType = reverse ? 'from' : 'to';
    const searchPos = (cmSearchState.searchPos || {})[posType];
    const cursorPos = cm.getCursor(posType);
    const preferCursor = !searchPos || CodeMirror.cmpPos(cursorPos, cmSearchState.cursorPos[posType]);
    return preferCursor ? cursorPos : searchPos;
  }


  function getEOF(cm) {
    const line = cm.doc.size - 1;
    return {line, ch: cm.getLine(line).length};
  }


  function getNextEditor(cm, step = 1) {
    const editors = state.editors;
    return editors[(editors.indexOf(cm) + step + editors.length) % editors.length];
  }


  // sets the editor to start the search in
  // e.g. when the user switched to another editor and invoked a search command
  function setActiveEditor(cm) {
    if (cm.display.wrapper.contains(document.activeElement)) {
      state.cm = cm;
      state.originalFocus = cm;
    }
  }


  // adds a class on the editor that contains the active match
  // instead of focusing it (in order to keep the minidialog focused)
  function makeTargetVisible(element) {
    const old = $('.' + TARGET_CLASS);
    if (old !== element) {
      if (old) {
        old.classList.remove(TARGET_CLASS);
        document.body.classList.remove('find-open');
      }
      if (element) {
        element.classList.add(TARGET_CLASS);
        document.body.classList.add('find-open');
      }
    }
  }


  // scrolls the editor to reveal the match
  function makeMatchVisible(cm, searchCursor) {
    const canFocus = !state.firstRun && (!state.dialog || !state.dialog.contains(document.activeElement));
    state.cm = cm;
    // scroll within the editor
    const pos = searchCursor.pos;
    Object.assign(getStateSafe(cm), {
      cursorPos: {
        from: cm.getCursor('from'),
        to: cm.getCursor('to'),
      },
      searchPos: pos,
      unclosedOp: !cm.curOp,
    });
    if (!cm.curOp) cm.startOperation();
    if (!state.firstRun) {
      cm.jumpToPos(pos.from, pos.to);
    }
    // focus or expose as the current search target
    clearMarker();
    if (canFocus) {
      cm.focus();
      makeTargetVisible(null);
    } else {
      makeTargetVisible(cm.display.wrapper);
      // mark the match
      state.marker = cm.state.search.marker = cm.markText(pos.from, pos.to, {
        className: MATCH_CLASS,
        clearOnEnter: true,
      });
    }
  }


  function clearMarker() {
    if (state.marker) state.marker.clear();
  }


  function showTally(num, numApplies) {
    if (!state.tally) return;
    if (num === undefined) {
      num = 0;
      for (const cm of state.editors) {
        const {annotate, overlay} = getStateSafe(cm);
        num +=
          ((annotate || {}).matches || []).length ||
          (overlay || {}).numFound ||
          0;
      }
      state.numFound = num;
    }
    if (numApplies === undefined && state.searchInApplies && state.numApplies < 0) {
      numApplies = 0;
      const elements = state.find ? document.getElementsByClassName(APPLIES_VALUE_CLASS) : [];
      const {rx} = state;
      for (const el of elements) {
        const value = el.value;
        if (rx) {
          rx.lastIndex = 0;
          // preventing an infinite loop if matched an empty string and didn't advance
          for (let m; (m = rx.exec(value)) && ++numApplies && rx.lastIndex > m.index;) { /* NOP */ }
        } else {
          let i = -1;
          while ((i = value.indexOf(state.find, i + 1)) >= 0) numApplies++;
        }
      }
      state.numApplies = numApplies;
    } else {
      numApplies = state.numApplies;
    }
    const newText = num + (numApplies > 0 ? '+' + numApplies : '');
    if (state.tally.textContent !== newText) {
      state.tally.textContent = newText;
      const newTitle = t('searchNumberOfResults' + (numApplies ? '2' : ''));
      if (state.tally.title !== newTitle) state.tally.title = newTitle;
    }
  }


  function trimUndoHistory() {
    const history = state.undoHistory;
    for (let last; (last = history[history.length - 1]);) {
      const undoables = last.filter(([cm, generation]) =>
        document.body.contains(cm.display.wrapper) && !cm.isClean(generation));
      if (undoables.length) {
        history[history.length - 1] = undoables;
        break;
      }
      history.length--;
    }
  }


  function focusNoScroll(el) {
    if (el) {
      saveWindowScrollPos();
      el.focus({preventScroll: true});
      restoreWindowScrollPos({immediately: false});
    }
  }


  function saveWindowScrollPos() {
    state.scrollX = window.scrollX;
    state.scrollY = window.scrollY;
  }


  function restoreWindowScrollPos({immediately = true} = {}) {
    if (!immediately) {
      // run in the next microtask cycle
      Promise.resolve().then(restoreWindowScrollPos);
      return;
    }
    if (window.scrollX !== state.scrollX || window.scrollY !== state.scrollY) {
      window.scrollTo(state.scrollX, state.scrollY);
    }
  }


  // produces [i, i+1, i-1, i+2, i-2, i+3, i-3, ...]
  function radiateArray(arr, focalIndex) {
    const focus = arr[focalIndex];
    if (!focus) return arr;
    const result = [focus];
    const len = arr.length;
    for (let i = 1; i < len; i++) {
      if (focalIndex + i < len) {
        result.push(arr[focalIndex + i]);
      }
      if (focalIndex - i >= 0) {
        result.push(arr[focalIndex - i]);
      }
    }
    return result;
  }


  function readStorage() {
    chromeLocal.getValue('editor').then((editor = {}) => {
      state.find = editor.find || '';
      state.replace = editor.replace || '';
      state.icase = editor.icase || state.icase;
    });
  }


  function writeStorage() {
    chromeLocal.getValue('editor').then((editor = {}) =>
      chromeLocal.setValue('editor', Object.assign(editor, {
        find: state.find,
        replace: state.replace,
        icase: state.icase,
      })));
  }


  function setInputValue(input, value) {
    input.focus();
    input.select();
    // using execCommand to add to the input's undo history
    document.execCommand(value ? 'insertText' : 'delete', false, value);
    // some versions of Firefox ignore execCommand
    if (input.value !== value) {
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }
  }

  //endregion
})();
