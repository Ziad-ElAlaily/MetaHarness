import { useEffect, useState } from 'react';
import type { ApprovalMode, ConfigView } from '../types.ts';

/**
 * Whether you're away (the daemon's, for every goal), said at once when you change it; the next
 * state from the daemon confirms it.
 */
export function useAway(server: boolean | undefined, onCommand: (b: Record<string, unknown>) => Promise<unknown>): [boolean, (away: boolean) => void] {
  const [now, setNow] = useState<boolean>();
  useEffect(() => setNow(undefined), [server]);
  return [
    now ?? server ?? false,
    away => {
      setNow(away);
      void onCommand({ cmd: 'presence.set', away });
    },
  ];
}

export function AwayButton({ away, onSet, className = 'btn' }: { away: boolean; onSet: (away: boolean) => void; className?: string }) {
  return (
    <button
      className={`${className}${away ? ' primary' : ''}`}
      onClick={() => onSet(!away)}
      title={
        away
          ? 'Questions and approvals reach you again, on every goal'
          : 'For every goal: nothing waits on you. What reaches outside a project goes to the gatekeeper and the lead, questions wait in your Inbox, and leads decide what they can'
      }
    >
      {away ? 'I’m back' : 'I’m away'}
    </button>
  );
}

export function AwayNote({ compact }: { compact?: boolean }) {
  return (
    <div className={`away-note${compact ? ' compact' : ' panel'}`}>
      {compact ? (
        <>
          You’re away: nothing waits on you. The lead decides what it can and writes it in <span className="mono">shared/decisions.md</span>; what agents ask you waits here.
        </>
      ) : (
        <>
          You’re away. Nothing waits on you: what reaches outside a project goes to the gatekeeper and the goal’s lead, and leads decide what they can and write it in{' '}
          <span className="mono">shared/decisions.md</span>. What agents ask you waits here.
        </>
      )}
    </div>
  );
}

const MODES: [ApprovalMode, string, string][] = [
  ['ask', 'Ask me', 'Whatever the fixed rules don’t settle comes to your Inbox'],
  ['gatekeeper', 'Gatekeeper', 'A cheap model allows what’s safe, refuses what’s harmful, and asks you about the rest'],
  ['harness', 'Harness’s own', 'Each harness’s automatic approvals where it has them; the gatekeeper, then you, for the rest'],
  ['allow', 'Allow in project', 'What stays in the project runs without asking; what reaches outside goes to the gatekeeper, then the lead'],
];

/**
 * How approvals are decided in this project, beside the away switch: saved to the project's
 * settings (your personal ones if it has none), as Settings does.
 */
export function ApprovalsSelect({ config, onSave }: { config?: ConfigView; onSave: (b: Record<string, unknown>) => Promise<unknown> }) {
  if (!config) return null;
  const mode = config.settings.effective.approvals;
  const scope = config.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal';
  return (
    <label className="approvals-select" title={`${MODES.find(m => m[0] === mode)?.[2] ?? ''}. More in Settings.`}>
      <span className="muted">Approvals</span>
      <select value={mode} onChange={e => void onSave({ cmd: 'settings.save', scope, patch: { approvals: e.target.value } })} aria-label="Approvals">
        {MODES.map(([m, label, hint]) => (
          <option key={m} value={m} title={hint}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
