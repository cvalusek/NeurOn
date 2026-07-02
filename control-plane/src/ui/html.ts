import type { ApiKey, AppConfig, AuthenticatedUser, CapacityTarget, ModelDefinition, Reservation, RuntimeProfile, TargetStatus } from "../domain/types.js";
import type { AuthMethodView } from "../services/AuthMethodService.js";
import type { ProviderView } from "../services/ProviderService.js";
import type { TargetView } from "../services/TargetService.js";

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
    .pill.starting, .pill.stopping { background: #fff4d6; color: #854a0e; }
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
    .reservation-cost { margin-top: 4px; color: #334155; font-size: 13px; }
    .reservation-cost strong { color: #1f2933; }
    .start-cost { border: 1px solid #d8ddd7; border-radius: 6px; background: #fbfcfb; padding: 10px; margin-top: 14px; }
    .reservation-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    input[type="number"], input[type="text"], input[type="password"], select, textarea { padding: 8px; border: 1px solid #aab4ad; border-radius: 6px; min-width: 140px; max-width: 100%; }
    textarea { width: min(100%, 720px); min-height: 92px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
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
    .inline-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f7f8f6; border: 1px solid #d8ddd7; border-radius: 6px; padding: 10px; font-size: 12px; }
    .summary-list { display: grid; gap: 10px; }
    .drilldown { border: 1px solid #d8ddd7; border-radius: 8px; background: #fbfcfb; }
    .drilldown > summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 13px 14px; cursor: pointer; }
    .drilldown-body { border-top: 1px solid #e2e7e1; padding: 14px; }
    .tabbar { display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid #d8ddd7; margin-bottom: 12px; }
    .tabbar button { background: transparent; color: #334155; border-radius: 0; border-bottom: 2px solid transparent; }
    .tabbar button[aria-selected="true"] { color: #0f766e; border-bottom-color: #0f766e; }
    .tab-panel[hidden], .modal[hidden] { display: none; }
    .modal { position: fixed; inset: 0; background: rgba(23, 32, 42, 0.45); display: grid; place-items: center; padding: 20px; z-index: 10; }
    .modal-dialog { width: min(720px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: white; border-radius: 8px; border: 1px solid #d8ddd7; padding: 18px; box-shadow: 0 16px 48px rgba(23, 32, 42, 0.22); }
    .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <header><div class="topbar"><strong class="brand">NeurOn</strong><nav><a href="/">Home</a><a href="/api-keys">API keys</a><a href="/admin/activations">Activations</a><a href="/admin">Admin</a><a href="/admin/auth">Auth</a><a href="/admin/providers">Providers</a><a href="/admin/targets">Targets</a></nav><span class="user">${user ? escapeHtml(user.username) : ""}</span></div></header>
  <main>${body}</main>
</body>
</html>`;
}

export function loginPage(error = "", githubMethods: Array<{ id: string; displayName: string }> = []): string {
  const githubButtons = githubMethods.length
    ? `<div class="inline-actions" style="margin-top: 14px;">${githubMethods.map((method) => `<form method="get" action="/auth/github/start"><input type="hidden" name="method" value="${escapeHtml(method.id)}"><button class="secondary" type="submit">Sign in with ${escapeHtml(method.displayName)}</button></form>`).join("")}</div>`
    : "";
  return layout("Login", undefined, `<section class="panel">
    <h1>Sign in</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/login">
      <p><label>Username<br><input name="username" required></label></p>
      <p><label>Password<br><input name="password" type="password" required></label></p>
      <button type="submit">Sign in</button>
    </form>
    ${githubButtons}
  </section>`);
}

export function startPage(user: AuthenticatedUser, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>, error = "", costEstimates: Record<string, { hourlyUsd: number }> = {}): string {
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
      <div id="start-cost-estimate" class="start-cost">Estimated cost: Not available</div>
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
    const costLookup = ${safeJson(costEstimates)};
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
    const startCostEstimate = document.querySelector('#start-cost-estimate');
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
    const formatUsd = (value) => '$' + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);
    const selectedTargetId = () => targetInputs.find(input => input.checked)?.value ?? targetInputs[0]?.value;
    const updateStartCostEstimate = () => {
      const targetCost = costLookup[selectedTargetId()];
      if (!targetCost?.hourlyUsd && targetCost?.hourlyUsd !== 0) {
        startCostEstimate.textContent = 'Estimated cost: Not available';
        return;
      }
      const durationMinutes = Math.max(0, Number(duration.value) || 0);
      const keepaliveMinutes = Math.max(0, Number(keepalive.value) || 0);
      const estimatedMinutes = durationMinutes + keepaliveMinutes;
      const estimatedCost = targetCost.hourlyUsd * estimatedMinutes / 60;
      startCostEstimate.textContent = 'Estimated cost: ' + formatUsd(estimatedCost) + ' for ' + estimatedMinutes + ' min (duration + keepalive)';
    };
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
    const reservationCostLine = (cost) => {
      const soFar = '<div><strong>Cost so far:</strong> ' + (cost ? formatUsd(cost.estimatedCostUsd) : 'Not allocated yet') + '</div>';
      const projected = cost?.projectedTotalCostUsd !== undefined ? '<div><strong>Projected total:</strong> ' + formatUsd(cost.projectedTotalCostUsd) + '</div>' : '';
      return '<div class="reservation-cost">' + soFar + projected + '</div>';
    };
    const statusBadge = (status) => '<span class="badge ' + status + '">' + status + '</span>';
    const countdown = (iso) => '<span class="countdown" data-countdown-expires="' + escapeText(iso) + '">' + escapeText(timeLeft(iso)) + '</span>';
    const reservationTimeHtml = (reservation) => {
      if (reservation.status === 'active') return 'until ' + escapeText(formatDateTime(reservation.expiresAt)) + ' (' + countdown(reservation.expiresAt) + ')';
      if (reservation.endedAt) return escapeText(reservation.status === 'done' ? 'ended ' + formatDateTime(reservation.endedAt) : reservation.status + ' ' + formatDateTime(reservation.endedAt));
      return escapeText(reservation.status + ' at ' + formatDateTime(reservation.expiresAt));
    };
    const reservationTargets = (reservation) => reservation.targets.map(target => targetLookup[target.id]?.displayName ?? target.id).join(', ');
    const reservationCard = (reservation, includeActions = false) => {
      const actions = includeActions
        ? '<div class="reservation-actions"><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="1" type="submit">+1 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="2" type="submit">+2 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="5" type="submit">+5 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="15" type="submit">+15 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="30" type="submit">+30 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="60" type="submit">+1 hour</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/done"><button class="danger" type="submit">I\\'m done</button></form></div>'
        : '';
      return '<div class="reservation-card"><div><div class="reservation-meta">' + statusBadge(reservation.status) + '<strong>' + escapeText(reservation.displayUsername ?? reservation.username) + '</strong><span class="muted">' + reservationTimeHtml(reservation) + '</span></div><div class="muted">' + escapeText(reservationTargets(reservation)) + '</div>' + reservationCostLine(reservation.costEstimate) + modelChipRow(reservation.modelIds) + '</div>' + actions + '</div>';
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
      updateStartCostEstimate();
    };
    durationButtons.forEach(button => button.addEventListener('click', () => selectDuration(button)));
    const selectKeepalive = (button) => {
      keepaliveButtons.forEach(candidate => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
      const isCustom = Boolean(button?.dataset.customKeepalive);
      customKeepaliveWrap.classList.toggle('hidden', !isCustom);
      keepalive.value = isCustom ? customKeepalive.value : button?.dataset.keepalive ?? keepalive.value;
      if (isCustom) customKeepalive.focus();
      updateStartCostEstimate();
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
    targetInputs.forEach(input => input.addEventListener('change', () => {
      selectTarget(input.value);
      updateStartCostEstimate();
    }));
    selectTarget(targetInputs.find(input => input.checked)?.value ?? targetInputs[0]?.value);
    updateStartCostEstimate();
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
      updateCountdowns();
    }
    function updateCountdowns() {
      document.querySelectorAll('[data-countdown-expires]').forEach(element => {
        element.textContent = timeLeft(element.dataset.countdownExpires);
      });
    }
    refreshServerStatus();
    setInterval(updateCountdowns, 1000);
    setInterval(refreshServerStatus, 10000);
  </script>`);
}

export function reservationPage(user: AuthenticatedUser, reservation: Reservation, config: AppConfig): string {
  return layout("NeurOn Reservation", user, `<section class="panel">
    <h1>Reservation ${escapeHtml(reservation.id)}</h1>
    <p>Status: <span id="reservation-status" class="status">${escapeHtml(reservation.status)}</span></p>
    <p>Models: <span id="reservation-models">${escapeHtml(reservation.modelIds.join(", "))}</span></p>
    <p>Expires: <span id="reservation-expires">${reservation.expiresAt.toISOString()}</span></p>
    <p>Cost so far: <span id="reservation-cost-so-far" class="status">Not allocated yet</span></p>
    <p>Projected total: <span id="reservation-cost-projected" class="status">Not available</span></p>
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
    const formatUsd = (value) => '$' + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);
    async function refresh() {
      const res = await fetch('/api/reservations/' + reservationId + '/status');
      if (!res.ok) return;
      const data = await res.json();
      document.querySelector('#reservation-status').textContent = data.status;
      document.querySelector('#reservation-expires').textContent = reservationTime(data);
      document.querySelector('#reservation-cost-so-far').textContent = data.costEstimate ? formatUsd(data.costEstimate.estimatedCostUsd) : 'Not allocated yet';
      document.querySelector('#reservation-cost-projected').textContent = data.costEstimate?.projectedTotalCostUsd !== undefined ? formatUsd(data.costEstimate.projectedTotalCostUsd) : 'Not available';
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
    <p><a href="/admin/auth">Manage authentication</a> | <a href="/admin/providers">Manage providers</a> | <a href="/admin/targets">Manage targets</a></p>
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
    const formatUsd = (value) => '$' + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);
    const reservationCost = (reservation) => reservation.costEstimate ? formatUsd(reservation.costEstimate.estimatedCostUsd) : '';
    const reservationTime = (reservation) => {
      if (reservation.status === 'active') return 'until ' + friendlyExpiration(reservation.expiresAt);
      if (reservation.endedAt) return reservation.status === 'done' ? 'ended ' + formatDateTime(reservation.endedAt) : reservation.status + ' ' + formatDateTime(reservation.endedAt);
      return reservation.status + ' at ' + formatDateTime(reservation.expiresAt);
    };
    async function post(url) { await fetch(url, { method: 'POST' }); refresh(); }
    window.provisionTarget = (id) => post('/api/admin/targets/' + id + '/provision');
    window.discoverTarget = (id) => post('/api/admin/targets/' + id + '/discover');
    window.forceStop = (id) => post('/api/admin/targets/' + id + '/force-stop');
    window.reconcileTarget = (id) => post('/api/admin/targets/' + id + '/reconcile');
    async function refresh() {
      const res = await fetch('/api/admin/status');
      if (!res.ok) return;
      const data = await res.json();
      const targets = data.capacityTargets.map(t => {
        const provision = t.needsProvisioning ? '<button onclick="provisionTarget(\\'' + t.id + '\\')">Provision</button> ' : '';
        return '<tr><td>' + t.id + '</td><td>' + t.desired + '</td><td>' + t.observed + '</td><td>' + t.message + '</td><td>' + t.activeUsers.join(', ') + '</td><td>' + provision + '<button onclick="discoverTarget(\\'' + t.id + '\\')">Discover</button> <button onclick="reconcileTarget(\\'' + t.id + '\\')">Reconcile</button> <button class="danger" onclick="forceStop(\\'' + t.id + '\\')">Force stop</button></td></tr>';
      }).join('');
      const reservations = data.reservations.map(r => '<tr><td>' + r.reservationId + '</td><td>' + (r.displayUsername ?? r.username) + '</td><td>' + statusBadge(r.status) + '</td><td>' + reservationTime(r) + '</td><td>' + reservationCost(r) + '</td><td>' + r.modelIds.join(', ') + '</td></tr>').join('');
      document.querySelector('#admin-status').innerHTML = '<h2>Targets</h2><table><thead><tr><th>Target</th><th>Desired</th><th>Observed</th><th>Message</th><th>Users</th><th></th></tr></thead><tbody>' + targets + '</tbody></table><h2>Reservations</h2><table><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Expires</th><th>Cost</th><th>Models</th></tr></thead><tbody>' + reservations + '</tbody></table>';
    }
    refresh();
    setInterval(refresh, ${config.adminStatusPollSeconds * 1000});
  </script>`);
}

export function activationPage(user: AuthenticatedUser): string {
  return layout("Activations", user, `<section class="panel">
    <h1>Activations</h1>
    <div id="activation-list"><p class="muted">Loading...</p></div>
  </section>
  <script type="module">
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const formatDateTime = (iso) => iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '';
    const formatUsd = (value) => '$' + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);
    const statusBadge = (status) => '<span class="badge ' + status + '">' + escapeText(status) + '</span>';
    const activationWindow = (activation) => escapeText(formatDateTime(activation.startedAt) + ' - ' + (activation.endedAt ? formatDateTime(activation.endedAt) : 'active'));
    const reservationRows = (activation) => activation.reservations.length
      ? '<table><thead><tr><th>Reservation</th><th>User</th><th>Status</th><th>Cost</th><th>Models</th></tr></thead><tbody>' + activation.reservations.map(reservation => '<tr><td><a href="/reservations/' + escapeText(reservation.reservationId) + '">' + escapeText(reservation.reservationId) + '</a></td><td>' + escapeText(reservation.displayUsername) + '</td><td>' + statusBadge(reservation.status) + '</td><td>' + formatUsd(reservation.estimatedCostUsd) + '</td><td>' + escapeText(reservation.modelIds.join(', ')) + '</td></tr>').join('') + '</tbody></table>'
      : '<p class="muted">No reservation allocations recorded.</p>';
    const activationCard = (activation) => '<details class="drilldown"><summary><div><strong>' + escapeText(activation.targetDisplayName) + '</strong><div class="muted"><code>' + escapeText(activation.id) + '</code> | ' + activationWindow(activation) + '</div></div><span>' + statusBadge(activation.status) + '</span></summary><div class="drilldown-body"><p><strong>Estimated cost:</strong> ' + formatUsd(activation.estimatedCostUsd) + '</p><p><strong>Hourly estimate:</strong> ' + (activation.estimatedHourlyCostUsd === undefined ? 'Not configured' : formatUsd(activation.estimatedHourlyCostUsd)) + '</p>' + reservationRows(activation) + '</div></details>';
    async function refresh() {
      const response = await fetch('/api/admin/activations');
      if (!response.ok) return;
      const data = await response.json();
      document.querySelector('#activation-list').innerHTML = data.activations.length ? '<div class="summary-list">' + data.activations.map(activationCard).join('') + '</div>' : '<p class="muted">No activations recorded yet.</p>';
    }
    refresh();
  </script>`);
}

export function adminAuthPage(user: AuthenticatedUser, methods: AuthMethodView[], error = ""): string {
  const rows = methods.length ? methods.map(authMethodRow).join("") : `<p class="muted">No additional authentication methods configured.</p>`;
  return layout("NeurOn Auth", user, `<section class="panel">
    <h1>Authentication</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/admin/auth">
      <div class="field-grid">
        <p><label>ID<br><input name="id" type="text" value="github" required></label></p>
        <p><label>Display name<br><input name="displayName" type="text" value="GitHub"></label></p>
      </div>
      <p><label><input name="enabled" type="checkbox" checked> Enabled</label></p>
      <div class="field-grid">
        <p><label>GitHub client ID<br><input name="clientId" type="text" required></label></p>
        <p><label>GitHub client secret<br><input name="clientSecret" type="password" required></label></p>
      </div>
      <div class="field-grid">
        <p><label>Allowed users<br><input name="allowedUsers" type="text" placeholder="alice,bob"></label></p>
        <p><label>Allowed organizations<br><input name="allowedOrganizations" type="text" placeholder="my-org"></label></p>
      </div>
      <div class="actions"><button type="submit">Add GitHub auth</button></div>
    </form>
  </section>
  <section class="panel">
    <h2>Methods</h2>
    <div class="summary-list">${rows}</div>
  </section>
  <script type="module">
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tab]');
      if (!button) return;
      const root = button.closest('[data-tabs]');
      if (!root) return;
      root.querySelectorAll('[data-tab]').forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === button)));
      root.querySelectorAll('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== button.dataset.tab; });
    });
  </script>`);
}

function authMethodRow(method: AuthMethodView): string {
  const github = method.config.github;
  const allowUsers = github?.allowedUsers?.join(", ") ?? "";
  const allowOrgs = github?.allowedOrganizations?.join(", ") ?? "";
  const editAction = method.editable
    ? authMethodEditPanel(method)
    : `<form method="post" action="/admin/auth/${escapeHtml(method.id)}/copy-to-db"><button class="secondary" type="submit">Copy config auth to DB</button></form>`;
  const deleteAction = method.editable ? authMethodDeletePanel(method) : `<p class="muted">This method is loaded from environment config. Remove it from configuration or copy it to the database before deleting it here.</p>`;
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(method.displayName)}</strong><div class="muted"><code>${escapeHtml(method.id)}</code> | ${escapeHtml(method.type)} | ${method.enabled ? "enabled" : "disabled"}</div></div><span class="badge ${method.source === "persisted" ? "active" : "done"}">${escapeHtml(method.source)}</span></summary><div class="drilldown-body" data-tabs><div class="tabbar"><button type="button" data-tab="view" aria-selected="true">View</button><button type="button" data-tab="edit" aria-selected="false">Edit</button><button type="button" data-tab="delete" aria-selected="false">Delete</button></div><section class="tab-panel" data-tab-panel="view"><p><strong>Client ID:</strong> <code>${escapeHtml(github?.clientId ?? "")}</code></p><p><strong>Allowed users:</strong> ${allowUsers ? escapeHtml(allowUsers) : "<span class=\"muted\">Any GitHub user</span>"}</p><p><strong>Allowed organizations:</strong> ${allowOrgs ? escapeHtml(allowOrgs) : "<span class=\"muted\">None required</span>"}</p></section><section class="tab-panel" data-tab-panel="edit" hidden>${editAction}</section><section class="tab-panel" data-tab-panel="delete" hidden>${deleteAction}</section></div></details>`;
}

function authMethodEditPanel(method: AuthMethodView): string {
  const github = method.config.github;
  return `<form method="post" action="/admin/auth/${escapeHtml(method.id)}/update">
    <div class="field-grid">
      <p><label>ID<br><input name="id" type="text" value="${escapeHtml(method.id)}" required></label></p>
      <p><label>Display name<br><input name="displayName" type="text" value="${escapeHtml(method.displayName)}"></label></p>
    </div>
    <p><label><input name="enabled" type="checkbox" ${method.enabled ? "checked" : ""}> Enabled</label></p>
    <div class="field-grid">
      <p><label>GitHub client ID<br><input name="clientId" type="text" value="${escapeHtml(github?.clientId ?? "")}" required></label></p>
      <p><label>GitHub client secret<br><input name="clientSecret" type="password" placeholder="leave blank to keep current secret"></label></p>
    </div>
    <div class="field-grid">
      <p><label>Allowed users<br><input name="allowedUsers" type="text" value="${escapeHtml(github?.allowedUsers?.join(",") ?? "")}"></label></p>
      <p><label>Allowed organizations<br><input name="allowedOrganizations" type="text" value="${escapeHtml(github?.allowedOrganizations?.join(",") ?? "")}"></label></p>
    </div>
    <div class="actions"><button type="submit">Save auth method</button></div>
  </form>`;
}

function authMethodDeletePanel(method: AuthMethodView): string {
  return `<p class="muted">Type <code>${escapeHtml(method.id)}</code> to delete this auth method.</p>
  <form method="post" action="/admin/auth/${escapeHtml(method.id)}/delete">
    <p><label>Method ID<br><input name="confirmName" type="text" autocomplete="off" required></label></p>
    <button class="danger" type="submit">Delete auth method</button>
  </form>`;
}

export function targetAdminPage(user: AuthenticatedUser, targets: TargetView[], providers: ProviderView[], runtimeProfiles: RuntimeProfile[] = [], error = "", createdTargetId = ""): string {
  const rows = targets.length
    ? targets.map((target) => targetRow(target, providers, runtimeProfiles)).join("")
    : `<p class="muted">No targets configured</p>`;
  const addTarget = providers.length > 0
    ? `<button type="button" data-open-modal="target-modal">Add target</button>`
    : `<a href="/admin/providers">Add a provider first</a>`;
  const modal = providers.length > 0 ? targetCreateModal(providers, runtimeProfiles) : "";
  return layout("NeurOn Targets", user, `<section class="panel">
    <div class="target-status-head"><h1>Targets</h1>${addTarget}</div>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    ${createdTargetId ? `<div class="secret-box"><span>Target <code>${escapeHtml(createdTargetId)}</code> was created.</span><button type="button" data-provision-target="${escapeHtml(createdTargetId)}">Provision target</button></div>` : ""}
    <div class="summary-list">${rows}</div>
  </section>
  ${modal}
  <script type="module">
    ${targetAdminScript(providers, runtimeProfiles)}
  </script>`);
}

function targetCreateModal(providers: ProviderView[], runtimeProfiles: RuntimeProfile[]): string {
  return `<div id="target-modal" class="modal" hidden>
    <div class="modal-dialog">
    <div class="target-status-head"><h2>Add target</h2><button class="secondary" type="button" data-close-modal>Close</button></div>
    <form method="post" action="/admin/targets">
      <p><label>Provider<br>${targetProviderSelect(providers)}</label></p>
      <p><label>Profile<br>${runtimeProfileSelect(runtimeProfiles)}</label></p>
      <p><label>Variant<br><select name="runtimeProfileVariantId"></select></label></p>
      <p id="target-runtime-profile-note" class="muted"></p>
      <div class="field-grid">
        <p><label>ID<br><input name="id" type="text" placeholder="target-id" required></label></p>
        <p><label>Display name<br><input name="displayName" type="text" placeholder="Target name"></label></p>
      </div>
      <div id="runpod-target-fields">
        <p><label>RunPod Pod ID<br><input name="runpodPodId" type="text" placeholder="pod-id"></label></p>
        <p><label>RunPod runtime port<br><input name="runpodRuntimePort" type="number" min="1" placeholder="8080"></label></p>
      </div>
      <div id="aws-target-fields">
        <p><label>AWS cluster<br><input name="awsCluster" type="text" placeholder="llm-cluster"></label></p>
        <p><label>AWS service<br><input name="awsService" type="text" placeholder="llama-cpp-gpu-pool"></label></p>
        <p><label>AWS ASG name<br><input name="awsAsgName" type="text" placeholder="llm-gpu-pool-asg"></label></p>
      </div>
      <div id="docker-target-fields">
        <p><label>Docker container name<br><input name="dockerContainerName" type="text" placeholder="prefer"></label></p>
        <p><label>Model volume<br><input name="dockerModelVolume" type="text" placeholder="prefer-model-cache"></label></p>
        <p class="muted">The profile supplies the container path.</p>
      </div>
      <div id="neuron-target-fields">
        <p><label>Remote NeurOn target ID<br><input name="neuronTargetId" type="text" placeholder="gpu-pool-west"></label></p>
        <p class="muted">Later we can pull these from the remote NeurOn API once that provider is wired.</p>
      </div>
      <details>
        <summary>Overrides</summary>
        <p><label>API URL override<br><input name="apiUrl" type="text" placeholder="http://runtime.internal:8080/v1"></label></p>
        <p><label>Health URL override<br><input name="healthUrl" type="text" placeholder="http://runtime.internal:8080/health"></label></p>
        <p><label>Configured model IDs<br><input name="modelIds" type="text" placeholder="qwen-3.6,gemma-4"></label></p>
        <p class="muted">Leave models empty to rely on runtime discovery.</p>
      </details>
      <div class="actions"><button type="submit">Add target</button></div>
    </form>
    </div>
  </div>`;
}

function targetAdminScript(providers: ProviderView[], runtimeProfiles: RuntimeProfile[]): string {
  return `
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
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-provision-target]');
      if (!button) return;
      event.preventDefault();
      const targetId = button.dataset.provisionTarget;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Provisioning...';
      const response = await fetch('/api/admin/targets/' + encodeURIComponent(targetId) + '/provision', { method: 'POST' });
      button.textContent = response.ok ? 'Provisioned' : 'Provision failed';
      await refreshTargetStatus();
      setTimeout(() => { button.disabled = false; button.textContent = previous; }, 1400);
    });
    document.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-open-modal]');
      if (opener) document.getElementById(opener.dataset.openModal).hidden = false;
      if (event.target.closest('[data-close-modal]')) event.target.closest('.modal').hidden = true;
      if (event.target.classList?.contains('modal')) event.target.hidden = true;
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      const group = tab.closest('[data-tabs]');
      group.querySelectorAll('[data-tab]').forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === tab)));
      group.querySelectorAll('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== tab.dataset.tab; });
    });
    const providers = ${safeJson(Object.fromEntries(providers.map((provider) => [provider.id, provider.type])))};
    const runtimeProfiles = ${safeJson(Object.fromEntries(runtimeProfiles.map((profile) => [profile.id, profile])))};
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const provider = document.querySelector('#target-modal select[name="providerId"]');
    const runtimeProfile = document.querySelector('#target-modal select[name="runtimeProfileId"]');
    const runtimeProfileVariant = document.querySelector('#target-modal select[name="runtimeProfileVariantId"]');
    const runtimeNote = document.querySelector('#target-runtime-profile-note');
    const dockerModelVolumeInput = document.querySelector('#target-modal input[name="dockerModelVolume"]');
    dockerModelVolumeInput?.addEventListener('input', () => { dockerModelVolumeInput.dataset.touched = 'true'; });
    const runpod = document.querySelector('#runpod-target-fields');
    const aws = document.querySelector('#aws-target-fields');
    const docker = document.querySelector('#docker-target-fields');
    const neuron = document.querySelector('#neuron-target-fields');
    const selectedProfile = () => runtimeProfile ? runtimeProfiles[runtimeProfile.value] : undefined;
    const selectedVariant = () => {
      const profile = selectedProfile();
      return profile?.variants?.find(variant => variant.id === runtimeProfileVariant?.value);
    };
    const effectiveProfile = () => {
      const profile = selectedProfile();
      const variant = selectedVariant();
      if (!profile || !variant) return profile;
      return {
        ...profile,
        image: variant.image ?? profile.image,
        port: variant.port ?? profile.port,
        health: variant.health ?? profile.health,
        api: variant.api ?? profile.api,
        volumes: variant.volumes ?? profile.volumes,
        env: { ...(profile.env ?? {}), ...(variant.env ?? {}) },
        discovery: variant.discovery ?? profile.discovery
      };
    };
    const syncVariants = () => {
      if (!runtimeProfileVariant) return;
      const profile = selectedProfile();
      const variants = profile?.variants ?? [];
      runtimeProfileVariant.innerHTML = variants.map(variant => '<option value="' + escapeText(variant.id) + '">' + escapeText(variant.name) + '</option>').join('');
      runtimeProfileVariant.closest('p').hidden = variants.length === 0;
    };
    const sync = () => {
      if (!provider) return;
      const type = providers[provider.value];
      runpod.hidden = type !== 'runpod';
      aws.hidden = type !== 'aws-ecs' && type !== 'aws-ecs-asg';
      docker.hidden = type !== 'docker';
      neuron.hidden = type !== 'neuron';
      const profile = effectiveProfile();
      const variant = selectedVariant();
      const port = profile?.port ?? 8080;
      const discovery = profile ? profile.discovery ?? true : false;
      const profileVolumes = Object.entries(profile?.volumes ?? {});
      const modelVolume = profileVolumes[0];
      runtimeNote.textContent = profile ? [profile.type, profile.image, variant ? 'variant ' + variant.name : '', 'port ' + port, modelVolume ? 'volume ' + modelVolume[1] + ' -> ' + modelVolume[0] : '', discovery ? 'discovery on' : 'discovery off'].filter(Boolean).join(' | ') : '';
      if (dockerModelVolumeInput && !dockerModelVolumeInput.dataset.touched) dockerModelVolumeInput.value = modelVolume?.[1] ?? '';
    };
    provider?.addEventListener('change', sync);
    runtimeProfile?.addEventListener('change', () => { syncVariants(); sync(); });
    runtimeProfileVariant?.addEventListener('change', sync);
    syncVariants();
    sync();
    document.querySelectorAll('form[data-target-edit-form]').forEach(form => {
      const providerSelect = form.querySelector('select[name="providerId"]');
      const sections = [...form.querySelectorAll('[data-edit-provider-fields]')];
      const editSync = () => {
        const selectedOption = providerSelect.selectedOptions[0];
        const type = providers[providerSelect.value] ?? selectedOption?.dataset.providerType ?? '';
        sections.forEach(section => {
          const names = section.dataset.editProviderFields.split(',');
          section.hidden = !names.includes(type);
        });
      };
      providerSelect.addEventListener('change', editSync);
      editSync();
    });
    const statusPill = (value) => '<span class="pill ' + String(value ?? '').replace(/[^a-z0-9_-]/gi, '') + '">' + escapeText(value) + '</span>';
    const statusCard = (target) => '<div class="target-status-meta">' + statusPill(target.desired) + statusPill(target.observed) + '<span class="muted">' + escapeText(target.message) + '</span>' + (target.activeUsers?.length ? '<span class="muted">Users: ' + escapeText(target.activeUsers.join(', ')) + '</span>' : '') + '</div>';
    async function refreshTargetStatus() {
      const response = await fetch('/api/admin/targets');
      if (!response.ok) return;
      const data = await response.json();
      const targets = Object.fromEntries(data.capacityTargets.map(target => [target.id, target]));
      document.querySelectorAll('[data-target-status]').forEach(panel => {
        const target = targets[panel.dataset.targetStatus];
        panel.innerHTML = target ? statusCard(target) : '<p class="muted">Status unavailable</p>';
      });
    }
    refreshTargetStatus();
  `;
}

function targetRow(target: TargetView, providers: ProviderView[], runtimeProfiles: RuntimeProfile[]): string {
  const details = targetDetails(target);
  const editAction = target.editable
    ? targetEditPanel(target, providers, runtimeProfiles)
    : `<form method="post" action="/admin/targets/${escapeHtml(target.id)}/copy-to-db"><button class="secondary" type="submit">Copy to DB</button></form>`;
  const deleteAction = target.editable ? targetDeletePanel(target) : `<p class="muted">This target is loaded from declarative config. Remove it from configuration or copy it to the database before deleting it here.</p>`;
  const users = target.modelIds.length > 0 ? `${target.modelIds.length} configured models` : "Discovery";
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(target.displayName)}</strong><div class="target-status-meta"><span class="pill off">${escapeHtml(target.provider)}</span><span class="muted"><code>${escapeHtml(target.id)}</code></span><span class="muted">${escapeHtml(users)}</span></div></div><span class="badge ${target.source === "persisted" ? "active" : "done"}">${escapeHtml(target.source)}</span></summary><div class="drilldown-body" data-tabs><div class="tabbar"><button type="button" data-tab="view" aria-selected="true">View</button><button type="button" data-tab="status" aria-selected="false">Status</button><button type="button" data-tab="json" aria-selected="false">JSON</button><button type="button" data-tab="env" aria-selected="false">ENV</button><button type="button" data-tab="edit" aria-selected="false">Edit</button><button type="button" data-tab="delete" aria-selected="false">Delete</button></div>${details}<section class="tab-panel" data-tab-panel="edit" hidden><p class="muted">${target.editable ? "This target is stored in the database." : "This target is loaded from declarative config."}</p>${editAction}</section><section class="tab-panel" data-tab-panel="delete" hidden>${deleteAction}</section></div></details>`;
}

function targetEditPanel(target: TargetView, providers: ProviderView[], runtimeProfiles: RuntimeProfile[]): string {
  const providerSelection = target.providerId ?? target.provider;
  const runtimeProfileId = runtimeProfileForTarget(target, runtimeProfiles);
  return `<form method="post" action="/admin/targets/${escapeHtml(target.id)}/update" data-target-edit-form>
    <p><label>Provider<br>${targetProviderSelect(providers, false, providerSelection, target.provider)}</label></p>
    <p><label>Profile<br>${runtimeProfileSelect(runtimeProfiles, runtimeProfileId)}</label></p>
    <div class="field-grid">
      <p><label>ID<br><input name="id" type="text" value="${escapeHtml(target.id)}" required></label></p>
      <p><label>Display name<br><input name="displayName" type="text" value="${escapeHtml(target.displayName)}"></label></p>
    </div>
    <div data-edit-provider-fields="runpod">
      <p><label>RunPod Pod ID<br><input name="runpodPodId" type="text" value="${escapeHtml(target.runpod?.podId ?? "")}"></label></p>
      <p><label>RunPod runtime port<br><input name="runpodRuntimePort" type="number" min="1" value="${escapeHtml(String(target.runpod?.runtimePort ?? ""))}"></label></p>
    </div>
    <div data-edit-provider-fields="aws-ecs,aws-ecs-asg">
      <p><label>AWS cluster<br><input name="awsCluster" type="text" value="${escapeHtml(target.aws?.cluster ?? target.aws?.clusterName ?? "")}"></label></p>
      <p><label>AWS service<br><input name="awsService" type="text" value="${escapeHtml(target.aws?.service ?? target.aws?.serviceName ?? "")}"></label></p>
      <p><label>AWS ASG name<br><input name="awsAsgName" type="text" value="${escapeHtml(target.aws?.autoScalingGroupName ?? "")}"></label></p>
    </div>
    <div data-edit-provider-fields="docker">
      <p><label>Docker container name<br><input name="dockerContainerName" type="text" value="${escapeHtml(target.docker?.containerName ?? "")}"></label></p>
      <p><label>Model volume<br><input name="dockerModelVolume" type="text" value="${escapeHtml(dockerModelVolumeForTarget(target))}"></label></p>
      <p class="muted">The profile supplies the container path.</p>
    </div>
    <div data-edit-provider-fields="neuron">
      <p><label>Remote NeurOn target ID<br><input name="neuronTargetId" type="text" value="${escapeHtml(target.neuron?.targetId ?? "")}"></label></p>
    </div>
    <details>
      <summary>Overrides</summary>
      <p><label>API URL override<br><input name="apiUrl" type="text" value="${escapeHtml(target.apiUrl ?? "")}"></label></p>
      <p><label>Health URL override<br><input name="healthUrl" type="text" value="${escapeHtml(target.healthUrl ?? "")}"></label></p>
      <p><label>Configured model IDs<br><input name="modelIds" type="text" value="${escapeHtml(target.modelIds.join(","))}"></label></p>
      <p class="muted">Leave models empty to rely on runtime discovery.</p>
    </details>
    <div class="actions"><button type="submit">Save target</button></div>
  </form>`;
}

function targetDeletePanel(target: TargetView): string {
  return `<p class="muted">Type <code>${escapeHtml(target.id)}</code> to delete this target.</p>
  <form method="post" action="/admin/targets/${escapeHtml(target.id)}/delete">
    <p><label>Target ID<br><input name="confirmName" type="text" autocomplete="off" required></label></p>
    <button class="danger" type="submit">Delete target</button>
  </form>`;
}

function targetDetails(target: CapacityTarget): string {
  const declarative = declarativeTargetJson(target);
  const env = declarativeTargetEnv(target);
  const viewRows = [
    ["Provider", target.providerId ?? target.provider],
    ["Provider type", target.provider],
    ["Models", target.modelIds.length ? target.modelIds.join(", ") : "Discovery"],
    ["API URL", target.apiUrl],
    ["Health URL", target.healthUrl],
    ["Traffic prefixes", target.trafficModelPrefixes?.join(", ")],
    ["Docker container", target.docker?.containerName],
    ["Docker image", target.docker?.image],
    ["Docker volumes", target.docker?.volumes?.join(", ")],
    ["RunPod Pod", target.runpod?.podId],
    ["AWS cluster", target.aws?.cluster ?? target.aws?.clusterName],
    ["AWS service", target.aws?.service ?? target.aws?.serviceName],
    ["AWS ASG", target.aws?.autoScalingGroupName],
    ["Remote NeurOn target", target.neuron?.targetId]
  ].filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "");
  const view = `<table><tbody>${viewRows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`).join("")}</tbody></table>`;
  return `<section class="tab-panel" data-tab-panel="view">${view}</section><section class="tab-panel" data-tab-panel="status" hidden><div data-target-status="${escapeHtml(target.id)}"><p class="muted">Loading status...</p></div></section><section class="tab-panel" data-tab-panel="json" hidden><div class="inline-actions"><button type="button" data-copy="${escapeHtml(declarative)}">Copy JSON</button></div><pre>${escapeHtml(declarative)}</pre></section><section class="tab-panel" data-tab-panel="env" hidden><p class="muted">Profiles are create-time templates; ENV shows the expanded target config.</p><div class="inline-actions"><button type="button" data-copy="${escapeHtml(env)}">Copy ENV</button></div><pre>${escapeHtml(env)}</pre></section>`;
}

function targetProviderSelect(providers: ProviderView[], _includeDirectTypes = false, selected = "", selectedType = ""): string {
  const hasSelectedProvider = providers.some((provider) => provider.id === selected);
  const options = [
    ...providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.id === selected ? "selected" : ""}>${escapeHtml(provider.displayName)} (${escapeHtml(provider.type)})</option>`),
    !hasSelectedProvider && selected ? `<option value="${escapeHtml(selected)}" selected data-provider-type="${escapeHtml(selectedType)}">${escapeHtml(selected)} (${escapeHtml(selectedType || "missing provider")})</option>` : ""
  ].join("");
  return `<select name="providerId" required>${options}</select>`;
}

