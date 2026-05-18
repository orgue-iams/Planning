/**
 * Cartes cours gabarit (vue élève) : horaire | titre + inscrits | prof.
 */

const DOW_FR = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

export function padTimeHhmm(raw) {
    const s = String(raw || '');
    if (s.includes('T')) {
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) {
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
    }
    const slice = s.slice(0, 5);
    const p = slice.split(':');
    return `${p[0] || '00'}:${p[1] || '00'}`;
}

export function profTintClass(ownerUserId) {
    const id = String(ownerUserId || '');
    if (!id) return '';
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % 5;
    return `st-slot-card--prof-tint-${h}`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * @param {HTMLElement} host
 * @param {{ dayOfWeek?: number|string, startTime?: string, endTime?: string, title?: string, slotType?: string, studentsLine?: string, ownerLabel?: string, ownerUserId?: string, dateSubline?: string }} p
 */
export function appendEleveGabaritCoursCard(host, p) {
    const card = document.createElement('article');
    const typ = String(p.slotType || 'cours').toLowerCase() === 'reservation' ? 'reservation' : 'cours';
    const titleText = String(p.title || '').trim() || (typ === 'cours' ? 'Cours' : 'Réservation');
    const dow = DOW_FR[parseInt(String(p.dayOfWeek || 1), 10)] || '—';
    card.className = [
        'st-slot-card st-slot-card--eleve-view profile-gabarit-cours-card',
        'grid grid-cols-[minmax(0,0.75fr)_minmax(0,1.1fr)_minmax(0,0.95fr)] gap-2 items-stretch',
        'rounded-lg border border-slate-200/90 dark:border-slate-600/80 px-2 py-2 min-w-0 text-[10px] text-slate-800 dark:text-slate-100',
        profTintClass(p.ownerUserId)
    ]
        .filter(Boolean)
        .join(' ');
    const studentsHtml =
        typ === 'cours'
            ? `<p class="st-ro-students text-[10px] font-normal text-slate-700 dark:text-slate-300 m-0 mt-0.5 leading-snug break-words">${escapeHtml(p.studentsLine || '—')}</p>`
            : '';
    const dateSubHtml = p.dateSubline
        ? `<div class="text-[10px] font-medium text-slate-600 dark:text-slate-300 mt-0.5 leading-snug">${escapeHtml(p.dateSubline)}</div>`
        : '';
    card.innerHTML = `
        <div class="st-slot-card__left min-w-0 self-stretch flex flex-col justify-center py-0.5">
            <div class="font-semibold leading-snug">${escapeHtml(dow)}</div>
            ${dateSubHtml}
            <div class="font-mono text-[10px] opacity-90 mt-0.5 leading-snug">${escapeHtml(padTimeHhmm(p.startTime))} – ${escapeHtml(padTimeHhmm(p.endTime))}</div>
        </div>
        <div class="st-slot-card__mid min-w-0 flex flex-col justify-center py-0.5">
            <p class="font-semibold m-0 leading-snug">${escapeHtml(titleText)}</p>
            ${studentsHtml}
        </div>
        <div class="st-slot-card__prof min-w-0 self-stretch flex items-center justify-end py-0.5">
            <span class="st-ro-prof text-[10px] font-medium text-slate-600 dark:text-slate-300 leading-snug text-right">${escapeHtml(p.ownerLabel || '—')}</span>
        </div>`;
    host.appendChild(card);
}
