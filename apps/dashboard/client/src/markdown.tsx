import { createElement, type VNode } from 'preact';

// ---- minimal, XSS-safe markdown → Preact renderer (no innerHTML, no deps) ----

export function safeUrl(url: string): string | undefined {
  const u = url.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(u)) return u;
  return undefined; // drop javascript:, data:, etc.
}

export function inline(text: string): Array<string | VNode> {
  const out: Array<string | VNode> = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] != null) out.push(<em key={key++}>{m[3]}</em>);
    else if (m[4] != null) out.push(<code key={key++}>{m[4]}</code>);
    else if (m[5] != null) {
      const href = safeUrl(m[6] ?? '');
      out.push(
        href ? (
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
            {m[5]}
          </a>
        ) : (
          (m[5] ?? '')
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** An anchored comment to highlight inline in the rendered plan. */
export interface RenderAnchor {
  id: string;
  exact: string;
  num: number;
  active: boolean;
  resolved: boolean;
}

/** Render a block of prose, wrapping the first occurrence of each comment anchor with a highlight + pin. */
export function blockText(
  text: string,
  anchors: RenderAnchor[],
  onAnchor: (id: string) => void,
  keyer: () => number,
): Array<string | VNode> {
  for (const a of anchors) {
    const idx = a.exact.length > 0 ? text.indexOf(a.exact) : -1;
    if (idx >= 0) {
      const before = text.slice(0, idx);
      const after = text.slice(idx + a.exact.length);
      const rest = anchors.filter((x) => x !== a);
      const cls = `plan-anchor${a.active ? ' active' : ''}${a.resolved ? ' resolved' : ''}`;
      return [
        ...inline(before),
        <span
          key={keyer()}
          class={cls}
          onClick={(e) => {
            e.stopPropagation();
            onAnchor(a.id);
          }}
        >
          {inline(a.exact)}
          <sup class="plan-pin">{a.num}</sup>
        </span>,
        ...blockText(after, rest, onAnchor, keyer),
      ];
    }
  }
  return inline(text);
}

export function renderMarkdown(
  md: string,
  anchors: RenderAnchor[],
  onAnchor: (id: string) => void,
): VNode[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: VNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => key++;
  const prose = (t: string) => blockText(t, anchors, onAnchor, k);
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++;
      blocks.push(
        <pre key={k()} class="md-code">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const level = Math.min((head[1]?.length ?? 1) + 2, 6);
      blocks.push(createElement(`h${level}`, { key: k(), class: 'md-h' }, inline(head[2] ?? '')));
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={k()} />);
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        quote.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(<blockquote key={k()}>{prose(quote.join(' '))}</blockquote>);
      continue;
    }
    const ulRe = /^\s*[-*+]\s+(.*)$/;
    const olRe = /^\s*\d+\.\s+(.*)$/;
    if (ulRe.test(line) || olRe.test(line)) {
      const ordered = olRe.test(line);
      const re = ordered ? olRe : ulRe;
      const items: VNode[] = [];
      while (i < lines.length && re.test(lines[i] ?? '')) {
        const m = re.exec(lines[i] ?? '');
        items.push(<li key={k()}>{prose(m?.[1] ?? '')}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k()}>{items}</ol> : <ul key={k()}>{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,6})\s/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').startsWith('```') &&
      !(lines[i] ?? '').startsWith('>')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    blocks.push(<p key={k()}>{prose(para.join(' '))}</p>);
  }
  return blocks;
}

/** Convenience wrapper: render plain markdown text with no comment anchors. */
export function renderMd(text: string): VNode[] {
  return renderMarkdown(text, [], () => {});
}
