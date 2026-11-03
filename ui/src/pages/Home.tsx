import { useMemo, useState } from 'react';
import { ago, duration, goalTitle, money } from '../format.ts';
import type { ConfigView, GoalSummary } from '../types.ts';
import { ACTIONABLE, NeedsYou } from '../components/Inbox.tsx';
import { ContinueButtons, type ContinueFrom } from '../components/Dialogs.tsx';
import { Markdown, More } from '../components/common.tsx';
import { AccountList, useOverview } from '../components/Accounts.tsx';
import { ApprovalsSelect, AwayButton, AwayNote, useAway } from '../components/Away.tsx';

interface Props {
  goals: GoalSummary[];
  rooms: GoalSummary[];
  onOpenRoom: (room: string) => void;
  onNewRoom: () => void;
  onNewGoal: () => void;
  loaded: boolean;
  config?: ConfigView;
  onOpen: (goal: string, agent?: string) => void;
  onContinue: (from: ContinueFrom) => void;
  onCommand: (b: Record<string, unknown>) => Promise<unknown>;
  onSaveConfig: (b: Record<string, unknown>) => Promise<unknown>;
  onSetup: () => void;
  onAllGoals: () => void;
}

/** A line of work: goals and rooms that continue one another, oldest first. */
interface Chain {
  steps: GoalSummary[];
  /** The step last started: what to continue from. */
  tip: GoalSummary;
}

/** Goals and rooms grouped by what continues what, the latest line of work first. */
export function chainsOf(items: GoalSummary[]): Chain[] {
  const byId = new Map(items.map(g => [g.id, g]));
  const rootOf = (g: GoalSummary): string => {
    const seen = new Set<string>();
    let at = g;
    while (at.from && byId.has(at.from) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byId.get(at.from)!;
    }
    return at.id;
  };
  const groups = new Map<string, GoalSummary[]>();
  for (const g of items) {
    const r = rootOf(g);
    groups.set(r, [...(groups.get(r) ?? []), g]);
  }
  return [...groups.values()]
    .map(steps => {
      steps.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { steps, tip: steps.at(-1)! };
    })
    .sort((a, b) => b.tip.createdAt.localeCompare(a.tip.createdAt));
}

/**
 * The project at a glance: plan limits, what waits on you, what's running, and your lines of work
 * (goals and rooms that continue one another), each ready to go on from its latest step.
 */
