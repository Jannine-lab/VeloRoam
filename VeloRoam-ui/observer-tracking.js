(() => {
  const key = 'veloroam-observer-consent-v1';
  let allowed = false;
  try { allowed = localStorage.getItem(key) === 'yes'; } catch (_) {}
  const id = crypto.randomUUID ? crypto.randomUUID() : null;
  const api = (() => {
    const host = new URLSearchParams(location.search).get('apiHost') || (location.protocol === 'https:' ? location.host : (['localhost', '127.0.0.1', ''].includes(location.hostname) ? '127.0.0.1:3000' : `${location.hostname}:3000`));
    return `${location.protocol === 'https:' ? 'https:' : 'http:'}//${host}/api`;
  })();
  const originalFetch = window.fetch.bind(window);
  function send(type, data) {
    if (!allowed || !id) return;
    originalFetch(`${api}/observer/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, session: id, data }), keepalive: true }).catch(() => {});
  }
  function visit() {
    send('visit', { path: location.pathname, referrer: document.referrer ? new URL(document.referrer).origin : '', language: navigator.language, screen: { width: screen.width, height: screen.height }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }
  window.veloroamObserverLocation = (coords) => send('location', coords);
  window.fetch = function(input, init) {
    const result = originalFetch(input, init);
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (allowed && url.origin === new URL(api).origin && /^\/api\/routes\/(plan|plan-with-stops|plan-fewest-signals)$/.test(url.pathname) && init?.body && typeof init.body === 'string') {
        const request = JSON.parse(init.body);
        result.then(response => { if (response.ok) send('route', { endpoint: url.pathname, request }); }).catch(() => {});
      }
    } catch (_) {}
    return result;
  };
  function settings() {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'observer-consent-title');
    dialog.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0008;display:flex;align-items:end;justify-content:center;padding:16px;box-sizing:border-box';
    dialog.innerHTML = '<section style="background:white;color:#17261d;max-width:560px;border-radius:16px;padding:24px;font:16px/1.5 system-ui;box-shadow:0 8px 32px #0003"><h2 id="observer-consent-title" style="margin:0 0 10px">访问与骑行数据</h2><p>如果你同意，我们会保存访问时间、页面、来源网站、设备信息，以及你使用路线规划时提交的起终点、途经点和偏好；已有定位可能包含精确坐标。数据由管理员查看，目前没有自动删除期限。拒绝不影响使用。你可随时通过页面上的“数据设置”停止后续采集；已保存的数据不会自动删除。</p><div style="display:flex;gap:12px;flex-wrap:wrap"><button id="observer-yes" style="padding:10px 18px">同意采集</button><button id="observer-no" style="padding:10px 18px">拒绝采集</button></div></section>';
    document.body.append(dialog);
    dialog.querySelector('#observer-yes').onclick = () => { allowed = true; try { localStorage.setItem(key, 'yes'); } catch (_) {} dialog.remove(); visit(); };
    dialog.querySelector('#observer-no').onclick = () => { allowed = false; try { localStorage.setItem(key, 'no'); } catch (_) {} dialog.remove(); };
    dialog.querySelector('#observer-no').focus();
  }
  function start() {
    const button = document.createElement('button'); button.textContent = '数据设置'; button.type = 'button';
    button.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9998;background:#fff;color:#31483a;border:1px solid #9aada0;border-radius:10px;padding:6px 10px;font-size:12px';
    button.onclick = settings; document.body.append(button);
    let saved = null; try { saved = localStorage.getItem(key); } catch (_) {}
    if (!saved) settings(); else if (allowed) visit();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
