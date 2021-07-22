/* global API */// msg.js
'use strict';

(() => {
  const allowedOrigin = 'https://userstyles.world';

  const sendPostMessage = message => {
    if (allowedOrigin === location.origin) {
      window.postMessage(message, location.origin);
    }
  };

  const onPageLoaded = event => {
    if (event.data
    && event.data.type === 'usw-ready'
    && allowedOrigin === event.origin
    ) {
      sendPostMessage({type: 'usw-remove-stylus-button'});

      if (location.pathname === '/api/oauth/style/new') {
        const styleId = Number(new URLSearchParams(location.search).get('vendor_data'));
        API.data.pop('usw' + styleId).then(data => {
          sendPostMessage({type: 'usw-fill-new-style', data});
        });
      }
    }
  };

  window.addEventListener('message', onPageLoaded);
})();
