/**
 * Éditeur WYSIWYG partagé (modales Règles + Annonces).
 * Requiert `window.Quill` chargé via CDN (voir index.html).
 *
 * Tailles : format Quill `size` (px) — 3 boutons T (prof) ou T− / T+ pas à pas (admin).
 */

const PLANNING_QUILL_SIZE_VER = 'style-px-v2';

const PLANNING_FONT_SIZES = /** @type {const} */ (['12px', '16px', '20px']);

/** @param {any} quill */
function applyPlanningFontSize(quill, px) {
    if (!quill) return;
    const range = quill.getSelection(true);
    if (range && range.length > 0) {
        quill.formatText(range.index, range.length, 'size', px, 'user');
    } else {
        quill.format('size', px, 'user');
    }
}

/** @param {any} quill */
function currentPlanningFontSizeIndex(quill) {
    const range = quill.getSelection(true);
    if (!range) return 1;
    const fmt = range.length > 0 ? quill.getFormat(range.index, 1) : quill.getFormat(range.index);
    const s = fmt?.size;
    const i = PLANNING_FONT_SIZES.indexOf(s);
    return i >= 0 ? i : 1;
}

/** Icône sobre : T + trait (diminuer). */
function planningFsSvgDecrease() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M12 5v8', 'M8 5h8', 'M7 18h10']) {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
    }
    return svg;
}

/** Icône sobre : T + croix (augmenter). */
function planningFsSvgIncrease() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M12 4v7', 'M8 4h8', 'M12 15v6', 'M9 18h6']) {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
    }
    return svg;
}

/**
 * @param {any} quill
 * @param {{ adminFontStepper?: boolean } | undefined} opts
 */
function injectPlanningFontSizeButtons(quill, opts = {}) {
    const tb = quill?.getModule?.('toolbar');
    const container = tb?.container;
    if (!(container instanceof HTMLElement)) return;
    const wrap = document.createElement('span');
    wrap.className = 'ql-formats planning-quill-fs-group';
    wrap.setAttribute('aria-label', 'Taille du texte');

    if (opts.adminFontStepper) {
        const bMinus = document.createElement('button');
        bMinus.type = 'button';
        bMinus.className = 'planning-fs-btn planning-fs-step planning-fs-step--minus';
        bMinus.title = 'Réduire la taille (T−)';
        bMinus.setAttribute('aria-label', 'Réduire la taille du texte');
        bMinus.appendChild(planningFsSvgDecrease());
        const labMinus = document.createElement('span');
        labMinus.className = 'planning-fs-step-text';
        labMinus.setAttribute('aria-hidden', 'true');
        labMinus.textContent = 'T−';
        bMinus.appendChild(labMinus);

        const bPlus = document.createElement('button');
        bPlus.type = 'button';
        bPlus.className = 'planning-fs-btn planning-fs-step planning-fs-step--plus';
        bPlus.title = 'Augmenter la taille (T+)';
        bPlus.setAttribute('aria-label', 'Augmenter la taille du texte');
        bPlus.appendChild(planningFsSvgIncrease());
        const labPlus = document.createElement('span');
        labPlus.className = 'planning-fs-step-text';
        labPlus.setAttribute('aria-hidden', 'true');
        labPlus.textContent = 'T+';
        bPlus.appendChild(labPlus);

        const syncDisabled = () => {
            const i = currentPlanningFontSizeIndex(quill);
            bMinus.disabled = i <= 0;
            bPlus.disabled = i >= PLANNING_FONT_SIZES.length - 1;
        };

        bMinus.addEventListener('click', (ev) => {
            ev.preventDefault();
            const i = currentPlanningFontSizeIndex(quill);
            if (i <= 0) return;
            applyPlanningFontSize(quill, PLANNING_FONT_SIZES[i - 1]);
            syncDisabled();
        });
        bPlus.addEventListener('click', (ev) => {
            ev.preventDefault();
            const i = currentPlanningFontSizeIndex(quill);
            if (i >= PLANNING_FONT_SIZES.length - 1) return;
            applyPlanningFontSize(quill, PLANNING_FONT_SIZES[i + 1]);
            syncDisabled();
        });

        quill.on('selection-change', syncDisabled);
        syncDisabled();

        wrap.appendChild(bMinus);
        wrap.appendChild(bPlus);
    } else {
        const sizes = [
            { px: '12px', cls: 'planning-fs-sm', title: 'Petit' },
            { px: '16px', cls: 'planning-fs-md', title: 'Moyen' },
            { px: '20px', cls: 'planning-fs-lg', title: 'Grand' }
        ];
        for (const { px, cls, title } of sizes) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `planning-fs-btn ${cls}`;
            b.textContent = 'T';
            b.title = title;
            b.setAttribute('aria-label', `${title} (${px})`);
            b.addEventListener('click', (ev) => {
                ev.preventDefault();
                applyPlanningFontSize(quill, px);
            });
            wrap.appendChild(b);
        }
    }

    container.appendChild(wrap);
}

