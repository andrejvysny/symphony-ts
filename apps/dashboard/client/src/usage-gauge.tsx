import type { ClaudeUsageLimits, UsageWindow } from './api.js';
import { untilReset } from './util.js';

/** Color band by utilization: ok (<70%), warn (<90%), crit (≥90%). */
function band(util: number): string {
  return util >= 90 ? 'crit' : util >= 70 ? 'warn' : 'ok';
}

/** Human-readable reason for an unavailable gauge (shown in the tooltip). */
function reasonText(reason: string): string {
  switch (reason) {
    case 'no_token':
      return 'no Claude subscription token (API-key mode or not logged in)';
    case 'timeout':
      return 'request timed out';
    case 'network':
      return 'network error';
    case 'parse':
    case 'shape':
      return 'unexpected response';
    default:
      return reason.startsWith('http_') ? `HTTP ${reason.slice(5)}` : reason;
  }
}

function Window(props: { label: string; w: UsageWindow; now: number; bind: boolean }) {
  const pct = Math.round(props.w.utilization);
  return (
    <span
      class={`usage-win ${band(pct)}${props.bind ? ' bind' : ''}`}
      title={`${props.label}: ${pct}% used · resets in ${untilReset(props.w.resetsAt, props.now)}`}
    >
      {props.label} {pct}%
    </span>
  );
}

/**
 * Top-bar gauge for the operator's Claude subscription usage limits (5-hour rolling window + weekly).
 * Renders nothing until the first fetch resolves (`usage === null`). When the server reports the data
 * it shows 5h/weekly percentages (binding window emphasized); when it's unavailable (e.g. API-key
 * mode) it shows a muted "n/a" placeholder with the reason in the tooltip.
 */
export function UsageGauge(props: { usage: ClaudeUsageLimits | null; now: number }) {
  const u = props.usage;
  if (!u) return null;
  if (!u.available) {
    return (
      <div
        class="gauge usage unavailable"
        data-test="usage-limits"
        title={`Claude usage limits unavailable — ${reasonText(u.reason)}`}
      >
        <span class="val usage-val">
          <span class="usage-win na">5h n/a</span>
        </span>
        <span class="cap">Claude limit</span>
      </div>
    );
  }
  const fiveBinds = u.fiveHour.utilization >= u.sevenDay.utilization;
  return (
    <div class="gauge usage" data-test="usage-limits" title="Claude subscription usage limits">
      <span class="val usage-val">
        <Window label="5h" w={u.fiveHour} now={props.now} bind={fiveBinds} />
        <span class="usage-sep">·</span>
        <Window label="wk" w={u.sevenDay} now={props.now} bind={!fiveBinds} />
      </span>
      <span class="cap">Claude limit</span>
    </div>
  );
}
