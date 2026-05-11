/** Préférence d’affichage clair / sombre (localStorage, pas en base). */
const STORAGE_KEY = 'planning_ui_theme';

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