export function isQuillAvailable() {
    return typeof window !== 'undefined' && typeof window.Quill === 'function';
}

function registerPlanningSizeFormat() {
    if (window.__planningQuillSizeVer === PLANNING_QUILL_SIZE_VER) return;
    const Quill = window.Quill;
    try {
        const SizeStyle = Quill.import('attributors/style/size');
        SizeStyle.whitelist = ['10px', '12px', '14px', '16px', '18px', '20px'];
        Quill.register(SizeStyle, true);
    } catch (e) {
        console.warn('[planning-quill] attributors/style/size indisponible, repli formats/size', e);
        const Size = Quill.import('formats/size');
        Size.whitelist = ['10px', '12px', '14px', '16px', '18px', '20px'];
        Quill.register(Size, true);
    }
    window.__planningQuillSizeVer = PLANNING_QUILL_SIZE_VER;
    try {
        delete window.__planningQuillSizeRegistered;
    } catch {
        /* */
    }
}

/**
 * @param {HTMLElement} mountEl conteneur vide (rempli par Quill : barre + zone d’édition)
 * @param {{ placeholder?: string; adminFontStepper?: boolean; compactAnnouncementToolbar?: boolean; disableFontSizeButtons?: boolean } | undefined} opts
 *   compactAnnouncementToolbar : annonces login — gras / italique / souligné uniquement (pas de tailles ni listes).
 */
export function createPlanningQuill(mountEl, opts = {}) {
    if (!(mountEl instanceof HTMLElement)) return null;
    if (!isQuillAvailable()) {
        console.warn('[planning-quill] Quill indisponible');
        return null;
    }
    destroyPlanningQuillMount(mountEl);
    registerPlanningSizeFormat();
    const Quill = window.Quill;
    const toolbar = opts.compactAnnouncementToolbar
        ? [['bold', 'italic', 'underline']]
        : [['bold', 'italic', 'underline'], [{ list: 'bullet' }]];
    const q = new Quill(mountEl, {
        theme: 'snow',
        placeholder: opts.placeholder ?? '',
        modules: { toolbar }
    });
    if (!opts.compactAnnouncementToolbar && !opts.disableFontSizeButtons) {
        injectPlanningFontSizeButtons(q, opts);
    }
    return q;
}

/** Vide le conteneur Quill (barre + éditeur) et retire toute barre orpheline (frères du mount, ex. ré-init). */
export function destroyPlanningQuillMount(mountEl) {
    if (!(mountEl instanceof HTMLElement)) return;
    mountEl.replaceChildren();
    const parent = mountEl.parentElement;
    if (parent instanceof HTMLElement) {
        parent.querySelectorAll(':scope > .ql-toolbar').forEach((n) => n.remove());
    }
}

/**
 * @param {any} quill instance Quill
 * @param {string} html fragment HTML (souvent déjà nettoyé côté app)
 */
export function quillSetHtml(quill, html) {
    if (!quill) return;
    const raw = String(html ?? '').trim();
    if (!raw) {
        quill.setContents([]);
        return;
    }
    const plainLen = raw.replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ').trim().length;
    try {
        const delta = quill.clipboard.convert({ html: raw });
        quill.setContents(delta, 'silent');
    } catch {
        quill.setContents([]);
    }
    if (plainLen > 0) {
        const after = quill.getText().replace(/\u00a0/g, ' ').replace(/\n+$/, '').trim();
        if (after.length === 0) {
            try {
                quill.setContents([], 'silent');
                const clip = quill.clipboard;
                if (clip && typeof clip.dangerouslyPasteHTML === 'function') {
                    clip.dangerouslyPasteHTML(0, raw, 'silent');
                } else {
                    quill.root.innerHTML = raw;
                    quill.update('silent');
                }
            } catch {
                /* */
            }
        }
    }
}

/** Texte brut utile pour valider une saisie non vide (ignore les paragraphes vides Quill). */
export function quillGetPlainText(quill) {
    if (!quill) return '';
    return String(quill.getText() ?? '').replace(/\u00a0/g, ' ').trim();
}
