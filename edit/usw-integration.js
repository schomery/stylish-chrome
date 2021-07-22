/* global $ messageBoxProxy toggleDataset */// dom.js
/* global API msg */// msg.js
/* global baseInit */
/* global editor */
/* global t */// localization.js
'use strict';

(() => {
  const ERROR_TITLE = 'UserStyles.world ' + t('genericError');

  msg.onExtension(request => {
    if (request.method === 'uswData' &&
        request.style.id === editor.style.id) {
      Object.assign(editor.style, request.style);
      updateUI();
    }
  });

  baseInit.ready.then(() => {
    updateUI();
    $('#usw-publish-style').onclick = disableWhileActive(publishStyle);
    $('#usw-revoke-link').onclick = disableWhileActive(revokeLink);
  });

  async function publishStyle() {
    const {id} = editor.style;
    if (await API.data.has('usw' + id) &&
        !await messageBoxProxy.confirm(t('publishRetry'), 'danger', ERROR_TITLE)) {
      return;
    }
    const code = editor.getEditors()[0].getValue();
    const res = await API.usw.publish(id, code);
    const err = /^Error:\s*(.*)|$/.exec(res)[1];
    if (err) messageBoxProxy.alert(err, 'pre-line danger', ERROR_TITLE);
  }

  async function revokeLink() {
    await API.usw.revoke(editor.style.id);
  }

  function updateUI(style = editor.style) {
    const usw = style._usw || {};
    toggleDataset($('#publish'), 'connected', usw.token);
    $('#usw-style-name').textContent = usw.name || '';
    $('#usw-style-descr').textContent = usw.description || '';
  }

  function disableWhileActive(fn) {
    /** @this {Element} */
    return async function () {
      this.disabled = true;
      await fn().catch(console.error);
      this.disabled = false;
    };
  }
})();