function runtimeProfileForTarget(target: CapacityTarget, runtimeProfiles: RuntimeProfile[]): string {
  const byImage = runtimeProfiles.find((profile) => profile.image && profile.image === target.docker?.image);
  return byImage?.id ?? runtimeProfiles[0]?.id ?? "";
}

function dockerModelVolumeForTarget(target: CapacityTarget): string {
  const volume = target.docker?.volumes?.[0];
  if (!volume) return "";
  return volume.split(":")[0] ?? "";
}

function declarativeTargetJson(target: CapacityTarget): string {
  return JSON.stringify(stripUndefined({
    id: target.id,
    displayName: target.displayName,
    provider: target.providerId ? undefined : target.provider,
    providerId: target.providerId,
    modelIds: target.modelIds,
    models: target.models,
    modelDiscovery: target.modelDiscovery,
    modelWarmup: target.modelWarmup,
    trafficModelPrefixes: target.trafficModelPrefixes,
    litellmDisplayPrefix: target.litellmDisplayPrefix,
    modelsMax: target.modelsMax,
    aws: target.aws,
    docker: target.docker,
    dockerCompose: target.dockerCompose,
    runpod: target.runpod,
    neuron: target.neuron,
    healthUrl: target.healthUrl,
    apiUrl: target.apiUrl,
    litellm: target.litellm
  }), null, 2);
}

