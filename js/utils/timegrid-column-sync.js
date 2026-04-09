/**
 * Aligne les colonnes « jour » entre l’en-tête (.fc-col-header) et le corps (.fc-timegrid-cols).
 * FC ne pose qu’un <col> pour l’axe ; le navigateur répartit le reste selon le contenu des th
 * (flex + badges) vs td vides → décalage cumulatif. On impose le même <colgroup> (px) sur les deux tables.
 */

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

    const tableW = colsTable.getBoundingClientRect().width;
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
 * @returns {() => void}
 */
export function bindTimeGridColumnSync(calendarEl) {
    if (!(calendarEl instanceof HTMLElement)) return () => {};

    const run = () => scheduleTimeGridColumnSync(calendarEl);
    const ro = new ResizeObserver(() => run());
    ro.observe(calendarEl);
    return () => ro.disconnect();
}
