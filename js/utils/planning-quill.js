/**
 * Éditeur WYSIWYG partagé (modales Règles + Annonces).
 * Requiert `window.Quill` chargé via CDN (voir index.html).
 *
 * Pas de sélecteur de police : affichage homogène et lisibilité du menu « taille »
 * (sans quoi Quill n’affiche que « Normal » pour les tailles personnalisées).
 * La barre d’outils est rendue sticky en CSS pour limiter le recouvrement par le menu Copier/Coller (mobile).
 */

export function isQuillAvailable() {
    return typeof window !== 'undefined' && typeof window.Quill === 'function';
}

function registerPlanningSizeFormat() {
    if (window.__planningQuillSizeRegistered) return;
    const Quill = window.Quill;
    const Size = Quill.import('formats/size');
    Size.whitelist = ['10px', '12px', '14px', '16px', '18px', '20px'];
    Quill.register(Size, true);
    window.__planningQuillSizeRegistered = true;
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
    mountEl.replaceChildren();
    registerPlanningSizeFormat();
    const Quill = window.Quill;
    return new Quill(mountEl, {
        theme: 'snow',
        placeholder: opts.placeholder ?? '',
        modules: {
            toolbar: [
                ['bold', 'italic', 'underline'],
                [{ list: 'bullet' }],
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