function declarativeTargetEnv(target: CapacityTarget): string {
  const key = envKey(target.id);
  const prefix = `CAPACITY_TARGET_${key}`;
  const json = envLine("CAPACITY_TARGETS_JSON", JSON.stringify([JSON.parse(declarativeTargetJson(target)) as Record<string, unknown>]));
  const lines = [
    "# JSON form",
    json,
    "",
    "# Expanded form",
    envLine("CAPACITY_TARGET_KEYS", key),
    envLine(`${prefix}_ID`, target.id),
    envLine(`${prefix}_DISPLAY_NAME`, target.displayName),
    target.providerId ? envLine(`${prefix}_PROVIDER_ID`, target.providerId) : envLine(`${prefix}_PROVIDER`, target.provider),
    target.modelIds.length > 0 ? `# ${envLine(`${prefix}_MODEL_IDS`, target.modelIds.join(","))} # optional; omit to use runtime discovery` : "",
    target.healthUrl ? envLine(`${prefix}_HEALTH_URL`, target.healthUrl) : "",
    target.apiUrl ? envLine(`${prefix}_API_URL`, target.apiUrl) : "",
    target.trafficModelPrefixes?.length ? envLine(`${prefix}_TRAFFIC_MODEL_PREFIXES`, target.trafficModelPrefixes.join(",")) : "",
    target.litellmDisplayPrefix !== undefined ? envLine(`${prefix}_LITELLM_DISPLAY_PREFIX`, target.litellmDisplayPrefix || "__empty__") : "",
    target.modelsMax ? envLine(`${prefix}_MODELS_MAX`, String(target.modelsMax)) : "",
    target.aws?.cluster ? envLine(`${prefix}_AWS_CLUSTER`, target.aws.cluster) : "",
    target.aws?.service ? envLine(`${prefix}_AWS_SERVICE`, target.aws.service) : "",
    target.aws?.clusterName ? envLine(`${prefix}_AWS_CLUSTER_NAME`, target.aws.clusterName) : "",
    target.aws?.serviceName ? envLine(`${prefix}_AWS_SERVICE_NAME`, target.aws.serviceName) : "",
    target.aws?.autoScalingGroupName ? envLine(`${prefix}_AWS_ASG_NAME`, target.aws.autoScalingGroupName) : "",
    target.runpod?.podId ? envLine(`${prefix}_RUNPOD_POD_ID`, target.runpod.podId) : "",
    target.runpod?.apiKeyEnv ? envLine(`${prefix}_RUNPOD_API_KEY_ENV`, target.runpod.apiKeyEnv) : "",
    target.runpod?.apiBaseUrl ? envLine(`${prefix}_RUNPOD_API_BASE_URL`, target.runpod.apiBaseUrl) : "",
    target.runpod?.runtimePort ? envLine(`${prefix}_RUNPOD_RUNTIME_PORT`, String(target.runpod.runtimePort)) : "",
    target.runpod?.create ? envLine(`${prefix}_RUNPOD_CREATE_JSON`, JSON.stringify(target.runpod.create)) : "",
    target.neuron?.targetId ? envLine(`${prefix}_NEURON_TARGET_ID`, target.neuron.targetId) : "",
    target.docker?.containerName ? envLine(`${prefix}_DOCKER_CONTAINER_NAME`, target.docker.containerName) : "",
    target.docker?.image ? envLine(`${prefix}_DOCKER_IMAGE`, target.docker.image) : "",
    target.docker?.ports?.length ? envLine(`${prefix}_DOCKER_PORTS`, target.docker.ports.join(",")) : "",
    target.docker?.volumes?.length ? envLine(`${prefix}_DOCKER_VOLUMES`, target.docker.volumes.join(",")) : "",
    target.docker?.gpus ? envLine(`${prefix}_DOCKER_GPUS`, target.docker.gpus) : "",
    target.docker?.restart ? envLine(`${prefix}_DOCKER_RESTART`, target.docker.restart) : "",
    target.docker?.network ? envLine(`${prefix}_DOCKER_NETWORK`, target.docker.network) : "",
    target.docker?.command?.length ? envLine(`${prefix}_DOCKER_COMMAND`, target.docker.command.join(",")) : "",
    target.docker?.extraArgs?.length ? envLine(`${prefix}_DOCKER_EXTRA_ARGS`, target.docker.extraArgs.join(",")) : "",
    target.dockerCompose?.projectDirectory ? envLine(`${prefix}_DOCKER_PROJECT_DIRECTORY`, target.dockerCompose.projectDirectory) : "",
    target.dockerCompose?.projectName ? envLine(`${prefix}_DOCKER_PROJECT_NAME`, target.dockerCompose.projectName) : "",
    target.dockerCompose?.composeFile ? envLine(`${prefix}_DOCKER_COMPOSE_FILE`, target.dockerCompose.composeFile) : "",
    target.dockerCompose?.composeFiles?.length ? envLine(`${prefix}_DOCKER_COMPOSE_FILES`, target.dockerCompose.composeFiles.join(",")) : "",
    target.dockerCompose?.profiles?.length ? envLine(`${prefix}_DOCKER_PROFILES`, target.dockerCompose.profiles.join(",")) : "",
    target.dockerCompose?.serviceName ? envLine(`${prefix}_DOCKER_SERVICE_NAME`, target.dockerCompose.serviceName) : "",
    target.litellm?.backendName ? envLine(`${prefix}_LITELLM_BACKEND_NAME`, target.litellm.backendName) : "",
    target.litellm?.apiBaseUrl ? envLine(`${prefix}_LITELLM_API_BASE_URL`, target.litellm.apiBaseUrl) : ""
  ].filter(Boolean);
  if (target.models?.length || target.modelDiscovery || target.modelWarmup || target.docker?.environment) {
    lines.push(`# Some fields are only represented in JSON: ${JSON.stringify(stripUndefined({ models: target.models, modelDiscovery: target.modelDiscovery, modelWarmup: target.modelWarmup, dockerEnvironment: target.docker?.environment }))}`);
  }
  return lines.join("\n");
}

