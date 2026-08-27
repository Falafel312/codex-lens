const $ = selector => document.querySelector(selector)

function label(value) {
  return String(value || '').replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function render(state) {
  const signedIn = Boolean(state.account)
  const relayOnline = state.relay === 'online'

  $('#codex-status').textContent = signedIn ? 'Signed in' : label(state.codex)
  $('#relay-status').textContent = label(state.relay)
  $('#codex-dot').className = `dot ${signedIn ? 'good' : state.codex === 'error' ? 'bad' : ''}`
  $('#relay-dot').className = `dot ${relayOnline ? 'good' : state.relay === 'offline' ? 'bad' : ''}`

  $('#account-copy').textContent = signedIn
    ? `${state.account.email || state.account.name || 'Your Codex account'} is connected on this computer.`
    : 'A secure OpenAI page opens in your browser. Your password never enters Codex Lens.'
  $('#sign-in').classList.toggle('hidden', signedIn)
  $('#sign-out').classList.toggle('hidden', !signedIn)

  const hasLoginCode = Boolean(state.loginCode)
  $('#login-code-wrap').classList.toggle('hidden', !hasLoginCode)
  $('#login-code').textContent = state.loginCode || ''

  $('#step-scan').classList.toggle('locked', !signedIn)
  const qr = $('#qr')
  qr.classList.toggle('hidden', !state.qrDataUrl)
  $('#qr-loading').classList.toggle('hidden', Boolean(state.qrDataUrl))
  if (state.qrDataUrl) qr.src = state.qrDataUrl
  $('#pair-code').textContent = state.pairCode || '------'

  $('#error').textContent = state.error || ''
  $('#error').classList.toggle('hidden', !state.error)
}

$('#sign-in').addEventListener('click', () => window.codexLens.signIn().then(render).catch(error => render({ error: error.message })))
$('#sign-out').addEventListener('click', () => window.codexLens.signOut().then(render).catch(error => render({ error: error.message })))
$('#retry').addEventListener('click', () => window.codexLens.retryRelay().then(render).catch(error => render({ error: error.message })))

window.codexLens.onState(render)
window.codexLens.getState().then(render)
