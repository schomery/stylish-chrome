var webextLaunchWebAuthFlow = (function () {
  'use strict';

  function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
    try {
      var info = gen[key](arg);
      var value = info.value;
    } catch (error) {
      reject(error);
      return;
    }

    if (info.done) {
      resolve(value);
    } else {
      Promise.resolve(value).then(_next, _throw);
    }
  }

  function _asyncToGenerator(fn) {
    return function () {
      var self = this,
          args = arguments;
      return new Promise(function (resolve, reject) {
        var gen = fn.apply(self, args);

        function _next(value) {
          asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
        }

        function _throw(err) {
          asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
        }

        _next(undefined);
      });
    };
  }

  /* eslint-env webextensions */
  function createWindow(_x) {
    return _createWindow.apply(this, arguments);
  }

  function _createWindow() {
    _createWindow = _asyncToGenerator(function* (options) {
      if (browser.windows) {
        return yield browser.windows.create(options);
      }

      const tabOptions = {
        active: options.state !== "minimized",
        url: options.url
      };
      const tab = yield browser.tabs.create(tabOptions);
      return {
        tabs: [tab]
      };
    });
    return _createWindow.apply(this, arguments);
  }

  function updateWindow(_x2, _x3, _x4) {
    return _updateWindow.apply(this, arguments);
  }

  function _updateWindow() {
    _updateWindow = _asyncToGenerator(function* (windowId, tabId, options) {
      if (windowId) {
        return yield browser.windows.update(windowId, options);
      }

      return yield browser.tabs.update(tabId, {
        active: options.focused
      });
    });
    return _updateWindow.apply(this, arguments);
  }

  function closeWindow(_x5, _x6) {
    return _closeWindow.apply(this, arguments);
  }

  function _closeWindow() {
    _closeWindow = _asyncToGenerator(function* (windowId, tabId) {
      if (windowId) {
        return yield browser.windows.remove(windowId);
      }

      return yield browser.tabs.remove(tabId);
    });
    return _closeWindow.apply(this, arguments);
  }

  function defer() {
    const o = {};
    o.promise = new Promise((resolve, reject) => {
      o.resolve = resolve;
      o.reject = reject;
    });
    return o;
  }

  function launchWebAuthFlow(_x7) {
    return _launchWebAuthFlow.apply(this, arguments);
  }

  function _launchWebAuthFlow() {
    _launchWebAuthFlow = _asyncToGenerator(function* ({
      url,
      redirect_uri,
      interactive = false
    }) {
      const wInfo = yield createWindow({
        type: "popup",
        url,
        state: "minimized" // https://crbug.com/783827
        // note that Firefox doesn't support focused either
        // focused: false

      });
      const windowId = wInfo.id;
      const tabId = wInfo.tabs[0].id;

      const _defer = defer(),
            promise = _defer.promise,
            resolve = _defer.resolve,
            reject = _defer.reject;

      browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, {
        urls: ["*://*/*"],
        tabId,
        types: ["main_frame"]
      }, ["blocking"]);
      browser.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded);
      browser.tabs.onRemoved.addListener(onTabRemoved);

      try {
        return yield promise;
      } finally {
        cleanup();
      }

      function onBeforeRequest(details) {
        if (details.frameId || details.tabId !== tabId) return;
        if (!details.url.startsWith(redirect_uri)) return;
        resolve(details.url);
        return {
          cancel: true
        };
      }

      function onDOMContentLoaded(details) {
        if (details.frameId || details.tabId !== tabId) return;

        if (interactive) {
          updateWindow(windowId, tabId, {
            focused: true,
            state: "normal"
          }).catch(err => console.error(err));
        } else {
          reject(new Error("User interaction required"));
        }

        browser.webNavigation.onDOMContentLoaded.removeListener(onDOMContentLoaded);
      }

      function onTabRemoved(removedTabId) {
        if (removedTabId === tabId) {
          reject(new Error("Canceled by user"));
        }
      }

      function cleanup() {
        browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
        browser.webNavigation.onDOMContentLoaded.removeListener(onDOMContentLoaded);
        browser.tabs.onRemoved.removeListener(onTabRemoved);
        closeWindow(windowId, tabId).catch(err => console.error(err));
      }
    });
    return _launchWebAuthFlow.apply(this, arguments);
  }

  return launchWebAuthFlow;

}());
//# sourceMappingURL=webext-launch-web-auth-flow.js.map