export function providerAdminPage(user: AuthenticatedUser, providers: ProviderView[], targets: TargetView[] = [], runtimeProfiles: RuntimeProfile[] = [], error = ""): string {
  const rows = providers.length
    ? providers.map((provider) => providerRow(provider, targets)).join("")
    : `<p class="muted">No providers configured</p>`;
  return layout("NeurOn Providers", user, `<section class="panel">
    <div class="target-status-head"><h1>Providers</h1><button type="button" data-open-modal="provider-modal">Add provider</button></div>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <div class="summary-list">${rows}</div>
  </section>
  <div id="provider-modal" class="modal" hidden>
    <div class="modal-dialog">
    <div class="target-status-head"><h2>Add provider</h2><button class="secondary" type="button" data-close-modal>Close</button></div>
    <form method="post" action="/admin/providers">
      <p><label>Type<br>${providerTypeSelect()}</label></p>
      <div class="field-grid">
        <p><label>ID<br><input name="id" type="text" placeholder="runpod-main" required></label></p>
        <p><label>Display name<br><input name="displayName" type="text" placeholder="RunPod Main"></label></p>
      </div>
      <p><label><input name="provisioningEnabled" type="checkbox"> Allow this provider to provision resources</label></p>
      <p id="provider-type-note" class="muted"></p>
      <div class="actions"><button type="submit">Add provider</button></div>
    </form>
    </div>
  </div>
  ${createTargetFromProviderModal(providers, runtimeProfiles)}
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
    document.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-open-modal]');
      if (opener) {
        const modal = document.getElementById(opener.dataset.openModal);
        modal.hidden = false;
        if (opener.dataset.providerId) {
          modal.querySelector('select[name="providerId"]').value = opener.dataset.providerId;
          modal.querySelector('select[name="providerId"]').dispatchEvent(new Event('change'));
        }
      }
      if (event.target.closest('[data-close-modal]')) event.target.closest('.modal').hidden = true;
      if (event.target.classList?.contains('modal')) event.target.hidden = true;
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      const group = tab.closest('[data-tabs]');
      group.querySelectorAll('[data-tab]').forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === tab)));
      group.querySelectorAll('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== tab.dataset.tab; });
    });
    const type = document.querySelector('#provider-modal select[name="type"]');
    const note = document.querySelector('#provider-type-note');
    const notes = {
      runpod: 'RunPod account access will come from the runtime environment or a future credentials record.',
      neuron: 'External NeurOn providers will need a NeurOn API key once credentials are modeled.',
      'aws-ecs-asg': 'AWS uses the NeurOn runtime role for ordinary lifecycle operations.',
      docker: 'Docker providers use the local Docker daemon available to NeurOn.',
      'docker-compose': 'Docker Compose providers use target-level project and service settings.'
    };
    const sync = () => { note.textContent = notes[type.value] ?? ''; };
    type?.addEventListener('change', sync);
    sync();
    const targetProviders = ${safeJson(Object.fromEntries(providers.map((provider) => [provider.id, provider.type])))};
    const runtimeProfiles = ${safeJson(Object.fromEntries(runtimeProfiles.map((profile) => [profile.id, profile])))};
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const targetProvider = document.querySelector('#provider-target-modal select[name="providerId"]');
    const runtimeProfile = document.querySelector('#provider-target-modal select[name="runtimeProfileId"]');
    const runtimeProfileVariant = document.querySelector('#provider-target-modal select[name="runtimeProfileVariantId"]');
    const runpodTarget = document.querySelector('#provider-target-modal [data-provider-fields="runpod"]');
    const dockerTarget = document.querySelector('#provider-target-modal [data-provider-fields="docker"]');
    const awsTarget = document.querySelector('#provider-target-modal [data-provider-fields="aws"]');
    const neuronTarget = document.querySelector('#provider-target-modal [data-provider-fields="neuron"]');
    const runtimeNote = document.querySelector('#runtime-profile-note');
    const dockerModelVolumeInput = document.querySelector('#provider-target-modal input[name="dockerModelVolume"]');
    dockerModelVolumeInput?.addEventListener('input', () => { dockerModelVolumeInput.dataset.touched = 'true'; });
    const selectedTargetProfile = () => runtimeProfiles[runtimeProfile.value];
    const selectedTargetVariant = () => {
      const profile = selectedTargetProfile();
      return profile?.variants?.find(variant => variant.id === runtimeProfileVariant?.value);
    };
    const effectiveTargetProfile = () => {
      const profile = selectedTargetProfile();
      const variant = selectedTargetVariant();
      if (!profile || !variant) return profile;
      return {
        ...profile,
        image: variant.image ?? profile.image,
        port: variant.port ?? profile.port,
        health: variant.health ?? profile.health,
        api: variant.api ?? profile.api,
        volumes: variant.volumes ?? profile.volumes,
        env: { ...(profile.env ?? {}), ...(variant.env ?? {}) },
        discovery: variant.discovery ?? profile.discovery
      };
    };
    const syncTargetVariants = () => {
      if (!runtimeProfileVariant) return;
      const profile = selectedTargetProfile();
      const variants = profile?.variants ?? [];
      runtimeProfileVariant.innerHTML = variants.map(variant => '<option value="' + escapeText(variant.id) + '">' + escapeText(variant.name) + '</option>').join('');
      runtimeProfileVariant.closest('p').hidden = variants.length === 0;
    };
    const syncTargetCreate = () => {
      const targetType = targetProviders[targetProvider.value] ?? '';
      runpodTarget.hidden = targetType !== 'runpod';
      dockerTarget.hidden = targetType !== 'docker';
      awsTarget.hidden = targetType !== 'aws-ecs' && targetType !== 'aws-ecs-asg';
      neuronTarget.hidden = targetType !== 'neuron';
      const profile = effectiveTargetProfile();
      const variant = selectedTargetVariant();
      const port = profile?.port ?? 8080;
      const discovery = profile ? profile.discovery ?? true : false;
      const profileVolumes = Object.entries(profile?.volumes ?? {});
      const modelVolume = profileVolumes[0];
      runtimeNote.textContent = profile ? [profile.type, profile.image, variant ? 'variant ' + variant.name : '', 'port ' + port, modelVolume ? 'volume ' + modelVolume[1] + ' -> ' + modelVolume[0] : '', discovery ? 'discovery on' : 'discovery off'].filter(Boolean).join(' | ') : '';
      if (dockerModelVolumeInput && !dockerModelVolumeInput.dataset.touched) dockerModelVolumeInput.value = modelVolume?.[1] ?? '';
    };
    targetProvider?.addEventListener('change', syncTargetCreate);
    runtimeProfile?.addEventListener('change', () => { syncTargetVariants(); syncTargetCreate(); });
    runtimeProfileVariant?.addEventListener('change', syncTargetCreate);
    syncTargetVariants();
    syncTargetCreate();
  </script>`);
}

