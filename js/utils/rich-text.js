/** Échappement HTML pour fragments texte. */
function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

/**
 * Gras + italique + retours ligne (contenu déjà traité pour les liens).
 * **gras** , *italique* (italique : une seule paire d’astérisques, pas de doubles).
 */
function formatBoldItalicEscapé(escapedPlain) {
    const parts = escapedPlain.split(/\*\*/);
    return parts
        .map((p, i) => {
            if (i % 2 === 1) return `<strong>${p}</strong>`;
            return p.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        })
        .join('');
}

function sanitizeHref(raw) {
    const t = String(raw ?? '').trim();
    if (!t) return null;
    try {
        const u = new URL(t, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
        if (u.protocol === 'mailto:') return u.href;
    } catch {
        return null;
    }
    return null;
}

/**
 * Inline : liens [libellé](url), **gras**, *italique*.
 * @param {string} plain texte brut (non échappé)
 */
export function formatRichInline(plain) {
    const text = String(plain ?? '');
    const out = [];
    let pos = 0;
    while (pos < text.length) {
        const linkStart = text.indexOf('[', pos);
        if (linkStart === -1) {
            out.push(formatBoldItalicEscapé(escapeHtml(text.slice(pos))));
            break;
        }
        if (linkStart > pos) {
            out.push(formatBoldItalicEscapé(escapeHtml(text.slice(pos, linkStart))));
        }
        const mid = text.indexOf('](', linkStart);
        const end = mid === -1 ? -1 : text.indexOf(')', mid + 2);
        if (mid !== -1 && end !== -1) {
            const label = text.slice(linkStart + 1, mid);
            const href = text.slice(mid + 2, end);
            const safe = sanitizeHref(href);
            if (safe) {
                out.push(
                    `<a href="${escapeHtml(safe)}" class="organ-rich-a" target="_blank" rel="noopener noreferrer">${formatBoldItalicEscapé(escapeHtml(label))}</a>`
                );
            } else {
                out.push(formatBoldItalicEscapé(escapeHtml(text.slice(linkStart, end + 1))));
            }
            pos = end + 1;
        } else {
            out.push(formatBoldItalicEscapé(escapeHtml(text[linkStart])));
            pos = linkStart + 1;
        }
    }
    return out.join('');
}

function isBlockSpecialLine(line) {
    const t = line.trim();
    if (t === '---') return true;
    if (/^#{1,3}\s/.test(t)) return true;
    if (/^[-*]\s+/.test(t)) return true;
    if (/^\d+\.\s+/.test(t)) return true;
    if (t.startsWith('>')) return true;
    return false;
}

/**
 * Mise en forme riche pour règles / contenus éditoriaux (sans HTML brut).
 * Blocs : paragraphes (lignes séparées par ligne vide ou début de bloc spécial),
 * # / ## / ### titres, listes - ou *, listes 1., citations > , séparateur --- .
 */
export function formatRichContentHtml(source) {
    const lines = String(source ?? '').split(/\n/);
    const chunks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            i++;
            continue;
        }
        const trimmed = line.trim();
        if (trimmed === '---') {
            chunks.push('<hr class="organ-rich-hr" />');
            i++;
            continue;
        }
        if (/^###\s/.test(trimmed)) {
            chunks.push(
                `<h5 class="organ-rich-h organ-rich-h-level3">${formatRichInline(trimmed.replace(/^###\s+/, ''))}</h5>`
            );
            i++;
            continue;
        }
        if (/^##\s/.test(trimmed)) {
            chunks.push(
                `<h4 class="organ-rich-h organ-rich-h-level2">${formatRichInline(trimmed.replace(/^##\s+/, ''))}</h4>`
            );
            i++;
            continue;
        }
        if (/^#\s/.test(trimmed)) {
            chunks.push(
                `<h3 class="organ-rich-h organ-rich-h-level1">${formatRichInline(trimmed.replace(/^#\s+/, ''))}</h3>`
            );
            i++;
            continue;
        }
        if (trimmed.startsWith('>')) {
            const qs = [];
            while (i < lines.length) {
                const ti = lines[i].trim();
                if (!ti.startsWith('>')) break;
                qs.push(formatRichInline(ti.replace(/^>\s?/, '')));
                i++;
            }
            chunks.push(`<blockquote class="organ-rich-bq">${qs.join('<br>')}</blockquote>`);
            continue;
        }
        if (/^[-*]\s+/.test(trimmed)) {
            const items = [];
            while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
                const ti = lines[i].trim();
                items.push(`<li>${formatRichInline(ti.replace(/^[-*]\s+/, ''))}</li>`);
                i++;
            }
            chunks.push(`<ul class="organ-rich-ul">${items.join('')}</ul>`);
            continue;
        }
        if (/^\d+\.\s+/.test(trimmed)) {
            const items = [];
            while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
                const ti = lines[i].trim();
                items.push(`<li>${formatRichInline(ti.replace(/^\d+\.\s+/, ''))}</li>`);
                i++;
            }
            chunks.push(`<ol class="organ-rich-ol">${items.join('')}</ol>`);
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() !== '' && !isBlockSpecialLine(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        chunks.push(
            `<p class="organ-rich-p">${para.map((l) => formatRichInline(l)).join('<br>')}</p>`
        );
    }
    return `<div class="organ-rich">${chunks.join('')}</div>`;
}

/** Mise en forme minimale : **gras** + retours à la ligne (annonces, bandeau). */
export function formatSimpleRichHtml(text) {
    const parts = String(text ?? '').split(/\*\*/);
    const inner = parts
        .map((p, i) => {
            const d = document.createElement('div');
            d.textContent = p;
            const esc = d.innerHTML;
            return i % 2 === 1 ? `<strong>${esc}</strong>` : esc;
        })
        .join('');
    return inner.replace(/\n/g, '<br>');
}
