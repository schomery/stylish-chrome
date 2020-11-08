/* global
  $
  cmFactory
  debounce
  DocFuncMapper
  editor
  initBeautifyButton
  linter
  prefs
  regExpTester
  t
  template
  trimCommentLabel
  tryRegExp
*/
'use strict';

/* exported createSection */

/** @returns {EditorSection} */
function createSection(originalSection, genId) {
  const {dirty} = editor;
  const sectionId = genId();
  const el = template.section.cloneNode(true);
  const elLabel = $('.code-label', el);
  const cm = cmFactory.create(wrapper => {
    const {height} = originalSection.localState || {};
    // making it tall during initial load so IntersectionObserver sees only one adjacent CM
    wrapper.style.height = height ? height + 'px' : '100vh';
    elLabel.after(wrapper);
  }, {
    value: originalSection.code,
  });
  el.CodeMirror = cm; // used by getAssociatedEditor

  const changeListeners = new Set();

  const appliesToContainer = $('.applies-to-list', el);
  const appliesTo = [];
  DocFuncMapper.forEachProp(originalSection, (type, value) =>
    insertApplyAfter({type, value}));
  if (!appliesTo.length) {
    insertApplyAfter({all: true});
  }

  let changeGeneration = cm.changeGeneration();
  let removed = false;

  registerEvents();
  updateRegexpTester();
  createResizeGrip(cm);

  /** @namespace EditorSection */
  const section = {
    id: sectionId,
    el,
    cm,
    appliesTo,
    getModel() {
      const items = appliesTo.map(a => !a.all && [a.type, a.value]);
      const height = Number(cm.display.wrapper.style.height.match(/[0-9.]+(?=px)|$/)[0]) || 0;
      return DocFuncMapper.toSection(items, Object.assign({
        code: cm.getValue(),
      }, height && {
        localState: {height},
      }));
    },
    remove() {
      linter.disableForEditor(cm);
      el.classList.add('removed');
      removed = true;
      appliesTo.forEach(a => a.remove());
    },
    render() {
      cm.refresh();
    },
    destroy() {
      cmFactory.destroy(cm);
    },
    restore() {
      linter.enableForEditor(cm);
      el.classList.remove('removed');
      removed = false;
      appliesTo.forEach(a => a.restore());
      cm.refresh();
    },
    onChange(fn) {
      changeListeners.add(fn);
    },
    off(fn) {
      changeListeners.delete(fn);
    },
    get removed() {
      return removed;
    },
    tocEntry: {
      label: '',
      get removed() {
        return removed;
      },
    },
  };

  prefs.subscribe('editor.toc.expanded', updateTocPrefToggled, {now: true});

  return section;

  function emitSectionChange(origin) {
    for (const fn of changeListeners) {
      fn(origin);
    }
  }

  function registerEvents() {
    cm.on('changes', () => {
      const newGeneration = cm.changeGeneration();
      dirty.modify(`section.${sectionId}.code`, changeGeneration, newGeneration);
      changeGeneration = newGeneration;
      emitSectionChange('code');
    });
    cm.display.wrapper.on('keydown', event => handleKeydown(cm, event), true);
    $('.test-regexp', el).onclick = () => {
      regExpTester.toggle();
      updateRegexpTester();
    };
    initBeautifyButton($('.beautify-section', el), () => [cm]);
  }

  function handleKeydown(cm, event) {
    if (event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    const {key} = event;
    const {line, ch} = cm.getCursor();
    switch (key) {
      case 'ArrowLeft':
        if (line || ch) {
          return;
        }
      // fallthrough
      case 'ArrowUp':
        cm = line === 0 && editor.prevEditor(cm, false);
        if (!cm) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        cm.setCursor(cm.doc.size - 1, key === 'ArrowLeft' ? 1e20 : ch);
        break;
      case 'ArrowRight':
        if (line < cm.doc.size - 1 || ch < cm.getLine(line).length - 1) {
          return;
        }
      // fallthrough
      case 'ArrowDown':
        cm = line === cm.doc.size - 1 && editor.nextEditor(cm, false);
        if (!cm) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        cm.setCursor(0, 0);
        break;
    }
  }

  function updateRegexpTester() {
    const regexps = appliesTo.filter(a => a.type === 'regexp')
      .map(a => a.value);
    if (regexps.length) {
      el.classList.add('has-regexp');
      regExpTester.update(regexps);
    } else {
      el.classList.remove('has-regexp');
      regExpTester.toggle(false);
    }
  }

  function updateTocEntry(origin) {
    const te = section.tocEntry;
    let changed;
    if (origin === 'code' || !origin) {
      const label = getLabelFromComment();
      if (te.label !== label) {
        te.label = elLabel.dataset.text = label;
        changed = true;
      }
    }
    if (!te.label) {
      const target = appliesTo[0].all ? null : appliesTo[0].value;
      if (te.target !== target) {
        te.target = target;
        changed = true;
      }
      if (te.numTargets !== appliesTo.length) {
        te.numTargets = appliesTo.length;
        changed = true;
      }
    }
    if (changed) editor.updateToc([section]);
  }

  function updateTocEntryLazy(...args) {
    debounce(updateTocEntry, 0, ...args);
  }

  function updateTocFocus() {
    editor.updateToc({focus: true, 0: section});
  }

  function updateTocPrefToggled(key, val) {
    changeListeners[val ? 'add' : 'delete'](updateTocEntryLazy);
    el.onOff(val, 'focusin', updateTocFocus);
    if (val) {
      updateTocEntry();
      if (el.contains(document.activeElement)) {
        updateTocFocus();
      }
    }
  }

  function getLabelFromComment() {
    let cmt = '';
    let inCmt;
    cm.eachLine(({text}) => {
      let i = 0;
      if (!inCmt) {
        i = text.search(/\S/);
        if (i < 0) return;
        inCmt = text[i] === '/' && text[i + 1] === '*';
        if (!inCmt) return true;
        i += 2;
      }
      const j = text.indexOf('*/', i);
      cmt = trimCommentLabel(text.slice(i, j >= 0 ? j : text.length));
      return j >= 0 || cmt;
    });
    return cmt;
  }

  function insertApplyAfter(init, base) {
    const apply = createApply(init);
    appliesTo.splice(base ? appliesTo.indexOf(base) + 1 : appliesTo.length, 0, apply);
    appliesToContainer.insertBefore(apply.el, base ? base.el.nextSibling : null);
    dirty.add(apply, apply);
    if (appliesTo.length > 1 && appliesTo[0].all) {
      removeApply(appliesTo[0]);
    }
    emitSectionChange('apply');
    return apply;
  }

  function removeApply(apply) {
    const index = appliesTo.indexOf(apply);
    appliesTo.splice(index, 1);
    apply.remove();
    apply.el.remove();
    dirty.remove(apply, apply);
    if (!appliesTo.length) {
      insertApplyAfter({all: true});
    }
    emitSectionChange('apply');
  }

  function createApply({type = 'url', value, all = false}) {
    const applyId = genId();
    const dirtyPrefix = `section.${sectionId}.apply.${applyId}`;
    const el = all ? template.appliesToEverything.cloneNode(true) :
      template.appliesTo.cloneNode(true);

    const selectEl = !all && $('.applies-type', el);
    if (selectEl) {
      selectEl.value = type;
      selectEl.on('change', () => {
        const oldType = type;
        dirty.modify(`${dirtyPrefix}.type`, type, selectEl.value);
        type = selectEl.value;
        if (oldType === 'regexp' || type === 'regexp') {
          updateRegexpTester();
        }
        emitSectionChange('apply');
        validate();
      });
    }

    const valueEl = !all && $('.applies-value', el);
    if (valueEl) {
      valueEl.value = value;
      valueEl.on('input', () => {
        dirty.modify(`${dirtyPrefix}.value`, value, valueEl.value);
        value = valueEl.value;
        if (type === 'regexp') {
          updateRegexpTester();
        }
        emitSectionChange('apply');
      });
      valueEl.on('change', validate);
    }

    restore();

    const apply = {
      id: applyId,
      all,
      remove,
      restore,
      el,
      valueEl, // used by validator
      get type() {
        return type;
      },
      get value() {
        return value;
      },
    };

    const removeButton = $('.remove-applies-to', el);
    if (removeButton) {
      removeButton.on('click', e => {
        e.preventDefault();
        removeApply(apply);
      });
    }
    $('.add-applies-to', el).on('click', e => {
      e.preventDefault();
      const newApply = insertApplyAfter({type, value: ''}, apply);
      $('input', newApply.el).focus();
    });

    return apply;

    function validate() {
      if (type !== 'regexp' || tryRegExp(value)) {
        valueEl.setCustomValidity('');
      } else {
        valueEl.setCustomValidity(t('styleBadRegexp'));
        setTimeout(() => valueEl.reportValidity());
      }
    }

    function remove() {
      if (all) {
        return;
      }
      dirty.remove(`${dirtyPrefix}.type`, type);
      dirty.remove(`${dirtyPrefix}.value`, value);
    }

    function restore() {
      if (all) {
        return;
      }
      dirty.add(`${dirtyPrefix}.type`, type);
      dirty.add(`${dirtyPrefix}.value`, value);
    }
  }
}

function createResizeGrip(cm) {
  const wrapper = cm.display.wrapper;
  wrapper.classList.add('resize-grip-enabled');
  const resizeGrip = template.resizeGrip.cloneNode(true);
  wrapper.appendChild(resizeGrip);
  let lastClickTime = 0;
  let initHeight;
  let initY;
  resizeGrip.onmousedown = event => {
    initHeight = wrapper.offsetHeight;
    initY = event.pageY;
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (Date.now() - lastClickTime < 500) {
      lastClickTime = 0;
      toggleSectionHeight(cm);
      return;
    }
    lastClickTime = Date.now();
    const minHeight = cm.defaultTextHeight() +
      /* .CodeMirror-lines padding */
      cm.display.lineDiv.offsetParent.offsetTop +
      /* borders */
      wrapper.offsetHeight - wrapper.clientHeight;
    wrapper.style.pointerEvents = 'none';
    document.body.style.cursor = 's-resize';
    document.on('mousemove', resize);
    document.on('mouseup', resizeStop);

    function resize(e) {
      const height = Math.max(minHeight, initHeight + e.pageY - initY);
      if (height !== wrapper.offsetHeight) {
        cm.setSize(null, height);
      }
    }

    function resizeStop() {
      document.off('mouseup', resizeStop);
      document.off('mousemove', resize);
      wrapper.style.pointerEvents = '';
      document.body.style.cursor = '';
    }
  };

  function toggleSectionHeight(cm) {
    if (cm.state.toggleHeightSaved) {
      // restore previous size
      cm.setSize(null, cm.state.toggleHeightSaved);
      cm.state.toggleHeightSaved = 0;
    } else {
      // maximize
      const wrapper = cm.display.wrapper;
      const allBounds = $('#sections').getBoundingClientRect();
      const pageExtrasHeight = allBounds.top + window.scrollY +
        parseFloat(getComputedStyle($('#sections')).paddingBottom);
      const sectionEl = wrapper.parentNode;
      const sectionExtrasHeight = sectionEl.clientHeight - wrapper.offsetHeight;
      cm.state.toggleHeightSaved = wrapper.clientHeight;
      cm.setSize(null, window.innerHeight - sectionExtrasHeight - pageExtrasHeight);
      const bounds = sectionEl.getBoundingClientRect();
      if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
        window.scrollBy(0, bounds.top);
      }
    }
  }
}
