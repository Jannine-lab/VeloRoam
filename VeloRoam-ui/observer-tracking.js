(() => {
  const id = crypto.randomUUID ? crypto.randomUUID() : null;
  const api = (() => {
    const host = new URLSearchParams(location.search).get('apiHost') || (location.protocol === 'https:' ? location.host : (['localhost', '127.0.0.1', ''].includes(location.hostname) ? '127.0.0.1:3000' : `${location.hostname}:3000`));
    return `${location.protocol === 'https:' ? 'https:' : 'http:'}//${host}/api`;
  })();
  const originalFetch = window.fetch.bind(window);
  function send(type, data) {
    if (!id) return;
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
      if (url.origin === new URL(api).origin && /^\/api\/routes\/(plan|plan-with-stops|plan-fewest-signals)$/.test(url.pathname) && init?.body && typeof init.body === 'string') {
        const request = JSON.parse(init.body);
        result.then(response => { if (response.ok) send('route', { endpoint: url.pathname, request }); }).catch(() => {});
      }
    } catch (_) {}
    return result;
  };
  visit();
})();
