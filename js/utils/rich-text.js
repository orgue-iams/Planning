/** Échappement HTML pour fragments texte. */
function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function sanitizeCssValue(raw) {
    const v = String(raw ?? '').trim();
    if (!v) return '';
    // Très strict : on refuse tout ce qui ressemble à une fonction ou à une URL.
    if (/[()]/.test(v)) return '';
    if (/url\s*=/i.test(v)) return '';
    return v;
}

function sanitizeStyleAttr(styleText) {
    const style = String(styleText ?? '');
    if (!style) return '';
    const keep = [];
    for (const decl of style.split(';')) {
        const [kRaw, vRaw] = decl.split(':');
        if (!kRaw || !vRaw) continue;
        const k = kRaw.trim().toLowerCase();
        const v = sanitizeCssValue(vRaw);
        if (!v) continue;
        if (k === 'color') {
            if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) keep.push(`color:${v}`);
        }
        if (k === 'font-size') {
            if (/^\d{1,2}px$/.test(v) || /^\d{1,2}(\.\d)?rem$/.test(v)) keep.push(`font-size:${v}`);
        }
        if (k === 'font-family') {
            if (/^[a-z0-9 ,\-]+$/i.test(v)) keep.push(`font-family:${v}`);
        }
        if (k === 'text-decoration') {
            if (/^(underline|none)$/i.test(v)) keep.push(`text-decoration:${v}`);
        }
        if (k === 'font-weight') {
            if (/^(bold|normal|[1-9]00)$/i.test(v)) keep.push(`font-weight:${v}`);
        }
        if (k === 'font-style') {
            if (/^(italic|normal)$/i.test(v)) keep.push(`font-style:${v}`);
        }
    }
    return keep.join(';');
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
 * Nettoie un HTML riche (WYSIWYG) en ne gardant qu’un sous-ensemble sûr de balises/attributs.
 * Objectif : permettre taille/police/couleur sans autoriser scripts/handlers/styles dangereux.
 */
export function sanitizeRulesHtml(html) {
    const input = String(html ?? '');
    if (!input) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, 'text/html');

    const allowedTags = new Set([
        'DIV',
        'P',
        'BR',
        'STRONG',
        'B',
        'EM',
        'I',
        'U',
        'UL',
        'OL',
        'LI',
        'H3',
        'H4',
        'H5',
        'BLOCKQUOTE',
        'HR',
        'A',
        'SPAN'
    ]);

    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return;
        if (node.nodeType === Node.COMMENT_NODE) {
            node.remove();
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            node.remove();
            return;
        }

        const el = /** @type {HTMLElement} */ (node);
        const tag = el.tagName.toUpperCase();

        if (!allowedTags.has(tag)) {
            const parent = el.parentNode;
            if (!parent) {
                el.remove();
                return;
            }
            while (el.firstChild) parent.insertBefore(el.firstChild, el);
            el.remove();
            return;
        }

        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
                continue;
            }
            if (name === 'style') {
                const clean = sanitizeStyleAttr(attr.value);
                if (clean) el.setAttribute('style', clean);
                else el.removeAttribute('style');
                continue;
            }
            if (tag === 'A' && name === 'href') {
                const safe = sanitizeHref(attr.value);
                if (safe) el.setAttribute('href', safe);
                else el.removeAttribute('href');
                continue;
            }
            // Autoriser target/rel, on forcera des valeurs sûres.
            if (tag === 'A' && (name === 'target' || name === 'rel')) continue;

            el.removeAttribute(attr.name);
        }

        if (tag === 'A') {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
        }

        for (const child of Array.from(el.childNodes)) walk(child);
    };

    for (const child of Array.from(doc.body.childNodes)) walk(child);
    return doc.body.innerHTML;
}

/** Convertit un texte simple en HTML sûr (paragraphes + <br>). */
export function plainTextToSafeHtml(text) {
    const t = String(text ?? '');
    if (!t) return '';
    const lines = t.split(/\n/).map((l) => escapeHtml(l));
    return `<p>${lines.join('<br>')}</p>`;
}

export function looksLikeHtml(text) {
    const t = String(text ?? '').trim();
    if (!t) return false;
    return /<\/?[a-z][\s\S]*>/i.test(t);
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
