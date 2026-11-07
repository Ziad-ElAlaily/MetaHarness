import { useState, type ReactNode } from 'react';
import type { Scope, SkillDef, SkillSource } from '../types.ts';
import { Field, Markdown, Toggle, useConfirm } from '../components/common.tsx';
import { ListItem, Section } from './setup.tsx';

/**
 * Skills in the Tools & skills library (design §18): guides with files that agents read through
 * the skill tool. Read-only here: a skill is a folder written in an editor. Roles say which ones
 * they carry; rules can point at one. Tools agents made (design §24) are skills too, shown apart
 * with where they came from, and a project's can be moved to the personal library.
 */

const SOURCE: Record<SkillSource, string> = {
  'built-in': 'built-in',
  personal: 'personal',
  repo: 'project',
  '.claude': 'project · .claude',
  '.agents': 'project · .agents',
};

/** A skill's key in the address, apart from servers' scope/name. */
export const skillKey = (s: SkillDef) => `skill/${s.name}`;

function size(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function SkillItem({ skill, on, onClick }: { skill: SkillDef; on: boolean; onClick: () => void }) {
  return (
    <ListItem
      on={on}
      title={skill.name}
      extra={
        <>
          {!skill.on && <span className="tag muted">off</span>}
          {skill.missing.length > 0 && <span className="tag muted" title={`Not installed here: ${skill.missing.join(', ')}`}>needs {skill.missing.join(', ')}</span>}
          {skill.tool && skill.source === 'repo' && skill.overrides === 'personal' && !skill.personalSame && <span className="tag muted" title="This project’s copy differs from the one in your personal library">changed</span>}
          <span className={`scope ${skill.source.startsWith('.') ? 'repo' : skill.source}`}>{skill.tool ? (skill.source === 'personal' ? 'your library' : 'project') : SOURCE[skill.source]}</span>
        </>
      }
      onClick={onClick}
      sub={skill.description && <span className="clamp-2">{skill.description}</span>}
    />
  );
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : new Date(iso).toLocaleDateString();
}

/** A tool's story: who made it for whom and why, what it needs, how much it's used, and moving it to the personal library. */
function ToolSection({ skill, onSave }: { skill: SkillDef; onSave: (b: Record<string, unknown>) => unknown }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const inProject = skill.source === 'repo';
  const elevate = async () => {
    const replaces = skill.overrides === 'personal' ? ' It replaces the copy in your library.' : '';
    const ok = await confirm({
      title: `Move ${skill.name} to your library?`,
      body: <p>Agents in every project can then use it. Its folder moves to <span className="mono">~/.metaharness/tools/</span> and leaves this project, in a commit of its own if the project tracks it.{replaces}</p>,
      confirm: 'Move to my library',
    });
    if (!ok) return;
    setBusy(true);
    await onSave({ cmd: 'tool.elevate', name: skill.name });
    setBusy(false);
  };
  return (
    <Section title="Where it came from">
      <div className="grid-2">
        <Field label="Made by">{skill.madeBy ?? <span className="muted">not recorded</span>}</Field>
        <Field label="Asked for by">{skill.askedBy ?? <span className="muted">not recorded</span>}</Field>
      </div>
      {skill.why && <Field label="Why">{skill.why}</Field>}
      <div className="grid-2">
        <Field label="Needs" hint="Programs it runs; mh doctor checks them too.">
          <span className="chips">
            {skill.needs.length ? skill.needs.map(n => <span key={n} className={`chip ro${skill.missing.includes(n) ? ' missing' : ''}`} title={skill.missing.includes(n) ? 'Not installed here' : undefined}>{n}{skill.missing.includes(n) ? ' ✗' : ''}</span>) : <span className="muted">nothing outside its folder</span>}
          </span>
        </Field>
        <Field label="Uses" hint="Other tools or skills it calls; they come along when it’s exported.">
          <span className="chips">{skill.uses.length ? skill.uses.map(n => <span key={n} className="chip ro">{n}</span>) : <span className="muted">none</span>}</span>
        </Field>
      </div>
      <Field label="Used" hint="Agents that read it, across every goal.">
        {skill.usage ? `${skill.usage.agents} agent${skill.usage.agents === 1 ? '' : 's'}, last ${ago(skill.usage.last)}` : <span className="muted">not yet</span>}
      </Field>
      {inProject ? (
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={() => void elevate()}>
            {skill.overrides === 'personal' ? (skill.personalSame ? 'Same as in your library: remove the project’s copy' : 'Update your library with this version') : 'Move to my library'}
          </button>
          <span className="hint">
            {skill.overrides === 'personal'
              ? skill.personalSame ? 'This project has a copy of the tool in your library.' : 'The toolsmith changed this project’s copy of a tool in your library. This project uses its own copy until you update your library.'
              : 'Only this project has it. In your library, every project gets it.'}
          </span>
        </div>
      ) : (
        <div className="hint">In your library: every project gets it. A toolsmith that changes it does so in a project’s copy, which you can take back here.</div>
      )}
    </Section>
  );
}

export function SkillDetail({ skill, scopes, onSave, exportButton }: { skill: SkillDef; scopes: { scope: Scope }[]; onSave: (b: Record<string, unknown>) => unknown; exportButton?: ReactNode }) {
  const switchScope: Scope = skill.switchedBy ?? (scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');
  return (
    <div className="editor">
      <div className="editor-scroll">
        <div className="editor-title">
          <h2>{skill.name}</h2>
          {exportButton}
          {skill.overrides && !skill.tool && <span className="hint">Replaces the {SOURCE[skill.overrides]} skill of this name.</span>}
        </div>
        {skill.tool && <ToolSection skill={skill} onSave={onSave} />}
        <Section title="On or off">
          <Toggle
            checked={skill.on}
            onChange={on => void onSave({ cmd: 'settings.save', scope: switchScope, patch: { skills: { [skill.name]: on } } })}
            label={skill.on ? `Agents can read this ${skill.tool ? 'tool' : 'skill'}` : 'Off: agents don’t see it'}
            hint={`Saved in ${switchScope === 'repo' ? 'this project’s' : 'your personal'} settings.json.`}
          />
        </Section>
        <Section title="What it's for">
          <div>{skill.description || <span className="muted">No description. Agents decide from it whether to read the skill, so add one to its front matter.</span>}</div>
        </Section>
        <Section title="Who carries it">
          <div className="grid-2">
            <Field label="Roles" hint={skill.tool ? 'Every agent can read a tool. A role that names it under Skills gets it in its kit, spelled out in its prompt, as does a teammate given it at spawn.' : 'A role’s Skills setting names the skills it carries.'}>
              <span className="chips">{skill.carriedBy.length ? skill.carriedBy.map(r => <span key={r} className="chip ro">{r}</span>) : <span className="muted">{skill.tool ? 'in no role’s kit' : 'every role (none names it)'}</span>}</span>
            </Field>
            <Field label="Harnesses" hint="harness: in its front matter.">
              <span className="chips">{skill.harness.length ? skill.harness.map(h => <span key={h} className="chip ro">{h}</span>) : <span className="muted">every harness</span>}</span>
            </Field>
          </div>
          <Field label="Rules pointing at it" hint="A rule with this skill reminds agents of it at a moment MetaHarness can see.">
            <span className="chips">{skill.pointedBy.length ? skill.pointedBy.map(r => <span key={r} className="chip ro">{r}</span>) : <span className="muted">none: agents see it in their prompt’s skill list</span>}</span>
          </Field>
        </Section>
        <Section title="SKILL.md">
          <div className="preview">
            <Markdown text={skill.body} />
          </div>
        </Section>
        {skill.files.length > 0 && (
          <Section title="Files">
            <ul className="file-list mono small">
              {skill.files.map(f => (
                <li key={f.path}>
                  {f.path} <span className="muted">({size(f.bytes)})</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <div className="muted small mono file-path">{skill.file}</div>
      </div>
    </div>
  );
}
