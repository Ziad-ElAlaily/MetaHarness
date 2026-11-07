/**
 * How a shell command is shown to the gatekeeper and the human (DESIGN.md §10): Codex's
 * `/bin/bash -lc '…'` wrapper taken off, and, for the gatekeeper, the bodies of quoted
 * here-documents that `cat` or `tee` write into a file left out, since the shell writes them as
 * is. Only ever a view: the checks and the agent use the command as it came.
 */

/** The script inside `bash -lc '<script>'` (or sh, zsh) when the command is only that; else the command. */
export function unwrapShell(command: string): string {
  const words = plainWords(command.trim());
  if (words?.length !== 3) return command;
  const [sh, flag, script] = words;
  return /^(\/(usr\/)?bin\/)?(bash|sh|zsh)$/.test(sh) && /^-[a-z]*c[a-z]*$/.test(flag) ? script : command;
}

/**
 * The words of a command with nothing for the shell to expand or run outside single quotes
 * (no operators, variables, substitutions, globs or comments); undefined otherwise.
 */
function plainWords(src: string): string[] | undefined {
  const out: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? '') + src.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let s = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '$' || src[j] === '`') return undefined;
        if (src[j] === '\\' && src[j + 1] === '\n') j++;
        else if (src[j] === '\\' && '"\\$`'.includes(src[j + 1])) s += src[++j];
        else s += src[j];
      }
      if (j >= src.length) return undefined;
      word = (word ?? '') + s;
      i = j;
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') word = (word ?? '') + (src[i + 1] ?? '');
      i++;
    } else if (c === ' ' || c === '\t') {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else if (';|&<>()$`*?[]{}~#!\n'.includes(c)) return undefined;
    else word = (word ?? '') + c;
  }
  if (word !== undefined) out.push(word);
  return out;
}

interface Heredoc {
  word: string;
  /** <<- : the end line may be indented with tabs. */
  dash: boolean;
  /** <<'EOF', <<"EOF" or <<\EOF: the body is written as is. */
  quoted: boolean;
  /** `cat` or `tee` writes it out: text, where for python or node it's the program. */
  toFile: boolean;
}

/** `cat > f <<'EOF'`, `cat <<'EOF' > f`, `tee f <<'EOF'`: the command before the here-document, and the rest of its line. Not piped on. */
function writesFile(before: string, after: string): boolean {
  return /^\s*(?:\w+=\S*\s+)*(cat|tee)\b/.test(before) && !/\|/.test(after.replace(/\|\|/g, ''));
}

/**
 * The script with the body of each quoted here-document that goes into a file replaced by a line
 * saying how long it was, as nothing in it runs. Unquoted ones keep their body ($( … ) and
 * backticks in it do run), and so do those fed to a program (`python3 - <<'PY'`): that's the
 * script the gatekeeper has to judge. Anything it can't follow (an unclosed quote, a missing end
 * line) leaves the script whole.
 */
export function elideHeredocs(script: string): string {
  const n = script.length;
  let out = '';
  let pending: Heredoc[] = [];
  /** Where the command being read starts. */
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = script[i];
    if (';|('.includes(c) || (c === '&' && script[i - 1] !== '>' && script[i + 1] !== '>')) start = i + 1;
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < n && script[j] !== c; j++) if (c === '"' && script[j] === '\\') j++;
      if (j >= n) return script;
      out += script.slice(i, j + 1);
      i = j + 1;
    } else if (c === '\\') {
      out += script.slice(i, i + 2);
      i += 2;
    } else if (c === '#' && (i === 0 || /[\s;|&(]/.test(script[i - 1]))) {
      const end = script.indexOf('\n', i) < 0 ? n : script.indexOf('\n', i);
      out += script.slice(i, end);
      i = end;
    } else if (script.startsWith('<<<', i)) {
      // A here-string: its word is on the same line.
      out += '<<<';
      i += 3;
    } else if (c === '<' && script[i + 1] === '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\(\w+)|(\w+))/.exec(script.slice(i));
      if (!m) return script;
      const eol = script.indexOf('\n', i) < 0 ? n : script.indexOf('\n', i);
      const toFile = writesFile(script.slice(start, i), script.slice(i + m[0].length, eol));
      pending.push({ dash: m[1] === '-', word: m[2] ?? m[3] ?? m[4] ?? m[5], quoted: m[5] === undefined, toFile });
      out += m[0];
      i += m[0].length;
    } else if (c === '\n' && pending.length) {
      out += '\n';
      i++;
      for (const h of pending) {
        const body: string[] = [];
        for (;;) {
          if (i >= n) return script;
          const end = script.indexOf('\n', i) < 0 ? n : script.indexOf('\n', i);
          const line = script.slice(i, end);
          i = end + 1;
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.word) {
            out += h.quoted && h.toFile ? `[${body.length} line${body.length === 1 ? '' : 's'} of text, written out as is: nothing in ${body.length === 1 ? 'it' : 'them'} runs]\n` : body.map(l => `${l}\n`).join('');
            out += line + (end < n ? '\n' : '');
            break;
          }
          body.push(line);
        }
      }
      pending = [];
      // The next command starts after the last end line, not where the bodies began.
      start = i;
    } else {
      if (c === '\n') start = i + 1;
      out += c;
      i++;
    }
  }
  return pending.length ? script : out;
}
