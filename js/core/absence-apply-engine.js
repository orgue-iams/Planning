/**
 * Application des périodes d'absence en attente : créneaux fermeture + décalage auto (prof).
 */
import { isAdmin, isProf } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import { showToast } from '../utils/toast.js';
import {
    fetchOrganSchoolSettings,
    getSchoolYearBoundsFromSettings
} from './organ-settings.js';
import {
    markAbsencePeriodApplied,
    pendingAbsencePeriodsForUser
} from './absence-period-db.js';
import { saveClosureRangeToPlanning } from './fermetures-planning.js';
import { executeProfSlotsShift } from './prof-slots-shift-engine.js';
import { getProfWeekCycleForToolbar } from './week-cycle.js';

function todayYmdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function effectiveYmdForPeriods(periods) {
    const today = todayYmdLocal();
    let min = '';
    for (const p of periods) {
        const s = String(p.startYmd || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
        const eff = s < today ? today : s;
        if (!min || eff < min) min = eff;
    }
    return min || today;
}

/**
 * @param {import('./absence-period-db.js').AbsencePeriodRow[]} periods
 * @param {{
 *   onProgress?: (pct: number, label: string) => void,
 *   deleteConflicts?: boolean,
 *   conflictsByPeriodId?: Map<string, object[]>
 * }} [opts]
 */
export async function applyPendingAbsencePeriods(periods, opts = {}) {
    const u = getPlanningSessionUser();
    if (!u?.id || !u?.email) {
        return { ok: false, error: 'Session requise.', applied: 0 };
    }

    await fetchOrganSchoolSettings();
    const { startYmd: sy, endYmd: ey } = getSchoolYearBoundsFromSettings();
    const today = todayYmdLocal();

    const pending = pendingAbsencePeriodsForUser(periods, u);
    if (!pending.length) {
        return { ok: false, error: 'Aucune nouvelle période à appliquer.', applied: 0 };
    }

    const valid = pending.filter((p) => {
        if (sy && p.endYmd < sy) return false;
        if (ey && p.startYmd > ey) return false;
        if (p.endYmd < today) return false;
        return true;
    });
    if (!valid.length) {
        return {
            ok: false,
            error: 'Aucune période applicable (année scolaire en cours, dates futures uniquement).',
            applied: 0
        };
    }

    const totalSteps = valid.length + (isProf(u) ? 1 : 0);
    let step = 0;
    const report = (label) => {
        step += 1;
        const pct = Math.min(100, Math.round((step / totalSteps) * 100));
        opts.onProgress?.(pct, label);
    };

    for (const period of valid) {
        report(`Fermetures : ${period.startYmd} → ${period.endYmd}…`);
        const conflicts = opts.conflictsByPeriodId?.get(period.id) || [];
        const r = await saveClosureRangeToPlanning(
            {
                startYmd: period.startYmd,
                endYmd: period.endYmd,
                title: period.title,
                absencePeriodId: period.id
            },
            {
                deleteConflicts: Boolean(opts.deleteConflicts && conflicts.length),
                conflicts
            }
        );
        if (!r.ok) {
            return { ok: false, error: r.error || 'Enregistrement impossible.', applied: step - 1 };
        }
        const mr = await markAbsencePeriodApplied(period.id);
        if (!mr.ok) {
            return {
                ok: false,
                error: mr.error || 'Marquage « appliqué » impossible.',
                applied: step - 1
            };
        }
    }

    if (isProf(u) && !isAdmin(u)) {
        report('Décalage des créneaux…');
        const cycle = getProfWeekCycleForToolbar();
        const effectiveYmd = effectiveYmdForPeriods(valid);
        const shift = await executeProfSlotsShift({
            profUserId: u.id,
            profEmail: u.email,
            effectiveYmd,
            weekDelta: 1,
            currentUser: u,
            profWeekCycle: cycle,
            onProgress: (detail) => opts.onProgress?.(95, detail)
        });
        if (!shift.ok) {
            return {
                ok: false,
                error: shift.error || 'Décalage des créneaux impossible.',
                applied: valid.length
            };
        }
    }

    opts.onProgress?.(100, 'Terminé');
    return { ok: true, error: null, applied: valid.length };
}
