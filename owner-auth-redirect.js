window.roggyOwnerAuthRedirectTo = function () {
  const current = window.location;
  if (current.protocol === 'http:' && current.hostname === '127.0.0.1' && current.port === '8766') {
    return 'http://127.0.0.1:8766/roggy/callback';
  }
  return 'https://garoggy.github.io/roggy-buy-list/';
};