function providerRow(provider: ProviderView, targets: TargetView[]): string {
  const declarative = declarativeProviderJson(provider);
  const env = declarativeProviderEnv(provider);
  const providerTargets = targetsForProvider(provider, targets);
  const editAction = provider.editable
    ? providerEditPanel(provider)
    : `<form method="post" action="/admin/providers/${escapeHtml(provider.id)}/copy-to-db"><button class="secondary" type="submit">Copy config provider to DB</button></form>`;
  const deleteAction = provider.editable ? providerDeletePanel(provider) : `<p class="muted">This provider is loaded from declarative config. Remove it from configuration or copy it to the database before deleting it here.</p>`;
  const viewConfig = `<p><strong>Resource creation:</strong> ${provider.provisioning?.enabled ? "enabled" : "disabled"}</p>${provider.config ? `<pre>${escapeHtml(JSON.stringify(provider.config, null, 2))}</pre>` : `<p class="muted">No provider-level config.</p>`}`;
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(provider.displayName)}</strong><div class="muted"><code>${escapeHtml(provider.id)}</code> | ${escapeHtml(provider.type)} | ${providerTargets.length} targets</div></div><span class="badge ${provider.source === "persisted" ? "active" : "done"}">${escapeHtml(provider.source)}</span></summary><div class="drilldown-body" data-tabs><div class="tabbar"><button type="button" data-tab="view" aria-selected="true">View</button><button type="button" data-tab="targets" aria-selected="false">Targets</button><button type="button" data-tab="json" aria-selected="false">JSON</button><button type="button" data-tab="env" aria-selected="false">ENV</button><button type="button" data-tab="edit" aria-selected="false">Edit</button><button type="button" data-tab="delete" aria-selected="false">Delete</button></div><section class="tab-panel" data-tab-panel="view">${viewConfig}</section><section class="tab-panel" data-tab-panel="targets" hidden>${providerTargetsPanel(provider, providerTargets)}</section><section class="tab-panel" data-tab-panel="json" hidden><div class="inline-actions"><button type="button" data-copy="${escapeHtml(declarative)}">Copy JSON</button></div><pre>${escapeHtml(declarative)}</pre></section><section class="tab-panel" data-tab-panel="env" hidden><div class="inline-actions"><button type="button" data-copy="${escapeHtml(env)}">Copy ENV</button></div><pre>${escapeHtml(env)}</pre></section><section class="tab-panel" data-tab-panel="edit" hidden><p class="muted">${provider.editable ? "This provider is stored in the database." : "This provider is loaded from declarative config."}</p>${editAction}</section><section class="tab-panel" data-tab-panel="delete" hidden>${deleteAction}</section></div></details>`;
}

function providerEditPanel(provider: ProviderView): string {
  return `<form method="post" action="/admin/providers/${escapeHtml(provider.id)}/update">
    <p><label>Type<br>${providerTypeSelect(provider.type)}</label></p>
    <div class="field-grid">
      <p><label>ID<br><input name="id" type="text" value="${escapeHtml(provider.id)}" required></label></p>
      <p><label>Display name<br><input name="displayName" type="text" value="${escapeHtml(provider.displayName)}"></label></p>
    </div>
    <p><label><input name="provisioningEnabled" type="checkbox" ${provider.provisioning?.enabled ? "checked" : ""}> Allow this provider to provision resources</label></p>
    <div class="actions"><button type="submit">Save provider</button></div>
  </form>`;
}

function providerDeletePanel(provider: ProviderView): string {
  return `<p class="muted">Type <code>${escapeHtml(provider.id)}</code> to delete this provider.</p>
  <form method="post" action="/admin/providers/${escapeHtml(provider.id)}/delete">
    <p><label>Provider ID<br><input name="confirmName" type="text" autocomplete="off" required></label></p>
    <button class="danger" type="submit">Delete provider</button>
  </form>`;
}

function targetsForProvider(provider: ProviderView, targets: TargetView[]): TargetView[] {
  return targets.filter((target) => (target.providerId ?? target.provider) === provider.id || (!target.providerId && target.provider === provider.type));
}

function providerTargetsPanel(provider: ProviderView, targets: TargetView[]): string {
  const list = targets.length === 0 ? `<p class="muted">No targets use this provider.</p>` : `<div class="summary-list">${targets.map(providerTargetRow).join("")}</div>`;
  return `<div class="target-status-head"><h3>Targets</h3><button type="button" data-open-modal="provider-target-modal" data-provider-id="${escapeHtml(provider.id)}">Create target</button></div>${list}`;
}

function providerTargetRow(target: TargetView): string {
  const modelHint = target.modelIds.length > 0 ? `${target.modelIds.length} configured models` : "Discovery";
  return `<div class="target-status-card"><div class="target-status-head"><div><strong>${escapeHtml(target.displayName)}</strong><div class="target-status-meta"><span class="pill off">${escapeHtml(target.provider)}</span><span class="muted"><code>${escapeHtml(target.id)}</code></span><span class="muted">${escapeHtml(modelHint)}</span></div></div><span class="badge ${target.source === "persisted" ? "active" : "done"}">${escapeHtml(target.source)}</span></div></div>`;
}

function createTargetFromProviderModal(providers: ProviderView[], runtimeProfiles: RuntimeProfile[]): string {
  return `<div id="provider-target-modal" class="modal" hidden>
    <div class="modal-dialog">
      <div class="target-status-head"><h2>Create target</h2><button class="secondary" type="button" data-close-modal>Close</button></div>
      <form method="post" action="/admin/targets">
        <p><label>Provider<br>${targetProviderSelect(providers)}</label></p>
        <p><label>Profile<br>${runtimeProfileSelect(runtimeProfiles)}</label></p>
        <p><label>Variant<br><select name="runtimeProfileVariantId"></select></label></p>
        <p id="runtime-profile-note" class="muted"></p>
        <div class="field-grid">
          <p><label>ID<br><input name="id" type="text" placeholder="target-id" required></label></p>
          <p><label>Display name<br><input name="displayName" type="text" placeholder="Target name"></label></p>
        </div>
        <div data-provider-fields="runpod">
          <p><label>RunPod Pod ID<br><input name="runpodPodId" type="text" placeholder="leave empty to provision a new Pod"></label></p>
          <p><label>RunPod runtime port<br><input name="runpodRuntimePort" type="number" min="1" placeholder="8080"></label></p>
        </div>
        <div data-provider-fields="docker">
          <p><label>Docker container name<br><input name="dockerContainerName" type="text" placeholder="prefer"></label></p>
          <p><label>Model volume<br><input name="dockerModelVolume" type="text" placeholder="prefer-model-cache"></label></p>
          <p class="muted">The profile supplies the container path.</p>
        </div>
        <div data-provider-fields="aws">
          <p><label>AWS cluster<br><input name="awsCluster" type="text" placeholder="llm-cluster"></label></p>
          <p><label>AWS service<br><input name="awsService" type="text" placeholder="llama-cpp-gpu-pool"></label></p>
          <p><label>AWS ASG name<br><input name="awsAsgName" type="text" placeholder="llm-gpu-pool-asg"></label></p>
        </div>
        <div data-provider-fields="neuron">
          <p><label>Remote NeurOn target ID<br><input name="neuronTargetId" type="text" placeholder="gpu-pool-west"></label></p>
          <p class="muted">Later we can populate this from the remote NeurOn API.</p>
        </div>
        <details>
          <summary>Overrides</summary>
          <p><label>API URL override<br><input name="apiUrl" type="text" placeholder="http://runtime.internal:8080/v1"></label></p>
          <p><label>Health URL override<br><input name="healthUrl" type="text" placeholder="http://runtime.internal:8080/health"></label></p>
          <p><label>Configured model IDs<br><input name="modelIds" type="text" placeholder="qwen-3.6,gemma-4"></label></p>
          <p class="muted">Leave models empty to use runtime discovery.</p>
        </details>
        <div class="actions"><button type="submit">Create target</button></div>
      </form>
    </div>
  </div>`;
}

function runtimeProfileSelect(runtimeProfiles: RuntimeProfile[], selected = ""): string {
  const options = runtimeProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}" ${profile.id === selected ? "selected" : ""}>${escapeHtml(profile.name)}</option>`).join("");
  return `<select name="runtimeProfileId">${options}</select>`;
}

