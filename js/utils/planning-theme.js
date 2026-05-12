/** Préférence d’affichage clair / sombre (localStorage, pas en base). */
const STORAGE_KEY = 'planning_ui_theme';

/** Taille du texte des créneaux FullCalendar : `sm` | `md` | `lg` (localStorage). */
const TEXT_SCALE_KEY = 'planning_fc_text_scale';

/** @returns {'light' | 'dark'} */
export function getPlanningThemePref() {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

/** @param {'light' | 'dark'} mode */
export function setPlanningThemePref(mode) {
    try {
        localStorage.setItem(STORAGE_KEY, mode === 'dark' ? 'dark' : 'light');
    } catch {
        /* quota / navigation privée */
    }
    applyPlanningTheme(mode);
}

/** @param {'light' | 'dark'} mode */
export function applyPlanningTheme(mode) {
    const theme = mode === 'dark' ? 'dark' : 'winter';
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute('content', mode === 'dark' ? '#0f172a' : '#2c3e50');
    }
}

export function applyPlanningThemeFromStorage() {
    applyPlanningTheme(getPlanningThemePref());
}

/** @returns {'sm' | 'md' | 'lg'} */
export function getPlanningFcTextScale() {
    try {
        const v = localStorage.getItem(TEXT_SCALE_KEY);
        if (v === 'sm' || v === 'lg') return v;
        return 'md';
    } catch {
        return 'md';
    }
}

/** @param {'sm' | 'md' | 'lg'} scale */
export function setPlanningFcTextScale(scale) {
    const s = scale === 'sm' || scale === 'lg' ? scale : 'md';
    try {
        localStorage.setItem(TEXT_SCALE_KEY, s);
    } catch {
        /* */
    }
    applyPlanningFcTextScale(s);
}

/** @param {'sm' | 'md' | 'lg'} scale */
export function applyPlanningFcTextScale(scale) {
    const s = scale === 'sm' || scale === 'lg' ? scale : 'md';
    document.documentElement.setAttribute('data-planning-fc-text', s);
}

export function applyPlanningFcTextScaleFromStorage() {
    applyPlanningFcTextScale(getPlanningFcTextScale());
}
