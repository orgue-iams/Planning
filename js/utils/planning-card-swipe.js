/**
 * Cartes glissables : swipe droite = « Supprimer », swipe gauche = « Modifier » (mode both uniquement).
 * Mode delete-only : clic sur la carte = édition, swipe droite = supprimer.
 */

const MENU_WIDTH_PX = 88;
const SNAP_RATIO = 0.35;

/**
 * @param {HTMLElement} surfaceContent
 * @param {{
 *   enabled?: boolean,
 *   onEdit?: () => void,
 *   onDelete?: () => void,
 *   mode?: 'both' | 'delete-only',
 *   editLabel?: string,
 * }} opts
 * @returns {HTMLElement}
 */
export function mountPlanningSwipeCard(surfaceContent, opts) {
    const enabled = Boolean(opts.enabled);
    if (!enabled) return surfaceContent;

    const mode = opts.mode === 'delete-only' ? 'delete-only' : 'both';
    const swipeEdit = mode === 'both';

    const wrap = document.createElement('div');
    wrap.className = 'planning-swipe-wrap';

    const deletePane = document.createElement('button');
    deletePane.type = 'button';
    deletePane.className = 'planning-swipe-pane planning-swipe-pane--delete';
    deletePane.innerHTML = '<span>Supprimer</span>';
    deletePane.setAttribute('aria-label', 'Supprimer');

    /** @type {HTMLButtonElement | null} */
    let editPane = null;
    if (swipeEdit) {
        editPane = document.createElement('button');
        editPane.type = 'button';
        editPane.className = 'planning-swipe-pane planning-swipe-pane--edit';
        editPane.textContent = opts.editLabel || 'Modifier';
        editPane.setAttribute('aria-label', opts.editLabel || 'Modifier');
    }

    const track = document.createElement('div');
    track.className = 'planning-swipe-track';

    const surface = document.createElement('div');
    surface.className = 'planning-swipe-surface';
    if (surfaceContent.parentNode) {
        surfaceContent.parentNode.replaceChild(surface, surfaceContent);
    }
    surface.appendChild(surfaceContent);
    track.appendChild(surface);

    wrap.appendChild(deletePane);
    if (editPane) wrap.appendChild(editPane);
    wrap.appendChild(track);

    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let dragX = 0;
    let dragging = false;
    let axisLock = /** @type {'x' | null} */ (null);

    const clamp = (x) => {
        const maxRight = MENU_WIDTH_PX;
        const maxLeft = swipeEdit ? -MENU_WIDTH_PX : 0;
        return Math.max(maxLeft, Math.min(maxRight, x));
    };

    const setTranslate = (x, animate = false) => {
        dragX = x;
        surface.style.transition = animate ? 'transform 0.18s ease' : 'none';
        surface.style.transform = x ? `translateX(${x}px)` : '';
        deletePane.classList.toggle('is-revealed', x > 8);
        editPane?.classList.toggle('is-revealed', x < -8);
    };

    const snapTo = (x) => setTranslate(x, true);

    const reset = () => {
        baseX = 0;
        snapTo(0);
    };

    deletePane.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof opts.onDelete === 'function') opts.onDelete();
        reset();
    });

    editPane?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof opts.onEdit === 'function') opts.onEdit();
        reset();
    });

    const isInteractiveTarget = (el) =>
        Boolean(
            el.closest(
                'button, a, input, select, textarea, label, .st-drag-handle, .planning-swipe-pane'
            )
        );

    if (mode === 'delete-only' && typeof opts.onEdit === 'function') {
        surface.addEventListener('click', (e) => {
            if (!(e.target instanceof Element)) return;
            if (isInteractiveTarget(e.target)) return;
            if (Math.abs(dragX) > 6) return;
            opts.onEdit();
        });
    }

    const onPointerDown = (e) => {
        if (!(e.target instanceof Element)) return;
        if (isInteractiveTarget(e.target)) return;
        dragging = true;
        axisLock = null;
        startX = e.clientX;
        startY = e.clientY;
        baseX = dragX;
        surface.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!axisLock) {
            if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
            axisLock = Math.abs(dx) > Math.abs(dy) ? 'x' : null;
            if (!axisLock) {
                dragging = false;
                return;
            }
        }
        if (axisLock !== 'x') return;
        e.preventDefault();
        setTranslate(clamp(baseX + dx), false);
    };

    const onPointerUp = (e) => {
        if (!dragging) return;
        dragging = false;
        try {
            surface.releasePointerCapture(e.pointerId);
        } catch {
            /* ignore */
        }
        if (axisLock !== 'x') return;

        if (dragX <= -MENU_WIDTH_PX * SNAP_RATIO && swipeEdit) {
            snapTo(-MENU_WIDTH_PX);
            return;
        }
        if (dragX >= MENU_WIDTH_PX * SNAP_RATIO) {
            snapTo(MENU_WIDTH_PX);
            return;
        }
        reset();
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerUp);
    surface.addEventListener('pointercancel', onPointerUp);

    wrap.planningSwipeReset = reset;
    return wrap;
}
