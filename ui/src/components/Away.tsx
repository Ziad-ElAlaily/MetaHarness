import { useEffect, useState } from 'react';

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
