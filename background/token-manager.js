/* global FIREFOX getActiveTab waitForTabUrl URLS */// toolbox.js
/* global chromeLocal */// storage-util.js
'use strict';

/* exported tokenMan */
const tokenMan = (() => {
  const AUTH = {
    dropbox: {
      flow: 'token',
      clientId: 'zg52vphuapvpng9',
      authURL: 'https://www.dropbox.com/oauth2/authorize',
      tokenURL: 'https://api.dropboxapi.com/oauth2/token',
      revoke: token =>
        fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }),
    },
    google: {
      flow: 'code',
      clientId: '283762574871-d4u58s4arra5jdan2gr00heasjlttt1e.apps.googleusercontent.com',
      clientSecret: 'J0nc5TlR_0V_ex9-sZk-5faf',
      authURL: 'https://accounts.google.com/o/oauth2/v2/auth',
      authQuery: {
        // NOTE: Google needs 'prompt' parameter to deliver multiple refresh
        // tokens for multiple machines.
        // https://stackoverflow.com/q/18519185
        access_type: 'offline',
        prompt: 'consent',
      },
      tokenURL: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.appdata'],
      revoke: token => {
        const params = {token};
        return postQuery(`https://accounts.google.com/o/oauth2/revoke?${new URLSearchParams(params)}`);
      },
    },
    onedrive: {
      flow: 'code',
      clientId: '3864ce03-867c-4ad8-9856-371a097d47b1',
      clientSecret: '9Pj=TpsrStq8K@1BiwB9PIWLppM:@s=w',
      authURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      redirect_uri: FIREFOX ?
        'https://clngdbkpkpeebahjckkjfobafhncgmne.chromiumapp.org/' :
        'https://' + location.hostname + '.chromiumapp.org/',
      scopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
    },
    userstylesworld: {
      flow: 'code',
      clientId: 'zeDmKhJIfJqULtcrGMsWaxRtWHEimKgS',
      clientSecret: 'wqHsvTuThQmXmDiVvOpZxPwSIbyycNFImpAOTxjaIRqDbsXcTOqrymMJKsOMuibFaij' +
        'ZZAkVYTDbLkQuYFKqgpMsMlFlgwQOYHvHFbgxQHDTwwdOroYhOwFuekCwXUlk',
      authURL: URLS.usw + 'api/oauth/style/link',
      tokenURL: URLS.usw + 'api/oauth/token',
      redirect_uri: 'https://gusted.xyz/callback_helper/',
    },
  };
  const NETWORK_LATENCY = 30; // seconds

  let alwaysUseTab = FIREFOX ? false : null;

  return {

    buildKeys(name, hooks) {
      const prefix = `secure/token/${hooks ? hooks.keyName(name) : name}/`;
      const k = {
        TOKEN: `${prefix}token`,
        EXPIRE: `${prefix}expire`,
        REFRESH: `${prefix}refresh`,
      };
      k.LIST = Object.values(k);
      return k;
    },

    getClientId(name) {
      return AUTH[name].clientId;
    },

    async getToken(name, interactive, hooks) {
      const k = tokenMan.buildKeys(name, hooks);
      const obj = await chromeLocal.get(k.LIST);
      if (obj[k.TOKEN]) {
        if (!obj[k.EXPIRE] || Date.now() < obj[k.EXPIRE]) {
          return obj[k.TOKEN];
        }
        if (obj[k.REFRESH]) {
          return refreshToken(name, k, obj);
        }
      }
      if (!interactive) {
        throw new Error(`Invalid token: ${name}`);
      }
      return authUser(k, name, interactive, hooks);
    },

    async revokeToken(name, hooks) {
      const provider = AUTH[name];
      const k = tokenMan.buildKeys(name, hooks);
      if (provider.revoke) {
        try {
          const token = await chromeLocal.getValue(k.TOKEN);
          if (token) await provider.revoke(token);
        } catch (e) {
          console.error(e);
        }
      }
      await chromeLocal.remove(k.LIST);
    },
  };

  async function refreshToken(name, k, obj) {
    if (!obj[k.REFRESH]) {
      throw new Error('No refresh token');
    }
    const provider = AUTH[name];
    const body = {
      client_id: provider.clientId,
      refresh_token: obj[k.REFRESH],
      grant_type: 'refresh_token',
      scope: provider.scopes.join(' '),
    };
    if (provider.clientSecret) {
      body.client_secret = provider.clientSecret;
    }
    const result = await postQuery(provider.tokenURL, body);
    if (!result.refresh_token) {
      // reuse old refresh token
      result.refresh_token = obj[k.REFRESH];
    }
    return handleTokenResult(result, k);
  }

  async function authUser(keys, name, interactive = false, hooks = null) {
    await require(['/vendor/webext-launch-web-auth-flow/webext-launch-web-auth-flow.min']);
    /* global webextLaunchWebAuthFlow */
    const provider = AUTH[name];
    const state = Math.random().toFixed(8).slice(2);
    const query = {
      response_type: provider.flow,
      client_id: provider.clientId,
      redirect_uri: provider.redirect_uri || chrome.identity.getRedirectURL(),
      state,
    };
    if (provider.scopes) {
      query.scope = provider.scopes.join(' ');
    }
    if (provider.authQuery) {
      Object.assign(query, provider.authQuery);
    }
    if (alwaysUseTab == null) {
      alwaysUseTab = await detectVivaldiWebRequestBug();
    }
    if (hooks) hooks.query(query);
    const url = `${provider.authURL}?${new URLSearchParams(query)}`;
    const finalUrl = await webextLaunchWebAuthFlow({
      url,
      alwaysUseTab,
      interactive,
      redirect_uri: query.redirect_uri,
      windowOptions: {
        state: 'normal',
        width: Math.min(screen.width - 100, 800),
        height: Math.min(screen.height - 100, 800),
      },
    });
    const params = new URLSearchParams(
      provider.flow === 'token' ?
        new URL(finalUrl).hash.slice(1) :
        new URL(finalUrl).search.slice(1)
    );
    if (params.get('state') !== state) {
      throw new Error(`Unexpected state: ${params.get('state')}, expected: ${state}`);
    }
    let result;
    if (provider.flow === 'token') {
      const obj = {};
      for (const [key, value] of params) {
        obj[key] = value;
      }
      result = obj;
    } else {
      const code = params.get('code');
      const body = {
        code,
        grant_type: 'authorization_code',
        client_id: provider.clientId,
        redirect_uri: query.redirect_uri,
        state,
      };
      if (provider.clientSecret) {
        body.client_secret = provider.clientSecret;
      }
      result = await postQuery(provider.tokenURL, body);
    }
    return handleTokenResult(result, keys);
  }

  async function handleTokenResult(result, k) {
    await chromeLocal.set({
      [k.TOKEN]: result.access_token,
      [k.EXPIRE]: result.expires_in
        ? Date.now() + (result.expires_in - NETWORK_LATENCY) * 1000
        : undefined,
      [k.REFRESH]: result.refresh_token,
    });
    return result.access_token;
  }

  async function postQuery(url, body) {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body ? new URLSearchParams(body) : null,
    };
    const r = await fetch(url, options);
    if (r.ok) {
      return r.json();
    }
    const text = await r.text();
    const err = new Error(`Failed to fetch (${r.status}): ${text}`);
    err.code = r.status;
    throw err;
  }

  async function detectVivaldiWebRequestBug() {
    // Workaround for https://github.com/openstyles/stylus/issues/1182
    // Note that modern Vivaldi isn't exposed in `navigator.userAgent` but it adds `extData` to tabs
    const anyTab = await getActiveTab() || (await browser.tabs.query({}))[0];
    if (anyTab && !anyTab.extData) {
      return false;
    }
    let bugged = true;
    const TEST_URL = chrome.runtime.getURL('manifest.json');
    const check = ({url}) => {
      bugged = url !== TEST_URL;
    };
    chrome.webRequest.onBeforeRequest.addListener(check, {urls: [TEST_URL], types: ['main_frame']});
    const {tabs: [tab]} = await browser.windows.create({
      type: 'popup',
      state: 'minimized',
      url: TEST_URL,
    });
    await waitForTabUrl(tab);
    chrome.windows.remove(tab.windowId);
    chrome.webRequest.onBeforeRequest.removeListener(check);
    return bugged;
  }
})();
