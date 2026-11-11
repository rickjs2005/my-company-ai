// Markdown leve para prévias (Mural, Mesa e visualizador): títulos, listas, separador e negrito. O resto aparece como texto.
// Nada é interpretado como HTML: o texto vira elementos React.

/** Negrito inline (**assim**) sem interpretar HTML. */
function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (/^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

export function MdLite({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return (
    <div className={`hq-soc-preview hq-soc-md${className ? ` ${className}` : ''}`}>
      {lines.map((l, i) => {
        if (/^\s{0,3}#{1,6}\s/.test(l)) return <p key={i} className="hq-soc-md__h">{inline(l.replace(/^\s{0,3}#{1,6}\s+/, ''))}</p>;
        if (/^\s{0,3}(---|\*\*\*|___)\s*$/.test(l)) return <hr key={i} />;
        if (/^\s*[-*•]\s+/.test(l)) return <p key={i} className="hq-soc-md__li">{inline(l.replace(/^\s*[-*•]\s+/, ''))}</p>;
        if (!l.trim()) return <div key={i} className="hq-soc-md__gap" />;
        return <p key={i}>{inline(l)}</p>;
      })}
    </div>
  );
}

export const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);
