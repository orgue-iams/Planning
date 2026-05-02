/**
 * Aligne les colonnes « jour » entre l’en-tête (.fc-col-header) et le corps (.fc-timegrid-cols).
 * FC ne pose qu’un <col> pour l’axe ; le navigateur répartit le reste selon le contenu des th
 * (flex + badges) vs td vides → décalage cumulatif. On impose le même <colgroup> (px) sur les deux tables.
 */

/**
 * Largeur utile pour répartir les jours : le client du scroller (zone visible), pas le `table`
 * (sinon en portrait après paysage, le tableau garde des <col> larges et getBoundingClientRect
 * reste gonflé — on ne voit que 2–3 jours).
 * @param {HTMLTableElement} colsTable
 */
function getDayAreaWidthPx(colsTable) {
    const scroller = colsTable.closest('.fc-scroller');
    if (scroller instanceof HTMLElement) {
        const w = scroller.clientWidth;
        if (w > 0) return w;
    }
    const r = colsTable.getBoundingClientRect().width;
    return r > 0 ? r : 0;
}

function applyColGroup(table, axisPx, dayPx, dayCount) {
    let cg = table.querySelector('colgroup');
    if (!cg) {
        cg = document.createElement('colgroup');
        table.insertBefore(cg, table.firstChild);
    }
    cg.replaceChildren();
    const axisCol = document.createElement('col');
    axisCol.style.width = `${axisPx}px`;
    cg.appendChild(axisCol);
    for (let i = 0; i < dayCount; i++) {
        const c = document.createElement('col');
        c.style.width = `${dayPx}px`;
        cg.appendChild(c);
    }
}

/**
 * @param {HTMLElement | null} calendarEl `#calendar`
 */
export function syncTimeGridColumnWidths(calendarEl) {
    if (!(calendarEl instanceof HTMLElement)) return;

    const root =
        calendarEl.querySelector('.fc-timeGridWeek-view') ||
        calendarEl.querySelector('.fc-timeGridDay-view');
    if (!root) return;

    const colsTable = root.querySelector('.fc-timegrid-cols table');
    const headerTable = root.querySelector('table.fc-col-header');
    if (!(colsTable instanceof HTMLTableElement) || !(headerTable instanceof HTMLTableElement)) return;

    const row = colsTable.querySelector('tbody tr:first-child');
    if (!row) return;
    const axisTd = row.querySelector('td.fc-timegrid-axis');
    const dayTds = row.querySelectorAll('td.fc-timegrid-col.fc-day');
    if (!(axisTd instanceof HTMLElement) || dayTds.length === 0) return;

    const tableW = getDayAreaWidthPx(colsTable);
    const axisW = axisTd.getBoundingClientRect().width;
    const n = dayTds.length;
    const remaining = tableW - axisW;
    if (!(remaining > 0) || !(n > 0)) return;

    let dayW = remaining / n;
    dayW = Math.round(dayW * 1000) / 1000;

    applyColGroup(colsTable, axisW, dayW, n);
    applyColGroup(headerTable, axisW, dayW, n);
}

/**
 * Après layout FC (scrollgrid, scrollbars) : exécuter au prochain frame voire celui d’après.
 * @param {HTMLElement | null} calendarEl
 */
export function scheduleTimeGridColumnSync(calendarEl) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            syncTimeGridColumnWidths(calendarEl);
            window.setTimeout(() => syncTimeGridColumnWidths(calendarEl), 0);
        });
    });
}

/**
 * @param {HTMLElement | null} calendarEl
 * @param {() => void} [beforeSync] ex. `() => calendar.updateSize()` pour orientation / resize fenêtre
 * @returns {() => void}
 */
export function bindTimeGridColumnSync(calendarEl, beforeSync) {
    if (!(calendarEl instanceof HTMLElement)) return () => {};

    const run = () => {
        try {
            if (typeof beforeSync === 'function') beforeSync();
        } catch {
            /* */
        }
        scheduleTimeGridColumnSync(calendarEl);
    };
    const ro = new ResizeObserver(() => run());

    let orientationTimer = 0;
    const onOrientationChange = () => {
        window.clearTimeout(orientationTimer);
        orientationTimer = window.setTimeout(() => run(), 180);
    };
    const onResize = () => {
        window.requestAnimationFrame(() => run());
    };

    ro.observe(calendarEl);
    window.addEventListener('orientationchange', onOrientationChange);
    window.addEventListener('resize', onResize);
    return () => {
        ro.disconnect();
        window.removeEventListener('orientationchange', onOrientationChange);
        window.removeEventListener('resize', onResize);
        window.clearTimeout(orientationTimer);
    };
}
