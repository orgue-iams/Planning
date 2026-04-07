/**
 * Éditeur WYSIWYG partagé (modales Règles + Annonces).
 * Requiert `window.Quill` chargé via CDN (voir index.html).
 */

export function isQuillAvailable() {
    return typeof window !== 'undefined' && typeof window.Quill === 'function';
}

function registerPlanningFormats() {
    if (window.__planningQuillFormatsRegistered) return;
    const Quill = window.Quill;
    const Font = Quill.import('formats/font');
    Font.whitelist = ['system-ui', 'arial', 'georgia', 'times-new-roman', 'verdana'];
    Quill.register(Font, true);

    const Size = Quill.import('formats/size');
    Size.whitelist = ['10px', '12px', '14px', '16px', '18px', '20px'];
    Quill.register(Size, true);

    window.__planningQuillFormatsRegistered = true;
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
    mountEl.innerHTML = '';
    registerPlanningFormats();
    const Quill = window.Quill;
    return new Quill(mountEl, {
        theme: 'snow',
        placeholder: opts.placeholder ?? '',
        modules: {
            toolbar: [
                [{ header: [false, 3, 4] }],
                ['blockquote'],
                ['bold', 'italic', 'underline'],
                [{ list: 'bullet' }],
                [{ font: [] }],
                [{ size: ['10px', '12px', '14px', '16px', '18px', '20px'] }],
                [{ color: [] }]
            ]
        }
    });
}

/** Vide le conteneur Quill (barre + éditeur). */
export function destroyPlanningQuillMount(mountEl) {
    if (!(mountEl instanceof HTMLElement)) return;
    mountEl.innerHTML = '';
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
    try {
        const delta = quill.clipboard.convert({ html: raw });
        quill.setContents(delta, 'silent');
    } catch {
        quill.setContents([]);
    }
}

/** Texte brut utile pour valider une saisie non vide (ignore les paragraphes vides Quill). */
export function quillGetPlainText(quill) {
    if (!quill) return '';
    return String(quill.getText() ?? '').replace(/\u00a0/g, ' ').trim();
}
