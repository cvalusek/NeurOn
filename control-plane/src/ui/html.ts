import type { ApiKey, AppConfig, AuthenticatedUser, CapacityTarget, ModelDefinition, Reservation, TargetStatus } from "../domain/types.js";

export function layout(title: string, user: AuthenticatedUser | undefined, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #f7f7f4; color: #1f2933; }
    header { background: #17202a; color: white; }
    .topbar { padding: 16px 24px; display: grid; grid-template-columns: 1fr minmax(0, 980px) 1fr; gap: 20px; align-items: center; }
    .topbar .brand { justify-self: start; }
    .topbar .user { justify-self: end; }
    header nav { display: flex; gap: 14px; align-items: center; }
    header a { color: white; }
    main { max-width: 980px; margin: 0 auto; padding: 24px; }
    a { color: #0f766e; } form { margin: 0; }
    .panel { background: white; border: 1px solid #d8ddd7; border-radius: 8px; padding: 18px; margin-bottom: 16px; }
    .models, .targets { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 14px 0; }
    .family { margin-top: 14px; }
    .family h3 { margin: 0 0 8px; font-size: 15px; }
    .model-group[hidden] { display: none; }
    label.option { position: relative; display: flex; gap: 10px; align-items: start; border: 1px solid #d8ddd7; border-radius: 6px; padding: 10px; background: #fbfcfb; cursor: pointer; }
    label.option:has(input:checked), button.choice[aria-pressed="true"] { border-color: #0f766e; background: #e7f5f2; box-shadow: inset 0 0 0 1px #0f766e; }
    label.option input { position: absolute; opacity: 0; pointer-events: none; }
    .model-body { min-width: 0; width: 100%; }
    .model-head { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
    .pill { border-radius: 999px; padding: 2px 8px; background: #eef2f0; color: #334155; font-size: 12px; font-weight: 750; white-space: nowrap; }
    .pill.on, .pill.healthy { background: #dff7ed; color: #05603a; }
    .pill.off, .pill.stopped { background: #e8edf3; color: #334155; }
    .pill.provisioning, .pill.stopping { background: #fff4d6; color: #854a0e; }
    .pill.failed { background: #fee4e2; color: #912018; }
    .copy-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .copy-chip { border: 1px solid #c8d0c9; border-radius: 999px; padding: 3px 8px; background: white; color: #334155; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 100%; overflow-wrap: anywhere; }
    .copy-chip.primary { border-color: #0f766e; color: #0f766e; background: #f0faf7; }
    .tag-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .model-tag { border-radius: 999px; padding: 2px 7px; background: #f5efe2; color: #6f4e12; font-size: 11px; font-weight: 800; letter-spacing: 0; white-space: nowrap; }
    .model-meta { margin-top: 7px; font-size: 12px; color: #657266; }
    .status-grid { display: grid; gap: 12px; }
    .target-status-card { border: 1px solid #d8ddd7; border-radius: 8px; padding: 14px; background: #fbfcfb; }
    .target-status-head, .reservation-card { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .target-status-meta, .reservation-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .reservation-list { display: grid; gap: 8px; margin-top: 12px; }
    .reservation-card { border-top: 1px solid #e2e7e1; padding-top: 10px; }
    .reservation-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    input[type="number"], input[type="text"], input[type="password"] { padding: 8px; border: 1px solid #aab4ad; border-radius: 6px; min-width: 140px; max-width: 100%; }
    button { border: 0; border-radius: 6px; padding: 9px 13px; background: #0f766e; color: white; font-weight: 650; cursor: pointer; }
    button.choice { border: 1px solid #aab4ad; background: #fbfcfb; color: #1f2933; }
    button.secondary { background: #334155; }
    button.danger { background: #b42318; }
    button.large { font-size: 18px; padding: 14px 18px; }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; background: #e7ebe6; color: #334155; }
    .badge.active { background: #dff7ed; color: #05603a; }
    .badge.done { background: #e8edf3; color: #334155; }
    .badge.expired, .badge.failed { background: #fee4e2; color: #912018; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d8ddd7; }
    th, td { text-align: left; padding: 9px; border-bottom: 1px solid #e7ebe6; vertical-align: top; }
    .muted { color: #657266; } .status { font-weight: 700; } .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .actions { display: flex; justify-content: flex-end; margin-top: 16px; }
    .secret-box { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 12px; border: 1px solid #0f766e; border-radius: 6px; background: #f0faf7; }
    .secret-box code { flex: 1 1 360px; overflow-wrap: anywhere; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header><div class="topbar"><strong class="brand">NeurOn</strong><nav><a href="/">Home</a><a href="/api-keys">API keys</a><a href="/admin">Admin</a></nav><span class="user">${user ? escapeHtml(user.username) : ""}</span></div></header>
  <main>${body}</main>
</body>
</html>`;
}

export function loginPage(error = ""): string {
  return layout("Login", undefined, `<section class="panel">
    <h1>Sign in</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/login">
      <p><label>Username<br><input name="username" required></label></p>
      <p><label>Password<br><input name="password" type="password" required></label></p>
      <button type="submit">Sign in</button>
    </form>
  </section>`);
}

export function startPage(user: AuthenticatedUser, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>, error = ""): string {
  const initialTargetId = targets[0]?.target.id ?? "";
  return layout("NeurOn", user, `<section class="panel">
    <h2>Your reservation</h2>
    <div id="current-reservation"><p class="muted">Loading...</p></div>
  </section>
  <section class="panel">
    <h1>Start capacity</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <form id="start-form" method="post" action="/reservations">
      <input id="duration-minutes" type="hidden" name="durationMinutes" value="2">
      <input id="keepalive-minutes" type="hidden" name="keepaliveMinutes" value="2">
      <h2>Target</h2>
      <div class="targets">${targets
        .map(({ target }, index) => targetOption(target, index === 0))
        .join("")}</div>
      <h2>Models</h2>
      ${targets
        .map(
          ({ target, models }) =>
            `<div class="model-group" data-target-models="${escapeHtml(target.id)}" ${target.id === initialTargetId ? "" : "hidden"}>${modelFamilySections(models)}</div>`
        )
        .join("")}
      <h2>Duration</h2>
      <div class="row" aria-label="Duration">
        <button class="choice" type="button" data-duration="1" aria-pressed="false">1 min</button>
        <button class="choice" type="button" data-duration="2" aria-pressed="true">2 min</button>
        <button class="choice" type="button" data-duration="5" aria-pressed="false">5 min</button>
        <button class="choice" type="button" data-duration="15" aria-pressed="false">15 min</button>
        <button class="choice" type="button" data-duration="30" aria-pressed="false">30 min</button>
        <button class="choice" type="button" data-duration="60" aria-pressed="false">1 hour</button>
        <button class="choice" type="button" data-duration="120" aria-pressed="false">2 hours</button>
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="choice" type="button" data-custom-duration="true" aria-pressed="false">Custom</button>
        <label id="custom-duration-wrap" class="hidden">Minutes <input id="custom-duration" type="number" min="1" max="720" value="120"></label>
      </div>
      <h2>Keepalive</h2>
      <div class="row" aria-label="Keepalive">
        <button class="choice" type="button" data-keepalive="1" aria-pressed="false">1 min</button>
        <button class="choice" type="button" data-keepalive="2" aria-pressed="true">2 min</button>
        <button class="choice" type="button" data-keepalive="5" aria-pressed="false">5 min</button>
        <button class="choice" type="button" data-keepalive="15" aria-pressed="false">15 min</button>
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="choice" type="button" data-custom-keepalive="true" aria-pressed="false">Custom</button>
        <label id="custom-keepalive-wrap" class="hidden">Minutes <input id="custom-keepalive" type="number" min="1" max="60" value="2"></label>
      </div>
      <div class="actions">
        <button type="submit">Reserve</button>
      </div>
    </form>
  </section>
  <section class="panel">
    <h2>Server status</h2>
    <div id="server-status"><p class="muted">Loading...</p></div>
  </section>
  <script type="module">
    const modelLookup = ${safeJson(modelLookupForTargets(targets))};
    const targetLookup = ${safeJson(targetLookupForTargets(targets))};
    const form = document.querySelector('#start-form');
    const duration = document.querySelector('#duration-minutes');
    const keepalive = document.querySelector('#keepalive-minutes');
    const custom = document.querySelector('#custom-duration');
    const customKeepalive = document.querySelector('#custom-keepalive');
    const modelInputs = [...document.querySelectorAll('input[name="modelIds"]')];
    const targetInputs = [...document.querySelectorAll('input[name="targetId"]')];
    const durationButtons = [...document.querySelectorAll('[data-duration], [data-custom-duration]')];
    const keepaliveButtons = [...document.querySelectorAll('[data-keepalive], [data-custom-keepalive]')];
    const customWrap = document.querySelector('#custom-duration-wrap');
    const customKeepaliveWrap = document.querySelector('#custom-keepalive-wrap');
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const value = button.dataset.copy;
      if (!value) return;
      await navigator.clipboard?.writeText(value);
      const previous = button.textContent;
      button.textContent = 'copied';
      setTimeout(() => { button.textContent = previous; }, 900);
    });
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const copyButton = (value, primary = false) => '<button class="copy-chip ' + (primary ? 'primary' : '') + '" type="button" data-copy="' + escapeText(value) + '">' + escapeText(value) + '</button>';
    const modelChipRow = (modelIds) => modelIds.length
      ? '<span class="chip-row">' + modelIds.map((id, index) => copyButton(modelLookup[id]?.recommendedAlias ?? id, index === 0) + ((modelLookup[id]?.recommendedAlias && modelLookup[id].recommendedAlias !== id) ? copyButton(id) : '')).join('') + '</span>'
      : '<span class="chip-row"><span class="pill">All models</span></span>';
    const statusPill = (value) => '<span class="pill ' + escapeText(value) + '">' + escapeText(value) + '</span>';
    const durationShort = (seconds) => {
      if (seconds < 60) return seconds + 's';
      const minutes = Math.round(seconds / 60);
      return minutes + 'm';
    };
    const startupEstimate = (target) => {
      const estimate = target.startupEstimate;
      if (!estimate) return '';
      return '<span class="muted">Start: usually ' + durationShort(estimate.avgSeconds) + ', range ' + durationShort(estimate.minSeconds) + '-' + durationShort(estimate.maxSeconds) + '</span>';
    };
    const formatDateTime = (iso) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
    const timeLeft = (iso) => {
      const ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return 'expired';
      if (ms < 60000) return '<1m left';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 60) return minutes + 'm left';
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? hours + 'h ' + rest + 'm left' : hours + 'h left';
    };
    const friendlyExpiration = (iso) => formatDateTime(iso) + ' (' + timeLeft(iso) + ')';
    const statusBadge = (status) => '<span class="badge ' + status + '">' + status + '</span>';
    const reservationTime = (reservation) => {
      if (reservation.status === 'active') return 'until ' + friendlyExpiration(reservation.expiresAt);
      if (reservation.endedAt) return reservation.status === 'done' ? 'ended ' + formatDateTime(reservation.endedAt) : reservation.status + ' ' + formatDateTime(reservation.endedAt);
      return reservation.status + ' at ' + formatDateTime(reservation.expiresAt);
    };
    const reservationTargets = (reservation) => reservation.targets.map(target => targetLookup[target.id]?.displayName ?? target.id).join(', ');
    const reservationCard = (reservation, includeActions = false) => {
      const actions = includeActions
        ? '<div class="reservation-actions"><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="1" type="submit">+1 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="2" type="submit">+2 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="5" type="submit">+5 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="15" type="submit">+15 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="30" type="submit">+30 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="60" type="submit">+1 hour</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/done"><button class="danger" type="submit">I\\'m done</button></form></div>'
        : '';
      return '<div class="reservation-card"><div><div class="reservation-meta">' + statusBadge(reservation.status) + '<strong>' + escapeText(reservation.username) + '</strong><span class="muted">' + escapeText(reservationTime(reservation)) + '</span></div><div class="muted">' + escapeText(reservationTargets(reservation)) + '</div>' + modelChipRow(reservation.modelIds) + '</div>' + actions + '</div>';
    };
    const targetStatusCard = (target, reservations) => {
      const relevant = reservations.filter(reservation => reservation.targets.some(candidate => candidate.id === target.id));
      const rows = relevant.length ? relevant.map(reservation => reservationCard(reservation)).join('') : '<p class="muted">No reservations for this server</p>';
      const users = target.activeUsers?.length ? '<span class="muted">Users: ' + escapeText(target.activeUsers.join(', ')) + '</span>' : '<span class="muted">No active users</span>';
      return '<section class="target-status-card"><div class="target-status-head"><div><h3>' + escapeText(target.displayName) + '</h3><div class="target-status-meta">' + statusPill(target.desired) + statusPill(target.observed) + users + startupEstimate(target) + '</div></div><div class="muted">' + escapeText(target.provider) + '</div></div><p class="muted">' + escapeText(target.message) + '</p><div class="reservation-list">' + rows + '</div></section>';
    };
    const selectDuration = (button) => {
      durationButtons.forEach(candidate => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
      const isCustom = Boolean(button?.dataset.customDuration);
      customWrap.classList.toggle('hidden', !isCustom);
      duration.value = isCustom ? custom.value : button?.dataset.duration ?? duration.value;
      if (isCustom) custom.focus();
    };
    durationButtons.forEach(button => button.addEventListener('click', () => selectDuration(button)));
    const selectKeepalive = (button) => {
      keepaliveButtons.forEach(candidate => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
      const isCustom = Boolean(button?.dataset.customKeepalive);
      customKeepaliveWrap.classList.toggle('hidden', !isCustom);
      keepalive.value = isCustom ? customKeepalive.value : button?.dataset.keepalive ?? keepalive.value;
      if (isCustom) customKeepalive.focus();
    };
    keepaliveButtons.forEach(button => button.addEventListener('click', () => selectKeepalive(button)));
    const selectTarget = (targetId) => {
      document.querySelectorAll('[data-target-models]').forEach(group => {
        const active = group.dataset.targetModels === targetId;
        group.hidden = !active;
        group.querySelectorAll('input[name="modelIds"]').forEach(input => {
          input.disabled = !active;
          if (!active) input.checked = false;
        });
      });
    };
    targetInputs.forEach(input => input.addEventListener('change', () => selectTarget(input.value)));
    selectTarget(targetInputs.find(input => input.checked)?.value ?? targetInputs[0]?.value);
    custom.addEventListener('input', () => {
      const customButton = document.querySelector('[data-custom-duration]');
      selectDuration(customButton);
    });
    customKeepalive.addEventListener('input', () => {
      const customButton = document.querySelector('[data-custom-keepalive]');
      selectKeepalive(customButton);
    });
    form.addEventListener('submit', (event) => {
      const activeModelInputs = modelInputs.filter(input => !input.disabled);
      if (activeModelInputs.length > 0 && !activeModelInputs.some(input => input.checked)) {
        event.preventDefault();
        modelInputs[0]?.setCustomValidity('Select at least one model');
        modelInputs[0]?.reportValidity();
        modelInputs[0]?.setCustomValidity('');
        return;
      }
    });
    async function refreshServerStatus() {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      const current = data.activeReservations.find(reservation => reservation.username === ${JSON.stringify(user.username)});
      document.querySelector('#current-reservation').innerHTML = current
        ? reservationCard(current, true)
        : '<p class="muted">No active reservation</p>';
      document.querySelector('#server-status').innerHTML = data.capacityTargets.length
        ? '<div class="status-grid">' + data.capacityTargets.map(target => targetStatusCard(target, data.reservations)).join('') + '</div>'
        : '<p class="muted">No targets configured</p>';
    }
    refreshServerStatus();
    setInterval(refreshServerStatus, 10000);
  </script>`);
}

export function reservationPage(user: AuthenticatedUser, reservation: Reservation, config: AppConfig): string {
  return layout("NeurOn Reservation", user, `<section class="panel">
    <h1>Reservation ${escapeHtml(reservation.id)}</h1>
    <p>Status: <span id="reservation-status" class="status">${escapeHtml(reservation.status)}</span></p>
    <p>Models: <span id="reservation-models">${escapeHtml(reservation.modelIds.join(", "))}</span></p>
    <p>Expires: <span id="reservation-expires">${reservation.expiresAt.toISOString()}</span></p>
    <div id="target-status"></div>
    <form method="post" action="/reservations/${escapeHtml(reservation.id)}/done"><button class="large danger" type="submit">I'm done</button></form>
  </section>
  <script type="module">
    const reservationId = ${JSON.stringify(reservation.id)};
    const formatDateTime = (iso) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
    const timeLeft = (iso) => {
      const ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return 'expired';
      if (ms < 60000) return '<1m left';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 60) return minutes + 'm left';
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? hours + 'h ' + rest + 'm left' : hours + 'h left';
    };
    const friendlyExpiration = (iso) => formatDateTime(iso) + ' (' + timeLeft(iso) + ')';
    const reservationTime = (data) => data.endedAt ? 'ended ' + formatDateTime(data.endedAt) : friendlyExpiration(data.expiresAt);
    async function refresh() {
      const res = await fetch('/api/reservations/' + reservationId + '/status');
      if (!res.ok) return;
      const data = await res.json();
      document.querySelector('#reservation-status').textContent = data.status;
      document.querySelector('#reservation-expires').textContent = reservationTime(data);
      document.querySelector('#target-status').innerHTML = data.targets.map(t => '<p><strong>' + t.id + '</strong>: ' + t.observed + ' - ' + t.message + '</p>').join('');
    }
    refresh();
    setInterval(refresh, ${config.reservationStatusPollSeconds * 1000});
  </script>`);
}

export function apiKeysPage(user: AuthenticatedUser, apiKeys: ApiKey[], createdToken = ""): string {
  return layout("NeurOn API Keys", user, `<section class="panel">
    <h1>API keys</h1>
    ${createdToken ? `<div class="secret-box"><code id="created-api-key">${escapeHtml(createdToken)}</code><button type="button" data-copy="${escapeHtml(createdToken)}">Copy</button></div><p class="muted">Copy this key now. It will not be shown again.</p>` : ""}
    <form method="post" action="/api-keys">
      <p><label>Name<br><input name="name" type="text" maxlength="80" value="Plugin key" required></label></p>
      <button type="submit">Generate key</button>
    </form>
  </section>
  <section class="panel">
    <h2>Your keys</h2>
    ${
      apiKeys.length
        ? `<table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${apiKeys.map(apiKeyRow).join("")}</tbody></table>`
        : `<p class="muted">No API keys yet.</p>`
    }
  </section>
  <script type="module">
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      event.preventDefault();
      const value = button.dataset.copy;
      if (!value) return;
      await navigator.clipboard?.writeText(value);
      const previous = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = previous; }, 900);
    });
  </script>`);
}

export function adminPage(user: AuthenticatedUser, config: AppConfig): string {
  return layout("NeurOn Admin", user, `<section class="panel">
    <h1>Admin</h1>
    <div id="admin-status"></div>
  </section>
  <script type="module">
    const formatDateTime = (iso) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
    const timeLeft = (iso) => {
      const ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return 'expired';
      if (ms < 60000) return '<1m left';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 60) return minutes + 'm left';
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? hours + 'h ' + rest + 'm left' : hours + 'h left';
    };
    const friendlyExpiration = (iso) => formatDateTime(iso) + ' (' + timeLeft(iso) + ')';
    const statusBadge = (status) => '<span class="badge ' + status + '">' + status + '</span>';
    const reservationTime = (reservation) => {
      if (reservation.status === 'active') return 'until ' + friendlyExpiration(reservation.expiresAt);
      if (reservation.endedAt) return reservation.status === 'done' ? 'ended ' + formatDateTime(reservation.endedAt) : reservation.status + ' ' + formatDateTime(reservation.endedAt);
      return reservation.status + ' at ' + formatDateTime(reservation.expiresAt);
    };
    async function post(url) { await fetch(url, { method: 'POST' }); refresh(); }
    window.installTarget = (id) => post('/api/admin/targets/' + id + '/install');
    window.discoverTarget = (id) => post('/api/admin/targets/' + id + '/discover');
    window.forceStop = (id) => post('/api/admin/targets/' + id + '/force-stop');
    window.reconcileTarget = (id) => post('/api/admin/targets/' + id + '/reconcile');
    async function refresh() {
      const res = await fetch('/api/admin/status');
      if (!res.ok) return;
      const data = await res.json();
      const targets = data.capacityTargets.map(t => '<tr><td>' + t.id + '</td><td>' + t.desired + '</td><td>' + t.observed + '</td><td>' + t.message + '</td><td>' + t.activeUsers.join(', ') + '</td><td><button onclick="installTarget(\\'' + t.id + '\\')">Install</button> <button onclick="discoverTarget(\\'' + t.id + '\\')">Discover</button> <button onclick="reconcileTarget(\\'' + t.id + '\\')">Reconcile</button> <button class="danger" onclick="forceStop(\\'' + t.id + '\\')">Force stop</button></td></tr>').join('');
      const reservations = data.reservations.map(r => '<tr><td>' + r.reservationId + '</td><td>' + r.username + '</td><td>' + statusBadge(r.status) + '</td><td>' + reservationTime(r) + '</td><td>' + r.modelIds.join(', ') + '</td></tr>').join('');
      document.querySelector('#admin-status').innerHTML = '<h2>Targets</h2><table><thead><tr><th>Target</th><th>Desired</th><th>Observed</th><th>Message</th><th>Users</th><th></th></tr></thead><tbody>' + targets + '</tbody></table><h2>Reservations</h2><table><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Expires</th><th>Models</th></tr></thead><tbody>' + reservations + '</tbody></table>';
    }
    refresh();
    setInterval(refresh, ${config.adminStatusPollSeconds * 1000});
  </script>`);
}

function apiKeyRow(key: ApiKey): string {
  return `<tr><td>${escapeHtml(key.name)}</td><td><code>${escapeHtml(key.prefix)}...</code></td><td>${formatDate(key.createdAt)}</td><td>${key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}</td><td><form method="post" action="/api-keys/${escapeHtml(key.id)}/revoke"><button class="danger" type="submit">Revoke</button></form></td></tr>`;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

export function statusRows(statuses: TargetStatus[]): string {
  return statuses.map((status) => `${status.targetId}: ${status.observed}`).join(", ");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);
}

function targetOption(target: CapacityTarget, checked: boolean): string {
  const details = [`Provider: ${target.provider}`, `${target.modelIds.length} models`];
  if (target.modelsMax) details.push(`models-max: ${target.modelsMax}`);
  return `<label class="option"><input type="radio" name="targetId" value="${escapeHtml(target.id)}" ${checked ? "checked" : ""}><span><strong>${escapeHtml(target.displayName)}</strong><br><span class="muted">${escapeHtml(details.join(" | "))}</span></span></label>`;
}

function modelOption(model: ModelDefinition): string {
  const aliases = aliasesForDisplay(model);
  const recommendedAlias = aliases[0];
  const otherAliases = aliases.filter((alias) => alias !== recommendedAlias && alias !== model.id);
  const runtimeModelIds = model.runtimeModelIds?.filter((id) => !aliases.includes(id) && id !== model.id) ?? [];
  const chips = [
    recommendedAlias ? copyChip(recommendedAlias, "primary") : "",
    recommendedAlias !== model.id ? copyChip(model.id) : "",
    ...otherAliases.map((alias) => copyChip(alias)),
    ...runtimeModelIds.map((id) => copyChip(id))
  ].join("");
  const context = model.contextLabel ? `<span class="pill" title="${escapeHtml(contextTitle(model))}">${escapeHtml(model.contextLabel)}</span>` : "";
  const description = model.description ? `<div class="muted">${escapeHtml(model.description)}</div>` : "";
  const tags = model.tags?.length ? `<span class="tag-row">${model.tags.map(modelTag).join("")}</span>` : "";
  const meta = runtimeMetaLine(model);
  return `<label class="option"><input type="checkbox" name="modelIds" value="${escapeHtml(model.id)}"><span class="model-body"><span class="model-head"><strong>${escapeHtml(model.displayName)}</strong>${context}</span>${description}${tags}${meta}<span class="copy-row">${chips}</span></span></label>`;
}

function modelFamilySections(models: ModelDefinition[]): string {
  if (models.length === 0) return `<p class="muted">No models discovered yet. Reserving this target keeps the full runtime available.</p>`;
  return groupModelsByFamily(models)
    .map(
      ([family, familyModels]) =>
        `<section class="family"><h3>${escapeHtml(family)}</h3><div class="models">${familyModels.map((model) => modelOption(model)).join("")}</div></section>`
    )
    .join("");
}

function groupModelsByFamily(models: ModelDefinition[]): Array<[string, ModelDefinition[]]> {
  const groups = new Map<string, ModelDefinition[]>();
  for (const model of models) {
    const family = model.modelFamily ?? inferModelFamily(model.displayName);
    groups.set(family, [...(groups.get(family) ?? []), model]);
  }
  return Array.from(groups.entries());
}

function inferModelFamily(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("gemma-4") || normalized.includes("gemma 4")) return "Gemma 4";
  if (normalized.includes("qwen3.6") || normalized.includes("qwen-3.6") || normalized.includes("qwen 3.6")) return "Qwen 3.6";
  if (normalized.includes("glm-4.7-flash") || normalized.includes("glm 4.7 flash")) return "GLM 4.7 Flash";
  return "Other";
}

function aliasesForDisplay(model: ModelDefinition): string[] {
  const aliases = Array.from(new Set(model.aliases.length ? model.aliases : [model.id]));
  return aliases.sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function copyChip(value: string, variant = ""): string {
  const classes = ["copy-chip", variant].filter(Boolean).join(" ");
  return `<button class="${classes}" type="button" data-copy="${escapeHtml(value)}" title="Copy ${escapeHtml(value)}">${escapeHtml(value)}</button>`;
}

function modelTag(tag: NonNullable<ModelDefinition["tags"]>[number]): string {
  const title = tag.title ? ` title="${escapeHtml(tag.title)}"` : "";
  return `<span class="model-tag"${title}>${escapeHtml(tag.label)}</span>`;
}

function contextTitle(model: ModelDefinition): string {
  const meta = model.runtimeMeta;
  if (!meta) return "Context window";
  const details = [];
  if (meta.n_ctx) details.push(`loaded context ${formatInteger(meta.n_ctx)}`);
  if (meta.n_ctx_train && meta.n_ctx_train !== meta.n_ctx) details.push(`training context ${formatInteger(meta.n_ctx_train)}`);
  return details.length ? details.join(", ") : "Context window";
}

function runtimeMetaLine(model: ModelDefinition): string {
  const meta = model.runtimeMeta;
  if (!meta) return "";
  const details = [
    meta.n_params ? `${formatCompactNumber(meta.n_params)} params` : "",
    meta.size ? formatBytes(meta.size) : "",
    meta.n_vocab ? `${formatInteger(meta.n_vocab)} vocab` : "",
    meta.n_embd ? `${formatInteger(meta.n_embd)} embd` : ""
  ].filter(Boolean);
  return details.length ? `<div class="model-meta">${escapeHtml(details.join(" | "))}</div>` : "";
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1000 && unitIndex < units.length - 1) {
    size /= 1000;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(size)} ${units[unitIndex]}`;
}

function modelLookupForTargets(targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): Record<string, { displayName: string; recommendedAlias: string }> {
  const lookup: Record<string, { displayName: string; recommendedAlias: string }> = {};
  for (const { models } of targets) {
    for (const model of models) {
      const recommendedAlias = aliasesForDisplay(model)[0] ?? model.id;
      lookup[model.id] = { displayName: model.displayName, recommendedAlias };
    }
  }
  return lookup;
}

function targetLookupForTargets(targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): Record<string, { displayName: string }> {
  return Object.fromEntries(targets.map(({ target }) => [target.id, { displayName: target.displayName }]));
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
