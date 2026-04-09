/**
 * Éditeur WYSIWYG partagé (modales Règles + Annonces).
 * Requiert `window.Quill` chargé via CDN (voir index.html).
 *
 * Tailles : format Quill `size` (px) + boutons T petit / moyen / grand (pas de liste déroulante).
 */

const PLANNING_QUILL_SIZE_VER = 'style-px-v2';

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
function injectPlanningFontSizeButtons(quill) {
    const tb = quill?.getModule?.('toolbar');
    const container = tb?.container;
    if (!(container instanceof HTMLElement)) return;
    const wrap = document.createElement('span');
    wrap.className = 'ql-formats planning-quill-fs-group';
    wrap.setAttribute('aria-label', 'Taille du texte');
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
 * @param {{ placeholder?: string } | undefined} opts
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
    const q = new Quill(mountEl, {
        theme: 'snow',
        placeholder: opts.placeholder ?? '',
        modules: {
            toolbar: [['bold', 'italic', 'underline'], [{ list: 'bullet' }]]
        }
    });
    injectPlanningFontSizeButtons(q);
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
