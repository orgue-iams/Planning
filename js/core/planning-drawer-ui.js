/**
 * Menu principal (tiroir) : vues calendrier + liens selon profil.
 */

/** @type {import('@fullcalendar/core').Calendar | null} */
let drawerCalendarRef = null;
let drawerUiBound = false;

function setDrawerAria(open) {
    const drawer = document.getElementById('planning-app-drawer');
    const backdrop = document.getElementById('planning-drawer-backdrop');
    const v = open ? 'false' : 'true';
    drawer?.setAttribute('aria-hidden', v);
    backdrop?.setAttribute('aria-hidden', v);
}

function closeDrawer() {
    const drawer = document.getElementById('planning-app-drawer');
    const backdrop = document.getElementById('planning-drawer-backdrop');
    const btn = document.getElementById('btn-app-drawer');
    drawer?.classList.remove('planning-app-drawer--open');
    backdrop?.classList.remove('planning-drawer-backdrop--open');
    if (btn) {
        btn.setAttribute('aria-expanded', 'false');
    }
    setDrawerAria(false);
}

function openDrawer() {
    const drawer = document.getElementById('planning-app-drawer');
    const backdrop = document.getElementById('planning-drawer-backdrop');
    const btn = document.getElementById('btn-app-drawer');
    drawer?.classList.add('planning-app-drawer--open');
    backdrop?.classList.add('planning-drawer-backdrop--open');
    if (btn) {
        btn.setAttribute('aria-expanded', 'true');
    }
    setDrawerAria(true);
}

function toggleDrawer() {
    const drawer = document.getElementById('planning-app-drawer');
    if (drawer?.classList.contains('planning-app-drawer--open')) closeDrawer();
    else openDrawer();
}

/** @param {import('@fullcalendar/core').Calendar | null} cal */
export function syncDrawerViewSelection(cal) {
    if (!cal) return;
    const t = cal.view.type;
    for (const b of document.querySelectorAll('#planning-app-drawer [data-calendar-view]')) {
        if (b instanceof HTMLElement) {
            const on = b.getAttribute('data-calendar-view') === t;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }
}

/**
 * @param {import('@fullcalendar/core').Calendar} calendar
 */
export function initPlanningDrawer(calendar) {
    drawerCalendarRef = calendar;
    syncDrawerViewSelection(calendar);

    if (drawerUiBound) return;
    drawerUiBound = true;

    document.getElementById('btn-app-drawer')?.addEventListener('click', (e) => {
        e.preventDefault();
        toggleDrawer();
    });
    document.getElementById('planning-drawer-backdrop')?.addEventListener('click', () => closeDrawer());

    for (const b of document.querySelectorAll('#planning-app-drawer [data-calendar-view]')) {
        b.addEventListener('click', (ev) => {
            const el = ev.currentTarget;
            if (!(el instanceof HTMLElement)) return;
            const id = el.getAttribute('data-calendar-view');
            if (!id || !drawerCalendarRef) return;
            ev.preventDefault();
            drawerCalendarRef.changeView(id);
            drawerCalendarRef.updateSize();
            syncDrawerViewSelection(drawerCalendarRef);
            closeDrawer();
            try {
                document.dispatchEvent(new CustomEvent('planning-calendar-view-changed'));
            } catch {
                /* */
            }
        });
    }
}

/** Ferme le tiroir (ex. ouverture des préférences depuis une entrée menu). */
export function closePlanningDrawer() {
    closeDrawer();
}

/** Rouvre le menu principal (ex. retour depuis une page modale plein écran). */
export function openPlanningDrawer() {
    openDrawer();
}

export function resetPlanningDrawerBindings() {
    drawerCalendarRef = null;
}