export function Home({ goals, rooms, loaded, config, onOpen, onOpenRoom, onNewRoom, onNewGoal, onContinue, onCommand, onSaveConfig, onSetup, onAllGoals }: Props) {
  const overview = useOverview();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const repo = config?.project?.dir;
  const all = useMemo(() => [...goals, ...rooms], [goals, rooms]);
  const running = all.filter(g => g.status === 'running').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const chains = useMemo(() => chainsOf(all), [all]);
  const q = query.toLowerCase();
  const found = q ? chains.filter(c => c.steps.some(g => `${g.request} ${g.result ?? ''}`.toLowerCase().includes(q))) : chains;
  const shown = showAll || q ? found : found.slice(0, 6);
  // What you just answered goes at once, not at the next refresh; it comes back if the answer didn't get through.
  const [answered, setAnswered] = useState<string[]>([]);
  const needs = (overview?.inbox ?? []).filter(i => ACTIONABLE.includes(i.kind) && !answered.includes(i.id));
  const [away, setAway] = useAway(overview?.away, onCommand);
  const label = (id: string) => goalTitle(all.find(g => g.id === id)?.request).slice(0, 40) || id;
  const roles = config?.roles.length ?? 0;
  const open = (g: GoalSummary) => (g.kind === 'room' ? onOpenRoom(g.id) : onOpen(g.id));

  return (
    <div className="page home">
      <div className="page-head">
        <div>
          <h1>Home</h1>
          {repo && (
            <div className="muted">
              Teams work in <span className="mono">{repo}</span>
              {config?.override ? <span className="pill">every role runs on {config.override}</span> : null}
            </div>
          )}
        </div>
        <div className="row">
          <ApprovalsSelect config={config} onSave={onSaveConfig} />
          {overview && <AwayButton away={away} onSet={setAway} className="btn small" />}
          <button className="btn small" onClick={onNewRoom} title="Talk it over with a lead agent and makers first, when you don't know yet what you want">
            + New room
          </button>
          <button className="btn primary small" onClick={onNewGoal} disabled={!!config && roles === 0}>
            + New goal
          </button>
        </div>
      </div>

      {away && <AwayNote />}

      {overview && (overview.accounts.length > 0 || overview.limitChecks.length > 0) && (
        <section className="home-limits">
          <h2 className="section-h">Plan limits</h2>
          <AccountList accounts={overview.accounts} checks={overview.limitChecks} onCheck={() => onCommand({ cmd: 'limits.check' })} />
        </section>
      )}

      <NeedsYou
        items={needs}
        goalLabel={label}
        onResolve={(item, decision, reply) => {
          setAnswered(a => [...a, item]);
          void onCommand({ cmd: 'inbox.resolve', item, decision, reply }).then(r => {
            if (!r) setAnswered(a => a.filter(x => x !== item));
          });
        }}
        onSelectAgent={(name, goal) => onOpen(goal, name)}
      />

      {config && roles === 0 && (
        <div className="empty panel">
          There are no roles yet, so there's nobody to lead.{' '}
          <button className="btn primary small" onClick={onSetup}>
            Set up roles
          </button>
        </div>
      )}

      {running.length > 0 && (
        <section>
          <h2 className="section-h">Running</h2>
          <div className="goal-cards">
            {running.map(g => (
              <button key={g.id} className="goal-card" onClick={() => open(g)}>
                <div className="goal-card-top">
                  <span className="pill running">
                    {g.kind === 'room' ? 'room · open' : 'running'} {duration(g.createdAt)}
                  </span>
                  {g.needs > 0 && <span className="badge warn" title="Waiting for you">{g.needs}</span>}
                  <span className="spacer" />
                  <span className="muted">{money(g.cost)}</span>
                </div>
                <div className="goal-card-title">{goalTitle(g.request)}</div>
                <div className="muted small">
                  {g.working} of {g.agents} {g.kind === 'room' ? 'participant' : 'agent'}
                  {g.agents === 1 ? '' : 's'} working
                  {g.workflow ? ` · ${g.workflow}` : ''}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-h-row">
          <h2 className="section-h">Lines of work</h2>
          <span className="spacer" />
          {(chains.length > 3 || query) && <input type="search" className="search" placeholder="Search goals and outcomes" value={query} onChange={e => setQuery(e.target.value)} />}
          {all.length > 0 && (
            <button className="btn ghost small" onClick={onAllGoals} title="Every goal, with its size on disk; delete the ones you’re done with">
              All goals…
            </button>
          )}
        </div>
        <div className="chains">
          {shown.map(c => (
            <ChainRow key={c.steps[0].id} chain={c} onOpen={open} onContinue={onContinue} />
          ))}
          {!found.length && (
            <div className="empty">
              {!loaded ? (
                'Loading…'
              ) : query ? (
                'Nothing matches.'
              ) : (
                <>
                  Goals and rooms show up here, grouped by what continues what.{' '}
                  {roles > 0 && (
                    <button className="btn primary small" onClick={onNewGoal}>
                      Start a goal
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {!showAll && !q && found.length > shown.length && (
            <button className="btn ghost" onClick={() => setShowAll(true)}>
              Show all {found.length}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/** One line of work: its steps in order, and what its latest step came to, with what to do next. */
function ChainRow({ chain, onOpen, onContinue }: { chain: Chain; onOpen: (g: GoalSummary) => void; onContinue: (f: ContinueFrom) => void }) {
  const { steps, tip } = chain;
  const finished = tip.status !== 'running';
  return (
    <div className="chain">
      <div className="chain-steps">
        {steps.map((g, i) => (
          <span key={g.id} className="chain-step-wrap">
            {i > 0 && <span className="chain-arrow">→</span>}
            <button className={`chain-step${g === tip ? ' tip' : ''}`} onClick={() => onOpen(g)} title={`${g.request}\n\n${g.status} · ${money(g.cost)} · ${ago(g.createdAt)}`}>
              <span className={`pill ${g.status}`}>{g.kind === 'room' ? 'room' : g.status}</span>
              <span className="ellipsis">{goalTitle(g.request)}</span>
            </button>
          </span>
        ))}
        <span className="spacer" />
        <span className="muted small nowrap">
          {steps.length > 1 ? `${steps.length} steps · ` : ''}
          {money(steps.reduce((n, g) => n + (g.cost ?? 0), 0))} · {ago(tip.createdAt)}
        </span>
      </div>
      {tip.result && (
        <More lines={2} className="quiet">
          <Markdown text={tip.result} />
        </More>
      )}
      {finished && (
        <div className="chain-actions">
          <ContinueButtons small from={{ id: tip.id, label: goalTitle(tip.request), kind: tip.kind }} onContinue={onContinue} />
        </div>
      )}
    </div>
  );
}
