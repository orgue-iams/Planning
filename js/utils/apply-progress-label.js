/**
 * Libellés homogènes pour barres de progression (fermetures, gabarit A/B, décalage prof).
 * @param {{ domain: string, step?: number, total?: number, detail?: string }} p
 */
export function formatApplyProgressLabel(p) {
    const domain = String(p.domain || 'Traitement').trim();
    const detail = String(p.detail || '').trim();
    const hasCounter =
        typeof p.step === 'number' &&
        typeof p.total === 'number' &&
        p.total > 0 &&
        Number.isFinite(p.step);
    const counter = hasCounter ? ` (${Math.min(p.step, p.total)}/${p.total})` : '';
    if (detail) return `${domain}${counter} — ${detail}`;
    return `${domain}${counter}`;
}

/**
 * @param {string[]} titles
 * @param {number} [max]
 */
export function formatUniqueTitlesPreview(titles, max = 3) {
    const unique = [...new Set(titles.map((t) => String(t || '').trim()).filter(Boolean))];
    const slice = unique.slice(0, max);
    const quoted = slice.map((t) => `« ${t} »`);
    const more = unique.length > max ? ` (+${unique.length - max})` : '';
    return { text: quoted.join(', ') + more, count: unique.length };
}