function providerTypeSelect(selected = "runpod"): string {
  const types = ["runpod", "aws-ecs-asg", "docker", "docker-compose", "neuron"];
  return `<select name="type">${types.map((type) => `<option value="${escapeHtml(type)}" ${type === selected ? "selected" : ""}>${escapeHtml(type)}</option>`).join("")}</select>`;
}

function declarativeProviderJson(provider: ProviderView): string {
  return JSON.stringify(stripUndefined({
    id: provider.id,
    displayName: provider.displayName,
    type: provider.type,
    provisioning: provider.provisioning,
    config: provider.config,
    credentialId: provider.credentialId
  }), null, 2);
}

function declarativeProviderEnv(provider: ProviderView): string {
  const json = envLine("CAPACITY_PROVIDERS_JSON", JSON.stringify([stripUndefined({
    id: provider.id,
    displayName: provider.displayName,
    type: provider.type,
    provisioning: provider.provisioning,
    config: provider.config,
    credentialId: provider.credentialId
  })]));
  const key = envKey(provider.id);
  const prefix = `CAPACITY_PROVIDER_${key}`;
  const lines = [
    "# JSON form",
    json,
    "",
    "# Expanded form",
    envLine("CAPACITY_PROVIDER_KEYS", key),
    envLine(`${prefix}_ID`, provider.id),
    provider.displayName && provider.displayName !== provider.id ? envLine(`${prefix}_DISPLAY_NAME`, provider.displayName) : `# ${prefix}_DISPLAY_NAME=${envValue(provider.displayName)}`,
    envLine(`${prefix}_TYPE`, provider.type),
    provider.provisioning?.enabled ? envLine(`${prefix}_PROVISIONING_ENABLED`, "true") : `# ${prefix}_PROVISIONING_ENABLED=false`,
    provider.credentialId ? envLine(`${prefix}_CREDENTIAL_ID`, provider.credentialId) : "",
    provider.config?.runpod && typeof provider.config.runpod === "object" && "apiKeyEnv" in provider.config.runpod ? envLine(`${prefix}_RUNPOD_API_KEY_ENV`, String(provider.config.runpod.apiKeyEnv)) : "",
    provider.config?.runpod && typeof provider.config.runpod === "object" && "apiBaseUrl" in provider.config.runpod ? envLine(`${prefix}_RUNPOD_API_BASE_URL`, String(provider.config.runpod.apiBaseUrl)) : "",
    provider.config?.neuron && typeof provider.config.neuron === "object" && "apiBaseUrl" in provider.config.neuron ? envLine(`${prefix}_NEURON_API_BASE_URL`, String(provider.config.neuron.apiBaseUrl)) : "",
    provider.config?.neuron && typeof provider.config.neuron === "object" && "apiKeyEnv" in provider.config.neuron ? envLine(`${prefix}_NEURON_API_KEY_ENV`, String(provider.config.neuron.apiKeyEnv)) : ""
  ].filter((line) => line !== "");
  return lines.join("\n");
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function envKey(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function envLine(name: string, value: string): string {
  return `${name}=${envValue(value)}`;
}

function envValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
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
