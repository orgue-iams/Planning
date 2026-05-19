/**
 * Cartes cours gabarit (vue élève) : même présentation que semaines types A/B (lecture seule).
 */

const DOW_FR = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

/** Heure « murale » Postgres (`time` / ancre 1970) sans décalage fuseau navigateur. */
export function wallTimeHhmmFromDb(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const plain = s.match(/^(\d{1,2}):(\d{2})/);
    if (plain && !s.includes('T')) {
        return `${String(parseInt(plain[1], 10)).padStart(2, '0')}:${plain[2]}`;
    }
    const iso = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
    if (iso) {
        const datePart = iso[1];
        const isPgTimeCarrier =
            datePart.startsWith('1970-') ||
            datePart === '2000-01-01' ||
            datePart.startsWith('0001-');
        if (isPgTimeCarrier) {
            return `${String(parseInt(iso[2], 10)).padStart(2, '0')}:${iso[3]}`;
        }
    }
    return null;
}

export function padTimeHhmm(raw) {
    if (raw instanceof Date) {
        return `${String(raw.getHours()).padStart(2, '0')}:${String(raw.getMinutes()).padStart(2, '0')}`;
    }
    const wall = wallTimeHhmmFromDb(raw);
    if (wall) return wall;
    const s = String(raw || '').trim();
    if (s.includes('T') || /\d{4}-\d{2}-\d{2}/.test(s)) {
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

function capitalizeFr(s) {
    const t = String(s || '').trim();
    if (!t) return t;
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/** @param {{ nom?: string, prenom?: string, display_name?: string, email?: string }} e */
export function elevePrenomNomLabel(e) {
    const n = String(e?.nom || '').trim();
    const p = String(e?.prenom || '').trim();
    if (p && n) return `${p} ${n}`;
    if (p || n) return p || n;
    const d = String(e?.display_name || '').trim();
    if (d) return d;
    return String(e?.email || '').trim() || '—';
}

/** @deprecated alias */
export const elevePrenomVirguleNom = elevePrenomNomLabel;

/**
 * @param {string[]} studentUserIds
 * @param {Map<string, { nom?: string, prenom?: string, display_name?: string, email?: string }>} byId
 */
export function formatEnrolledStudentsLineFromIds(studentUserIds, byId) {
    const rows = [];
    for (const id of studentUserIds || []) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        const e = byId.get(sid);
        rows.push({
            nom: String(e?.nom || '').toLowerCase(),
            prenom: String(e?.prenom || '').toLowerCase(),
            label: e ? elevePrenomNomLabel(e) : sid
        });
    }
    rows.sort((a, b) => {
        const c = a.nom.localeCompare(b.nom, 'fr');
        if (c !== 0) return c;
        return a.prenom.localeCompare(b.prenom, 'fr');
    });
    if (!rows.length) return '';
    return rows.map((r) => r.label).join(', ');
}

/**
 * @param {string[]} emails
 * @param {Map<string, { nom?: string, prenom?: string, display_name?: string, email?: string }>} byEmail
 */
export function formatEnrolledStudentsLineFromEmails(emails, byEmail) {
    const rows = [];
    for (const raw of emails || []) {
        const em = String(raw || '').trim().toLowerCase();
        if (!em) continue;
        const e = byEmail.get(em);
        rows.push({
            nom: String(e?.nom || '').toLowerCase(),
            prenom: String(e?.prenom || '').toLowerCase(),
            label: e ? elevePrenomNomLabel(e) : em
        });
    }
    rows.sort((a, b) => {
        const c = a.nom.localeCompare(b.nom, 'fr');
        if (c !== 0) return c;
        return a.prenom.localeCompare(b.prenom, 'fr');
    });
    if (!rows.length) return '';
    return rows.map((r) => r.label).join(', ');
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderProfHtml(ownerPrenom, ownerNom, ownerLabel) {
    const label = String(ownerLabel || '').trim();
    if (label) return escapeHtml(label);
    const full = [ownerPrenom, ownerNom]
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .join(' ');
    if (full) return escapeHtml(full);
    return '—';
}

/**
 * @param {HTMLElement} host
 * @param {{
 *   dayOfWeek?: number|string,
 *   startTime?: string,
 *   endTime?: string,
 *   title?: string,
 *   slotType?: string,
 *   studentsLine?: string,
 *   ownerLabel?: string,
 *   ownerPrenom?: string,
 *   ownerNom?: string,
 *   ownerUserId?: string,
 *   planningColorClass?: string,
 *   dateSubline?: string
 * }} p
 */
export function appendEleveGabaritCoursCard(host, p) {
    const card = document.createElement('div');
    const typ = String(p.slotType || 'cours').toLowerCase() === 'reservation' ? 'reservation' : 'cours';
    const titleText = String(p.title || '').trim() || (typ === 'cours' ? 'Cours' : 'Travail perso.');
    const dow = DOW_FR[parseInt(String(p.dayOfWeek || 1), 10)] || '—';
    const dateSub = String(p.dateSubline || '').trim();
    const periodLine = dateSub ? capitalizeFr(dateSub) : dow;
    const colorCls =
        String(p.planningColorClass || '').trim() ||
        (typ === 'reservation' ? 'event-travail-other' : 'event-cours');
    const studentsLine =
        typ === 'cours' ? String(p.studentsLine || '').trim() || "pas d'élèves" : '—';

    card.className = [
        'event-box st-slot-card st-slot-card--eleve-view profile-gabarit-cours-card gabarit-cours-card--slot-text',
        colorCls,
        'grid grid-cols-[minmax(5rem,0.95fr)_minmax(0,1.1fr)_minmax(0,0.95fr)] gap-2 items-stretch',
        'rounded-lg border px-2 py-2 min-w-0 text-[10px]',
        profTintClass(p.ownerUserId)
    ]
        .filter(Boolean)
        .join(' ');

    const profHtml = renderProfHtml(p.ownerPrenom, p.ownerNom, p.ownerLabel);

    card.innerHTML = `
        <div class="st-slot-card__left min-w-0 self-stretch flex flex-col justify-center py-0.5">
            <div class="font-semibold leading-snug">${escapeHtml(periodLine)}</div>
            <div class="font-mono text-[10px] opacity-90 mt-0.5 leading-snug">${escapeHtml(padTimeHhmm(p.startTime))} – ${escapeHtml(padTimeHhmm(p.endTime))}</div>
        </div>
        <div class="st-slot-card__right min-w-0 flex flex-col justify-center py-0.5">
            <p class="st-ro-headline font-semibold m-0 leading-snug">${escapeHtml(titleText)}</p>
            <p class="st-ro-students text-[10px] font-normal m-0 leading-snug break-words">${escapeHtml(studentsLine)}</p>
        </div>
        <div class="st-slot-card__prof min-w-0 self-stretch flex items-center justify-end py-0.5">
            <span class="st-ro-prof text-[10px] font-medium leading-snug block text-right">${profHtml}</span>
        </div>`;

    host.appendChild(card);
}