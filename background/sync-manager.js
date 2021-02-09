/* global API msg */// msg.js
/* global chromeLocal */// storage-util.js
/* global compareRevision */// common.js
/* global iconMan */
/* global prefs */
/* global tokenMan */
'use strict';

const syncMan = (() => {
  //#region Init

  const SYNC_DELAY = 1; // minutes
  const SYNC_INTERVAL = 30; // minutes
  const STATES = Object.freeze({
    connected: 'connected',
    connecting: 'connecting',
    disconnected: 'disconnected',
    disconnecting: 'disconnecting',
  });
  const STORAGE_KEY = 'sync/state/';
  const status = /** @namespace SyncManager.Status */ {
    STATES,
    state: STATES.disconnected,
    syncing: false,
    progress: null,
    currentDriveName: null,
    errorMessage: null,
    login: false,
  };
  let lastError = null;
  let ctrl;
  let currentDrive;
  /** @type {Promise|boolean} will be `true` to avoid wasting a microtask tick on each `await` */
  let ready = prefs.ready.then(() => {
    ready = true;
    prefs.subscribe('sync.enabled',
      (_, val) => val === 'none'
        ? syncMan.stop()
        : syncMan.start(val, true),
      {runNow: true});
  });

  chrome.alarms.onAlarm.addListener(info => {
    if (info.name === 'syncNow') {
      syncMan.syncNow();
    }
  });

  //#endregion
  //#region Exports

  return {

    async delete(...args) {
      if (ready.then) await ready;
      if (!currentDrive) return;
      schedule();
      return ctrl.delete(...args);
    },

    /** @returns {Promise<SyncManager.Status>} */
    async getStatus() {
      return status;
    },

    async login(name = prefs.get('sync.enabled')) {
      // FIXME: it doesn't really make sense to wait pref after getting the pref value
      if (ready.then) await ready;
      await tokenMan.revokeToken(name);
      try {
        await tokenMan.getToken(name, true);
        status.login = true;
      } catch (err) {
        status.login = false;
        throw err;
      } finally {
        emitStatusChange();
      }
    },

    async put(...args) {
      if (ready.then) await ready;
      if (!currentDrive) return;
      schedule();
      return ctrl.put(...args);
    },

    async start(name, fromPref = false) {
      if (ready.then) await ready;
      if (!ctrl) await initController();
      if (currentDrive) return;
      currentDrive = getDrive(name);
      ctrl.use(currentDrive);

      status.state = STATES.connecting;
      status.currentDriveName = currentDrive.name;
      emitStatusChange();

      if (!fromPref) {
        try {
          await syncMan.login(name);
        } catch (err) {
          console.error(err);
          status.errorMessage = err.message;
          lastError = err;
          emitStatusChange();
          return syncMan.stop();
        }
      }

      await syncMan.syncNow(name);
      prefs.set('sync.enabled', name);
      status.state = STATES.connected;
      schedule(SYNC_INTERVAL);
      emitStatusChange();
    },

    async stop() {
      if (ready.then) await ready;
      if (!currentDrive) return;
      chrome.alarms.clear('syncNow');
      status.state = STATES.disconnecting;
      emitStatusChange();
      try {
        await ctrl.uninit();
        await tokenMan.revokeToken(currentDrive.name);
        await chromeLocal.remove(STORAGE_KEY + currentDrive.name);
      } catch (e) {}
      currentDrive = null;
      prefs.set('sync.enabled', 'none');
      status.state = STATES.disconnected;
      status.currentDriveName = null;
      status.login = false;
      emitStatusChange();
    },

    async syncNow() {
      if (ready.then) await ready;
      if (!currentDrive || !status.login) throw new Error('cannot sync when disconnected');
      try {
        await ctrl.init();
        await ctrl.syncNow();
        status.errorMessage = null;
        lastError = null;
      } catch (err) {
        status.errorMessage = err.message;
        lastError = err;

        if (isGrantError(err)) {
          status.login = false;
        }
      }
      emitStatusChange();
    },
  };

  //#endregion
  //#region Utils

  async function initController() {
    await require(['/vendor/db-to-cloud/db-to-cloud.min']); /* global dbToCloud */
    ctrl = dbToCloud.dbToCloud({
      onGet(id) {
        return API.styles.getByUUID(id);
      },
      onPut(doc) {
        return API.styles.putByUUID(doc);
      },
      onDelete(id, rev) {
        return API.styles.deleteByUUID(id, rev);
      },
      async onFirstSync() {
        for (const i of await API.styles.getAll()) {
          ctrl.put(i._id, i._rev);
        }
      },
      onProgress(e) {
        if (e.phase === 'start') {
          status.syncing = true;
        } else if (e.phase === 'end') {
          status.syncing = false;
          status.progress = null;
        } else {
          status.progress = e;
        }
        emitStatusChange();
      },
      compareRevision,
      getState(drive) {
        return chromeLocal.getValue(STORAGE_KEY + drive.name);
      },
      setState(drive, state) {
        return chromeLocal.setValue(STORAGE_KEY + drive.name, state);
      },
    });
  }

  function emitStatusChange() {
    msg.broadcastExtension({method: 'syncStatusUpdate', status});

    if (status.state !== STATES.connected || !lastError || isNetworkError(lastError)) {
      iconMan.overrideBadge({});
    } else if (isGrantError(lastError)) {
      iconMan.overrideBadge({
        text: 'x',
        color: '#F00',
        title: chrome.i18n.getMessage('syncErrorRelogin'),
      });
    } else {
      iconMan.overrideBadge({
        text: 'x',
        color: '#F00',
        title: chrome.i18n.getMessage('syncError'),
      });
    }
  }

  function isNetworkError(err) {
    return err.name === 'TypeError' && /networkerror|failed to fetch/i.test(err.message);
  }

  function isGrantError(err) {
    if (err.code === 401) return true;
    if (err.code === 400 && /invalid_grant/.test(err.message)) return true;
    return false;
  }

  function getDrive(name) {
    if (name === 'dropbox' || name === 'google' || name === 'onedrive') {
      return dbToCloud.drive[name]({
        getAccessToken: () => tokenMan.getToken(name),
      });
    }
    throw new Error(`unknown cloud name: ${name}`);
  }

  function schedule(delay = SYNC_DELAY) {
    chrome.alarms.create('syncNow', {
      delayInMinutes: delay,
      periodInMinutes: SYNC_INTERVAL,
    });
  }

  //#endregion
})();
