const $ = selector => document.querySelector(selector)

function label(value) {
  return String(value || '').replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function render(state) {
  const signedIn = Boolean(state.account)
  const accountReady = signedIn && Boolean(state.accountApproved)
  const relayOnline = state.relay === 'online'

  $('#codex-status').textContent = accountReady ? 'Ready' : signedIn ? 'Confirm account' : label(state.codex)
  $('#relay-status').textContent = label(state.relay)
  $('#codex-dot').className = `dot ${accountReady ? 'good' : state.codex === 'error' ? 'bad' : ''}`
  $('#relay-dot').className = `dot ${relayOnline ? 'good' : state.relay === 'offline' ? 'bad' : ''}`

  $('#account-copy').textContent = signedIn
    ? accountReady
      ? `${state.account.email || state.account.name || 'Your Codex account'} is confirmed for this Windows user. This login is not shared with anyone else.`
      : `Codex is already signed in as ${state.account.email || state.account.name || 'this Windows user'}. Confirm this is your account before a pairing QR is shown.`
    : 'No Codex account is connected on this PC. A secure OpenAI page opens in your browser; your password never enters Codex Lens.'
  $('#sign-in').classList.toggle('hidden', signedIn)
  $('#use-account').classList.toggle('hidden', !signedIn || accountReady)
  $('#sign-out').classList.toggle('hidden', !signedIn)

  const hasLoginCode = Boolean(state.loginCode)
  $('#login-code-wrap').classList.toggle('hidden', !hasLoginCode)
  $('#login-code').textContent = state.loginCode || ''

  $('#step-scan').classList.toggle('locked', !accountReady)
  const qr = $('#qr')
  qr.classList.toggle('hidden', !accountReady || !state.qrDataUrl)
  $('#qr-loading').classList.toggle('hidden', accountReady && Boolean(state.qrDataUrl))
  $('#qr-loading').textContent = accountReady ? 'Preparing secure QR…' : 'Confirm your account above first.'
  if (accountReady && state.qrDataUrl) qr.src = state.qrDataUrl
  $('#pair-code').textContent = accountReady ? state.pairCode || '------' : '------'

  $('#error').textContent = state.error || ''
  $('#error').classList.toggle('hidden', !state.error)
}

$('#sign-in').addEventListener('click', () => window.codexLens.signIn().then(render).catch(error => render({ error: error.message })))
$('#use-account').addEventListener('click', () => window.codexLens.approveAccount().then(render).catch(error => render({ error: error.message })))
$('#sign-out').addEventListener('click', () => window.codexLens.signOut().then(render).catch(error => render({ error: error.message })))
$('#retry').addEventListener('click', () => window.codexLens.retryRelay().then(render).catch(error => render({ error: error.message })))

window.codexLens.onState(render)
window.codexLens.getState().then(render)
