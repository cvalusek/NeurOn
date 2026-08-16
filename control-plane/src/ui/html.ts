import type { ApiKey, AppConfig, AssistantConfig, AuthMethod, AuthenticatedUser, CapacityTarget, ModelDefinition, ModelSelectionCatalogConfig, Reservation, ReservationProfile, RuntimeProfile, TargetStatus } from "../domain/types.js";
import { DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN } from "../capacity/AwsEc2CapacityProvider.js";
import type { AuthMethodView } from "../services/AuthMethodService.js";
import type { ProviderView } from "../services/ProviderService.js";
import type { TargetView } from "../services/TargetService.js";
import { litellmAliases, litellmRoutePrefixes } from "../litellm/modelRouting.js";
import type { ShutdownStatus } from "../services/ShutdownCoordinator.js";
import { safeGithubRepositoryUrl, type UpdateStatus } from "../services/UpdateChecker.js";
import type { ModelDeploymentSelectionView } from "../services/ModelSelectionService.js";

export interface HassleOffSafetyView {
  configured: boolean;
  baseUrl?: string;
  reachable: boolean;
  healthy?: boolean;
  ready?: boolean;
  armed?: boolean;
  registrationIssues: string[];
  diagnostic?: string;
  lastSuccessfulFailSafeTestAt?: string;
  lastSuccessfulFailSafeTestAuditEventId?: number;
  failSafeTestTarget: {
    targetId: string;
    registered: boolean;
    eligible: boolean;
    actionType?: string;
    testOnly?: boolean;
    armed?: boolean;
  };
  targets: Array<{
    id: string;
    displayName: string;
    protected: boolean;
    leaseDurationSeconds?: number;
    registered: boolean;
    registrationActionType?: string;
    registrationTestOnly?: boolean;
    registrationArmed?: boolean;
  }>;
  csrfToken?: string;
  success?: string;
  error?: string;
}

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
    .topbar { max-width: 1180px; margin: 0 auto; padding: 12px 24px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; }
    .brand { color: white; text-decoration: none; font-weight: 800; }
    .nav-link { color: white; text-decoration: none; border-radius: 6px; padding: 7px 9px; font-weight: 650; }
    .nav-link:hover, .nav-link:focus-visible { background: rgba(255, 255, 255, 0.12); outline: none; }
    .topbar .user { justify-self: end; color: #d8ddd7; font-size: 13px; }
    .menu-button { display: inline-grid; place-items: center; width: 38px; height: 38px; background: #334155; padding: 0; justify-self: start; }
    .hamburger { position: relative; display: block; width: 18px; height: 2px; border-radius: 999px; background: currentColor; }
    .hamburger::before, .hamburger::after { content: ""; position: absolute; left: 0; width: 18px; height: 2px; border-radius: 999px; background: currentColor; }
    .hamburger::before { top: -6px; }
    .hamburger::after { top: 6px; }
    .drawer-scrim { position: fixed; inset: 0; background: rgba(23, 32, 42, 0.45); border: 0; border-radius: 0; padding: 0; z-index: 20; opacity: 0; visibility: hidden; pointer-events: none; }
    .nav-drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 21; width: min(320px, calc(100vw - 48px)); background: white; color: #1f2933; border-left: 1px solid #d8ddd7; box-shadow: -16px 0 48px rgba(23, 32, 42, 0.22); padding: 18px; overflow: auto; transform: translateX(calc(100% + 24px)); visibility: hidden; pointer-events: none; will-change: transform; }
    body.nav-ready .drawer-scrim { transition: opacity 180ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 220ms; }
    body.nav-ready .nav-drawer { transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1), visibility 0s linear 260ms; }
    body.drawer-open .drawer-scrim { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: 0s; }
    body.drawer-open .nav-drawer { transform: translateX(0); visibility: visible; pointer-events: auto; transition-delay: 0s; }
    .drawer-head { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    .drawer-nav { display: grid; gap: 8px; }
    .drawer-tree { border: 1px solid #e2e7e1; border-radius: 8px; background: #fbfcfb; overflow: hidden; }
    .drawer-tree summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; color: #334155; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; cursor: pointer; list-style: none; }
    .drawer-tree summary::-webkit-details-marker { display: none; }
    .drawer-tree summary::before { content: ">"; color: #657266; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; transition: transform 120ms ease; }
    .drawer-tree[open] summary::before { transform: rotate(90deg); }
    .drawer-tree summary:hover, .drawer-tree summary:focus-visible { background: #eef2f0; outline: none; }
    .drawer-branch { display: grid; gap: 2px; padding: 0 8px 8px 28px; }
    .drawer-branch a, .drawer-action { display: block; width: 100%; color: #1f2933; text-align: left; text-decoration: none; border: 0; border-radius: 6px; padding: 8px 10px; background: transparent; font: inherit; font-weight: 700; }
    .drawer-branch a:hover, .drawer-branch a:focus-visible, .drawer-action:hover, .drawer-action:focus-visible { background: #eef2f0; outline: none; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    a { color: #0f766e; } form { margin: 0; }
    .panel { background: white; border: 1px solid #d8ddd7; border-radius: 8px; padding: 18px; margin-bottom: 16px; }
    .home-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); gap: 16px; align-items: start; }
    .home-grid .panel { margin-bottom: 0; }
    .profile-strip { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 10px; align-items: end; margin-bottom: 14px; }
    .profile-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .profile-actions.below { margin-top: 10px; justify-content: flex-end; }
    .profile-picker { position: relative; }
    .profile-picker summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 1px solid #aab4ad; border-radius: 8px; padding: 12px; background: #fbfcfb; cursor: pointer; list-style: none; }
    .profile-picker summary::-webkit-details-marker { display: none; }
    .profile-picker summary::after { content: "Change"; color: #0f766e; font-weight: 800; }
    .profile-picker[open] summary::after { content: "Close"; }
    .profile-menu { display: grid; gap: 8px; margin-top: 8px; border: 1px solid #d8ddd7; border-radius: 8px; background: white; padding: 8px; box-shadow: 0 14px 32px rgba(23, 32, 42, 0.16); }
    .profile-card-button { display: block; width: 100%; text-align: left; border: 1px solid #d8ddd7; border-radius: 8px; padding: 12px; background: #fbfcfb; color: #1f2933; }
    .profile-card-button[aria-pressed="true"] { border-color: #0f766e; background: #e7f5f2; box-shadow: inset 0 0 0 1px #0f766e; }
    .profile-card-title { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; }
    .quick-start { display: grid; gap: 14px; }
    .reserve-bar { position: sticky; bottom: 10px; z-index: 4; display: flex; gap: 12px; justify-content: space-between; align-items: center; border: 1px solid #86b8ad; border-radius: 8px; background: rgba(240, 250, 247, 0.97); padding: 12px; box-shadow: 0 8px 24px rgba(23, 32, 42, 0.14); }
    .reserve-bar .start-cost { border: 0; background: transparent; padding: 0; margin: 0; }
    .keepalive-control { padding-bottom: 82px; }
    .compact-summary { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
    .status-details { margin-top: 10px; }
    .status-details summary { cursor: pointer; color: #334155; font-weight: 700; }
    .models, .targets { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 14px 0; }
    .family { margin-top: 14px; }
    .family h3 { margin: 0 0 8px; font-size: 15px; }
    .model-group[hidden] { display: none; }
    label.option { position: relative; display: flex; gap: 10px; align-items: start; border: 1px solid #d8ddd7; border-radius: 6px; padding: 10px; background: #fbfcfb; cursor: pointer; }
    label.option:has(input:checked), button.choice[aria-pressed="true"] { border-color: #0f766e; background: #e7f5f2; box-shadow: inset 0 0 0 1px #0f766e; }
    label.option input { position: absolute; opacity: 0; pointer-events: none; }
    .model-body { min-width: 0; width: 100%; }
    .model-head { display: flex; justify-content: space-between; gap: 8px; align-items: start; }
    .favorite-button { background: transparent; color: #a16207; border: 0; padding: 2px 5px; font-size: 22px; line-height: 1; vertical-align: middle; }
    .favorite-button[aria-pressed="true"] { color: #ca8a04; }
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
    .profile-target-selections { display: grid; gap: 12px; }
    .profile-target-selection:not(.selected) [data-profile-target-models] { opacity: 0.55; }
    .modal-dialog.profile-builder-dialog { width: min(1180px, 100%); }
    .profile-builder-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
    .profile-guide { border: 1px solid #c7d9d3; border-radius: 8px; background: #f5fbf9; padding: 14px; margin: 14px 0; }
    .profile-guide h3 { margin-top: 0; }
    .profile-guide-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; flex-wrap: wrap; }
    .profile-guide-mode { display: flex; gap: 7px; flex-wrap: wrap; }
    .profile-guide-mode button.secondary { border: 1px solid #86b8ad; background: white; color: #0f5f59; }
    .profile-guide-mode button[aria-pressed="true"] { border-color: #0f766e; background: #0f766e; color: white; }
    .profile-guide-mode .wizard-callout[aria-pressed="false"] { border-color: #d6a742; background: #fff8df; color: #6b4f00; box-shadow: 0 0 0 2px rgba(214,167,66,.12); }
    .selection-filter-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .profile-browser-grid { display: grid; grid-template-columns: minmax(220px, 2fr) minmax(180px, 1fr); gap: 10px; margin-top: 14px; }
    .profile-browser-grid input, .profile-browser-grid select { width: 100%; }
    .profile-wizard[hidden] { display: none; }
    .preference-grid { display: grid; grid-template-columns: minmax(220px, 360px) minmax(220px, 1fr); gap: 16px; align-items: center; margin-top: 14px; }
    .preference-triangle { width: 100%; height: auto; touch-action: none; cursor: crosshair; }
    .preference-triangle polygon { fill: #e7f5f2; stroke: #5a9488; stroke-width: 2; }
    .preference-triangle .triangle-snap { fill: #a7cdc5; stroke: #f5fbf9; stroke-width: 2; }
    .preference-triangle #profile-preference-point { fill: #0f766e; stroke: white; stroke-width: 3; filter: drop-shadow(0 2px 3px rgba(23, 32, 42, 0.25)); }
    .triangle-leaders { display: grid; gap: 10px; }
    .category-leader { border: 1px solid #d8ddd7; border-radius: 8px; padding: 10px; background: #fbfcfb; }
    .category-leader strong, .category-leader span { display: block; }
    .requirement-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .requirement-tags label { display: inline-flex; gap: 6px; align-items: center; border: 1px solid #aab4ad; border-radius: 999px; padding: 7px 10px; background: #fbfcfb; cursor: pointer; }
    .requirement-tags label:has(input:checked) { border-color: #0f766e; background: #e7f5f2; }
    .context-slider { width: min(100%, 360px); }
    button.choice.duration-too-short { border-color: #c75b50; background: #fff0ee; color: #7a271a; }
    button.choice.duration-long { border-color: #d6a742; background: #fff8df; color: #6b4f00; }
    .recommendation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-top: 12px; }
    .recommendation-card { display: grid; gap: 5px; text-align: left; border: 1px solid #86b8ad; background: white; color: #1f2933; }
    .recommendation-card strong { color: #0f766e; }
    .assistant-toggle { position: fixed; right: 18px; bottom: 18px; z-index: 25; border-radius: 999px; box-shadow: 0 8px 24px rgba(23, 32, 42, 0.24); }
    .assistant-drawer { position: fixed; right: 18px; bottom: 70px; z-index: 25; width: min(560px, calc(100vw - 36px)); height: min(760px, calc(100vh - 100px)); display: grid; grid-template-rows: auto minmax(280px, 1fr) auto; border: 1px solid #aab4ad; border-radius: 12px; background: white; box-shadow: 0 18px 54px rgba(23, 32, 42, 0.28); overflow: hidden; }
    .assistant-drawer[hidden] { display: none; }
    .assistant-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 13px 14px; background: #17202a; color: white; }
    .assistant-head button { padding: 5px 9px; background: #334155; }
    .assistant-head-actions { display: flex; gap: 6px; }
    .assistant-messages { display: grid; align-content: start; gap: 9px; padding: 12px; overflow: auto; background: #f7f8f6; }
    .assistant-message { border: 1px solid #d8ddd7; border-radius: 8px; padding: 9px 10px; background: white; white-space: pre-wrap; }
    .assistant-message.user { margin-left: 34px; background: #e7f5f2; border-color: #86b8ad; }
    .assistant-message.system { display: flex; align-items: center; gap: 9px; margin-right: 34px; background: #f0f7ff; border-color: #93b8dc; color: #244a6a; }
    .assistant-message.error { background: #fff1f0; border-color: #d99a96; color: #7a2e2a; }
    .assistant-spinner { width: 16px; height: 16px; flex: 0 0 auto; border: 2px solid #b9ccdf; border-top-color: #0f766e; border-radius: 50%; animation: assistant-spin .8s linear infinite; }
    .assistant-guided-target { position: relative; z-index: 30; animation: assistant-guide-pulse .45s ease-in-out 4 alternate; }
    .assistant-guide-arrow { display: inline-block; margin-right: 5px; color: #d97706; font-size: 18px; font-weight: 900; }
    .assistant-confirm { display: grid; gap: 8px; border: 1px solid #d6a742; border-radius: 8px; padding: 10px; background: #fff8df; }
    .assistant-compose { display: grid; gap: 8px; padding: 12px; border-top: 1px solid #d8ddd7; background: white; }
    .assistant-compose textarea { width: 100%; min-height: 104px; font-family: inherit; }
    .assistant-compose-hint { font-size: 11px; color: #6b7280; }
    @keyframes assistant-spin { to { transform: rotate(360deg); } }
    @keyframes assistant-guide-pulse { from { box-shadow: 0 0 0 2px rgba(217,119,6,.25); background-color: #fff8df; } to { box-shadow: 0 0 0 8px rgba(217,119,6,.08); background-color: #ffe8a3; } }
    .target-price { border-radius: 6px; padding: 5px 8px; background: #17202a; color: white; font-weight: 800; white-space: nowrap; }
    .model-metrics { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .metric { border-radius: 5px; padding: 3px 6px; background: #eef2f0; color: #334155; font-size: 11px; font-weight: 750; }
    .option.does-not-match { border-style: dashed; opacity: 0.72; }
    .filter-status { margin-top: 8px; }
    .profile-target-toggle { display: flex; gap: 10px; align-items: start; cursor: pointer; }
    .profile-target-toggle > span { display: grid; gap: 2px; }
    .target-status-head, .reservation-card { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .target-status-meta, .reservation-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .reservation-list { display: grid; gap: 8px; margin-top: 12px; }
    .reservation-card { border-top: 1px solid #e2e7e1; padding-top: 10px; }
    .reservation-card.compact { align-items: center; }
    .reservation-cost { margin-top: 4px; color: #334155; font-size: 13px; }
    .reservation-cost strong { color: #1f2933; }
    .start-cost { border: 1px solid #d8ddd7; border-radius: 6px; background: #fbfcfb; padding: 10px; margin-top: 14px; }
    .reservation-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    input[type="number"], input[type="text"], input[type="password"], select, textarea { padding: 8px; border: 1px solid #aab4ad; border-radius: 6px; min-width: 140px; max-width: 100%; }
    textarea { width: min(100%, 720px); min-height: 92px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    button, a.button { border: 0; border-radius: 6px; padding: 9px 13px; background: #0f766e; color: white; font-weight: 650; cursor: pointer; font: inherit; font-weight: 650; }
    a.button { display: inline-block; text-decoration: none; }
    button.choice { border: 1px solid #aab4ad; background: #fbfcfb; color: #1f2933; }
    button.secondary, a.button.secondary { background: #334155; }
    button.danger { background: #b42318; }
    button.large { font-size: 18px; padding: 14px 18px; }
    .badge { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 700; background: #e7ebe6; color: #334155; }
    .badge.active { background: #dff7ed; color: #05603a; }
    .badge.done { background: #e8edf3; color: #334155; }
    .badge.expired, .badge.failed { background: #fee4e2; color: #912018; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d8ddd7; }
    th, td { text-align: left; padding: 9px; border-bottom: 1px solid #e7ebe6; vertical-align: top; }
    .muted { color: #657266; } .status { font-weight: 700; } .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .help-tip { position: relative; display: inline-grid; place-items: center; width: 19px; height: 19px; margin-left: 5px; border: 1px solid #829087; border-radius: 999px; color: #475569; background: white; font-size: 12px; font-weight: 800; cursor: help; vertical-align: middle; }
    .help-tip::after { content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 8px); z-index: 30; width: min(280px, 75vw); padding: 9px 10px; border-radius: 6px; background: #17202a; color: white; font-size: 12px; font-weight: 500; line-height: 1.35; box-shadow: 0 6px 20px rgba(23, 32, 42, 0.25); opacity: 0; visibility: hidden; transform: translate(-50%, 4px); transition: 100ms ease; pointer-events: none; }
    .help-tip:hover::after, .help-tip:focus-visible::after { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
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
    .modal { position: fixed; inset: 0; background: rgba(23, 32, 42, 0.45); display: grid; place-items: center; padding: 20px; z-index: 30; }
    .modal-dialog { width: min(720px, 100%); max-height: calc(100vh - 40px); overflow: auto; background: white; border-radius: 8px; border: 1px solid #d8ddd7; padding: 18px; box-shadow: 0 16px 48px rgba(23, 32, 42, 0.22); }
    .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .hidden { display: none; }
    .system-banner { margin: 14px 24px 0; border: 1px solid #d6a756; border-radius: 8px; background: #fff4d6; color: #65400b; padding: 10px 14px; font-weight: 700; }
    .system-banner a { margin-left: 8px; }
    @media (min-width: 1024px) {
      .topbar { max-width: none; }
      .nav-drawer { top: 62px; left: 0; right: auto; width: 260px; border-left: 0; border-right: 1px solid #d8ddd7; box-shadow: none; padding: 14px; transform: translateX(calc(-100% - 1px)); }
      .drawer-scrim, body.drawer-open .drawer-scrim { opacity: 0; visibility: hidden; pointer-events: none; }
      main { max-width: none; margin: 0; }
      body.nav-ready main, body.nav-ready .system-banner { transition: margin-left 260ms cubic-bezier(0.22, 1, 0.36, 1); }
      body.drawer-open main { margin-left: 288px; }
      body.drawer-open .system-banner { margin-left: 312px; }
    }
    @media (max-width: 820px) {
      .home-grid { grid-template-columns: 1fr; }
      .profile-strip { grid-template-columns: 1fr; }
      .topbar { grid-template-columns: auto 1fr; gap: 12px; }
      .topbar .user { display: none; }
      .profile-builder-layout, .preference-grid, .profile-browser-grid { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      body.nav-ready .drawer-scrim, body.nav-ready .nav-drawer, body.nav-ready main, body.nav-ready .system-banner { transition: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <button class="menu-button" type="button" data-nav-toggle aria-label="Open menu" aria-controls="nav-drawer" aria-expanded="false"><span class="hamburger" aria-hidden="true"></span></button>
      <a class="brand" href="/">NeurOn</a>
      <span class="user">${user ? escapeHtml(user.username) : ""}</span>
    </div>
</header>
  <div id="system-banner" class="system-banner" hidden></div>
  <button class="drawer-scrim" type="button" data-nav-close aria-label="Close menu" tabindex="-1"></button>
  <aside id="nav-drawer" class="nav-drawer" aria-hidden="true">
    <div class="drawer-head"><strong>NeurOn</strong></div>
    <nav class="drawer-nav" aria-label="Side navigation">
      <details class="drawer-tree" open>
        <summary>Workspace</summary>
        <div class="drawer-branch">
          <a href="/">Home</a>
          <a href="/profiles">Profiles</a>
          <a href="/help">Guide</a>
          <a href="/client-setup">Client setup</a>
          <a href="/api-keys">API keys</a>
          ${user ? `<form method="post" action="/logout"><button class="drawer-action" type="submit">Sign out</button></form>` : ""}
        </div>
      </details>
      ${user?.isAdmin ? `<details class="drawer-tree" open>
        <summary>Admin</summary>
        <div class="drawer-branch">
          <a href="/admin/auth">Authentication</a>
          <a href="/admin/hassleoff">HassleOff safety</a>
          <a href="/admin/updates">Updates</a>
        </div>
      </details>
      <details class="drawer-tree" open>
        <summary>Configuration</summary>
        <div class="drawer-branch">
          <a href="/admin/auth">Auth</a>
          <a href="/admin/providers">Providers</a>
          <a href="/admin/targets">Targets</a>
          <a href="/admin/models">Model data</a>
          <a href="/admin/assistant">Assistant</a>
        </div>
      </details>
      <details class="drawer-tree">
        <summary>History</summary>
        <div class="drawer-branch">
          <a href="/admin/reservations">Reservations</a>
          <a href="/admin/activations">Activations</a>
          <a href="/admin/usage">Usage</a>
        </div>
      </details>` : ""}
    </nav>
  </aside>
  <main>${body}</main>
  ${user ? `<button class="assistant-toggle" type="button" data-assistant-toggle aria-controls="profile-assistant" aria-expanded="false">Ask NeurOn</button>
  <aside id="profile-assistant" class="assistant-drawer" hidden aria-label="NeurOn assistant">
    <div class="assistant-head"><strong>NeurOn assistant</strong><span class="assistant-head-actions"><button type="button" data-assistant-clear aria-label="Clear assistant chat">Clear</button><button type="button" data-assistant-collapse aria-label="Collapse assistant">Collapse</button></span></div>
    <div class="assistant-messages" data-assistant-messages></div>
    <form class="assistant-compose" data-assistant-form><textarea maxlength="2000" placeholder="Ask about this screen, configure a profile, or manage a reservation."></textarea><span class="assistant-compose-hint">Enter to send · Shift+Enter for a new line</span><button type="submit">Send</button><span class="muted" data-assistant-status></span></form>
  </aside>` : ""}
  <script>
    (() => {
      const drawer = document.querySelector('#nav-drawer');
      const scrim = document.querySelector('[data-nav-close].drawer-scrim');
      const toggle = document.querySelector('[data-nav-toggle]');
      const desktopQuery = window.matchMedia('(min-width: 1024px)');
      const setOpen = (open) => {
        document.body.classList.toggle('drawer-open', open);
        drawer?.setAttribute('aria-hidden', String(!open));
        if (scrim) scrim.tabIndex = open && !desktopQuery.matches ? 0 : -1;
        toggle?.setAttribute('aria-expanded', String(open));
        toggle?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      };
      setOpen(desktopQuery.matches);
      requestAnimationFrame(() => document.body.classList.add('nav-ready'));
      toggle?.addEventListener('click', () => setOpen(!document.body.classList.contains('drawer-open')));
      document.querySelectorAll('[data-nav-close]').forEach((button) => button.addEventListener('click', () => setOpen(false)));
      desktopQuery.addEventListener('change', (event) => setOpen(event.matches));
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setOpen(false);
      });
    })();
    ${user?.isAdmin ? `(() => {
      const banner = document.querySelector('#system-banner');
      const refresh = async () => {
        try {
          const response = await fetch('/api/admin/update-status');
          if (!response.ok) return;
          const data = await response.json();
          const draining = data.shutdown.mode !== 'idle';
          if (!data.update.updateAvailable && !draining) { banner.hidden = true; return; }
          banner.textContent = draining ? data.shutdown.message : 'A newer NeurOn image is available.';
          const link = document.createElement('a');
          link.href = '/admin/updates';
          link.textContent = draining ? 'View restart status' : 'Review update';
          banner.appendChild(link);
          banner.hidden = false;
          if (draining) setTimeout(refresh, 2000);
        } catch {}
      };
      refresh();
      setInterval(refresh, 300000);
    })();` : ""}
    ${user ? assistantClientScript(user.username) : ""}
  </script>
</body>
</html>`;
}

function assistantClientScript(username: string): string {
  const usernameJson = JSON.stringify(username).replace(/</gu, "\\u003c");
  return `(() => {
      const namespace = ${usernameJson};
      const chatKey = 'neuron-assistant-chat:' + namespace;
      const requestKey = 'neuron-assistant-request:' + namespace;
      const actionKey = 'neuron-assistant-action:' + namespace;
      const drawer = document.querySelector('#profile-assistant');
      const toggle = document.querySelector('[data-assistant-toggle]');
      const collapse = document.querySelector('[data-assistant-collapse]');
      const clear = document.querySelector('[data-assistant-clear]');
      const form = document.querySelector('[data-assistant-form]');
      const messages = document.querySelector('[data-assistant-messages]');
      const status = document.querySelector('[data-assistant-status]');
      const textarea = form?.querySelector('textarea');
      const send = form?.querySelector('button[type="submit"]');
      if (!drawer || !toggle || !form || !messages || !status || !textarea || !send) return;
      const setOpen = open => { drawer.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Assistant open' : 'Ask NeurOn'; localStorage.setItem('neuron-assistant-open', open ? '1' : '0'); };
      setOpen(localStorage.getItem('neuron-assistant-open') === '1');
      toggle.addEventListener('click', () => setOpen(drawer.hidden)); collapse.addEventListener('click', () => setOpen(false));
      let history = [];
      try { const stored = JSON.parse(sessionStorage.getItem(chatKey) || '[]'); if (Array.isArray(stored)) history = stored; } catch {}
      const persistHistory = () => sessionStorage.setItem(chatKey, JSON.stringify(history.slice(-100)));
      const addMessage = (text, kind = '', persist = true) => {
        const node = document.createElement('div'); node.className = 'assistant-message' + (kind ? ' ' + kind : ''); node.textContent = text; messages.appendChild(node); messages.scrollTop = messages.scrollHeight;
        if (persist) { history.push({ text, kind }); persistHistory(); }
        return node;
      };
      history.slice(-100).forEach(entry => { if (entry && typeof entry.text === 'string') addMessage(entry.text, typeof entry.kind === 'string' ? entry.kind : '', false); });
      const showWelcome = () => { if (!messages.childElementCount) addMessage('Ask me to explain this screen, find a model, fill a profile, or guide you to the right page. I will always ask before saving or starting capacity.', '', false); };
      showWelcome();
      let progressNode;
      const showProgress = text => {
        if (!progressNode) { progressNode = document.createElement('div'); progressNode.className = 'assistant-message system'; progressNode.append(Object.assign(document.createElement('span'), { className: 'assistant-spinner' }), document.createElement('span')); messages.appendChild(progressNode); }
        progressNode.lastElementChild.textContent = text; messages.scrollTop = messages.scrollHeight;
      };
      const clearProgress = () => { progressNode?.remove(); progressNode = undefined; };
      clear.addEventListener('click', () => { history = []; persistHistory(); messages.replaceChildren(); progressNode = undefined; sessionStorage.removeItem(actionKey); sessionStorage.removeItem(requestKey); activeRequestId = undefined; setBusy(false); showWelcome(); });
      const currentDraft = () => {
        const profile = document.querySelector('#profile-form');
        if (!profile) { try { return JSON.parse(sessionStorage.getItem('neuron-profile-assistant-guidance') || 'null')?.draft; } catch { return undefined; } }
        const selections = [...profile.querySelectorAll('[data-profile-target]:checked')].map(target => ({ targetId: target.value, modelIds: [...target.closest('[data-profile-target-card]').querySelectorAll('[data-profile-model]:checked')].map(model => JSON.parse(model.value).modelId) }));
        return { name: profile.elements.name?.value || undefined, description: profile.elements.description?.value || undefined, defaultDurationMinutes: Number(profile.elements.defaultDurationMinutes?.value) || undefined, defaultKeepaliveMinutes: Number(profile.elements.defaultKeepaliveMinutes?.value) || undefined, selections };
      };
      const screenSurface = path => {
        if (path === '/') return 'home'; if (path === '/profiles' && document.querySelector('#profile-form')) return 'profile_create'; if (path === '/profiles') return 'profiles';
        if (path === '/profiles/new') return 'profile_create'; if (path.startsWith('/profiles/') && path.endsWith('/edit')) return 'profile_edit'; if (path === '/help' || path === '/welcome') return 'guide';
        if (path === '/client-setup') return 'client_setup'; if (path === '/api-keys') return 'api_keys'; if (path === '/admin/models') return 'admin_model_data'; if (path === '/admin/assistant') return 'admin_assistant';
        if (path === '/admin/targets') return 'admin_targets'; if (path.startsWith('/admin/')) return 'admin_other'; return 'other';
      };
      const currentScreen = () => {
        const path = location.pathname; const screen = { path, title: document.title, surface: screenSurface(path) }; const start = document.querySelector('#start-form');
        if (start) screen.startControls = { selectedProfileId: start.elements.profileId?.value || undefined, durationMinutes: Number(start.elements.durationMinutes?.value) || undefined, keepaliveMinutes: Number(start.elements.keepaliveMinutes?.value) || undefined };
        const profileRoot = document.querySelector('#profile-modal'); if (profileRoot?.dataset.assistantRequirements) { try { screen.profileRequirements = JSON.parse(profileRoot.dataset.assistantRequirements); } catch {} }
        const clientProfile = document.querySelector('#client-profile'); if (clientProfile?.value) screen.clientProfileId = clientProfile.value; return screen;
      };
      const highlight = element => { if (!element) return; element.classList.add('assistant-guided-target'); element.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => element.classList.remove('assistant-guided-target'), 2100); };
      const storeDraft = guidance => { sessionStorage.setItem('neuron-profile-assistant-guidance', JSON.stringify(guidance)); document.dispatchEvent(new CustomEvent('neuron:apply-profile-guidance', { detail: guidance })); highlight(document.querySelector('#profile-form')); };
      const actionButton = (label, handler) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', handler); return button; };
      const clearPendingAction = () => sessionStorage.removeItem(actionKey);
      const confirmation = (result, label, handler) => {
        sessionStorage.setItem(actionKey, JSON.stringify(result)); const card = document.createElement('div'); card.className = 'assistant-confirm'; const text = document.createElement('span'); text.textContent = result.message;
        const actions = document.createElement('span'); actions.className = 'row'; const confirm = actionButton(label, async event => { const button = event.currentTarget; button.disabled = true; button.textContent = 'Working…'; try { await handler(); clearPendingAction(); card.remove(); } catch (error) { addMessage(error instanceof Error ? error.message : 'The confirmed action failed.', 'error'); button.disabled = false; button.textContent = label; } });
        const cancel = actionButton('Cancel', () => { clearPendingAction(); card.remove(); addMessage('Cancelled.'); }); cancel.className = 'secondary'; actions.append(confirm, cancel); card.append(text, actions); messages.appendChild(card); messages.scrollTop = messages.scrollHeight;
      };
      const jsonRequest = async (path, options) => {
        const response = await fetch(path, options); const raw = await response.text(); let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
        if (!response.ok) throw new Error(body.error || ('NeurOn request failed with HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : ''))); return body;
      };
      const guidedNavigate = (path, message) => {
        addMessage(message); setOpen(true); const destination = new URL(path, location.href); const link = [...document.querySelectorAll('a[href]')].find(candidate => new URL(candidate.href, location.href).pathname === destination.pathname);
        if (link) { document.body.classList.add('drawer-open'); const arrow = document.createElement('span'); arrow.className = 'assistant-guide-arrow'; arrow.textContent = '→'; link.prepend(arrow); highlight(link); }
        setTimeout(() => { location.href = destination.pathname + destination.search; }, link ? 1900 : 500);
      };
      const teachControl = async (element, message) => {
        if (!element) return;
        addMessage(message); const arrow = document.createElement('span'); arrow.className = 'assistant-guide-arrow'; arrow.textContent = '→'; element.prepend(arrow); highlight(element);
        await new Promise(resolve => setTimeout(resolve, 1300)); arrow.remove();
      };
      const handleResult = result => {
        if (!result) return;
        if (result.type === 'answer') { clearPendingAction(); addMessage(result.message); return; }
        if (result.type === 'configure_profile') { clearPendingAction(); storeDraft(result.guidance); addMessage('I filled a profile draft for ' + result.guidance.useCase + '. Review the highlighted target and model selections before saving.'); if (!document.querySelector('#profile-form')) { const node = addMessage('The draft is ready to open in the profile builder.'); node.append(document.createElement('br'), actionButton('Open profile builder', () => guidedNavigate('/profiles/new?assistant=1', 'Opening the profile builder…'))); } return; }
        if (result.type === 'save_profile') { storeDraft({ useCase: result.message, responseLength: 'mixed', requirements: { domains: [], technicalCapabilities: [], weights: { intelligence: 1/3, speed: 1/3, cost: 1/3 } }, draft: result.draft }); confirmation(result, 'Confirm save profile', async () => { await teachControl(document.querySelector('#profile-form button[type="submit"]'), 'This is the profile Save button NeurOn is using for the confirmed action.'); const profile = await jsonRequest('/api/reservation-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result.draft) }); addMessage('Saved profile ' + profile.name + '. Nothing was started.'); }); return; }
        if (result.type === 'start_reservation') { confirmation(result, 'Confirm start reservation', async () => { await teachControl(document.querySelector('#start-form button[type="submit"]'), 'This is the Reserve capacity button for the confirmed action.'); await jsonRequest('/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: result.profileId, modelIds: [], targetIds: [], durationMinutes: result.durationMinutes, keepaliveMinutes: result.keepaliveMinutes }) }); addMessage('Reservation created. NeurOn is reconciling the selected capacity.'); }); return; }
        if (result.type === 'open_page' || result.type === 'open_admin_page') { clearPendingAction(); guidedNavigate(result.path, result.message); return; }
        if (result.type === 'rediscover_target') confirmation(result, 'Confirm rediscovery', async () => { await jsonRequest('/api/admin/targets/' + encodeURIComponent(result.targetId) + '/discover', { method: 'POST' }); addMessage('Rediscovery and benchmark completed for ' + result.targetId + '.'); });
      };
      let activeRequestId;
      let assistantEnabled = true;
      const setBusy = busy => { send.disabled = busy || !assistantEnabled; textarea.disabled = busy || !assistantEnabled; };
      const pollRequest = async id => {
        if (activeRequestId === id) return; activeRequestId = id; sessionStorage.setItem(requestKey, id); setBusy(true);
        try {
          while (activeRequestId === id) {
            const request = await jsonRequest('/api/profile-advisor/requests/' + encodeURIComponent(id)); showProgress(request.message || 'Assistant is working…');
            if (request.phase === 'complete') { clearProgress(); sessionStorage.removeItem(requestKey); activeRequestId = undefined; setBusy(false); handleResult(request.result); return; }
            if (request.phase === 'failed') { clearProgress(); sessionStorage.removeItem(requestKey); activeRequestId = undefined; setBusy(false); addMessage(request.message || 'Assistant failed.', 'error'); return; }
            await new Promise(resolve => setTimeout(resolve, 900));
          }
        } catch (error) { clearProgress(); sessionStorage.removeItem(requestKey); activeRequestId = undefined; setBusy(false); addMessage(error instanceof Error ? error.message : 'The Assistant request could not be checked.', 'error'); }
      };
      form.addEventListener('submit', async event => {
        event.preventDefault(); const request = textarea.value.trim(); if (request.length < 3 || activeRequestId) return; addMessage(request, 'user'); textarea.value = ''; setBusy(true); showProgress('Checking whether the Assistant is awake…');
        try { const started = await jsonRequest('/api/profile-advisor/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, currentDraft: currentDraft(), screen: currentScreen() }) }); activeRequestId = undefined; showProgress(started.message); await pollRequest(started.id); }
        catch (error) { clearProgress(); setBusy(false); addMessage(error instanceof Error ? error.message : 'The Assistant failed.', 'error'); }
      });
      textarea.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
      fetch('/api/profile-advisor/status').then(response => response.json()).then(data => { if (!data.enabled) { assistantEnabled = false; setBusy(false); status.textContent = data.reason === 'maintenance_mode' ? 'The Assistant is paused while NeurOn is in maintenance mode.' : 'An administrator has not configured the Assistant target and model.'; } }).catch(() => undefined);
      const pendingGuidance = sessionStorage.getItem('neuron-profile-assistant-guidance'); if (pendingGuidance && document.querySelector('#profile-form')) { try { document.dispatchEvent(new CustomEvent('neuron:apply-profile-guidance', { detail: JSON.parse(pendingGuidance) })); } catch {} }
      const pendingAction = sessionStorage.getItem(actionKey); if (pendingAction) { try { handleResult(JSON.parse(pendingAction)); } catch { clearPendingAction(); } }
      const pendingRequest = sessionStorage.getItem(requestKey); if (pendingRequest) void pollRequest(pendingRequest);
    })();`;
}

export function loginPage(error = "", methods: Array<Pick<AuthMethod, "id" | "displayName" | "type">> = [], sharedPasswordEnabled = true): string {
  const authButtons = methods.length
    ? `<div class="inline-actions" style="margin-top: 14px;">${methods.map((method) => `<form method="get" action="/auth/${escapeHtml(method.type)}/start"><input type="hidden" name="method" value="${escapeHtml(method.id)}"><button class="secondary" type="submit">Sign in with ${escapeHtml(method.displayName)}</button></form>`).join("")}</div>`
    : "";
  const passwordForm = sharedPasswordEnabled ? `<form method="post" action="/login">
      <p><label>Username<br><input name="username" required></label></p>
      <p><label>Password<br><input name="password" type="password" required></label></p>
      <button type="submit">Sign in</button>
    </form>` : "";
  const noMethods = !sharedPasswordEnabled && methods.length === 0 ? `<p class="status">No interactive sign-in methods are enabled.</p>` : "";
  return layout("Login", undefined, `<section class="panel">
    <h1>Sign in</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    ${passwordForm}
    ${authButtons}
    ${noMethods}
  </section>`);
}

export function welcomePage(user: AuthenticatedUser, hasProfiles: boolean, helpMode: boolean): string {
  const nextHref = hasProfiles ? "/" : "/profiles/new?onboarding=1";
  const nextLabel = hasProfiles ? "Return home" : "Create your first profile";
  return layout(helpMode ? "How NeurOn works" : "Welcome to NeurOn", user, `<section class="panel">
    <p class="pill">${helpMode ? "Guide" : "Getting started"}</p>
    <h1>${helpMode ? "How NeurOn works" : "Shared model capacity without paying for idle time"}</h1>
    <p>NeurOn turns configured model servers on while people need them and lets them stop after demand ends. Sharing targets and avoiding idle runtime reduces infrastructure cost without making every user manage the underlying provider.</p>
  </section>
  <div class="field-grid">
    <section class="panel"><h2>1. Build a profile</h2><p>Choose one or more target-and-model combinations that belong to a workflow. If a target has only one model, NeurOn selects it automatically.</p></section>
    <section class="panel"><h2>2. Reserve capacity</h2><p>Select the profile on Home, choose how long you expect to work, and press <strong>Reserve capacity</strong>. You can hold more than one reservation and manage each one separately.</p></section>
    <section class="panel"><h2>3. Use your model</h2><p>The server status shows startup progress and model aliases. Copy the appropriate alias into your connected tool once the target is healthy.</p></section>
  </div>
  <section class="panel">
    <h2>Timing and traffic</h2>
    <p><strong>Duration</strong> is the planned working time. <strong>Keepalive</strong> is the extra idle window after demand ends, which helps avoid a shutdown between nearby requests.</p>
    <p>A <strong>traffic reservation</strong> is NeurOn's short-lived signal that a configured model was recently used. It can keep an already-participating activation warm, but it does not represent a separate person or start failed capacity by itself.</p>
    <p class="muted">NeurOn controls targets an administrator has configured. For example, its EC2 adapter starts and stops an existing instance; it does not create AWS infrastructure.</p>
    <div class="actions"><a href="${nextHref}"><button class="large" type="button">${nextLabel}</button></a></div>
  </section>`);
}

export function startPage(user: AuthenticatedUser, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>, profiles: ReservationProfile[] = [], error = "", costEstimates: Record<string, { hourlyUsd: number }> = {}, statusPollSeconds = 5, selectionDeployments: ModelDeploymentSelectionView[] = []): string {
  const initialTargetId = targets[0]?.target.id ?? "";
  return layout("NeurOn", user, `<div class="home-grid"><div><section class="panel">
    <h2>Your reservations</h2>
    <div id="current-reservation"><p class="muted">Loading...</p></div>
  </section>
  <section class="panel">
    <h1>Start capacity</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <form id="start-form" class="quick-start" method="post" action="/reservations">
      <input id="duration-minutes" type="hidden" name="durationMinutes" value="2">
      <input id="keepalive-minutes" type="hidden" name="keepaliveMinutes" value="2">
      <input id="reservation-profile-id" type="hidden" name="profileId" value="">
      <div class="profile-strip">
        <div><strong>Reservation profile</strong>${helpTip("A profile remembers the targets, models, duration, and keepalive you use together.")}</div>
      </div>
      ${profilePicker(profiles, targets)}
      <div class="profile-actions below">
        <button class="secondary" type="button" data-review-profile>Review selected</button>
        <a class="button secondary" href="/profiles/new">Create profile</a>
      </div>
      <p id="profile-selection-error" class="status" hidden></p>
      ${durationControls()}
      ${keepaliveControls()}
      <div class="reserve-bar">
        <div id="start-cost-estimate" class="start-cost">Estimated cost: Not available</div>
        <button class="large" type="submit">Reserve capacity</button>
      </div>
    </form>
  </section>
  </div><aside>
  <section class="panel">
    <h2>Server status</h2>
    <div id="server-status"><p class="muted">Loading...</p></div>
  </section>
  </aside></div>
  ${profileReviewModal(profiles, targets)}
  ${profileCreateModal(targets, initialTargetId, "/", selectionDeployments, costEstimates)}
  <script type="module">
    const modelLookup = ${safeJson(modelLookupForTargets(targets))};
    const targetLookup = ${safeJson(targetLookupForTargets(targets))};
    const profiles = ${safeJson(profilesForClient(profiles, targets))};
    const costLookup = ${safeJson(costEstimates)};
    const currentUser = ${JSON.stringify(user.username)};
    const form = document.querySelector('#start-form');
    const duration = document.querySelector('#duration-minutes');
    const keepalive = document.querySelector('#keepalive-minutes');
    const custom = document.querySelector('#custom-duration');
    const customKeepalive = document.querySelector('#custom-keepalive');
    const durationButtons = [...document.querySelectorAll('[data-duration], [data-custom-duration]')];
    const keepaliveButtons = [...document.querySelectorAll('[data-keepalive], [data-custom-keepalive]')];
    const customWrap = document.querySelector('#custom-duration-wrap');
    const customKeepaliveWrap = document.querySelector('#custom-keepalive-wrap');
    const startCostEstimate = document.querySelector('#start-cost-estimate');
    const profileSelectionError = document.querySelector('#profile-selection-error');
    const profileSelectInput = document.querySelector('#reservation-profile-id');
    const profilePicker = document.querySelector('#profile-picker');
    const profilePickerSummary = document.querySelector('#profile-picker-summary');
    const profileForm = document.querySelector('#profile-form');
    const profileTargetInputs = [...profileForm.querySelectorAll('[data-profile-target]')];
    const profileDurationInput = document.querySelector('#profile-duration-minutes');
    const profileKeepaliveInput = document.querySelector('#profile-keepalive-minutes');
    const profileDurationButtons = [...document.querySelectorAll('[data-profile-duration], [data-profile-custom-duration]')];
    const profileKeepaliveButtons = [...document.querySelectorAll('[data-profile-keepalive], [data-profile-custom-keepalive]')];
    const profileCustomDuration = document.querySelector('#profile-custom-duration');
    const profileCustomKeepalive = document.querySelector('#profile-custom-keepalive');
    const profileCustomDurationWrap = document.querySelector('#profile-custom-duration-wrap');
    const profileCustomKeepaliveWrap = document.querySelector('#profile-custom-keepalive-wrap');
    document.addEventListener('click', async (event) => {
      const profileButton = event.target.closest('[data-profile-id]');
      if (profileButton) {
        event.preventDefault();
        const modal = document.querySelector('#profile-review-modal');
        document.querySelector('#profile-review-body').innerHTML = profileDetailHtml(profiles.find(profile => profile.id === profileButton.dataset.profileId));
        modal.hidden = false;
        return;
      }
      const profileChoice = event.target.closest('[data-select-profile]');
      if (profileChoice) {
        event.preventDefault();
        profileSelectInput.value = profileChoice.dataset.selectProfile ?? '';
        document.querySelectorAll('[data-select-profile]').forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === profileChoice)));
        applyProfile(selectedProfile());
        if (profilePickerSummary) profilePickerSummary.innerHTML = profileSummaryHtml(selectedProfile());
        if (profilePicker) profilePicker.open = false;
        return;
      }
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
    const profileSummaryHtml = (profile) => {
      if (!profile) return '<span class="muted">Choose a profile</span>';
      const targetNames = profile.selections.map(selection => targetLookup[selection.targetId]?.displayName ?? selection.targetId).join(', ');
      const aliases = [...new Set(profile.selections.flatMap(selection => selection.modelIds.map(modelId => modelLookup[modelId]?.recommendedAlias ?? modelId)))].slice(0, 6);
      const defaults = [profile.defaultDurationMinutes ? profile.defaultDurationMinutes + ' min' : '', profile.defaultKeepaliveMinutes ? profile.defaultKeepaliveMinutes + ' min keepalive' : ''].filter(Boolean).join(' | ');
      return '<span><span class="profile-card-title"><strong>' + escapeText(profile.name) + '</strong>' + (defaults ? '<span class="pill">' + escapeText(defaults) + '</span>' : '') + '</span>' + (profile.description ? '<span class="muted">' + escapeText(profile.description) + '</span>' : '') + '<span class="compact-summary"><span class="pill">' + escapeText(targetNames || 'No target') + '</span>' + (aliases.length ? aliases.map(alias => '<span class="copy-chip">' + escapeText(alias) + '</span>').join('') : '<span class="pill">All models</span>') + '</span></span>';
    };
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
    const selectedProfile = () => profiles.find(profile => profile.id === profileSelectInput?.value);
    const selectedProfileTargetIds = () => [...new Set(selectedProfile()?.selections.map(selection => selection.targetId) ?? [])];
    const updateStartCostEstimate = () => {
      const targetIds = selectedProfileTargetIds();
      const hourlyCosts = targetIds.map(targetId => costLookup[targetId]?.hourlyUsd);
      if (targetIds.length === 0 || hourlyCosts.some(hourlyUsd => hourlyUsd === undefined)) {
        startCostEstimate.textContent = 'Estimated cost: Not available';
        return;
      }
      const durationMinutes = Math.max(0, Number(duration.value) || 0);
      const keepaliveMinutes = Math.max(0, Number(keepalive.value) || 0);
      const estimatedMinutes = durationMinutes + keepaliveMinutes;
      const hourlyUsd = hourlyCosts.reduce((total, value) => total + value, 0);
      const estimatedCost = hourlyUsd * estimatedMinutes / 60;
      const targetSummary = targetIds.length > 1 ? ' across ' + targetIds.length + ' targets' : '';
      startCostEstimate.textContent = 'Estimated cost: ' + formatUsd(estimatedCost) + ' for ' + estimatedMinutes + ' min' + targetSummary + ' (duration + keepalive)';
    };
    const updateSelectedProfileSummary = () => {
      if (profileSelectionError) profileSelectionError.hidden = true;
    };
    const syncProfileSelections = () => {
      profileTargetInputs.forEach(input => {
        const card = input.closest('[data-profile-target-card]');
        const selected = input.checked;
        card?.classList.toggle('selected', selected);
        const models = [...card.querySelectorAll('[data-profile-model]')];
        models.forEach(model => { model.disabled = !selected; });
        if (selected && models.length === 1) models[0].checked = true;
      });
    };
    const syncProfileDefaultButtons = (value, buttons, customButton, customInput, customWrap, attr) => {
      const matching = buttons.find(button => button.dataset[attr] === String(value));
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button === (matching ?? customButton))));
      customWrap.classList.toggle('hidden', Boolean(matching));
      if (!matching) customInput.value = String(value);
    };
    const syncProfileDefaultsFromStart = () => {
      profileDurationInput.value = duration.value;
      profileKeepaliveInput.value = keepalive.value;
      syncProfileDefaultButtons(profileDurationInput.value, profileDurationButtons, document.querySelector('[data-profile-custom-duration]'), profileCustomDuration, profileCustomDurationWrap, 'profileDuration');
      syncProfileDefaultButtons(profileKeepaliveInput.value, profileKeepaliveButtons, document.querySelector('[data-profile-custom-keepalive]'), profileCustomKeepalive, profileCustomKeepaliveWrap, 'profileKeepalive');
    };
    const selectProfileDuration = (button) => {
      const isCustom = Boolean(button?.dataset.profileCustomDuration);
      profileDurationButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
      profileCustomDurationWrap.classList.toggle('hidden', !isCustom);
      profileDurationInput.value = isCustom ? profileCustomDuration.value : button?.dataset.profileDuration ?? profileDurationInput.value;
      if (isCustom) profileCustomDuration.focus();
    };
    const selectProfileKeepalive = (button) => {
      const isCustom = Boolean(button?.dataset.profileCustomKeepalive);
      profileKeepaliveButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
      profileCustomKeepaliveWrap.classList.toggle('hidden', !isCustom);
      profileKeepaliveInput.value = isCustom ? profileCustomKeepalive.value : button?.dataset.profileKeepalive ?? profileKeepaliveInput.value;
      if (isCustom) profileCustomKeepalive.focus();
    };
    const applyProfile = (profile) => {
      if (!profile) return;
      if (profile.defaultDurationMinutes) setDurationValue(profile.defaultDurationMinutes);
      if (profile.defaultKeepaliveMinutes) setKeepaliveValue(profile.defaultKeepaliveMinutes);
      updateSelectedProfileSummary();
      updateStartCostEstimate();
    };
    const profileDetailHtml = (profile, options = {}) => {
      if (!profile) return '<p class="muted">Pick a reservation profile to review it.</p>';
      const selections = profile.selections.map(selection => {
        const targetName = targetLookup[selection.targetId]?.displayName ?? selection.targetId;
        const modelCount = selection.modelIds.length ? selection.modelIds.length + ' models' : 'All models';
        const models = options.compact ? '<span class="pill">' + escapeText(modelCount) + '</span>' : (selection.modelIds.length ? modelChipRow(selection.modelIds) : '<span class="chip-row"><span class="pill">All models</span></span>');
        return '<div class="' + (options.compact ? 'compact-summary' : 'target-status-card') + '"><strong>' + escapeText(targetName) + '</strong>' + models + '</div>';
      }).join('');
      const defaults = [profile.defaultDurationMinutes ? profile.defaultDurationMinutes + ' min duration' : '', profile.defaultKeepaliveMinutes ? profile.defaultKeepaliveMinutes + ' min keepalive' : ''].filter(Boolean).join(' | ');
      return '<h3>' + escapeText(profile.name) + '</h3>' + (profile.description ? '<p class="muted">' + escapeText(profile.description) + '</p>' : '') + (defaults ? '<p class="muted">' + escapeText(defaults) + '</p>' : '') + selections;
    };
    const timeLeft = (iso) => {
      const ms = new Date(iso).getTime() - Date.now();
      if (ms <= 0) return 'expired';
      const totalSeconds = Math.ceil(ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes ? minutes + 'm ' + String(seconds).padStart(2, '0') + 's left' : seconds + 's left';
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
    const reservationModelsForTarget = (reservation, targetId) => targetId
      ? (reservation.targetSelections?.find(selection => selection.targetId === targetId)?.modelIds ?? reservation.modelIds)
      : reservation.modelIds;
    const reservationCard = (reservation, includeActions = false, targetId) => {
      const profileButton = reservation.profileName ? '<button class="copy-chip primary" type="button" data-profile-id="' + escapeText(reservation.profileId ?? '') + '">' + escapeText(reservation.profileName) + '</button>' : '';
      const trafficContext = reservation.synthetic ? '<span class="pill">traffic reservation</span><span class="help-tip" tabindex="0" role="note" aria-label="Recent observed traffic is temporarily keeping this already-needed target available." data-tip="Recent observed traffic is temporarily keeping this already-needed target available.">?</span>' : '';
      const actions = includeActions
        ? '<div class="reservation-actions"><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="1" type="submit">+1 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="2" type="submit">+2 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="5" type="submit">+5 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="15" type="submit">+15 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/extend"><button class="secondary" name="durationMinutes" value="30" type="submit">+30 min</button></form><form method="post" action="/reservations/' + reservation.reservationId + '/done"><button class="danger" type="submit">I\\'m done</button></form></div>'
        : '';
      return '<div class="reservation-card"><div><div class="reservation-meta">' + statusBadge(reservation.status) + '<strong>' + escapeText(reservation.displayUsername ?? reservation.username) + '</strong><span class="muted">' + reservationTimeHtml(reservation) + '</span>' + profileButton + trafficContext + '</div><div class="muted">' + escapeText(reservationTargets(reservation)) + '</div>' + reservationCostLine(reservation.costEstimate) + modelChipRow(reservationModelsForTarget(reservation, targetId)) + '</div>' + actions + '</div>';
    };
    const compactReservationCard = (reservation, targetId) => {
      const models = reservationModelsForTarget(reservation, targetId);
      return '<div class="reservation-card compact"><div><div class="reservation-meta">' + statusBadge(reservation.status) + '<strong>' + escapeText(reservation.displayUsername ?? reservation.username) + '</strong><span class="muted">' + reservationTimeHtml(reservation) + '</span>' + (reservation.synthetic ? '<span class="pill" title="Recent observed traffic is temporarily keeping this already-needed target available.">traffic reservation</span>' : '') + '</div><div class="muted">' + escapeText(reservationTargets(reservation)) + ' | ' + (models.length ? models.length + ' models' : 'All models') + '</div></div></div>';
    };
    const orderTargetsForStatus = (capacityTargets, reservations) => {
      const reservedTargetIds = new Set(reservations.filter(reservation => reservation.username === currentUser).flatMap(reservation => reservation.targets.map(target => target.id)));
      const priority = (target) => reservedTargetIds.has(target.id) ? 0 : target.desired === 'on' ? 1 : 2;
      return capacityTargets
        .map((target, index) => ({ target, index, priority: priority(target) }))
        .sort((left, right) => left.priority - right.priority || (new Date(right.target.lastUsedAt ?? 0).getTime() - new Date(left.target.lastUsedAt ?? 0).getTime()) || left.index - right.index)
        .map(({ target }) => target);
    };
    const targetStatusCard = (target, reservations) => {
      const relevant = reservations.filter(reservation => reservation.targets.some(candidate => candidate.id === target.id));
      const mine = relevant.filter(reservation => reservation.username === currentUser);
      const others = relevant.filter(reservation => reservation.username !== currentUser);
      const modelCount = new Set(relevant.flatMap(reservation => reservationModelsForTarget(reservation, target.id))).size;
      const summary = '<span class="muted">' + relevant.length + ' active reservations</span><span class="muted">' + (target.activeUsers?.length ?? 0) + ' users</span><span class="muted">' + (modelCount || 'All') + ' models</span>';
      const userLine = target.activeUsers?.length ? '<span class="muted">Users: ' + escapeText(target.activeUsers.join(', ')) + '</span>' : '<span class="muted">No active users</span>';
      const mineRows = mine.length ? mine.map(reservation => reservationCard(reservation, false, target.id)).join('') : '';
      const otherRows = others.length ? '<details class="status-details" data-status-details="' + escapeText(target.id) + ':others"><summary>' + others.length + ' other reservations</summary><div class="reservation-list">' + others.map(reservation => compactReservationCard(reservation, target.id)).join('') + '</div></details>' : '';
      const rows = relevant.length ? mineRows + otherRows : '<p class="muted">No reservations for this server</p>';
      return '<section class="target-status-card" data-status-target="' + escapeText(target.id) + '"><div class="target-status-head"><div><h3>' + escapeText(target.displayName) + '</h3><div class="target-status-meta">' + statusPill(target.desired) + statusPill(target.observed) + summary + startupEstimate(target) + '</div></div><div class="muted">' + escapeText(target.provider) + '</div></div><p class="muted">' + escapeText(target.message) + '</p><div class="target-status-meta">' + userLine + '</div><div class="reservation-list">' + rows + '</div></section>';
    };
    const selectDuration = (button, focus = true) => {
      durationButtons.forEach(candidate => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
      const isCustom = Boolean(button?.dataset.customDuration);
      customWrap.classList.toggle('hidden', !isCustom);
      duration.value = isCustom ? custom.value : button?.dataset.duration ?? duration.value;
      if (isCustom && focus) custom.focus();
      updateStartCostEstimate();
    };
    durationButtons.forEach(button => button.addEventListener('click', () => selectDuration(button)));
    const selectKeepalive = (button, focus = true) => {
      keepaliveButtons.forEach(candidate => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
      const isCustom = Boolean(button?.dataset.customKeepalive);
      customKeepaliveWrap.classList.toggle('hidden', !isCustom);
      keepalive.value = isCustom ? customKeepalive.value : button?.dataset.keepalive ?? keepalive.value;
      if (isCustom && focus) customKeepalive.focus();
      updateStartCostEstimate();
    };
    keepaliveButtons.forEach(button => button.addEventListener('click', () => selectKeepalive(button)));
    const setDurationValue = (value) => {
      const matching = durationButtons.find(button => button.dataset.duration === String(value));
      if (matching) return selectDuration(matching, false);
      custom.value = String(value);
      selectDuration(document.querySelector('[data-custom-duration]'), false);
    };
    const setKeepaliveValue = (value) => {
      const matching = keepaliveButtons.find(button => button.dataset.keepalive === String(value));
      if (matching) return selectKeepalive(matching, false);
      customKeepalive.value = String(value);
      selectKeepalive(document.querySelector('[data-custom-keepalive]'), false);
    };
    profileTargetInputs.forEach(input => input.addEventListener('change', syncProfileSelections));
    profileSelectInput?.addEventListener('change', () => { applyProfile(selectedProfile()); updateDurationGuidance(); });
    document.querySelector('[data-review-profile]')?.addEventListener('click', () => {
      const modal = document.querySelector('#profile-review-modal');
      document.querySelector('#profile-review-body').innerHTML = profileDetailHtml(selectedProfile());
      modal.hidden = false;
    });
    document.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-open-modal]');
      if (opener) {
        document.getElementById(opener.dataset.openModal).hidden = false;
        syncProfileSelections();
        syncProfileDefaultsFromStart();
      }
      if (event.target.closest('[data-close-modal]')) event.target.closest('.modal').hidden = true;
      if (event.target.classList?.contains('modal')) event.target.hidden = true;
    });
    custom.addEventListener('input', () => {
      const customButton = document.querySelector('[data-custom-duration]');
      selectDuration(customButton);
    });
    customKeepalive.addEventListener('input', () => {
      const customButton = document.querySelector('[data-custom-keepalive]');
      selectKeepalive(customButton);
    });
    profileDurationButtons.forEach(button => button.addEventListener('click', () => selectProfileDuration(button)));
    profileKeepaliveButtons.forEach(button => button.addEventListener('click', () => selectProfileKeepalive(button)));
    profileCustomDuration.addEventListener('input', () => selectProfileDuration(document.querySelector('[data-profile-custom-duration]')));
    profileCustomKeepalive.addEventListener('input', () => selectProfileKeepalive(document.querySelector('[data-profile-custom-keepalive]')));
    form.addEventListener('submit', (event) => {
      if (!profileSelectInput.value) {
        event.preventDefault();
        if (profileSelectionError) {
          profileSelectionError.textContent = 'Choose or create a reservation profile.';
          profileSelectionError.hidden = false;
        }
        return;
      }
    });
    if (!profileSelectInput.value && profiles[0]) profileSelectInput.value = profiles[0].id;
    document.querySelectorAll('[data-select-profile]').forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate.dataset.selectProfile === profileSelectInput.value)));
    applyProfile(selectedProfile());
    if (profilePickerSummary) profilePickerSummary.innerHTML = profileSummaryHtml(selectedProfile());
    syncProfileSelections();
    syncProfileDefaultsFromStart();
    let latestTargets = [];
    const updateDurationGuidance = () => {
      const targetIds = selectedProfileTargetIds();
      const startupMinutes = targetIds.map(id => latestTargets.find(target => target.id === id)?.startupEstimate?.avgSeconds).filter(value => typeof value === 'number').map(value => value / 60);
      const recommended = startupMinutes.length ? Math.ceil(Math.max(...startupMinutes) + 2) : undefined;
      durationButtons.forEach(button => {
        const value = Number(button.dataset.duration);
        const tooShort = recommended !== undefined && Number.isFinite(value) && value < recommended;
        button.classList.toggle('duration-too-short', tooShort);
        if (tooShort) button.title = 'Below the usual startup time plus two minutes; little useful reservation time may remain.';
        else if (button.classList.contains('duration-long')) button.title = 'Longer reservation; review the estimated cost.';
        else button.removeAttribute('title');
      });
    };
    async function refreshServerStatus() {
      const statusRoot = document.querySelector('#server-status');
      const openDetails = new Set([...statusRoot.querySelectorAll('details[open][data-status-details]')].map(details => details.dataset.statusDetails));
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();
      latestTargets = data.capacityTargets;
      const current = data.activeReservations.filter(reservation => reservation.username === currentUser);
      document.querySelector('#current-reservation').innerHTML = current.length
        ? '<div class="reservation-list">' + current.map(reservation => reservationCard(reservation, true)).join('') + '</div>'
        : '<p class="muted">No active reservations. Choose a profile below, adjust the timing if needed, then select Reserve capacity.</p>';
      const orderedTargets = orderTargetsForStatus(data.capacityTargets, data.reservations);
      statusRoot.innerHTML = orderedTargets.length
        ? '<div class="status-grid">' + orderedTargets.map(target => targetStatusCard(target, data.reservations)).join('') + '</div>'
        : '<p class="muted">No targets configured</p>';
      statusRoot.querySelectorAll('details[data-status-details]').forEach(details => { details.open = openDetails.has(details.dataset.statusDetails); });
      updateDurationGuidance();
      updateCountdowns();
    }
    function updateCountdowns() {
      document.querySelectorAll('[data-countdown-expires]').forEach(element => {
        element.textContent = timeLeft(element.dataset.countdownExpires);
      });
    }
    refreshServerStatus();
    setInterval(updateCountdowns, 1000);
    setInterval(refreshServerStatus, ${statusPollSeconds * 1000});
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
      const totalSeconds = Math.ceil(ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes ? minutes + 'm ' + String(seconds).padStart(2, '0') + 's left' : seconds + 's left';
    };
    const friendlyExpiration = (iso) => formatDateTime(iso) + ' (' + timeLeft(iso) + ')';
    const reservationTime = (data) => data.endedAt ? 'ended ' + formatDateTime(data.endedAt) : friendlyExpiration(data.expiresAt);
    const formatUsd = (value) => '$' + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);
    let currentReservation;
    const updateReservationTime = () => {
      if (currentReservation) document.querySelector('#reservation-expires').textContent = reservationTime(currentReservation);
    };
    async function refresh() {
      const res = await fetch('/api/reservations/' + reservationId + '/status');
      if (!res.ok) return;
      const data = await res.json();
      currentReservation = data;
      document.querySelector('#reservation-status').textContent = data.status;
      updateReservationTime();
      document.querySelector('#reservation-cost-so-far').textContent = data.costEstimate ? formatUsd(data.costEstimate.estimatedCostUsd) : 'Not allocated yet';
      document.querySelector('#reservation-cost-projected').textContent = data.costEstimate?.projectedTotalCostUsd !== undefined ? formatUsd(data.costEstimate.projectedTotalCostUsd) : 'Not available';
      document.querySelector('#target-status').innerHTML = data.targets.map(t => '<p><strong>' + t.id + '</strong>: ' + t.observed + ' - ' + t.message + '</p>').join('');
    }
    refresh();
    setInterval(updateReservationTime, 1000);
    setInterval(refresh, ${config.reservationStatusPollSeconds * 1000});
  </script>`);
}

export function clientSetupPage(
  user: AuthenticatedUser,
  profiles: ReservationProfile[],
  targets: CapacityTarget[],
  deployments: ModelDeploymentSelectionView[]
): string {
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  const rows = deployments.flatMap((deployment) => {
    const target = targetsById.get(deployment.targetId);
    if (!target) return [];
    const aliases = litellmAliases(target, deployment.modelId, deployment.aliases);
    const profileIds = profiles
      .filter((profile) => profile.selections.some((selection) => selection.targetId === deployment.targetId && selection.modelIds.includes(deployment.modelId)))
      .map((profile) => profile.id);
    return aliases.global.map((globalAlias, index) => ({
      targetId: deployment.targetId,
      targetDisplayName: deployment.targetDisplayName,
      modelId: deployment.modelId,
      modelDisplayName: deployment.modelDisplayName,
      globalAlias,
      scopedAlias: aliases.scoped[index],
      priority: target.aliasPriority ?? 100,
      contextWindowTokens: deployment.contextWindowTokens,
      profileIds
    }));
  }).sort((left, right) => left.globalAlias.localeCompare(right.globalAlias) || left.priority - right.priority || left.targetDisplayName.localeCompare(right.targetDisplayName));
  const serialized = JSON.stringify(rows).replace(/</gu, "\\u003c");
  const options = profiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("");
  return layout("Client setup", user, `<section class="panel">
    <div class="target-status-head"><div><h1>Client setup</h1><p class="muted">Copy a complete OpenCode model catalog or inspect the LiteLLM routes NeurOn publishes. Global aliases use target priority and fall back in numeric order; target-scoped aliases pin one deployment.</p></div><a class="button secondary" href="/api-keys">Create API key</a></div>
    <p><label>Configuration scope<br><select id="client-profile"><option value="">All models (global fallback aliases)</option>${options}</select></label></p>
  </section>
  <section class="panel"><h2>OpenCode provider</h2><p class="muted">Replace the endpoint placeholder and keep secrets in environment variables. The NeurOn plugin reserves and waits for the selected route before OpenCode sends the request.</p><div class="inline-actions"><button type="button" data-copy-client="opencode-config">Copy config</button><button class="secondary" type="button" data-copy-client="opencode-env">Copy plugin environment</button><span class="muted" id="client-copy-status"></span></div><pre id="opencode-config"></pre><pre id="opencode-env">NEURON_API_BASE_URL=&lt;NEURON_BASE_URL&gt;
NEURON_API_KEY=sk-neuron-...
NEURON_ALLOWED_PROVIDERS=litellm</pre></section>
  <section class="panel"><h2>Available aliases</h2><p class="muted">Use the global alias when you want automatic fallback. Use the scoped alias when a profile or workload must stay on a particular target.</p><div style="overflow:auto"><table><thead><tr><th>Model</th><th>Global route</th><th>Target-scoped route</th><th>Target priority</th></tr></thead><tbody id="client-aliases"></tbody></table></div></section>
  <script>
    (() => {
      const routes = ${serialized};
      const profile = document.querySelector('#client-profile');
      const table = document.querySelector('#client-aliases');
      const config = document.querySelector('#opencode-config');
      const escapeText = (value) => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
      const visibleRoutes = () => profile.value ? routes.filter(route => route.profileIds.includes(profile.value)) : routes;
      const render = () => {
        const visible = visibleRoutes();
        table.innerHTML = visible.map(route => '<tr><td><strong>' + escapeText(route.modelDisplayName) + '</strong><br><code>' + escapeText(route.modelId) + '</code></td><td><button class="copy-chip" type="button" data-copy-value="' + escapeText(route.globalAlias) + '">' + escapeText(route.globalAlias) + '</button></td><td><button class="copy-chip primary" type="button" data-copy-value="' + escapeText(route.scopedAlias) + '">' + escapeText(route.scopedAlias) + '</button><br><span class="muted">' + escapeText(route.targetDisplayName) + '</span></td><td>' + route.priority + '</td></tr>').join('') || '<tr><td colspan="4" class="muted">This profile has no model routes.</td></tr>';
        const chosen = new Map();
        visible.forEach(route => {
          const modelID = profile.value ? route.scopedAlias : route.globalAlias;
          if (!chosen.has(modelID)) chosen.set(modelID, { name: route.modelDisplayName + (profile.value ? ' · ' + route.targetDisplayName : ''), ...(route.contextWindowTokens ? { limit: { context: route.contextWindowTokens } } : {}) });
        });
        const body = { '$schema': 'https://opencode.ai/config.json', plugin: ['opencode-neuron'], provider: { litellm: { npm: '@ai-sdk/openai-compatible', name: 'LiteLLM through NeurOn', options: { baseURL: '<LITELLM_BASE_URL>/v1', apiKey: '{env:LITELLM_API_KEY}' }, models: Object.fromEntries(chosen) } } };
        config.textContent = JSON.stringify(body, null, 2);
      };
      profile.addEventListener('change', render);
      document.addEventListener('click', async (event) => {
        const direct = event.target.closest('[data-copy-value]');
        const block = event.target.closest('[data-copy-client]');
        const value = direct?.dataset.copyValue ?? (block ? document.querySelector('#' + block.dataset.copyClient)?.textContent : undefined);
        if (!value) return;
        await navigator.clipboard?.writeText(value);
        document.querySelector('#client-copy-status').textContent = 'Copied.';
      });
      render();
    })();
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

export function profilesPage(
  user: AuthenticatedUser,
  profiles: ReservationProfile[],
  targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>,
  options: { openCreate?: boolean; onboarding?: boolean; error?: string } = {},
  selectionDeployments: ModelDeploymentSelectionView[] = [],
  selectionCosts: Record<string, { hourlyUsd: number }> = {}
): string {
  const initialTargetId = targets[0]?.target.id ?? "";
  const rows = profiles.length
    ? profiles.map((profile) => profileListCard(profile, targets)).join("")
    : `<p class="muted">No reservation profiles yet.</p>`;
  return layout("NeurOn Profiles", user, `<section class="panel">
    ${options.onboarding ? `<p class="pill">Getting started</p><h1>Create your first profile</h1><p class="muted">A profile connects the servers and models you use together. NeurOn will select the only model automatically on single-model targets.</p>` : ""}
    ${options.error ? `<p class="status">${escapeHtml(options.error)}</p>` : ""}
    <div class="target-status-head"><h1>Profiles</h1><a class="button" href="/profiles/new">New profile</a></div>
    <div class="summary-list">${rows}</div>
  </section>
  ${profileCreateModal(targets, initialTargetId, options.onboarding ? "/" : "/profiles", selectionDeployments, selectionCosts)}
  <script type="module">
    const form = document.querySelector('#profile-form');
    const targetInputs = [...form.querySelectorAll('[data-profile-target]')];
    const profileDurationInput = form.querySelector('#profile-duration-minutes');
    const profileKeepaliveInput = form.querySelector('#profile-keepalive-minutes');
    const profileDurationButtons = [...form.querySelectorAll('[data-profile-duration], [data-profile-custom-duration]')];
    const profileKeepaliveButtons = [...form.querySelectorAll('[data-profile-keepalive], [data-profile-custom-keepalive]')];
    const profileCustomDuration = form.querySelector('#profile-custom-duration');
    const profileCustomKeepalive = form.querySelector('#profile-custom-keepalive');
    const profileCustomDurationWrap = form.querySelector('#profile-custom-duration-wrap');
    const profileCustomKeepaliveWrap = form.querySelector('#profile-custom-keepalive-wrap');
    const syncTargets = () => {
      targetInputs.forEach(input => {
        const card = input.closest('[data-profile-target-card]');
        const selected = input.checked;
        card?.classList.toggle('selected', selected);
        const models = [...card.querySelectorAll('[data-profile-model]')];
        models.forEach(model => { model.disabled = !selected; });
        if (selected && models.length === 1) models[0].checked = true;
      });
    };
    const selectProfileDuration = (button) => {
      const isCustom = Boolean(button?.dataset.profileCustomDuration);
      profileDurationButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
      profileCustomDurationWrap.classList.toggle('hidden', !isCustom);
      profileDurationInput.value = isCustom ? profileCustomDuration.value : button?.dataset.profileDuration ?? profileDurationInput.value;
      if (isCustom) profileCustomDuration.focus();
    };
    const selectProfileKeepalive = (button) => {
      const isCustom = Boolean(button?.dataset.profileCustomKeepalive);
      profileKeepaliveButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
      profileCustomKeepaliveWrap.classList.toggle('hidden', !isCustom);
      profileKeepaliveInput.value = isCustom ? profileCustomKeepalive.value : button?.dataset.profileKeepalive ?? profileKeepaliveInput.value;
      if (isCustom) profileCustomKeepalive.focus();
    };
    targetInputs.forEach(input => input.addEventListener('change', syncTargets));
    profileDurationButtons.forEach(button => button.addEventListener('click', () => selectProfileDuration(button)));
    profileKeepaliveButtons.forEach(button => button.addEventListener('click', () => selectProfileKeepalive(button)));
    profileCustomDuration.addEventListener('input', () => selectProfileDuration(form.querySelector('[data-profile-custom-duration]')));
    profileCustomKeepalive.addEventListener('input', () => selectProfileKeepalive(form.querySelector('[data-profile-custom-keepalive]')));
    syncTargets();
    document.addEventListener('click', async (event) => {
      const copy = event.target.closest('[data-copy]');
      if (copy) {
        event.preventDefault();
        event.stopPropagation();
        const value = copy.dataset.copy;
        if (!value) return;
        await navigator.clipboard?.writeText(value);
        const previous = copy.textContent;
        copy.textContent = 'copied';
        setTimeout(() => { copy.textContent = previous; }, 900);
        return;
      }
      const opener = event.target.closest('[data-open-modal]');
      if (opener) document.getElementById(opener.dataset.openModal).hidden = false;
      if (event.target.closest('[data-close-modal]')) event.target.closest('.modal').hidden = true;
      if (event.target.classList?.contains('modal')) event.target.hidden = true;
    });
    if (${options.openCreate ? "true" : "false"}) document.querySelector('#profile-modal').hidden = false;
  </script>`);
}

export function profileEditorPage(
  user: AuthenticatedUser,
  targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>,
  deployments: ModelDeploymentSelectionView[],
  costs: Record<string, { hourlyUsd: number }>,
  options: { profile?: ReservationProfile; onboarding?: boolean; error?: string } = {}
): string {
  const initialTargetId = options.profile?.selections[0]?.targetId ?? targets[0]?.target.id ?? "";
  const heading = options.profile ? `Edit ${options.profile.name}` : "New reservation profile";
  return layout(heading, user, `${options.onboarding ? `<section class="panel"><p class="pill">Getting started</p><h1>Create your first profile</h1><p class="muted">Choose the target and model combinations used by this workflow. Nothing starts until you make a reservation.</p></section>` : ""}${options.error ? `<p class="status">${escapeHtml(options.error)}</p>` : ""}${profileCreateModal(targets, initialTargetId, options.onboarding ? "/" : "/profiles", deployments, costs, options.profile, true)}`);
}

function profileListCard(profile: ReservationProfile, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): string {
  const targetLookup = targetLookupForTargets(targets);
  const modelLookup = modelLookupForTargets(targets);
  const defaults = [profile.defaultDurationMinutes ? `${profile.defaultDurationMinutes} min duration` : "", profile.defaultKeepaliveMinutes ? `${profile.defaultKeepaliveMinutes} min keepalive` : ""].filter(Boolean).join(" | ");
  const selections = profile.selections.map((selection) => {
    const aliases = selection.modelIds.map((modelId) => modelLookup[modelId]?.recommendedAlias ?? modelId);
    const modelSummary = aliases.length ? aliases.map((alias) => `<span class="copy-chip">${escapeHtml(alias)}</span>`).join("") : `<span class="pill">All models</span>`;
    return `<div class="target-status-card"><div class="target-status-head"><strong>${escapeHtml(targetLookup[selection.targetId]?.displayName ?? selection.targetId)}</strong><span class="muted"><code>${escapeHtml(selection.targetId)}</code></span></div><div class="chip-row">${modelSummary}</div></div>`;
  }).join("");
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(profile.name)}</strong>${profile.description ? `<div class="muted">${escapeHtml(profile.description)}</div>` : ""}<div class="target-status-meta">${defaults ? `<span class="pill">${escapeHtml(defaults)}</span>` : ""}<span class="muted">${profile.selections.length} target selection${profile.selections.length === 1 ? "" : "s"}</span></div></div><div class="inline-actions"><a class="button secondary" href="/profiles/${escapeHtml(profile.id)}/edit">Edit</a><form method="post" action="/reservation-profiles/${escapeHtml(profile.id)}/delete"><button class="danger" type="submit">Delete</button></form></div></summary><div class="drilldown-body">${selections}</div></details>`;
}

export function reservationHistoryPage(user: AuthenticatedUser): string {
  return layout("Reservations", user, `<section class="panel">
    <h1>Reservations</h1>
    <div id="reservation-history"><p class="muted">Loading...</p></div>
  </section>
  <script type="module">
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    const formatDateTime = (iso) => iso ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '';
    const formatUsd = (value) => '$' + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value ?? 0);
    const statusBadge = (status) => '<span class="badge ' + escapeText(status) + '">' + escapeText(status) + '</span>';
    const pageSize = 20;
    const params = new URLSearchParams(window.location.search);
    let page = Math.max(1, Number(params.get('page') ?? '1') || 1);
    const reservationTime = (reservation) => {
      const expires = 'expires ' + formatDateTime(reservation.expiresAt);
      if (!reservation.endedAt) return expires;
      return expires + '<br><span class="muted">ended ' + formatDateTime(reservation.endedAt) + '</span>';
    };
    const row = (reservation) => '<tr><td><a href="/reservations/' + escapeText(reservation.reservationId) + '">' + escapeText(reservation.reservationId) + '</a></td><td>' + escapeText(reservation.displayUsername ?? reservation.username) + '</td><td>' + statusBadge(reservation.status) + '</td><td>' + reservationTime(reservation) + '</td><td>' + escapeText(reservation.targets.map(target => target.id).join(', ')) + '</td><td>' + escapeText(reservation.modelIds.length ? reservation.modelIds.join(', ') : 'All models') + '</td><td>' + (reservation.costEstimate ? formatUsd(reservation.costEstimate.estimatedCostUsd) : '') + '</td></tr>';
    const render = (data) => {
      const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
      const controls = '<div class="target-status-head"><div class="muted">' + data.total + ' reservations | expires newest first</div><div class="inline-actions"><button class="secondary" type="button" data-page="' + (data.page - 1) + '" ' + (data.page <= 1 ? 'disabled' : '') + '>Previous</button><span class="muted">Page ' + data.page + ' of ' + totalPages + '</span><button class="secondary" type="button" data-page="' + (data.page + 1) + '" ' + (data.page >= totalPages ? 'disabled' : '') + '>Next</button></div></div>';
      const table = data.reservations.length
        ? '<table><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Time</th><th>Targets</th><th>Models</th><th>Cost</th></tr></thead><tbody>' + data.reservations.map(row).join('') + '</tbody></table>'
        : '<p class="muted">No reservations recorded yet.</p>';
      document.querySelector('#reservation-history').innerHTML = controls + table;
    };
    async function load() {
      const response = await fetch('/api/admin/reservations?page=' + page + '&pageSize=' + pageSize + '&sort=expires_desc');
      if (!response.ok) return;
      const data = await response.json();
      page = data.page;
      params.set('page', String(page));
      window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
      render(data);
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled) return;
      page = Number(button.dataset.page);
      load();
    });
    load();
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

export function usagePage(user: AuthenticatedUser): string {
  return layout("Usage", user, `<section class="panel"><div class="target-status-head"><div><h1>Daily usage</h1><p class="muted">Cost and activated time are derived from durable activation allocations. Times are grouped by UTC day.</p></div><select id="usage-window"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></div><div id="usage-report"><p class="muted">Loading…</p></div></section>
  <script type="module">
    const root = document.querySelector('#usage-report');
    const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
    const money = value => '$' + Number(value ?? 0).toFixed(2);
    const table = (title, rows, date = false) => '<section class="panel"><h2>' + title + '</h2>' + (rows.length ? '<table><thead><tr><th>' + (date ? 'Date' : 'Name') + '</th><th>Reservations</th><th>Activated</th><th>Estimated cost</th></tr></thead><tbody>' + rows.map(row => '<tr><td>' + escapeText(row.label) + '</td><td>' + row.reservationCount + '</td><td>' + row.activatedMinutes.toFixed(1) + ' min</td><td>' + money(row.estimatedCostUsd) + '</td></tr>').join('') + '</tbody></table>' : '<p class="muted">No allocated usage in this window.</p>') + '</section>';
    async function load() {
      root.innerHTML = '<p class="muted">Loading…</p>';
      const response = await fetch('/api/admin/usage?days=' + document.querySelector('#usage-window').value);
      if (!response.ok) { root.textContent = 'Could not load usage.'; return; }
      const data = await response.json();
      root.innerHTML = '<div class="field-grid">' + table('By user', data.users) + table('By provider', data.providers) + table('By target', data.targets) + table('By model', data.models) + '</div>' + table('Daily', [...data.daily].sort((a,b) => b.key.localeCompare(a.key)), true);
    }
    document.querySelector('#usage-window').addEventListener('change', load); load();
  </script>`);
}

export function modelMetadataPage(user: AuthenticatedUser, deployments: ModelDeploymentSelectionView[], stored: ModelSelectionCatalogConfig): string {
  const capabilityByModel = new Map(stored.models.map((value) => [value.modelId, value]));
  const deploymentByKey = new Map(stored.deployments.map((value) => [`${value.targetId}::${value.modelId}`, value]));
  const models = Array.from(new Map(deployments.map((deployment) => [deployment.modelId, deployment])).values());
  const capabilityForms = models.map((model) => {
    const value = capabilityByModel.get(model.modelId);
    const domains = Object.entries(value?.domains ?? {}).map(([name, score]) => `${name}=${score}`).join(", ");
    const legacyQuantization = stored.deployments.find((deployment) => deployment.modelId === model.modelId && deployment.quantization)?.quantization;
    const quantization = value?.quantization ?? legacyQuantization;
    const technical = deployments.find((deployment) => deployment.modelId === model.modelId)?.technicalCapabilities ?? [];
    return `<details class="drilldown"><summary><div><strong>${escapeHtml(model.modelDisplayName)}</strong><div class="muted"><code>${escapeHtml(model.modelId)}</code></div></div><span class="pill">${value?.intelligence === undefined ? "Not rated" : `Intelligence ${formatMetric(value.intelligence)}`}</span></summary><div class="drilldown-body"><form data-model-metadata data-model-id="${escapeHtml(model.modelId)}"><div class="field-grid"><label>Intelligence (0–100)${helpTip("General model intelligence. The Good corner of the profile triangle increases the weight of this score.")}<br><input name="intelligence" type="number" min="0" max="100" step="0.1" value="${value?.intelligence ?? ""}"></label><label>Scored strengths (<code>tag=score</code>)${helpTip("Optional subject scores such as coding or reasoning. These refine Intelligence ranking; they are not binary runtime features.")}<br><input name="domains" value="${escapeHtml(domains)}" placeholder="coding=92, reasoning=88"></label><label>Quantization / artifact<br><input name="quantization" value="${escapeHtml(quantization?.format ?? "")}"></label><label>Estimated quality retained (%)${helpTip("Display-only measured retention for this model artifact relative to its named reference.")}<br><input name="retention" type="number" min="0" max="100" step="0.1" value="${quantization?.qualityRetentionPercent ?? ""}"></label><label>Reference artifact<br><input name="reference" value="${escapeHtml(quantization?.reference ?? "")}"></label><label>Source<br><input name="source" value="${escapeHtml(value?.provenance?.source ?? "")}" placeholder="Manual benchmark"></label><label>Version<br><input name="version" value="${escapeHtml(value?.provenance?.version ?? "")}"></label></div>${technical.length ? `<p><strong>Advertised technical capabilities:</strong> ${technical.map((capability) => `<span class="pill" title="${escapeHtml(capability.title ?? capability.label)}">${escapeHtml(capability.label)}</span>`).join(" ")}</p>` : `<p class="muted">The runtime has not advertised any recognized technical capability flags for this model.</p>`}<button type="submit">Save model data</button><span class="muted" data-save-status></span></form></div></details>`;
  }).join("");
  const deploymentForms = deployments.map((deployment) => {
    const value = deploymentByKey.get(deployment.key);
    const context = deployment.contextWindowTokens ? `${formatTokenCount(deployment.contextWindowTokens)} context (${deployment.contextSource ?? "target"})` : "Context not reported by target/model";
    return `<details class="drilldown"><summary><div><strong>${escapeHtml(deployment.modelDisplayName)}</strong><div class="muted">${escapeHtml(deployment.targetDisplayName)} · <code>${escapeHtml(deployment.key)}</code></div></div><span class="pill">${value?.performance?.decodeTokensPerSecond ? `${formatMetric(value.performance.decodeTokensPerSecond)} decode t/s` : "Not benchmarked"}</span></summary><div class="drilldown-body"><form data-deployment-metadata data-target-id="${escapeHtml(deployment.targetId)}" data-model-id="${escapeHtml(deployment.modelId)}"><p class="muted">${escapeHtml(context)}. Context is owned by the target/model configuration or runtime discovery and is not duplicated here.</p><div class="field-grid"><label>LiteLLM aliases (comma-separated)<br><input name="aliases" value="${escapeHtml(deployment.aliases.join(", "))}"></label><label>Decode tokens/s<br><input name="decode" type="number" min="0" step="0.01" value="${value?.performance?.decodeTokensPerSecond ?? ""}"></label><label>Prefill tokens/s<br><input name="prefill" type="number" min="0" step="0.01" value="${value?.performance?.prefillTokensPerSecond ?? ""}"></label><label>Source<br><input name="source" value="${escapeHtml(value?.provenance?.source ?? value?.performance?.provenance?.source ?? "")}" placeholder="NeurOn benchmark"></label><label>Version<br><input name="version" value="${escapeHtml(value?.provenance?.version ?? value?.performance?.provenance?.version ?? "")}"></label></div><button type="submit">Save deployment speed and aliases</button><span class="muted" data-save-status></span></form></div></details>`;
  }).join("");
  return layout("Model data", user, `<section class="panel"><h1>Model data</h1><p>Store model intelligence, scored strengths, artifact facts, and target-specific speed measurements in NeurOn.</p><p class="muted">Binary technical capabilities come from target/model configuration or runtime discovery. Only enter rating data you are permitted to store, with source and version provenance.</p></section><section class="panel"><h2>Model intelligence and artifact data</h2><div class="summary-list">${capabilityForms || `<p class="muted">No models are known.</p>`}</div></section><section class="panel"><h2>Target-specific speed and routing</h2><div class="summary-list">${deploymentForms || `<p class="muted">No deployments are known.</p>`}</div></section>
  <script type="module">
    const number = (form, name) => form.elements[name].value === '' ? undefined : Number(form.elements[name].value);
    const provenance = form => form.elements.source.value.trim() ? { source: form.elements.source.value.trim(), ...(form.elements.version.value.trim() ? { version: form.elements.version.value.trim() } : {}) } : undefined;
    document.addEventListener('submit', async event => {
      const form = event.target.closest('[data-model-metadata], [data-deployment-metadata]'); if (!form) return;
      event.preventDefault(); const status = form.querySelector('[data-save-status]'); status.textContent = ' Saving…';
      try {
        let path; let body;
        if (form.matches('[data-model-metadata]')) {
          const domains = Object.fromEntries(form.elements.domains.value.split(',').map(value => value.trim()).filter(Boolean).map(value => { const [key, score] = value.split('='); return [key.trim(), Number(score)]; }));
          const format = form.elements.quantization.value.trim(); const retention = number(form, 'retention'); const reference = form.elements.reference.value.trim();
          path = '/api/admin/model-metadata/models/' + encodeURIComponent(form.dataset.modelId);
          body = { intelligence: number(form, 'intelligence'), ...(Object.keys(domains).length ? { domains } : {}), ...(format ? { quantization: { format, ...(retention === undefined ? {} : { qualityRetentionPercent: retention }), ...(reference ? { reference } : {}) } } : {}), provenance: provenance(form) };
        } else {
          const aliases = form.elements.aliases.value.split(',').map(value => value.trim()).filter(Boolean);
          const aliasResponse = await fetch('/api/admin/targets/' + encodeURIComponent(form.dataset.targetId) + '/models/' + encodeURIComponent(form.dataset.modelId) + '/aliases', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aliases }) });
          if (!aliasResponse.ok) throw new Error((await aliasResponse.json()).error || 'Alias save failed');
          const decode = number(form, 'decode'); const prefill = number(form, 'prefill');
          path = '/api/admin/model-metadata/deployments/' + encodeURIComponent(form.dataset.targetId) + '/' + encodeURIComponent(form.dataset.modelId);
          body = { ...((decode || prefill) ? { performance: { ...(decode ? { decodeTokensPerSecond: decode } : {}), ...(prefill ? { prefillTokensPerSecond: prefill } : {}), measuredAt: new Date().toISOString(), sampleCount: 1 } } : {}), provenance: provenance(form) };
        }
        const response = await fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error((await response.json()).error || 'Save failed'); status.textContent = ' Saved';
      } catch (error) { status.textContent = ' ' + (error instanceof Error ? error.message : 'Save failed'); }
    });
  </script>`);
}

export function assistantConfigPage(user: AuthenticatedUser, deployments: ModelDeploymentSelectionView[], config?: AssistantConfig, error = ""): string {
  const options = deployments.map((deployment) => `<option value="${escapeHtml(JSON.stringify({ targetId: deployment.targetId, modelId: deployment.modelId }))}" ${config?.targetId === deployment.targetId && config.modelId === deployment.modelId ? "selected" : ""}>${escapeHtml(deployment.targetDisplayName)} · ${escapeHtml(deployment.modelDisplayName)}</option>`).join("");
  const reservationMinutes = config?.reservationMinutes ?? 15;
  const keepaliveMinutes = config?.keepaliveMinutes ?? 15;
  const choices = (kind: string, values: number[], selected: number) => values.map((value) => `<button class="choice" type="button" data-assistant-${kind}="${value}" aria-pressed="${String(value === selected)}">${value} min</button>`).join("");
  return layout("Assistant", user, `${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}<section class="panel"><h1>Assistant</h1><p>Select the existing NeurOn target and model that power the in-application assistant. The configuration is stored independently from targets and model-selection data.</p><p class="muted">The selected deployment must support OpenAI-compatible chat completions and function/tool calling. Asking a question may create a visible synthetic reservation and cold-start that target through normal reconciliation.</p></section><section class="panel"><form id="assistant-config-form"><input type="hidden" name="reservationMinutes" value="${reservationMinutes}"><input type="hidden" name="keepaliveMinutes" value="${keepaliveMinutes}"><label>Target and model${helpTip("The exact deployment NeurOn reserves and calls for assistant requests.")}<br><select name="deployment"><option value="">Disabled</option>${options}</select></label><div class="field-grid" style="margin-top:16px"><div><h2>Reservation duration${helpTip("How long the assistant reservation remains active. This is also the maximum cold-start wait for an individual request.")}</h2><div class="row">${choices("duration", [2, 5, 15, 30, 60], reservationMinutes)}</div></div><div><h2>Keepalive${helpTip("How long idle assistant capacity stays available after its reservation window, reducing repeated cold starts.")}</h2><div class="row">${choices("keepalive", [1, 2, 5, 15], keepaliveMinutes)}</div></div></div><label style="display:block;margin-top:16px">Additional system guidance${helpTip("Trusted local terminology, priorities, or workflow guidance appended to NeurOn's built-in Assistant prompt. Tool validation, authorization, and confirmation rules still apply. Do not enter credentials or private source data.")}<br><textarea name="additionalInstructions" maxlength="8000" rows="5" placeholder="Optional organization-specific guidance">${escapeHtml(config?.additionalInstructions ?? "")}</textarea></label><details style="margin-top:16px"><summary><strong>Advanced</strong></summary><label>Warm-model response timeout (seconds)${helpTip("Maximum time for the already-ready model to answer. Cold-start waiting uses Reservation duration instead.")}<br><input name="requestTimeoutSeconds" type="number" min="1" max="600" value="${config?.requestTimeoutSeconds ?? 300}"></label></details><div class="actions"><button type="submit">Save assistant settings</button><span class="muted" data-assistant-config-status></span></div></form></section>
  <script type="module">
    const form = document.querySelector('#assistant-config-form');
    const select = (kind, button) => { form.querySelectorAll('[data-assistant-' + kind + ']').forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button))); form.elements[kind === 'duration' ? 'reservationMinutes' : 'keepaliveMinutes'].value = button.dataset['assistant' + kind[0].toUpperCase() + kind.slice(1)]; };
    form.querySelectorAll('[data-assistant-duration]').forEach(button => button.addEventListener('click', () => select('duration', button)));
    form.querySelectorAll('[data-assistant-keepalive]').forEach(button => button.addEventListener('click', () => select('keepalive', button)));
    form.addEventListener('submit', async event => {
      event.preventDefault(); const status = form.querySelector('[data-assistant-config-status]'); status.textContent = ' Saving…';
      try {
        const deployment = form.elements.deployment.value ? JSON.parse(form.elements.deployment.value) : { targetId: null, modelId: null }; const { targetId, modelId } = deployment;
        const response = await fetch('/api/admin/assistant-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId, modelId, reservationMinutes: Number(form.elements.reservationMinutes.value), keepaliveMinutes: Number(form.elements.keepaliveMinutes.value), requestTimeoutSeconds: Number(form.elements.requestTimeoutSeconds.value), additionalInstructions: form.elements.additionalInstructions.value }) });
        if (!response.ok) throw new Error((await response.json()).error || 'Save failed'); status.textContent = ' Saved'; setTimeout(() => location.reload(), 250);
      } catch (caught) { status.textContent = ' ' + (caught instanceof Error ? caught.message : 'Save failed'); }
    });
  </script>`);
}

export interface UpdateSafetySummary {
  hassleOffConfigured: boolean;
  protectedTargets: number;
  totalTargets: number;
}

export function updatesPage(
  user: AuthenticatedUser,
  update: UpdateStatus,
  shutdown: ShutdownStatus,
  safety: UpdateSafetySummary,
  error = "",
  success = ""
): string {
  const updateMessage = !update.enabled
    ? "Update checks are disabled or this image does not contain build revision metadata."
    : update.error
      ? `The last update check failed: ${update.error}`
      : update.updateAvailable
        ? "A newer successfully built NeurOn image is available."
        : update.updateAvailable === false
          ? "This NeurOn instance matches the latest successful image build."
          : "The current image revision is unknown, so availability cannot be compared yet.";
  const hassleOffCoverage = safety.hassleOffConfigured && safety.totalTargets > 0 && safety.protectedTargets === safety.totalTargets;
  const targetRows = shutdown.targetStates.length
    ? shutdown.targetStates.map((target) => `<tr><td>${escapeHtml(target.displayName)}</td><td><code>${escapeHtml(target.id)}</code></td><td>${escapeHtml(target.desired)}</td><td><span class="pill ${escapeHtml(target.observed)}">${escapeHtml(target.observed)}</span></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">No targets configured.</td></tr>`;
  const activeRestart = shutdown.mode !== "idle";
  const releaseNotes = update.releaseNotes?.length
    ? `<div class="summary-list">${update.releaseNotes.map((note) => {
        const noteUrl = safeGithubRepositoryUrl(note.url, update.repository);
        return `<article class="target-status-card"><div class="target-status-head"><strong>${escapeHtml(note.title)}</strong>${note.revision ? `<code>${escapeHtml(note.revision)}</code>` : ""}</div>${note.details ? `<p>${escapeHtml(note.details)}</p>` : ""}${noteUrl ? `<a href="${escapeHtml(noteUrl)}" target="_blank" rel="noreferrer">View change</a>` : ""}</article>`;
      }).join("")}</div>`
    : `<p class="muted">${update.updateAvailable ? "No individual patch notes were published for this comparison." : "Patch notes appear here when an update is available."}</p>`;
  const compareUrl = safeGithubRepositoryUrl(update.compareUrl, update.repository);
  return layout("NeurOn Updates", user, `<section class="panel">
    <h1>Updates and restart</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    ${success ? `<p class="status">${escapeHtml(success)}</p>` : ""}
    <p class="status">${escapeHtml(updateMessage)}</p>
    <div class="field-grid">
      <p><strong>Current revision</strong><br><code>${escapeHtml(shortRevision(update.currentRevision))}</code></p>
      <p><strong>Latest successful revision</strong><br><code>${escapeHtml(shortRevision(update.latestRevision))}</code></p>
      <p><strong>Last checked</strong><br>${update.checkedAt ? escapeHtml(new Date(update.checkedAt).toLocaleString()) : "<span class=\"muted\">Not checked</span>"}</p>
    </div>
    <form method="post" action="/admin/updates/check"><button class="secondary" type="submit">Check now</button></form>
  </section>
  <section class="panel">
    <div class="target-status-head"><h2>What changes in this update</h2>${compareUrl ? `<a href="${escapeHtml(compareUrl)}" target="_blank" rel="noreferrer">Full comparison</a>` : ""}</div>
    ${update.releaseNotesError ? `<p class="status">Patch notes could not be loaded: ${escapeHtml(update.releaseNotesError)}</p>` : ""}
    ${releaseNotes}
  </section>
  <section class="panel">
    <h2>Restart safety</h2>
    <p class="status">${escapeHtml(shutdown.message)}</p>
    <div class="field-grid">
      <p><strong>Mode</strong><br><span class="badge ${shutdown.mode === "idle" ? "done" : "active"}">${escapeHtml(shutdown.mode)}</span></p>
      <p><strong>New reservations</strong><br>${shutdown.acceptingReservations ? "Accepted" : "Blocked while draining"}</p>
      <p><strong>Active reservations</strong><br>${shutdown.activeReservationCount}</p>
      <p><strong>Active discoveries</strong><br>${shutdown.activeDiscoveryCount}</p>
      <p><strong>In-flight reservation operations</strong><br>${shutdown.activeDemandMutationCount}</p>
    </div>
    <table><thead><tr><th>Target</th><th>ID</th><th>Desired</th><th>Observed</th></tr></thead><tbody>${targetRows}</tbody></table>
    ${activeRestart
      ? shutdown.mode === "stopping-targets" || shutdown.mode === "shutting-down"
        ? `<p class="muted">Shutdown is committed and can no longer be cancelled safely.</p>`
        : `<div class="actions"><form method="post" action="/admin/updates/cancel"><button class="secondary" type="submit">Cancel restart</button></form></div>`
      : `<p class="muted">Safe restart first enters drain mode. Existing reservations may finish, but new reservations, extensions, traffic keepalives, provisioning, and model discovery are blocked. NeurOn exits only after every target freshly reports stopped.</p><div class="actions"><form method="post" action="/admin/updates/schedule"><button type="submit">Restart when safe</button></form></div>`}
  </section>
  <section class="panel">
    <h2>Force restart</h2>
    <p class="status">Force restart can interrupt active reservations.</p>
    <p>${hassleOffCoverage
      ? `All ${safety.totalTargets} configured targets opt into HassleOff protection. Verify HassleOff is currently armed before relying on it.`
      : `HassleOff does not cover every configured target (${safety.protectedTargets}/${safety.totalTargets} protected). If NeurOn fails to restart, capacity left running may remain unmanaged and continue accruing cost.`}</p>
    <form method="post" action="/admin/updates/force">
      <p><label><input type="radio" name="stopTargets" value="yes" checked> End active reservations, stop every running target, verify all are stopped, then restart <strong>(recommended)</strong></label></p>
      <p><label><input type="radio" name="stopTargets" value="no"> Restart immediately without stopping targets</label></p>
      <p><label><input type="checkbox" name="acknowledgeRisk"> I understand that restarting without stopping targets can leave machines running if NeurOn does not return and HassleOff is unavailable.</label></p>
      <p><label>Type <code>RESTART</code> to confirm<br><input name="confirm" type="text" autocomplete="off" required></label></p>
      <button class="danger" type="submit">Force restart</button>
    </form>
  </section>
  ${activeRestart ? `<script>setTimeout(() => location.reload(), 3000);</script>` : ""}`);
}

function shortRevision(revision: string | undefined): string {
  return revision ? revision.slice(0, 12) : "unknown";
}

export function adminAuthPage(user: AuthenticatedUser, methods: AuthMethodView[], error = ""): string {
  const rows = methods.length ? methods.map(authMethodRow).join("") : `<p class="muted">No additional authentication methods configured.</p>`;
  return layout("NeurOn Auth", user, `<section class="panel">
    <h1>Authentication</h1>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    <h2>Add OIDC provider</h2>
    <p class="muted">Works with Okta and other OpenID Connect providers. Register <code>/auth/oidc/callback</code> beneath this NeurOn deployment's public URL.</p>
    ${oidcAuthForm("/admin/auth", {
      id: "okta",
      displayName: "Okta",
      enabled: true,
      issuer: "",
      clientId: "",
      secretSource: "environment",
      secretEnvironmentVariable: "AUTH_METHOD_OKTA_CLIENT_SECRET",
      scopes: "openid,profile,email",
      usernameClaim: "preferred_username",
      groupsClaim: "groups",
      allowedUsers: "",
      allowedGroups: ""
    }, "Add OIDC provider")}
  </section>
  <section class="panel">
    <h2>Add GitHub provider</h2>
    <form method="post" action="/admin/auth">
      <input name="type" type="hidden" value="github">
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
    const updateSecretFields = (form) => {
      const source = form.querySelector('[name="clientSecretSource"]')?.value;
      form.querySelectorAll('[data-secret-fields]').forEach(group => { group.hidden = group.dataset.secretFields !== source; });
    };
    document.querySelectorAll('[data-oidc-auth-form]').forEach(form => {
      updateSecretFields(form);
      form.querySelector('[name="clientSecretSource"]')?.addEventListener('change', () => updateSecretFields(form));
      const id = form.querySelector('[name="id"]');
      const env = form.querySelector('[name="clientSecretEnvironmentVariable"]');
      let generated = env?.value ?? '';
      id?.addEventListener('input', () => {
        if (!env || (env.value && env.value !== generated)) return;
        generated = 'AUTH_METHOD_' + id.value.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() + '_CLIENT_SECRET';
        env.value = generated;
      });
    });
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

interface OidcAuthFormValues {
  id: string;
  displayName: string;
  enabled: boolean;
  issuer: string;
  clientId: string;
  secretSource: "environment" | "aws-secrets-manager" | "stored";
  secretEnvironmentVariable?: string;
  secretId?: string;
  secretJsonKey?: string;
  scopes: string;
  usernameClaim: string;
  groupsClaim: string;
  allowedUsers: string;
  allowedGroups: string;
}

function oidcAuthForm(action: string, values: OidcAuthFormValues, buttonLabel: string): string {
  return `<form method="post" action="${escapeHtml(action)}" data-oidc-auth-form>
    <input name="type" type="hidden" value="oidc">
    <div class="field-grid">
      <p><label>ID<br><input name="id" type="text" value="${escapeHtml(values.id)}" required></label></p>
      <p><label>Display name<br><input name="displayName" type="text" value="${escapeHtml(values.displayName)}"></label></p>
    </div>
    <p><label><input name="enabled" type="checkbox" ${values.enabled ? "checked" : ""}> Enabled</label></p>
    <div class="field-grid">
      <p><label>Issuer URL<br><input name="issuer" type="url" value="${escapeHtml(values.issuer)}" placeholder="https://example.okta.com" required></label></p>
      <p><label>Client ID<br><input name="clientId" type="text" value="${escapeHtml(values.clientId)}" required></label></p>
    </div>
    <p><label>Client secret source<br><select name="clientSecretSource">
      <option value="environment" ${values.secretSource === "environment" ? "selected" : ""}>Environment variable (default)</option>
      <option value="aws-secrets-manager" ${values.secretSource === "aws-secrets-manager" ? "selected" : ""}>AWS Secrets Manager (recommended for production)</option>
      <option value="stored" ${values.secretSource === "stored" ? "selected" : ""}>Stored in NeurOn database</option>
    </select></label></p>
    <div data-secret-fields="environment"><p><label>Environment variable<br><input name="clientSecretEnvironmentVariable" type="text" value="${escapeHtml(values.secretEnvironmentVariable ?? "")}" placeholder="AUTH_METHOD_OKTA_CLIENT_SECRET"></label></p></div>
    <div data-secret-fields="aws-secrets-manager"><div class="field-grid">
      <p><label>Secret name or ARN<br><input name="clientSecretId" type="text" value="${escapeHtml(values.secretId ?? "")}" placeholder="/neuron/auth/okta"></label></p>
      <p><label>JSON key (optional)<br><input name="clientSecretJsonKey" type="text" value="${escapeHtml(values.secretJsonKey ?? "")}" placeholder="clientSecret"></label></p>
    </div><p class="muted">NeurOn resolves this at sign-in using its ECS task role. Grant only <code>secretsmanager:GetSecretValue</code> for the selected secret.</p></div>
    <div data-secret-fields="stored"><p><label>Client secret<br><input name="clientSecret" type="password" autocomplete="new-password" placeholder="${values.secretSource === "stored" ? "leave blank to keep current secret" : "client secret"}"></label></p><p class="status">This value is stored in NeurOn's database. Avoid this option in production.</p></div>
    <div class="field-grid">
      <p><label>Scopes<br><input name="scopes" type="text" value="${escapeHtml(values.scopes)}"></label></p>
      <p><label>Username claim<br><input name="usernameClaim" type="text" value="${escapeHtml(values.usernameClaim)}"></label></p>
      <p><label>Groups claim<br><input name="groupsClaim" type="text" value="${escapeHtml(values.groupsClaim)}"></label></p>
      <p><label>Allowed groups<br><input name="allowedGroups" type="text" value="${escapeHtml(values.allowedGroups)}" placeholder="neuron-users"></label></p>
      <p><label>Allowed users<br><input name="allowedUsers" type="text" value="${escapeHtml(values.allowedUsers)}" placeholder="alice@example.com"></label></p>
    </div>
    <div class="actions"><button type="submit">${escapeHtml(buttonLabel)}</button></div>
  </form>`;
}

function authMethodRow(method: AuthMethodView): string {
  const github = method.config.github;
  const oidc = method.config.oidc;
  const editAction = method.editable
    ? authMethodEditPanel(method)
    : `<form method="post" action="/admin/auth/${escapeHtml(method.id)}/copy-to-db"><button class="secondary" type="submit">Copy config auth to DB</button></form>`;
  const deleteAction = method.editable ? authMethodDeletePanel(method) : `<p class="muted">This method is loaded from environment config. Remove it from configuration or copy it to the database before deleting it here.</p>`;
  const details = oidc
    ? `<p><strong>Issuer:</strong> <code>${escapeHtml(oidc.issuer)}</code></p><p><strong>Client ID:</strong> <code>${escapeHtml(oidc.clientId)}</code></p><p><strong>Secret source:</strong> ${escapeHtml(oidcSecretSummary(oidc.clientSecret))}</p><p><strong>Username claim:</strong> <code>${escapeHtml(oidc.usernameClaim ?? "preferred_username")}</code></p><p><strong>Allowed groups:</strong> ${oidc.allowedGroups?.length ? escapeHtml(oidc.allowedGroups.join(", ")) : "<span class=\"muted\">None required</span>"}</p><p><strong>Allowed users:</strong> ${oidc.allowedUsers?.length ? escapeHtml(oidc.allowedUsers.join(", ")) : "<span class=\"muted\">Any assigned user</span>"}</p>`
    : `<p><strong>Client ID:</strong> <code>${escapeHtml(github?.clientId ?? "")}</code></p><p><strong>Allowed users:</strong> ${github?.allowedUsers?.length ? escapeHtml(github.allowedUsers.join(", ")) : "<span class=\"muted\">Any GitHub user</span>"}</p><p><strong>Allowed organizations:</strong> ${github?.allowedOrganizations?.length ? escapeHtml(github.allowedOrganizations.join(", ")) : "<span class=\"muted\">None required</span>"}</p>`;
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(method.displayName)}</strong><div class="muted"><code>${escapeHtml(method.id)}</code> | ${escapeHtml(method.type)} | ${method.enabled ? "enabled" : "disabled"}</div></div><span class="badge ${method.source === "persisted" ? "active" : "done"}">${escapeHtml(method.source)}</span></summary><div class="drilldown-body" data-tabs><div class="tabbar"><button type="button" data-tab="view" aria-selected="true">View</button><button type="button" data-tab="edit" aria-selected="false">Edit</button><button type="button" data-tab="delete" aria-selected="false">Delete</button></div><section class="tab-panel" data-tab-panel="view">${details}</section><section class="tab-panel" data-tab-panel="edit" hidden>${editAction}</section><section class="tab-panel" data-tab-panel="delete" hidden>${deleteAction}</section></div></details>`;
}

function authMethodEditPanel(method: AuthMethodView): string {
  const oidc = method.config.oidc;
  if (oidc) {
    const reference = oidc.clientSecret;
    return oidcAuthForm(`/admin/auth/${method.id}/update`, {
      id: method.id,
      displayName: method.displayName,
      enabled: method.enabled,
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      secretSource: reference.source,
      secretEnvironmentVariable: reference.source === "environment" ? reference.environmentVariable : undefined,
      secretId: reference.source === "aws-secrets-manager" ? reference.secretId : undefined,
      secretJsonKey: reference.source === "aws-secrets-manager" ? reference.jsonKey : undefined,
      scopes: (oidc.scopes?.length ? oidc.scopes : ["openid", "profile", "email"]).join(","),
      usernameClaim: oidc.usernameClaim ?? "preferred_username",
      groupsClaim: oidc.groupsClaim ?? "groups",
      allowedUsers: oidc.allowedUsers?.join(",") ?? "",
      allowedGroups: oidc.allowedGroups?.join(",") ?? ""
    }, "Save auth method");
  }
  const github = method.config.github;
  return `<form method="post" action="/admin/auth/${escapeHtml(method.id)}/update">
    <input name="type" type="hidden" value="github">
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

function oidcSecretSummary(reference: NonNullable<AuthMethod["config"]["oidc"]>["clientSecret"]): string {
  if (reference.source === "environment") return `Environment variable: ${reference.environmentVariable}`;
  if (reference.source === "aws-secrets-manager") return `AWS Secrets Manager: ${reference.secretId}${reference.jsonKey ? ` (JSON key: ${reference.jsonKey})` : ""}`;
  return "Stored in NeurOn database (value hidden)";
}

function authMethodDeletePanel(method: AuthMethodView): string {
  return `<p class="muted">Type <code>${escapeHtml(method.id)}</code> to delete this auth method.</p>
  <form method="post" action="/admin/auth/${escapeHtml(method.id)}/delete">
    <p><label>Method ID<br><input name="confirmName" type="text" autocomplete="off" required></label></p>
    <button class="danger" type="submit">Delete auth method</button>
  </form>`;
}

export function targetAdminPage(user: AuthenticatedUser, targets: TargetView[], providers: ProviderView[], runtimeProfiles: RuntimeProfile[] = [], error = "", createdTargetId = "", statusPollSeconds = 5): string {
  const rows = targets.length
    ? targets.map((target) => targetRow(target, providers, runtimeProfiles)).join("")
    : `<p class="muted">No targets configured</p>`;
  const addTarget = providers.length > 0
    ? `<button type="button" data-open-modal="target-modal">Add target</button>`
    : `<a href="/admin/providers">Add a provider first</a>`;
  const modal = providers.length > 0 ? targetCreateModal(providers, runtimeProfiles) : "";
  return layout("NeurOn Targets", user, `<section class="panel">
    <div class="target-status-head"><h1>Targets</h1><div class="inline-actions"><button class="secondary" type="button" data-rediscover-all>Rediscover and benchmark all</button>${addTarget}</div></div>
    <p class="muted" data-rediscover-all-status>Runs targets one at a time. Each target is discovered, briefly benchmarked, and returned through the normal demand controller before the next target begins.</p>
    ${error ? `<p class="status">${escapeHtml(error)}</p>` : ""}
    ${createdTargetId ? `<div class="secret-box"><span>Target <code>${escapeHtml(createdTargetId)}</code> was created.</span><button type="button" data-provision-target="${escapeHtml(createdTargetId)}">Provision target</button></div>` : ""}
    <div class="summary-list">${rows}</div>
  </section>
  ${modal}
  <script type="module">
    ${targetAdminScript(providers, runtimeProfiles, statusPollSeconds)}
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
      <div id="aws-ec2-target-fields">
        <p><label>AWS EC2 instance ID<br><input name="awsInstanceId" type="text" placeholder="i-1234567890abcdef0"></label></p>
        ${ec2InstanceDiscoveryControls()}
        <p><label>Runtime port<br><input name="awsRuntimePort" type="number" min="1" max="65535" placeholder="8080"></label></p>
        <p class="muted">NeurOn starts, stops, and inspects this pre-created instance. Runtime URLs default to <code>http://&lt;private-ip&gt;:8080/v1</code> and <code>/health</code>.</p>
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
        <p><label>Hourly cost override (USD)<br><input name="estimatedHourlyCostUsd" type="number" min="0" step="0.000001" placeholder="leave empty for provider discovery"></label></p>
        <p><label>Configured model IDs<br><input name="modelIds" type="text" placeholder="qwen-3.6,gemma-4"></label></p>
        <p><label>Hosting mode<br><select name="hostingMode"><option value="">Unknown</option><option value="dedicated">Dedicated model host</option><option value="multi-model">Multi-model host</option></select></label></p>
        <p><label>LiteLLM alias priority<br><input name="aliasPriority" type="number" min="1" step="1" value="100"></label></p>
        <p class="muted">Lower priorities are tried first; later targets become ordered fallbacks for colliding aliases.</p>
        <p><label>LiteLLM model route prefixes<br><input name="trafficModelPrefixes" type="text" placeholder="defaults to &lt;target-id&gt;/"></label></p>
        <p class="muted">Comma-separated prefixes link matching LiteLLM model names and traffic to this target. When omitted, NeurOn uses <code>&lt;target-id&gt;/</code>.</p>
        <p><label>LiteLLM credential name override<br><input name="litellmCredentialName" type="text" placeholder="neuron/&lt;target-id&gt;"></label></p>
        <p><label>Runtime API key environment variable<br><input name="litellmApiKeyEnv" type="text" placeholder="PREFER_TARGET_API_KEY"></label></p>
        <p class="muted">NeurOn reads this environment variable only while synchronizing the target credential; the key is not stored in target configuration.</p>
        <p><label><input name="litellmSyncDisabled" type="checkbox"> Disable discovered-model synchronization to LiteLLM</label></p>
        <p class="muted">Leave models empty to rely on runtime discovery.</p>
      </details>
      <div class="actions"><button type="submit">Add target</button></div>
    </form>
    </div>
  </div>`;
}

function ec2InstanceDiscoveryControls(): string {
  return `<div class="inline-actions"><button class="secondary" type="button" data-discover-ec2-instances>Find EC2 instances</button></div>
  <p><label>Discovered instances<br><select data-ec2-instance-results hidden><option value="">Choose an instance</option></select></label></p>
  <p class="muted" data-ec2-discovery-status>Uses the selected provider's Name-tag pattern.</p>`;
}

function ec2InstanceDiscoveryScript(): string {
  return `
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-discover-ec2-instances]');
      if (!button) return;
      event.preventDefault();
      const form = button.closest('form');
      const providerId = form?.querySelector('select[name="providerId"]')?.value;
      const results = form?.querySelector('[data-ec2-instance-results]');
      const status = form?.querySelector('[data-ec2-discovery-status]');
      if (!providerId || !results || !status) return;
      button.disabled = true;
      status.textContent = 'Looking for EC2 instances...';
      try {
        const response = await fetch('/api/admin/providers/' + encodeURIComponent(providerId) + '/resources');
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'EC2 instance discovery failed');
        const resources = body.resources ?? [];
        results.innerHTML = '<option value="">Choose an instance</option>' + resources.map(resource => {
          const details = resource.details ?? {};
          const suffix = [resource.state, details.instanceType, details.availabilityZone, details.privateIpAddress].filter(Boolean).join(' | ');
          const label = resource.displayName + ' (' + resource.id + ')' + (suffix ? ' — ' + suffix : '');
          return '<option value="' + escapeText(resource.id) + '">' + escapeText(label) + '</option>';
        }).join('');
        results.hidden = resources.length === 0;
        status.textContent = resources.length === 0 ? 'No matching EC2 instances were found.' : 'Found ' + resources.length + ' instance' + (resources.length === 1 ? '.' : 's.');
      } catch (error) {
        results.hidden = true;
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    });
    document.addEventListener('change', (event) => {
      const results = event.target.closest?.('[data-ec2-instance-results]');
      if (!results?.value) return;
      const form = results.closest('form');
      const instanceInput = form?.querySelector('input[name="awsInstanceId"]');
      if (instanceInput) instanceInput.value = results.value;
    });
  `;
}

function targetAdminScript(providers: ProviderView[], runtimeProfiles: RuntimeProfile[], statusPollSeconds: number): string {
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
      const button = event.target.closest('[data-rediscover-all]');
      if (!button) return;
      event.preventDefault(); button.disabled = true;
      const status = document.querySelector('[data-rediscover-all-status]'); status.textContent = 'Rediscovery is running one target at a time…';
      try {
        const response = await fetch('/api/admin/targets/rediscover-all', { method: 'POST' });
        const result = await response.json();
        const failures = result.results?.filter(item => !item.ok) ?? [];
        status.textContent = failures.length ? (result.results.length - failures.length) + ' succeeded; ' + failures.length + ' failed. ' + failures.map(item => item.targetId + ': ' + item.error).join(' | ') : 'All targets were rediscovered and benchmarked.';
      } catch { status.textContent = 'Rediscovery failed before a result was returned.'; }
      finally { button.disabled = false; await refreshTargetStatus(); }
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
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-target-action]');
      if (!button) return;
      event.preventDefault();
      const targetId = button.dataset.targetId;
      const action = button.dataset.targetAction;
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Working...';
      const response = await fetch('/api/admin/targets/' + encodeURIComponent(targetId) + '/' + action, { method: 'POST' });
      const result = await response.json().catch(() => ({}));
      button.textContent = response.ok ? 'Done' : 'Failed';
      if (!response.ok) {
        const message = result.error || 'The target operation failed without a detailed response.';
        window.alert(message);
      }
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
    ${ec2InstanceDiscoveryScript()}
    const provider = document.querySelector('#target-modal select[name="providerId"]');
    const runtimeProfile = document.querySelector('#target-modal select[name="runtimeProfileId"]');
    const runtimeProfileVariant = document.querySelector('#target-modal select[name="runtimeProfileVariantId"]');
    const runtimeNote = document.querySelector('#target-runtime-profile-note');
    const dockerModelVolumeInput = document.querySelector('#target-modal input[name="dockerModelVolume"]');
    dockerModelVolumeInput?.addEventListener('input', () => { dockerModelVolumeInput.dataset.touched = 'true'; });
    const runpod = document.querySelector('#runpod-target-fields');
    const aws = document.querySelector('#aws-target-fields');
    const awsEc2 = document.querySelector('#aws-ec2-target-fields');
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
      awsEc2.hidden = type !== 'aws-ec2';
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
    const discoveryCache = (target) => target.runtimeModelDiscovery?.cached
      ? '<span class="muted">Discovery cached ' + escapeText(new Date(target.runtimeModelDiscovery.discoveredAt).toLocaleString()) + '</span>'
      : '<span class="muted">No discovery cache</span>';
    const startupDiscovery = (target) => target.runtimeModelDiscovery?.startupOutcome
      ? '<span class="muted">Startup discovery: ' + escapeText(target.runtimeModelDiscovery.startupOutcome.reason) + '</span>'
      : '';
    const statusCard = (target) => '<div class="target-status-meta">' + statusPill(target.desired) + statusPill(target.observed) + '<span class="muted">' + escapeText(target.message) + '</span>' + discoveryCache(target) + startupDiscovery(target) + (target.activeUsers?.length ? '<span class="muted">Users: ' + escapeText(target.activeUsers.join(', ')) + '</span>' : '<span class="muted">No active users</span>') + (target.needsProvisioning ? '<button type="button" data-provision-target="' + escapeText(target.id) + '">Provision</button>' : '') + '</div>';
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
    setInterval(refreshTargetStatus, ${statusPollSeconds * 1000});
  `;
}

function targetRow(target: TargetView, providers: ProviderView[], runtimeProfiles: RuntimeProfile[]): string {
  const details = targetDetails(target);
  const editAction = target.editable
    ? targetEditPanel(target, providers, runtimeProfiles)
    : `<p class="muted">Copy this target to the database before editing settings such as LiteLLM model route prefixes.</p><form method="post" action="/admin/targets/${escapeHtml(target.id)}/copy-to-db"><button class="secondary" type="submit">Copy to DB</button></form>`;
  const deleteAction = target.editable ? targetDeletePanel(target) : `<p class="muted">This target is loaded from declarative config. Remove it from configuration or copy it to the database before deleting it here.</p>`;
  const users = target.modelIds.length > 0 ? `${target.modelIds.length} configured models` : "Discovery";
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(target.displayName)}</strong><div class="target-status-meta"><span class="pill off">${escapeHtml(target.provider)}</span><span class="muted"><code>${escapeHtml(target.id)}</code></span><span class="muted">${escapeHtml(users)}</span></div><div data-target-status="${escapeHtml(target.id)}"><p class="muted">Loading status...</p></div></div><span class="badge ${target.source === "persisted" ? "active" : "done"}">${escapeHtml(target.source)}</span></summary><div class="drilldown-body" data-tabs><div class="tabbar"><button type="button" data-tab="view" aria-selected="true">View</button><button type="button" data-tab="json" aria-selected="false">JSON</button><button type="button" data-tab="env" aria-selected="false">ENV</button><button type="button" data-tab="edit" aria-selected="false">Edit</button><button type="button" data-tab="delete" aria-selected="false">Delete</button></div>${details}<section class="tab-panel" data-tab-panel="edit" hidden><p class="muted">${target.editable ? "This target is stored in the database." : "This target is loaded from declarative config."}</p>${editAction}</section><section class="tab-panel" data-tab-panel="delete" hidden>${deleteAction}</section></div></details>`;
}

export function hassleOffSafetyPage(user: AuthenticatedUser, view: HassleOffSafetyView): string {
  const servicePills = [
    safetyPill("configured", view.configured),
    safetyPill("reachable", view.reachable),
    safetyPill("healthy", view.healthy),
    safetyPill("ready", view.ready),
    safetyPill("armed", view.armed)
  ].join("");
  const lastSuccess = safeDateLabel(view.lastSuccessfulFailSafeTestAt) ?? "Never";
  const target = view.failSafeTestTarget;
  const testAvailability = target.eligible
    ? `<span class="badge active">synthetic fake target</span>`
    : `<span class="badge failed">not eligible</span>`;
  const runForm = view.csrfToken
    ? `<form method="post" action="/admin/hassleoff/fail-safe-test" data-fail-safe-test-form data-target-id="${escapeHtml(target.targetId)}">
        <input type="hidden" name="csrfToken" value="${escapeHtml(view.csrfToken)}">
        <p><label><input type="checkbox" name="confirm" value="yes" required> I confirm this test is synthetic and must not call a real provider action.</label></p>
        <div class="inline-actions">
          <button type="submit" data-fail-safe-test-button>Run fail-safe test</button>
          <span class="muted" role="status" aria-live="polite" data-fail-safe-test-status></span>
        </div>
      </form>`
    : `<p class="muted">The command is available only when HassleOff is reachable, ready, armed, the configured target is registered as <code>testOnly</code> with a <code>fake</code> action, and <code>COOKIE_SECRET</code> is configured.</p>`;
  const capacityTargets = view.targets.length
    ? view.targets.map((capacityTarget) => `<section class="target-status-card">
        <div class="target-status-head">
          <div><strong>${escapeHtml(capacityTarget.displayName)}</strong><div class="muted"><code>${escapeHtml(capacityTarget.id)}</code></div></div>
          <span class="badge ${capacityTarget.protected ? "active" : "done"}">${capacityTarget.protected ? "protected" : "unprotected"}</span>
        </div>
        <div class="target-status-meta">
          <span class="pill ${capacityTarget.registered ? "healthy" : "off"}">${capacityTarget.registered ? "registered" : "not registered"}</span>
          ${capacityTarget.registrationActionType ? `<span class="pill">${escapeHtml(capacityTarget.registrationActionType)}</span>` : ""}
          ${capacityTarget.registrationTestOnly ? `<span class="pill">testOnly</span>` : ""}
          ${capacityTarget.registrationArmed ? `<span class="pill healthy">armed</span>` : ""}
          ${capacityTarget.leaseDurationSeconds ? `<span class="muted">Lease ${capacityTarget.leaseDurationSeconds}s</span>` : ""}
        </div>
      </section>`).join("")
    : `<p class="muted">No NeurOn capacity targets are configured.</p>`;
  return layout("HassleOff safety", user, `<section class="panel">
    <h1>HassleOff safety</h1>
    <p class="muted">Controller-token requests are made by NeurOn on the server. The token is never sent to this page.</p>
    <div class="target-status-meta">${servicePills}</div>
    ${view.baseUrl ? `<p><strong>Controller URL:</strong> <code>${escapeHtml(view.baseUrl)}</code></p>` : `<p><strong>Controller URL:</strong> <span class="muted">Not configured</span></p>`}
    ${view.diagnostic ? `<p class="status" role="alert">${escapeHtml(view.diagnostic)}</p>` : ""}
    ${view.registrationIssues.length ? `<div role="alert"><strong>Registration issues</strong><ul>${view.registrationIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul></div>` : ""}
  </section>
  <section class="panel">
    <h2>HassleOff fail-safe test</h2>
    ${view.success ? `<div class="secret-box" role="status">${escapeHtml(view.success)}</div>` : ""}
    ${view.error ? `<p class="status" role="alert">${escapeHtml(view.error)}</p>` : ""}
    <p><strong>Last successful fail-safe test:</strong> ${escapeHtml(lastSuccess)}${view.lastSuccessfulFailSafeTestAuditEventId !== undefined ? ` <span class="muted">(audit #${escapeHtml(String(view.lastSuccessfulFailSafeTestAuditEventId))})</span>` : ""}</p>
    <div class="target-status-card">
      <div class="target-status-head"><div><strong>${escapeHtml(target.targetId)}</strong><div class="muted">Configured synthetic target</div></div>${testAvailability}</div>
      <div class="target-status-meta">
        <span class="pill ${target.registered ? "healthy" : "off"}">${target.registered ? "registered" : "not registered"}</span>
        ${target.actionType ? `<span class="pill">${escapeHtml(target.actionType)}</span>` : ""}
        ${target.testOnly ? `<span class="pill">testOnly</span>` : ""}
        ${target.armed ? `<span class="pill healthy">armed</span>` : ""}
      </div>
    </div>
    <p class="muted">The button calls the authenticated <code>/trip-test</code> API behind this fail-safe test. Both NeurOn and HassleOff reject any target that is not explicitly <code>testOnly</code> with a <code>fake</code> action.</p>
    ${runForm}
  </section>
  <section class="panel">
    <h2>NeurOn target protection</h2>
    <div class="status-grid">${capacityTargets}</div>
  </section>
  <script type="module">
    const form = document.querySelector('[data-fail-safe-test-form]');
    form?.addEventListener('submit', (event) => {
      if (!form.checkValidity()) return;
      const targetId = form.dataset.targetId;
      if (!window.confirm('Run the synthetic HassleOff fail-safe test for ' + targetId + '? No real provider action is permitted.')) {
        event.preventDefault();
        return;
      }
      const button = form.querySelector('[data-fail-safe-test-button]');
      const status = form.querySelector('[data-fail-safe-test-status]');
      button.disabled = true;
      button.textContent = 'Running fail-safe test...';
      status.textContent = 'Waiting for the complete lease-expiry and fake-action path.';
    });
  </script>`);
}

function safetyPill(label: string, value: boolean | undefined): string {
  const state = value === undefined ? "unknown" : value ? "yes" : "no";
  const css = value === true ? "healthy" : value === false ? "failed" : "off";
  return `<span class="pill ${css}">${escapeHtml(label)}: ${state}</span>`;
}

function safeDateLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : undefined;
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
    <div data-edit-provider-fields="aws-ec2">
      <p><label>AWS EC2 instance ID<br><input name="awsInstanceId" type="text" value="${escapeHtml(target.aws?.instanceId ?? "")}"></label></p>
      ${ec2InstanceDiscoveryControls()}
      <p><label>Runtime port<br><input name="awsRuntimePort" type="number" min="1" max="65535" value="${escapeHtml(String(target.aws?.runtimePort ?? ""))}" placeholder="8080"></label></p>
      <p class="muted">Runtime URLs default from the instance private address; explicit URL overrides still win.</p>
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
      <p><label>API URL override<br><input name="apiUrl" type="text" value="${escapeHtml(target.apiUrl ?? target.litellm?.apiBaseUrl ?? "")}"></label></p>
      <p><label>Health URL override<br><input name="healthUrl" type="text" value="${escapeHtml(target.healthUrl ?? "")}"></label></p>
      <p><label>Hourly cost override (USD)<br><input name="estimatedHourlyCostUsd" type="number" min="0" step="0.000001" value="${escapeHtml(String(target.costEstimate?.hourlyUsd ?? ""))}" placeholder="leave empty for provider discovery"></label></p>
      <p><label>Configured model IDs<br><input name="modelIds" type="text" value="${escapeHtml(target.modelIds.join(","))}"></label></p>
      <p><label>Hosting mode<br><select name="hostingMode"><option value="" ${target.hostingMode ? "" : "selected"}>Unknown</option><option value="dedicated" ${target.hostingMode === "dedicated" ? "selected" : ""}>Dedicated model host</option><option value="multi-model" ${target.hostingMode === "multi-model" ? "selected" : ""}>Multi-model host</option></select></label></p>
      <p><label>LiteLLM alias priority<br><input name="aliasPriority" type="number" min="1" step="1" value="${target.aliasPriority ?? 100}"></label></p>
      <p class="muted">Lower priorities are preferred; matching aliases on higher-numbered targets are fallbacks.</p>
      <p><label>LiteLLM model route prefixes<br><input name="trafficModelPrefixes" type="text" value="${escapeHtml(target.trafficModelPrefixes?.join(",") ?? "")}" placeholder="defaults to ${escapeHtml(target.id)}/"></label></p>
      <p class="muted">Comma-separated prefixes link matching LiteLLM model names and traffic to this target. When omitted, NeurOn uses <code>${escapeHtml(target.id)}/</code>.</p>
      <p><label>LiteLLM credential name override<br><input name="litellmCredentialName" type="text" value="${escapeHtml(target.litellm?.credentialName ?? "")}" placeholder="neuron/${escapeHtml(target.id)}"></label></p>
      <p><label>Runtime API key environment variable<br><input name="litellmApiKeyEnv" type="text" value="${escapeHtml(target.litellm?.apiKeyEnv ?? "")}" placeholder="PREFER_TARGET_API_KEY"></label></p>
      <p class="muted">The secret value is injected into NeurOn at runtime and is never stored with the target.</p>
      <p><label><input name="litellmSyncDisabled" type="checkbox" ${target.litellm?.syncDiscoveredModels === false ? "checked" : ""}> Disable discovered-model synchronization to LiteLLM</label></p>
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
    ["LiteLLM route prefixes", litellmRoutePrefixes(target).join(", ")],
    ["LiteLLM credential", target.litellm?.credentialName ?? `neuron/${target.id}`],
    ["Runtime API key environment variable", target.litellm?.apiKeyEnv],
    ["Docker container", target.docker?.containerName],
    ["Docker image", target.docker?.image],
    ["Docker volumes", target.docker?.volumes?.join(", ")],
    ["RunPod Pod", target.runpod?.podId],
    ["AWS cluster", target.aws?.cluster ?? target.aws?.clusterName],
    ["AWS service", target.aws?.service ?? target.aws?.serviceName],
    ["AWS ASG", target.aws?.autoScalingGroupName],
    ["AWS EC2 instance", target.aws?.instanceId],
    ["AWS runtime port", target.aws?.runtimePort === undefined ? undefined : String(target.aws.runtimePort)],
    ["Hourly cost override", target.costEstimate?.hourlyUsd === undefined ? undefined : `$${target.costEstimate.hourlyUsd.toFixed(6)}`],
    ["Remote NeurOn target", target.neuron?.targetId]
  ].filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "");
  const view = `<table><tbody>${viewRows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`).join("")}</tbody></table>`;
  const operations = `<p class="muted">Discover models now refreshes the cached runtime catalog and may activate a stopped target.</p><div class="inline-actions" style="margin-top: 12px;"><button type="button" data-target-action="discover" data-target-id="${escapeHtml(target.id)}">Discover models now</button><button class="secondary" type="button" data-target-action="reconcile" data-target-id="${escapeHtml(target.id)}">Reconcile</button><button class="danger" type="button" data-target-action="force-stop" data-target-id="${escapeHtml(target.id)}">Force stop</button></div>`;
  return `<section class="tab-panel" data-tab-panel="view">${view}${operations}</section><section class="tab-panel" data-tab-panel="json" hidden><div class="inline-actions"><button type="button" data-copy="${escapeHtml(declarative)}">Copy JSON</button></div><pre>${escapeHtml(declarative)}</pre></section><section class="tab-panel" data-tab-panel="env" hidden><p class="muted">Profiles are create-time templates; ENV shows the expanded target config.</p><div class="inline-actions"><button type="button" data-copy="${escapeHtml(env)}">Copy ENV</button></div><pre>${escapeHtml(env)}</pre></section>`;
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
    litellm: target.litellm,
    costEstimate: target.costEstimate
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
    target.aws?.instanceId ? envLine(`${prefix}_AWS_INSTANCE_ID`, target.aws.instanceId) : "",
    target.aws?.runtimePort ? envLine(`${prefix}_AWS_RUNTIME_PORT`, String(target.aws.runtimePort)) : "",
    target.aws?.runtimeProtocol ? envLine(`${prefix}_AWS_RUNTIME_PROTOCOL`, target.aws.runtimeProtocol) : "",
    target.aws?.healthPath ? envLine(`${prefix}_AWS_HEALTH_PATH`, target.aws.healthPath) : "",
    target.aws?.apiPath ? envLine(`${prefix}_AWS_API_PATH`, target.aws.apiPath) : "",
    target.costEstimate?.hourlyUsd !== undefined ? envLine(`${prefix}_ESTIMATED_HOURLY_COST_USD`, String(target.costEstimate.hourlyUsd)) : "",
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
    target.litellm?.apiBaseUrl ? envLine(`${prefix}_LITELLM_API_BASE_URL`, target.litellm.apiBaseUrl) : "",
    target.litellm?.credentialName ? envLine(`${prefix}_LITELLM_CREDENTIAL_NAME`, target.litellm.credentialName) : "",
    target.litellm?.apiKeyEnv ? envLine(`${prefix}_LITELLM_API_KEY_ENV`, target.litellm.apiKeyEnv) : "",
    target.litellm?.syncDiscoveredModels === false ? envLine(`${prefix}_LITELLM_SYNC_DISCOVERED_MODELS`, "false") : ""
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
      <div id="aws-ec2-provider-fields">
        <p><label>Instance Name-tag pattern<br><input name="awsEc2InstanceNamePattern" type="text" placeholder="${DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN}"></label></p>
        <p class="muted">Defaults to <code>${DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN}</code>. Find instances limits discovery to this wildcard pattern. Start/stop authorization remains enforced by IAM.</p>
      </div>
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
    const awsEc2ProviderFields = document.querySelector('#aws-ec2-provider-fields');
    const notes = {
      runpod: 'RunPod account access will come from the runtime environment or a future credentials record.',
      neuron: 'External NeurOn providers will need a NeurOn API key once credentials are modeled.',
      'aws-ec2': 'AWS uses the NeurOn runtime role to start, stop, and inspect a pre-created EC2 instance.',
      'aws-ecs-asg': 'AWS uses the NeurOn runtime role for ordinary lifecycle operations.',
      docker: 'Docker providers use the local Docker daemon available to NeurOn.',
      'docker-compose': 'Docker Compose providers use target-level project and service settings.'
    };
    const sync = () => {
      note.textContent = notes[type.value] ?? '';
      awsEc2ProviderFields.hidden = type.value !== 'aws-ec2';
    };
    type?.addEventListener('change', sync);
    sync();
    document.querySelectorAll('[data-provider-edit-form]').forEach(form => {
      const providerType = form.querySelector('select[name="type"]');
      const sections = [...form.querySelectorAll('[data-provider-config-fields]')];
      const syncProviderEdit = () => sections.forEach(section => {
        section.hidden = section.dataset.providerConfigFields !== providerType.value;
      });
      providerType?.addEventListener('change', syncProviderEdit);
      syncProviderEdit();
    });
    const targetProviders = ${safeJson(Object.fromEntries(providers.map((provider) => [provider.id, provider.type])))};
    const runtimeProfiles = ${safeJson(Object.fromEntries(runtimeProfiles.map((profile) => [profile.id, profile])))};
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-discover-provider-resources]');
      if (!button) return;
      event.preventDefault();
      const panel = button.closest('[data-provider-resource-discovery]');
      const providerId = panel?.dataset.providerId;
      const status = panel?.querySelector('[data-provider-resource-status]');
      const list = panel?.querySelector('[data-provider-resource-list]');
      if (!providerId || !status || !list) return;
      button.disabled = true;
      status.textContent = 'Looking for EC2 instances...';
      try {
        const response = await fetch('/api/admin/providers/' + encodeURIComponent(providerId) + '/resources');
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'EC2 instance discovery failed');
        const resources = body.resources ?? [];
        status.textContent = resources.length === 0 ? 'No matching EC2 instances were found.' : 'Found ' + resources.length + ' instance' + (resources.length === 1 ? '.' : 's.');
        list.innerHTML = resources.map(resource => {
          const details = resource.details ?? {};
          const metadata = [resource.state, details.instanceType, details.availabilityZone, details.privateIpAddress].filter(Boolean).join(' | ');
          return '<div class="target-status-card"><strong>' + escapeText(resource.displayName) + '</strong><div><code>' + escapeText(resource.id) + '</code></div><div class="muted">' + escapeText(metadata) + '</div></div>';
        }).join('');
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        list.innerHTML = '';
      } finally {
        button.disabled = false;
      }
    });
    ${ec2InstanceDiscoveryScript()}
    const targetProvider = document.querySelector('#provider-target-modal select[name="providerId"]');
    const runtimeProfile = document.querySelector('#provider-target-modal select[name="runtimeProfileId"]');
    const runtimeProfileVariant = document.querySelector('#provider-target-modal select[name="runtimeProfileVariantId"]');
    const runpodTarget = document.querySelector('#provider-target-modal [data-provider-fields="runpod"]');
    const dockerTarget = document.querySelector('#provider-target-modal [data-provider-fields="docker"]');
    const awsTarget = document.querySelector('#provider-target-modal [data-provider-fields="aws"]');
    const awsEc2Target = document.querySelector('#provider-target-modal [data-provider-fields="aws-ec2"]');
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
      awsEc2Target.hidden = targetType !== 'aws-ec2';
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
  const resourceDiscovery = provider.type === "aws-ec2"
    ? `<div data-provider-resource-discovery data-provider-id="${escapeHtml(provider.id)}"><div class="inline-actions"><button class="secondary" type="button" data-discover-provider-resources>Find EC2 instances</button></div><p class="muted" data-provider-resource-status>Uses this provider's Name-tag pattern.</p><div class="summary-list" data-provider-resource-list></div></div>`
    : "";
  const viewConfig = `<p><strong>Resource creation:</strong> ${provider.provisioning?.enabled ? "enabled" : "disabled"}</p>${provider.config ? `<pre>${escapeHtml(JSON.stringify(provider.config, null, 2))}</pre>` : `<p class="muted">No provider-level config.</p>`}${resourceDiscovery}`;
  return `<details class="drilldown"><summary><div><strong>${escapeHtml(provider.displayName)}</strong><div class="muted"><code>${escapeHtml(provider.id)}</code> | ${escapeHtml(provider.type)} | ${providerTargets.length} targets</div></div><span class="badge ${provider.source === "persisted" ? "active" : "done"}">${escapeHtml(provider.source)}</span></summary><div class="drilldown-body" data-tabs><div class="tabbar"><button type="button" data-tab="view" aria-selected="true">View</button><button type="button" data-tab="targets" aria-selected="false">Targets</button><button type="button" data-tab="json" aria-selected="false">JSON</button><button type="button" data-tab="env" aria-selected="false">ENV</button><button type="button" data-tab="edit" aria-selected="false">Edit</button><button type="button" data-tab="delete" aria-selected="false">Delete</button></div><section class="tab-panel" data-tab-panel="view">${viewConfig}</section><section class="tab-panel" data-tab-panel="targets" hidden>${providerTargetsPanel(provider, providerTargets)}</section><section class="tab-panel" data-tab-panel="json" hidden><div class="inline-actions"><button type="button" data-copy="${escapeHtml(declarative)}">Copy JSON</button></div><pre>${escapeHtml(declarative)}</pre></section><section class="tab-panel" data-tab-panel="env" hidden><div class="inline-actions"><button type="button" data-copy="${escapeHtml(env)}">Copy ENV</button></div><pre>${escapeHtml(env)}</pre></section><section class="tab-panel" data-tab-panel="edit" hidden><p class="muted">${provider.editable ? "This provider is stored in the database." : "This provider is loaded from declarative config."}</p>${editAction}</section><section class="tab-panel" data-tab-panel="delete" hidden>${deleteAction}</section></div></details>`;
}

function providerEditPanel(provider: ProviderView): string {
  const instanceNamePattern = provider.config?.awsEc2?.instanceNamePattern ?? "";
  return `<form method="post" action="/admin/providers/${escapeHtml(provider.id)}/update" data-provider-edit-form>
    <p><label>Type<br>${providerTypeSelect(provider.type)}</label></p>
    <div class="field-grid">
      <p><label>ID<br><input name="id" type="text" value="${escapeHtml(provider.id)}" required></label></p>
      <p><label>Display name<br><input name="displayName" type="text" value="${escapeHtml(provider.displayName)}"></label></p>
    </div>
    <p><label><input name="provisioningEnabled" type="checkbox" ${provider.provisioning?.enabled ? "checked" : ""}> Allow this provider to provision resources</label></p>
    <div data-provider-config-fields="aws-ec2" ${provider.type === "aws-ec2" ? "" : "hidden"}>
      <p><label>Instance Name-tag pattern<br><input name="awsEc2InstanceNamePattern" type="text" value="${escapeHtml(instanceNamePattern)}" placeholder="${DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN}"></label></p>
      <p class="muted">Defaults to <code>${DEFAULT_AWS_EC2_INSTANCE_NAME_PATTERN}</code>. Used by Find EC2 instances; IAM separately controls which instances may be started or stopped.</p>
    </div>
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
        <div data-provider-fields="aws-ec2">
          <p><label>AWS EC2 instance ID<br><input name="awsInstanceId" type="text" placeholder="i-1234567890abcdef0"></label></p>
          ${ec2InstanceDiscoveryControls()}
          <p><label>Runtime port<br><input name="awsRuntimePort" type="number" min="1" max="65535" placeholder="8080"></label></p>
          <p class="muted">Runtime URLs default from the instance private address; explicit URL overrides still win.</p>
        </div>
        <div data-provider-fields="neuron">
          <p><label>Remote NeurOn target ID<br><input name="neuronTargetId" type="text" placeholder="gpu-pool-west"></label></p>
          <p class="muted">Later we can populate this from the remote NeurOn API.</p>
        </div>
        <details>
          <summary>Overrides</summary>
          <p><label>API URL override<br><input name="apiUrl" type="text" placeholder="http://runtime.internal:8080/v1"></label></p>
          <p><label>Health URL override<br><input name="healthUrl" type="text" placeholder="http://runtime.internal:8080/health"></label></p>
          <p><label>Hourly cost override (USD)<br><input name="estimatedHourlyCostUsd" type="number" min="0" step="0.000001" placeholder="leave empty for provider discovery"></label></p>
          <p><label>Configured model IDs<br><input name="modelIds" type="text" placeholder="qwen-3.6,gemma-4"></label></p>
          <p><label>LiteLLM model route prefixes<br><input name="trafficModelPrefixes" type="text" placeholder="defaults to &lt;target-id&gt;/"></label></p>
          <p class="muted">Comma-separated prefixes link matching LiteLLM model names and traffic to this target. When omitted, NeurOn uses <code>&lt;target-id&gt;/</code>.</p>
          <p><label>LiteLLM credential name override<br><input name="litellmCredentialName" type="text" placeholder="neuron/&lt;target-id&gt;"></label></p>
          <p><label>Runtime API key environment variable<br><input name="litellmApiKeyEnv" type="text" placeholder="PREFER_TARGET_API_KEY"></label></p>
          <p class="muted">NeurOn reads this environment variable only while synchronizing the target credential.</p>
          <p><label><input name="litellmSyncDisabled" type="checkbox"> Disable discovered-model synchronization to LiteLLM</label></p>
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
  const types = ["runpod", "aws-ec2", "aws-ecs-asg", "docker", "docker-compose", "neuron"];
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
    provider.config?.neuron && typeof provider.config.neuron === "object" && "apiKeyEnv" in provider.config.neuron ? envLine(`${prefix}_NEURON_API_KEY_ENV`, String(provider.config.neuron.apiKeyEnv)) : "",
    provider.config?.awsEc2?.instanceNamePattern ? envLine(`${prefix}_AWS_EC2_INSTANCE_NAME_PATTERN`, provider.config.awsEc2.instanceNamePattern) : ""
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

function helpTip(message: string): string {
  return `<span class="help-tip" tabindex="0" role="note" aria-label="${escapeHtml(message)}" data-tip="${escapeHtml(message)}">?</span>`;
}

function profilePicker(profiles: ReservationProfile[], targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): string {
  if (profiles.length === 0) return `<div class="target-status-card"><p class="muted">No reservation profiles yet.</p></div>`;
  return `<details class="profile-picker" id="profile-picker"><summary id="profile-picker-summary">${profilePickerSummary(profiles[0], targets)}</summary><div class="profile-menu">${profiles.map((profile) => profilePickerCard(profile, targets)).join("")}</div></details>`;
}

function profilePickerSummary(profile: ReservationProfile, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): string {
  const targetLookup = targetLookupForTargets(targets);
  const modelLookup = modelLookupForTargets(targets);
  const targetNames = profile.selections.map((selection) => targetLookup[selection.targetId]?.displayName ?? selection.targetId).join(", ");
  const aliases = primaryAliasesForProfile(profile, modelLookup);
  const defaults = [profile.defaultDurationMinutes ? `${profile.defaultDurationMinutes} min` : "", profile.defaultKeepaliveMinutes ? `${profile.defaultKeepaliveMinutes} min keepalive` : ""].filter(Boolean).join(" | ");
  return `<span><span class="profile-card-title"><strong>${escapeHtml(profile.name)}</strong>${defaults ? `<span class="pill">${escapeHtml(defaults)}</span>` : ""}</span>${profile.description ? `<span class="muted">${escapeHtml(profile.description)}</span>` : ""}<span class="compact-summary"><span class="pill">${escapeHtml(targetNames || "No target")}</span>${aliases.length ? aliases.map((alias) => `<span class="copy-chip">${escapeHtml(alias)}</span>`).join("") : `<span class="pill">All models</span>`}</span></span>`;
}

function profilePickerCard(profile: ReservationProfile, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): string {
  const targetLookup = targetLookupForTargets(targets);
  const modelLookup = modelLookupForTargets(targets);
  const targetNames = profile.selections.map((selection) => targetLookup[selection.targetId]?.displayName ?? selection.targetId).join(", ");
  const aliases = primaryAliasesForProfile(profile, modelLookup);
  const defaults = [profile.defaultDurationMinutes ? `${profile.defaultDurationMinutes} min` : "", profile.defaultKeepaliveMinutes ? `${profile.defaultKeepaliveMinutes} min keepalive` : ""].filter(Boolean).join(" | ");
  return `<button class="profile-card-button" type="button" data-select-profile="${escapeHtml(profile.id)}" aria-pressed="false">
    <span class="profile-card-title"><strong>${escapeHtml(profile.name)}</strong>${defaults ? `<span class="pill">${escapeHtml(defaults)}</span>` : ""}</span>
    ${profile.description ? `<span class="muted">${escapeHtml(profile.description)}</span>` : ""}
    <span class="compact-summary"><span class="pill">${escapeHtml(targetNames || "No target")}</span>${aliases.length ? aliases.map((alias) => `<span class="copy-chip">${escapeHtml(alias)}</span>`).join("") : `<span class="pill">All models</span>`}</span>
  </button>`;
}

function durationControls(): string {
  return `<div>
    <h2>Duration${helpTip("How long you expect to use the capacity. You can extend an active reservation later.")}</h2>
    <div class="row" aria-label="Duration">
      <button class="choice" type="button" data-duration="1" aria-pressed="false">1 min</button>
      <button class="choice" type="button" data-duration="2" aria-pressed="true">2 min</button>
      <button class="choice" type="button" data-duration="5" aria-pressed="false">5 min</button>
      <button class="choice" type="button" data-duration="15" aria-pressed="false">15 min</button>
      <button class="choice duration-long" type="button" data-duration="30" aria-pressed="false">30 min</button>
    </div>
    <div class="row" style="margin-top: 12px;">
      <button class="choice" type="button" data-custom-duration="true" aria-pressed="false">Custom</button>
      <label id="custom-duration-wrap" class="hidden">Minutes <input id="custom-duration" type="number" min="1" max="720" value="120"></label>
    </div>
  </div>`;
}

function keepaliveControls(): string {
  return `<div class="keepalive-control">
    <h2>Keepalive${helpTip("Extra idle time after the reservation ends. Recent model traffic can refresh this window so capacity does not stop between nearby requests.")}</h2>
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
  </div>`;
}

function profileDefaultControls(durationMinutes = 2, keepaliveMinutes = 2): string {
  const durationChoices = [1, 2, 5, 15, 30];
  const keepaliveChoices = [1, 2, 5, 15];
  const durationIsCustom = !durationChoices.includes(durationMinutes);
  const keepaliveIsCustom = !keepaliveChoices.includes(keepaliveMinutes);
  return `<div class="field-grid">
    <div>
      <h2>Default duration</h2>
      <div class="row" aria-label="Profile default duration">
        ${durationChoices.map((value) => `<button class="choice${value >= 30 ? " duration-long" : ""}" type="button" data-profile-duration="${value}" aria-pressed="${String(!durationIsCustom && durationMinutes === value)}">${value} min</button>`).join("")}
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="choice" type="button" data-profile-custom-duration="true" aria-pressed="${String(durationIsCustom)}">Custom</button>
        <label id="profile-custom-duration-wrap" class="${durationIsCustom ? "" : "hidden"}">Minutes <input id="profile-custom-duration" type="number" min="1" max="720" value="${durationMinutes}"></label>
      </div>
    </div>
    <div>
      <h2>Default keepalive</h2>
      <div class="row" aria-label="Profile default keepalive">
        ${keepaliveChoices.map((value) => `<button class="choice" type="button" data-profile-keepalive="${value}" aria-pressed="${String(!keepaliveIsCustom && keepaliveMinutes === value)}">${value} min</button>`).join("")}
      </div>
      <div class="row" style="margin-top: 12px;">
        <button class="choice" type="button" data-profile-custom-keepalive="true" aria-pressed="${String(keepaliveIsCustom)}">Custom</button>
        <label id="profile-custom-keepalive-wrap" class="${keepaliveIsCustom ? "" : "hidden"}">Minutes <input id="profile-custom-keepalive" type="number" min="1" max="60" value="${keepaliveMinutes}"></label>
      </div>
    </div>
  </div>`;
}

function profileCreateModal(
  targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>,
  initialTargetId: string,
  returnTo = "/",
  deployments: ModelDeploymentSelectionView[] = [],
  costs: Record<string, { hourlyUsd: number }> = {},
  profile?: ReservationProfile,
  standalone = false
): string {
  const deploymentByKey = new Map(deployments.map((deployment) => [deployment.key, deployment]));
  const selections = new Map((profile?.selections ?? []).map((selection) => [selection.targetId, selection.modelIds]));
  const durationMinutes = profile?.defaultDurationMinutes ?? 2;
  const keepaliveMinutes = profile?.defaultKeepaliveMinutes ?? 2;
  const rootClass = standalone ? "profile-builder-page" : "modal";
  const dialogClass = standalone ? "panel profile-builder-dialog" : "modal-dialog profile-builder-dialog";
  return `<div id="profile-modal" class="${rootClass}"${standalone ? "" : " hidden"}>
    <div class="${dialogClass}">
      <div class="target-status-head"><h1>${profile ? "Edit" : "New"} reservation profile</h1>${standalone ? `<a href="/profiles">Back to profiles</a>` : `<button class="secondary" type="button" data-close-modal>Close</button>`}</div>
      <form id="profile-form" method="post" action="${profile ? `/reservation-profiles/${escapeHtml(profile.id)}` : "/reservation-profiles"}">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
        <input id="profile-duration-minutes" type="hidden" name="defaultDurationMinutes" value="${durationMinutes}">
        <input id="profile-keepalive-minutes" type="hidden" name="defaultKeepaliveMinutes" value="${keepaliveMinutes}">
        <div class="profile-builder-layout">
          <div>
            <div class="field-grid">
              <p><label>Name<br><input name="name" type="text" placeholder="Daily coding" value="${escapeHtml(profile?.name ?? "")}" required></label></p>
              <p><label>Description<br><input name="description" type="text" placeholder="Target and models for this workflow" value="${escapeHtml(profile?.description ?? "")}"></label></p>
            </div>
            ${profileDefaultControls(durationMinutes, keepaliveMinutes)}
            ${profileSelectionGuide(deployments)}
            <h2>Targets and models</h2>
            <p class="muted">Add every server this workflow needs, then choose the models to prepare on each one. Recommendations select one starting point; you can still add other targets.</p>
            <div class="profile-target-selections">${targets.map(({ target, models }, index) => {
              const existingModels = selections.get(target.id);
              const selected = existingModels !== undefined || (!profile && (target.id === initialTargetId || (index === 0 && !initialTargetId)));
              return profileTargetSelection(target, models, selected, deploymentByKey, costs[target.id]?.hourlyUsd, existingModels ?? []);
            }).join("")}</div>
          </div>
        </div>
        <div class="actions"><button type="submit">${profile ? "Save changes" : "Save profile"}</button></div>
      </form>
    </div>
    ${profileSelectionClientScript(deployments)}
    ${standalone ? profileEditorClientScript() : ""}
  </div>`;
}

function profileSelectionGuide(deployments: ModelDeploymentSelectionView[]): string {
  const domains = Array.from(new Set(deployments.flatMap((deployment) => Object.keys(deployment.domains)))).sort();
  const technicalCapabilities = Array.from(new Set(deployments.flatMap((deployment) => deployment.technicalCapabilities.map((capability) => capability.label)))).sort();
  const contexts = Array.from(new Set(deployments.map((deployment) => deployment.contextWindowTokens).filter((value): value is number => typeof value === "number" && value > 0))).sort((left, right) => left - right);
  const contextStops = contexts.map((value, index) => `<option value="${index + 1}" label="${escapeHtml(formatTokenCount(value))}"></option>`).join("");
  const costs = Array.from(new Set(deployments.map((deployment) => deployment.hourlyUsd).filter((value): value is number => typeof value === "number" && value >= 0))).sort((left, right) => left - right);
  const costStops = costs.map((value, index) => `<option value="${index + 1}" label="$${value.toFixed(2)}"></option>`).join("");
  return `<section class="profile-guide" aria-labelledby="profile-guide-title">
    <div class="profile-guide-head"><div><h3 id="profile-guide-title">Choose models</h3><p class="muted">Search and sort the catalog, or let the Good, Fast, and Cheap wizard rank the choices.</p></div><div class="profile-guide-mode" role="group" aria-label="Model selection mode"><button id="profile-browse-mode" class="secondary" type="button" aria-pressed="true">Browse &amp; filter</button><button id="profile-wizard-mode" class="secondary wizard-callout" type="button" aria-pressed="false">Help me choose</button></div></div>
    <div class="profile-browser-grid">
      <label>Search models${helpTip("Searches model names, target names, IDs, aliases, and technical capabilities.")}<br><input id="profile-model-search" type="search" placeholder="Model, server, alias, or capability"></label>
      <label>Sort results<br><select id="profile-model-sort"><option value="fit">Best overall fit</option><option value="favorite">Favorites first</option><option value="popular">Most used in profiles</option><option value="name">Model name</option><option value="cost">Cost: low to high</option><option value="intelligence">Intelligence: high to low</option><option value="speed">Speed: high to low</option></select></label>
    </div>
    <p class="muted">Requirements below remove deployments that cannot work. Missing measurements never pass a selected requirement.</p>
    <div class="selection-filter-grid" style="margin-top: 14px;">
      <label>Minimum context${helpTip("A hard per-request context requirement. Values come from target configuration or runtime discovery, including any concurrency sharing.")}<br><input id="profile-min-context" class="context-slider" type="range" min="0" max="${contexts.length}" step="1" value="0" list="profile-context-stops" data-context-values="${escapeHtml(JSON.stringify(contexts))}"><datalist id="profile-context-stops"><option value="0" label="Any"></option>${contextStops}</datalist><output id="profile-min-context-output">No minimum</output></label>
      <label>Hosting mode${helpTip("Dedicated targets serve one model deployment. Multi-model targets can keep several models available together.")}<br><select id="profile-hosting-mode"><option value="">Dedicated or multi-model</option><option value="dedicated">Dedicated model host</option><option value="multi-model">Multi-model host</option></select></label>
      <label>Maximum target cost${helpTip("A hard hourly target-cost ceiling. The slider stops are the costs currently known to NeurOn.")}<br><input id="profile-max-cost" class="context-slider" type="range" min="0" max="${costs.length}" step="1" value="0" list="profile-cost-stops" data-cost-values="${escapeHtml(JSON.stringify(costs))}"><datalist id="profile-cost-stops"><option value="0" label="Any"></option>${costStops}</datalist><output id="profile-max-cost-output">No maximum</output></label>
    </div>
    ${technicalCapabilities.length ? `<fieldset><legend>Required technical capabilities${helpTip("Binary features advertised by the runtime or configured by an operator, such as vision or tool use. Selected features are hard requirements.")}</legend><div id="profile-technical-capabilities" class="requirement-tags">${technicalCapabilities.map((capability) => `<label><input type="checkbox" value="${escapeHtml(capability)}" data-profile-technical-capability> ${escapeHtml(domainLabel(capability))}</label>`).join("")}</div></fieldset>` : `<p class="muted">No runtime has advertised a recognized technical capability such as vision or tool use yet.</p>`}
    ${domains.length ? `<fieldset><legend>Desired strengths${helpTip("Curated, scored areas such as coding, math, or reasoning. These refine Intelligence ranking but never remove a model.")}</legend><div id="profile-domains" class="requirement-tags">${domains.map((domain) => `<label><input type="checkbox" value="${escapeHtml(domain)}" data-profile-domain> ${escapeHtml(domainLabel(domain))}</label>`).join("")}</div></fieldset>` : `<p class="muted">No scored model strengths have been entered yet; general Intelligence is used when available.</p>`}
    <div id="profile-wizard" class="profile-wizard" hidden>
    <div class="preference-grid">
      <svg id="profile-preference-triangle" class="preference-triangle" viewBox="0 0 320 280" role="img" tabindex="0" aria-label="Good, Fast, and Cheap ranking preference. Center balances all three; corners favor one category.">
        <polygon points="160,28 24,244 296,244"></polygon>
        <text x="160" y="18" text-anchor="middle">Good</text><text x="16" y="266">Cheap</text><text x="304" y="266" text-anchor="end">Fast</text>
        <circle class="triangle-snap" cx="160" cy="28" r="5"></circle><circle class="triangle-snap" cx="296" cy="244" r="5"></circle><circle class="triangle-snap" cx="24" cy="244" r="5"></circle>
        <circle class="triangle-snap" cx="228" cy="136" r="5"></circle><circle class="triangle-snap" cx="92" cy="136" r="5"></circle><circle class="triangle-snap" cx="160" cy="244" r="5"></circle><circle class="triangle-snap" cx="160" cy="172" r="5"></circle>
        <circle id="profile-preference-point" cx="160" cy="172" r="9"></circle>
      </svg>
      <div class="triangle-leaders">
        <p class="muted">This triangle is the profile wizard. Drag toward Good, Fast, or Cheap to change the internal Intelligence, Speed, and Cost preferences. The center balances all three; useful centers, edges, and corners snap into place.</p>
        <div id="profile-leader-good" class="category-leader"><strong>Intelligence leader</strong><span class="muted">Not measured</span></div>
        <div id="profile-leader-fast" class="category-leader"><strong>Speed leader</strong><span class="muted">Not measured</span></div>
        <div id="profile-leader-cheap" class="category-leader"><strong>Cost leader</strong><span class="muted">Not measured</span></div>
      </div>
    </div>
    <div id="profile-recommendations" class="recommendation-grid" aria-live="polite"></div>
    </div>
    <div id="profile-filter-status" class="muted filter-status" aria-live="polite"></div>
  </section>`;
}

function domainLabel(value: string): string {
  return value.split(/[._-]/u).map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

function profileSelectionClientScript(deployments: ModelDeploymentSelectionView[]): string {
  return `<script type="module">
    (() => {
      const root = document.querySelector('#profile-modal');
      if (!root) return;
      const deployments = ${safeJson(deployments)};
      const byKey = new Map(deployments.map(deployment => [deployment.key, deployment]));
      const form = root.querySelector('#profile-form');
      const browseModeButton = root.querySelector('#profile-browse-mode');
      const wizardModeButton = root.querySelector('#profile-wizard-mode');
      const wizardPanel = root.querySelector('#profile-wizard');
      const searchInput = root.querySelector('#profile-model-search');
      const sortInput = root.querySelector('#profile-model-sort');
      const contextInput = root.querySelector('#profile-min-context');
      const contextOutput = root.querySelector('#profile-min-context-output');
      const contextValues = JSON.parse(contextInput?.dataset.contextValues ?? '[]');
      const domainInputs = [...root.querySelectorAll('[data-profile-domain]')];
      const technicalInputs = [...root.querySelectorAll('[data-profile-technical-capability]')];
      const hostingInput = root.querySelector('#profile-hosting-mode');
      const maxCostInput = root.querySelector('#profile-max-cost');
      const maxCostOutput = root.querySelector('#profile-max-cost-output');
      const costValues = JSON.parse(maxCostInput?.dataset.costValues ?? '[]');
      const point = root.querySelector('#profile-preference-point');
      const triangle = root.querySelector('#profile-preference-triangle');
      const recommendations = root.querySelector('#profile-recommendations');
      const filterStatus = root.querySelector('#profile-filter-status');
      let selectionMode = 'browse';
      let weights = { intelligence: 1, speed: 1, cost: 1 };
      const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
      const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
      const selectedDomains = () => domainInputs.filter(input => input.checked).map(input => input.value);
      const selectedTechnicalCapabilities = () => technicalInputs.filter(input => input.checked).map(input => input.value);
      const maximumCost = () => {
        const index = Number(maxCostInput?.value) || 0;
        return index ? costValues[index - 1] : undefined;
      };
      const intelligenceValue = (deployment) => {
        const domains = selectedDomains();
        if (!domains.length) return deployment.intelligence;
        const values = domains.map(domain => deployment.domains?.[domain]).filter(isNumber);
        return values.length === domains.length ? Math.min(...values) : undefined;
      };
      const clamp01 = value => Math.max(0, Math.min(1, value));
      const relativeToMaximum = (value, values) => values.length && Math.max(...values) > 0 ? clamp01(value / Math.max(...values)) : undefined;
      const relativeCost = (value, values) => {
        if (!values.length) return undefined;
        const minimum = Math.min(...values);
        if (minimum === 0) return value === 0 ? 1 : 0;
        return value > 0 ? clamp01(minimum / value) : undefined;
      };
      const weightedAverage = (parts) => {
        const total = parts.reduce((sum, part) => sum + part.weight, 0);
        return total ? parts.reduce((sum, part) => sum + part.score * part.weight, 0) / total : 0;
      };
      const currentWeights = () => {
        const total = weights.intelligence + weights.speed + weights.cost || 1;
        return { intelligence: weights.intelligence / total, speed: weights.speed / total, cost: weights.cost / total };
      };
      const requirementEligibleDeployments = () => {
        const contextIndex = Number(contextInput.value) || 0;
        const minimumContext = contextIndex ? contextValues[contextIndex - 1] : 0;
        const costCeiling = maximumCost();
        const requiredTechnical = selectedTechnicalCapabilities();
        return deployments.filter(deployment => {
          if (minimumContext && (!isNumber(deployment.contextWindowTokens) || deployment.contextWindowTokens < minimumContext)) return false;
          if (costCeiling !== undefined && (!isNumber(deployment.hourlyUsd) || deployment.hourlyUsd > costCeiling)) return false;
          if (hostingInput.value && deployment.hostingMode !== hostingInput.value) return false;
          if (requiredTechnical.some(required => !deployment.technicalCapabilities?.some(capability => capability.label === required))) return false;
          return true;
        });
      };
      const eligibleDeployments = () => {
        const terms = String(searchInput?.value ?? '').trim().toLocaleLowerCase().split(/\\s+/u).filter(Boolean);
        return requirementEligibleDeployments().filter(deployment => {
          const searchable = [deployment.modelDisplayName, deployment.modelId, deployment.targetDisplayName, deployment.targetId, ...(deployment.aliases ?? []), ...(deployment.technicalCapabilities ?? []).flatMap(capability => [capability.label, capability.title])].join(' ').toLocaleLowerCase();
          return terms.every(term => searchable.includes(term));
        });
      };
      const rankedDeployments = () => {
        const eligible = eligibleDeployments();
        const decodeValues = eligible.map(item => item.performance?.decodeTokensPerSecond).filter(isNumber);
        const prefillValues = eligible.map(item => item.performance?.prefillTokensPerSecond).filter(isNumber);
        const costValues = eligible.map(item => item.hourlyUsd).filter(isNumber);
        const weights = currentWeights();
        const ranked = eligible.map(deployment => {
          const rawIntelligence = intelligenceValue(deployment);
          const intelligenceScore = isNumber(rawIntelligence) ? clamp01(rawIntelligence / 100) : undefined;
          const decodeScore = isNumber(deployment.performance?.decodeTokensPerSecond) ? relativeToMaximum(deployment.performance.decodeTokensPerSecond, decodeValues) : undefined;
          const prefillScore = isNumber(deployment.performance?.prefillTokensPerSecond) ? relativeToMaximum(deployment.performance.prefillTokensPerSecond, prefillValues) : undefined;
          const speedParts = [isNumber(decodeScore) ? { score: decodeScore, weight: 0.8 } : undefined, isNumber(prefillScore) ? { score: prefillScore, weight: 0.2 } : undefined].filter(Boolean);
          const speedScore = speedParts.length ? weightedAverage(speedParts) : undefined;
          const costScore = isNumber(deployment.hourlyUsd) ? relativeCost(deployment.hourlyUsd, costValues) : undefined;
          const dimensions = [isNumber(intelligenceScore) ? { score: intelligenceScore, weight: weights.intelligence } : undefined, isNumber(speedScore) ? { score: speedScore, weight: weights.speed } : undefined, isNumber(costScore) ? { score: costScore, weight: weights.cost } : undefined].filter(Boolean);
          return { ...deployment, fitScore: dimensions.length ? weightedAverage(dimensions) : 0, coverage: Math.round(dimensions.reduce((sum, dimension) => sum + dimension.weight, 0) * 100), intelligenceScore, speedScore, costScore };
        });
        const measuredDescending = (left, right, value) => isNumber(value(right)) ? (isNumber(value(left)) ? value(right) - value(left) : 1) : (isNumber(value(left)) ? -1 : 0);
        const measuredAscending = (left, right, value) => isNumber(value(left)) ? (isNumber(value(right)) ? value(left) - value(right) : -1) : (isNumber(value(right)) ? 1 : 0);
        const selectedSort = selectionMode === 'wizard' ? 'fit' : sortInput?.value;
        return ranked.sort((left, right) => {
          const compared = selectedSort === 'name' ? left.modelDisplayName.localeCompare(right.modelDisplayName) || left.targetDisplayName.localeCompare(right.targetDisplayName)
            : selectedSort === 'cost' ? measuredAscending(left, right, item => item.hourlyUsd)
            : selectedSort === 'intelligence' ? measuredDescending(left, right, item => intelligenceValue(item))
            : selectedSort === 'speed' ? measuredDescending(left, right, item => item.speedScore)
            : selectedSort === 'favorite' ? Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) || (right.popularityScore ?? 0) - (left.popularityScore ?? 0)
            : selectedSort === 'popular' ? (right.profileCount ?? 0) - (left.profileCount ?? 0) || (right.popularityScore ?? 0) - (left.popularityScore ?? 0)
            : right.fitScore - left.fitScore;
          return compared || Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) || (right.popularityScore ?? 0) - (left.popularityScore ?? 0) || right.coverage - left.coverage || left.targetDisplayName.localeCompare(right.targetDisplayName);
        });
      };
      const metricSummary = (deployment) => {
        const pieces = [];
        const intelligence = intelligenceValue(deployment);
        if (isNumber(intelligence)) pieces.push((selectedDomains().length ? 'Desired strengths' : 'Intelligence') + ' ' + intelligence.toFixed(1));
        if (isNumber(deployment.performance?.decodeTokensPerSecond)) pieces.push(deployment.performance.decodeTokensPerSecond.toFixed(1) + ' t/s');
        if (isNumber(deployment.hourlyUsd)) pieces.push('$' + deployment.hourlyUsd.toFixed(2) + '/hr');
        if (isNumber(deployment.contextWindowTokens)) pieces.push(Math.round(deployment.contextWindowTokens / 1000) + 'K context');
        return pieces.join(' · ') || 'Selection measurements unavailable';
      };
      const bestBy = (items, value, lower = false) => items.filter(item => isNumber(value(item))).sort((left, right) => lower ? value(left) - value(right) : value(right) - value(left))[0];
      const setLeader = (id, label, deployment, metric) => {
        const container = root.querySelector(id);
        if (!container) return;
        container.innerHTML = '<strong>' + label + '</strong>' + (deployment
          ? '<span>' + escapeText(deployment.modelDisplayName) + '</span><span class="muted">' + escapeText(deployment.targetDisplayName) + ' · ' + escapeText(metric(deployment)) + '</span>'
          : '<span class="muted">Not measured</span>');
      };
      const render = () => {
        const contextIndex = Number(contextInput.value) || 0;
        const normalizedWeights = currentWeights();
        root.dataset.assistantRequirements = JSON.stringify({
          ...(contextIndex ? { minimumContextTokens: contextValues[contextIndex - 1] } : {}),
          ...(maximumCost() === undefined ? {} : { maximumHourlyUsd: maximumCost() }),
          ...(hostingInput.value ? { hostingMode: hostingInput.value } : {}),
          domains: selectedDomains(),
          technicalCapabilities: selectedTechnicalCapabilities(),
          weights: normalizedWeights
        });
        const ranked = rankedDeployments();
        const matchingKeys = new Set(ranked.map(deployment => deployment.key));
        const requirementKeys = new Set(requirementEligibleDeployments().map(deployment => deployment.key));
        const rankByKey = new Map(ranked.map((deployment, index) => [deployment.key, { deployment, index }]));
        root.querySelectorAll('[data-deployment-key]').forEach(option => {
          const matches = matchingKeys.has(option.dataset.deploymentKey);
          const meetsRequirements = requirementKeys.has(option.dataset.deploymentKey);
          const input = option.querySelector('[data-profile-model]');
          if (!meetsRequirements && input?.checked) input.checked = false;
          option.hidden = !matches && !input?.checked;
          option.classList.toggle('does-not-match', !matches && Boolean(input?.checked));
          option.style.order = String(rankByKey.get(option.dataset.deploymentKey)?.index ?? deployments.length);
          const score = option.querySelector('[data-profile-fit-score]');
          const rankedEntry = rankByKey.get(option.dataset.deploymentKey)?.deployment;
          if (score) score.textContent = rankedEntry ? 'Fit ' + Math.round(rankedEntry.fitScore * 100) + ' · ' + rankedEntry.coverage + '% data' : '';
        });
        root.querySelectorAll('[data-profile-target-card]').forEach(card => {
          const options = [...card.querySelectorAll('[data-deployment-key]')];
          const input = card.querySelector('[data-profile-target]');
          const visible = options.filter(option => !option.hidden);
          const selectable = options.some(option => requirementKeys.has(option.dataset.deploymentKey));
          if (!selectable && input?.checked) { input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); }
          card.hidden = options.length > 0 && visible.length === 0 && !input?.checked;
          card.style.order = String(visible.length ? Math.min(...visible.map(option => Number(option.style.order))) : deployments.length);
        });
        filterStatus.textContent = ranked.length + ' of ' + deployments.length + ' target-model deployments match the current search and requirements. ' + (selectionMode === 'wizard' ? 'The wizard ranks them by the Good, Fast, and Cheap balance.' : 'Results use the selected sort order.');
        const goodLeader = bestBy(ranked, intelligenceValue);
        const fastLeader = bestBy(ranked, item => item.speedScore);
        const cheapLeader = bestBy(ranked, item => item.hourlyUsd, true);
        setLeader('#profile-leader-good', 'Intelligence leader', goodLeader, item => intelligenceValue(item).toFixed(1));
        setLeader('#profile-leader-fast', 'Speed leader', fastLeader, item => item.performance?.decodeTokensPerSecond ? item.performance.decodeTokensPerSecond.toFixed(1) + ' decode t/s' : 'Measured speed leader');
        setLeader('#profile-leader-cheap', 'Cost leader', cheapLeader, item => '$' + item.hourlyUsd.toFixed(2) + '/hr');
        if (!ranked.length) {
          recommendations.innerHTML = '<p class="muted">No deployment satisfies every requirement. Relax a hard filter to see choices.</p>';
          return;
        }
        const winners = [
          ['Best fit', ranked[0]],
          ['Intelligence leader', goodLeader],
          ['Speed leader', fastLeader],
          ['Cost leader', cheapLeader]
        ].filter(entry => entry[1]);
        recommendations.innerHTML = winners.map(entry => '<button class="recommendation-card" type="button" data-use-deployment="' + escapeText(entry[1].key) + '"><span class="pill">' + escapeText(entry[0]) + '</span><strong>' + escapeText(entry[1].modelDisplayName) + '</strong><span>' + escapeText(entry[1].targetDisplayName) + '</span><span class="muted">' + metricSummary(entry[1]) + '</span><span class="muted">Fit ' + Math.round(entry[1].fitScore * 100) + ' · ' + entry[1].coverage + '% data coverage</span></button>').join('');
      };
      const setWeights = (intelligence, speed, cost) => {
        weights = { intelligence: Math.max(0, intelligence), speed: Math.max(0, speed), cost: Math.max(0, cost) };
        const total = weights.intelligence + weights.speed + weights.cost || 1;
        const goodShare = weights.intelligence / total;
        const speedShare = weights.speed / total;
        const cheapShare = weights.cost / total;
        point.setAttribute('cx', String(goodShare * 160 + cheapShare * 24 + speedShare * 296));
        point.setAttribute('cy', String(goodShare * 28 + (cheapShare + speedShare) * 244));
        render();
      };
      const setSelectionMode = mode => {
        selectionMode = mode === 'wizard' ? 'wizard' : 'browse';
        const wizard = selectionMode === 'wizard';
        wizardPanel.hidden = !wizard;
        browseModeButton.setAttribute('aria-pressed', String(!wizard));
        wizardModeButton.setAttribute('aria-pressed', String(wizard));
        sortInput.disabled = wizard;
        render();
      };
      const updateContextOutput = () => {
        const index = Number(contextInput.value) || 0;
        const value = index ? contextValues[index - 1] : 0;
        contextOutput.value = value ? new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value) + ' minimum' : 'No minimum';
      };
      const updateCostOutput = () => {
        const value = maximumCost();
        maxCostOutput.value = isNumber(value) ? '$' + value.toFixed(2) + '/hr maximum' : 'No maximum';
      };
      [searchInput, sortInput, contextInput, hostingInput, maxCostInput, ...domainInputs, ...technicalInputs].forEach(input => input?.addEventListener('input', () => { updateContextOutput(); updateCostOutput(); render(); }));
      browseModeButton.addEventListener('click', () => setSelectionMode('browse'));
      wizardModeButton.addEventListener('click', () => setSelectionMode('wizard'));
      const snaps = [
        { x: 160, y: 28, weights: [1, 0, 0] }, { x: 296, y: 244, weights: [0, 1, 0] }, { x: 24, y: 244, weights: [0, 0, 1] },
        { x: 228, y: 136, weights: [1, 1, 0] }, { x: 92, y: 136, weights: [1, 0, 1] }, { x: 160, y: 244, weights: [0, 1, 1] },
        { x: 160, y: 172, weights: [1, 1, 1] }
      ];
      const updateFromPointer = (event) => {
        const bounds = triangle.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width * 320;
        const y = (event.clientY - bounds.top) / bounds.height * 280;
        const snapped = snaps.map(snap => ({ snap, distance: Math.hypot(snap.x - x, snap.y - y) })).sort((left, right) => left.distance - right.distance)[0];
        if (snapped && snapped.distance <= 24) { setWeights(...snapped.snap.weights); return; }
        const goodShare = Math.max(0, Math.min(1, (244 - y) / 216));
        const left = 24 + 136 * goodShare;
        const right = 296 - 136 * goodShare;
        const speedShare = right === left ? 0.5 : Math.max(0, Math.min(1, (x - left) / (right - left)));
        setWeights(goodShare, (1 - goodShare) * speedShare, (1 - goodShare) * (1 - speedShare));
      };
      triangle.addEventListener('pointerdown', event => { triangle.setPointerCapture(event.pointerId); updateFromPointer(event); });
      triangle.addEventListener('pointermove', event => { if (triangle.hasPointerCapture(event.pointerId)) updateFromPointer(event); });
      triangle.addEventListener('pointerup', event => triangle.releasePointerCapture(event.pointerId));
      let keyboardSnap = snaps.length - 1;
      triangle.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        keyboardSnap = (keyboardSnap + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + snaps.length) % snaps.length;
        setWeights(...snaps[keyboardSnap].weights);
      });
      recommendations.addEventListener('click', event => {
        const button = event.target.closest('[data-use-deployment]');
        if (!button) return;
        const deployment = byKey.get(button.dataset.useDeployment);
        if (!deployment) return;
        form.querySelectorAll('[data-profile-target]').forEach(input => { input.checked = input.value === deployment.targetId; input.dispatchEvent(new Event('change', { bubbles: true })); });
        form.querySelectorAll('[data-profile-model]').forEach(input => { const value = JSON.parse(input.value); input.checked = value.targetId === deployment.targetId && value.modelId === deployment.modelId; });
        const option = [...form.querySelectorAll('[data-deployment-key]')].find(candidate => candidate.dataset.deploymentKey === deployment.key);
        option?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      root.addEventListener('click', async event => {
        const button = event.target.closest('[data-model-favorite]');
        if (!button) return;
        event.preventDefault(); event.stopPropagation();
        const key = button.dataset.targetId + '::' + button.dataset.modelId;
        const deployment = byKey.get(key);
        if (!deployment) return;
        button.disabled = true;
        try {
          const active = button.getAttribute('aria-pressed') === 'true';
          const response = await fetch(active ? '/api/model-favorites/' + encodeURIComponent(button.dataset.targetId) + '/' + encodeURIComponent(button.dataset.modelId) : '/api/model-favorites', active
            ? { method: 'DELETE' }
            : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: button.dataset.targetId, modelId: button.dataset.modelId }) });
          if (!response.ok) throw new Error('Could not update favorite');
          deployment.favorite = !active;
          button.setAttribute('aria-pressed', String(!active)); button.textContent = active ? '☆' : '★';
          button.title = active ? 'Favorite this deployment' : 'Remove favorite';
          render();
        } finally { button.disabled = false; }
      });
      const setMinimumContext = (value) => {
        if (!isNumber(value) || value <= 0) { contextInput.value = '0'; updateContextOutput(); return; }
        const index = contextValues.findIndex(candidate => candidate >= value);
        contextInput.value = String(index >= 0 ? index + 1 : contextValues.length);
        updateContextOutput();
      };
      const applyGuidance = guidance => {
        if (!guidance?.requirements || !guidance?.draft) return;
        setMinimumContext(guidance.requirements.minimumContextTokens);
        const advisedCost = guidance.requirements.maximumHourlyUsd;
        if (!isNumber(advisedCost)) maxCostInput.value = '0';
        else {
          const index = costValues.findLastIndex(candidate => candidate <= advisedCost);
          maxCostInput.value = String(index >= 0 ? index + 1 : 0);
        }
        hostingInput.value = guidance.requirements.hostingMode ?? '';
        const advisedDomains = guidance.requirements.domains ?? [];
        domainInputs.forEach(input => { input.checked = advisedDomains.includes(input.value); });
        const advisedTechnical = guidance.requirements.technicalCapabilities ?? [];
        technicalInputs.forEach(input => { input.checked = advisedTechnical.includes(input.value); });
        const advisedWeights = guidance.requirements.weights ?? { intelligence: 1, speed: 1, cost: 1 };
        setWeights(advisedWeights.intelligence, advisedWeights.speed, advisedWeights.cost);
        if (guidance.draft.name) form.elements.name.value = guidance.draft.name;
        if (guidance.draft.description !== undefined) form.elements.description.value = guidance.draft.description;
        const chooseDefault = (kind, value) => {
          if (!isNumber(value)) return;
          const preset = form.querySelector('[data-profile-' + kind + '="' + value + '"]');
          if (preset) { preset.click(); return; }
          const custom = form.querySelector('#profile-custom-' + kind); const button = form.querySelector('[data-profile-custom-' + kind + ']');
          if (custom && button) { custom.value = String(value); button.click(); custom.dispatchEvent(new Event('input', { bubbles: true })); }
        };
        chooseDefault('duration', guidance.draft.defaultDurationMinutes);
        chooseDefault('keepalive', guidance.draft.defaultKeepaliveMinutes);
        const selected = new Map((guidance.draft.selections ?? []).map(selection => [selection.targetId, new Set(selection.modelIds)]));
        form.querySelectorAll('[data-profile-target]').forEach(input => { input.checked = selected.has(input.value); input.dispatchEvent(new Event('change', { bubbles: true })); });
        form.querySelectorAll('[data-profile-model]').forEach(input => { const value = JSON.parse(input.value); input.checked = selected.get(value.targetId)?.has(value.modelId) ?? false; });
        render(); sessionStorage.removeItem('neuron-profile-assistant-guidance');
      };
      document.addEventListener('neuron:apply-profile-guidance', event => applyGuidance(event.detail));
      updateContextOutput();
      updateCostOutput();
      setWeights(1, 1, 1);
      setSelectionMode('browse');
    })();
  </script>`;
}

function profileEditorClientScript(): string {
  return `<script type="module">
    (() => {
      const form = document.querySelector('#profile-form');
      if (!form) return;
      const targetInputs = [...form.querySelectorAll('[data-profile-target]')];
      const durationInput = form.querySelector('#profile-duration-minutes');
      const keepaliveInput = form.querySelector('#profile-keepalive-minutes');
      const durationButtons = [...form.querySelectorAll('[data-profile-duration], [data-profile-custom-duration]')];
      const keepaliveButtons = [...form.querySelectorAll('[data-profile-keepalive], [data-profile-custom-keepalive]')];
      const customDuration = form.querySelector('#profile-custom-duration');
      const customKeepalive = form.querySelector('#profile-custom-keepalive');
      const customDurationWrap = form.querySelector('#profile-custom-duration-wrap');
      const customKeepaliveWrap = form.querySelector('#profile-custom-keepalive-wrap');
      const syncTargets = () => targetInputs.forEach(input => {
        const card = input.closest('[data-profile-target-card]');
        card?.classList.toggle('selected', input.checked);
        const models = [...card.querySelectorAll('[data-profile-model]')];
        models.forEach(model => { model.disabled = !input.checked; });
        if (input.checked && models.length === 1) models[0].checked = true;
      });
      const selectDuration = (button, focus = true) => {
        const custom = Boolean(button?.dataset.profileCustomDuration);
        durationButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
        customDurationWrap.classList.toggle('hidden', !custom);
        durationInput.value = custom ? customDuration.value : button?.dataset.profileDuration ?? durationInput.value;
        if (custom && focus) customDuration.focus();
      };
      const selectKeepalive = (button, focus = true) => {
        const custom = Boolean(button?.dataset.profileCustomKeepalive);
        keepaliveButtons.forEach(candidate => candidate.setAttribute('aria-pressed', String(candidate === button)));
        customKeepaliveWrap.classList.toggle('hidden', !custom);
        keepaliveInput.value = custom ? customKeepalive.value : button?.dataset.profileKeepalive ?? keepaliveInput.value;
        if (custom && focus) customKeepalive.focus();
      };
      targetInputs.forEach(input => input.addEventListener('change', syncTargets));
      durationButtons.forEach(button => button.addEventListener('click', () => selectDuration(button)));
      keepaliveButtons.forEach(button => button.addEventListener('click', () => selectKeepalive(button)));
      customDuration.addEventListener('input', () => selectDuration(form.querySelector('[data-profile-custom-duration]'), false));
      customKeepalive.addEventListener('input', () => selectKeepalive(form.querySelector('[data-profile-custom-keepalive]'), false));
      form.addEventListener('submit', event => {
        const selectedTargets = targetInputs.filter(input => input.checked);
        const invalid = selectedTargets.find(input => {
          const models = [...input.closest('[data-profile-target-card]').querySelectorAll('[data-profile-model]')];
          return models.length > 0 && !models.some(model => model.checked);
        });
        if (!selectedTargets.length || invalid) {
          event.preventDefault();
          const message = !selectedTargets.length ? 'Choose at least one target.' : 'Choose at least one model for every selected target.';
          window.alert(message);
          invalid?.closest('[data-profile-target-card]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      document.addEventListener('click', async event => {
        const copy = event.target.closest('[data-copy]');
        if (!copy) return;
        event.preventDefault(); event.stopPropagation();
        if (!copy.dataset.copy) return;
        await navigator.clipboard?.writeText(copy.dataset.copy);
        const previous = copy.textContent; copy.textContent = 'copied';
        setTimeout(() => { copy.textContent = previous; }, 900);
      });
      syncTargets();
    })();
  </script>`;
}

function profileTargetSelection(target: CapacityTarget, models: ModelDefinition[], selected: boolean, deploymentByKey: Map<string, ModelDeploymentSelectionView>, resolvedTargetCost?: number, selectedModelIds: string[] = []): string {
  const targetCost = resolvedTargetCost ?? models.map((model) => deploymentByKey.get(`${target.id}::${model.id}`)?.hourlyUsd).find((value) => value !== undefined);
  const modelContent = models.length === 0
    ? `<p class="muted">No models are known yet. This reserves the target and leaves its full discovered runtime available.</p>`
    : models.length === 1
      ? `<p class="muted">This target has one model, so NeurOn selects it automatically.</p><div class="models">${profileModelOption(target, models[0], selected, deploymentByKey.get(`${target.id}::${models[0].id}`))}</div>`
      : `<p class="muted">Choose at least one model for this target. Matching models follow the active search, requirements, and sort or wizard ranking.</p><div class="models">${models.map((model) => profileModelOption(target, model, selectedModelIds.includes(model.id), deploymentByKey.get(`${target.id}::${model.id}`))).join("")}</div>`;
  return `<section class="target-status-card profile-target-selection" data-profile-target-card data-target-id="${escapeHtml(target.id)}">
    <div class="target-status-head"><label class="profile-target-toggle"><input type="checkbox" name="selectionTargetIds" value="${escapeHtml(target.id)}" data-profile-target ${selected ? "checked" : ""}><span><strong>${escapeHtml(target.displayName)}</strong><span class="muted"><code>${escapeHtml(target.id)}</code></span></span></label><span class="target-price">${targetCost === undefined ? "Cost unavailable" : `$${targetCost.toFixed(2)}/hr`}</span></div>
    <div data-profile-target-models>${modelContent}</div>
  </section>`;
}

function profileModelOption(target: CapacityTarget, model: ModelDefinition, selected: boolean, deployment?: ModelDeploymentSelectionView): string {
  const value = JSON.stringify({ targetId: target.id, modelId: model.id });
  const aliases = litellmAliases(target, model.id, deployment?.aliases ?? aliasesForDisplay(model));
  const globalAlias = aliases.global[0];
  const scopedAlias = aliases.scoped[0];
  const contextTokens = deployment?.contextWindowTokens ?? model.contextWindowTokens;
  const contextTitle = deployment?.contextSource === "runtime-shared"
    ? `Per-request context; runtime reported one context pool shared across ${deployment.contextConcurrency} concurrent sequences`
    : deployment?.contextSource === "operator" ? "Operator-set per-request context" : "Per-request context reported by configuration or runtime";
  const context = contextTokens ? `<span class="pill" title="${escapeHtml(contextTitle)}">${escapeHtml(formatTokenCount(contextTokens))} context</span>` : "";
  const description = model.description ? `<div class="muted">${escapeHtml(model.description)}</div>` : "";
  const metrics = deployment ? profileModelMetrics(deployment) : "";
  const capabilities = deployment?.technicalCapabilities.length ? `<span class="model-metrics">${deployment.technicalCapabilities.map((capability) => `<span class="metric" title="${escapeHtml(capability.title ?? "Advertised technical capability")}">${escapeHtml(domainLabel(capability.label))}</span>`).join("")}</span>` : "";
  const favorite = deployment ? `<button class="favorite-button" type="button" data-model-favorite data-target-id="${escapeHtml(target.id)}" data-model-id="${escapeHtml(model.id)}" aria-pressed="${String(Boolean(deployment.favorite))}" title="${deployment.favorite ? "Remove favorite" : "Favorite this deployment"}">${deployment.favorite ? "★" : "☆"}</button>` : "";
  return `<label class="option" data-deployment-key="${escapeHtml(`${target.id}::${model.id}`)}"><input type="checkbox" name="selectionModels" value="${escapeHtml(value)}" data-profile-model ${selected ? "checked" : ""}><span class="model-body"><span class="model-head"><strong>${escapeHtml(model.displayName)}</strong><span>${context}${favorite}</span></span><span class="pill" data-profile-fit-score></span>${description}${capabilities}${metrics}<span class="copy-row">${scopedAlias ? copyChip(scopedAlias, "primary") : ""}${globalAlias && globalAlias !== scopedAlias ? copyChip(globalAlias) : ""}</span><span class="model-meta">Scoped route pins this target; the global route follows alias priority and fallback.</span></span></label>`;
}

function profileModelMetrics(deployment: ModelDeploymentSelectionView): string {
  const metrics = [
    deployment.intelligence === undefined ? "" : `<span class="metric">Intelligence ${formatMetric(deployment.intelligence)}</span>`,
    ...Object.entries(deployment.domains).map(([domain, score]) => `<span class="metric">${escapeHtml(domainLabel(domain))} ${formatMetric(score)}</span>`),
    deployment.performance?.decodeTokensPerSecond === undefined ? "" : `<span class="metric">Decode ${formatMetric(deployment.performance.decodeTokensPerSecond)} t/s</span>`,
    deployment.performance?.prefillTokensPerSecond === undefined ? "" : `<span class="metric">Prefill ${formatMetric(deployment.performance.prefillTokensPerSecond)} t/s</span>`,
    deployment.performance?.timeToFirstTokenSeconds === undefined ? "" : `<span class="metric">First token ${formatMetric(deployment.performance.timeToFirstTokenSeconds)}s</span>`,
    deployment.quantization?.format ? `<span class="metric">${escapeHtml(deployment.quantization.format)}</span>` : "",
    deployment.quantization?.qualityRetentionPercent === undefined ? "" : `<span class="metric">Estimated quality retained ${formatMetric(deployment.quantization.qualityRetentionPercent)}%</span>`,
    deployment.profileCount === undefined ? "" : `<span class="metric">${deployment.profileCount} profile${deployment.profileCount === 1 ? "" : "s"}</span>`,
    deployment.reservationCount ? `<span class="metric">${deployment.reservationCount} recent reservation${deployment.reservationCount === 1 ? "" : "s"}</span>` : ""
  ].filter(Boolean).join("");
  const observed = deployment.performance?.source === "observed"
    ? `<span class="muted">Observed locally${deployment.performance.sampleCount ? ` from ${deployment.performance.sampleCount} requests` : ""}</span>`
    : "";
  return metrics || observed ? `<span class="model-metrics">${metrics}</span>${observed}` : `<span class="model-meta">Selection measurements not available yet</span>`;
}

function formatMetric(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 10 ? 2 : 1 }).format(value);
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return value.toLocaleString("en-US");
}

function profileReviewModal(profiles: ReservationProfile[], targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): string {
  return `<div id="profile-review-modal" class="modal" hidden>
    <div class="modal-dialog">
      <div class="target-status-head"><h2>Reservation profile</h2><button class="secondary" type="button" data-close-modal>Close</button></div>
      <div id="profile-review-body">${profiles.length ? profileReviewBody(profiles[0], targets) : `<p class="muted">No reservation profiles saved yet.</p>`}</div>
    </div>
  </div>`;
}

function profileReviewBody(profile: ReservationProfile, targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): string {
  const targetLookup = targetLookupForTargets(targets);
  const modelLookup = modelLookupForTargets(targets);
  const defaults = [profile.defaultDurationMinutes ? `${profile.defaultDurationMinutes} min duration` : "", profile.defaultKeepaliveMinutes ? `${profile.defaultKeepaliveMinutes} min keepalive` : ""].filter(Boolean).join(" | ");
  const selections = profile.selections.map((selection) => {
    const models = selection.modelIds.length
      ? `<span class="chip-row">${selection.modelIds.map((id) => `<span class="copy-chip">${escapeHtml(modelLookup[id]?.displayName ?? id)}</span>`).join("")}</span>`
      : `<span class="chip-row"><span class="pill">All models</span></span>`;
    return `<div class="target-status-card"><strong>${escapeHtml(targetLookup[selection.targetId]?.displayName ?? selection.targetId)}</strong>${models}</div>`;
  }).join("");
  return `<h3>${escapeHtml(profile.name)}</h3>${profile.description ? `<p class="muted">${escapeHtml(profile.description)}</p>` : ""}${defaults ? `<p class="muted">${escapeHtml(defaults)}</p>` : ""}${selections}`;
}

function profilesForClient(profiles: ReservationProfile[], targets: Array<{ target: CapacityTarget; models: ModelDefinition[] }>): Array<Record<string, unknown>> {
  const targetIds = new Set(targets.map(({ target }) => target.id));
  const modelIds = new Set(targets.flatMap(({ models }) => models.map((model) => model.id)));
  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    defaultDurationMinutes: profile.defaultDurationMinutes,
    defaultKeepaliveMinutes: profile.defaultKeepaliveMinutes,
    selections: profile.selections
      .filter((selection) => targetIds.has(selection.targetId))
      .map((selection) => ({ targetId: selection.targetId, modelIds: selection.modelIds.filter((modelId) => modelIds.has(modelId)) }))
  }));
}

function primaryAliasesForProfile(profile: ReservationProfile, modelLookup: Record<string, { displayName: string; recommendedAlias: string }>): string[] {
  return Array.from(new Set(profile.selections.flatMap((selection) => selection.modelIds.map((modelId) => modelLookup[modelId]?.recommendedAlias ?? modelId)))).slice(0, 6);
}

function aliasesForDisplay(model: ModelDefinition): string[] {
  const aliases = Array.from(new Set(model.aliases.length ? model.aliases : [model.id]));
  return aliases.sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function copyChip(value: string, variant = ""): string {
  const classes = ["copy-chip", variant].filter(Boolean).join(" ");
  return `<button class="${classes}" type="button" data-copy="${escapeHtml(value)}" title="Copy ${escapeHtml(value)}">${escapeHtml(value)}</button>`;
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
