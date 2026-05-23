/**
 * Application des périodes d'absence en attente : créneaux fermeture + décalage auto (prof).
 */
import { isAdmin, isProf } from './auth-logic.js';
import { getPlanningSessionUser } from './session-user.js';
import {
    fetchOrganSchoolSettings,
    getSchoolYearBoundsFromSettings
} from './organ-settings.js';
import {
    markAbsencePeriodApplied,
    pendingAbsencePeriodsForUser
} from './absence-period-db.js';
import { resolveClosureOccurrenceDays, saveClosureRangeToPlanning } from './fermetures-planning.js';
import { formatApplyProgressLabel } from '../utils/apply-progress-label.js';
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
 *   onProgress?: (pct: number | null, label: string) => void,
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

    const runProfShift = isProf(u) && !isAdmin(u);
    const phaseCount = valid.length + (runProfShift ? 1 : 0);
    let phase = 0;
    const reportPhase = (label) => {
        phase += 1;
        const pct = Math.min(95, Math.round((phase / Math.max(phaseCount, 1)) * 90));
        opts.onProgress?.(
            pct,
            formatApplyProgressLabel({
                domain: 'Traitement principal',
                step: phase,
                total: phaseCount,
                detail: label
            })
        );
    };
    const reportDetail = (label) => {
        opts.onProgress?.(null, label);
    };

    /** Jours de fermeture publiés lors de cette application (décalage prof limité à ces jours). */
    const appliedClosureYmdSet = new Set();
    for (const period of valid) {
        const days = await resolveClosureOccurrenceDays(period);
        for (const ymd of days) appliedClosureYmdSet.add(ymd);
    }

    let applied = 0;
    for (const period of valid) {
        reportPhase(`Période ${period.startYmd} → ${period.endYmd}…`);
        const conflicts = opts.conflictsByPeriodId?.get(period.id) || [];
        const r = await saveClosureRangeToPlanning(
            {
                startYmd: period.startYmd,
                endYmd: period.endYmd,
                title: period.title,
                absencePeriodId: period.id,
                isPeriodic: period.isPeriodic,
                weekdays: period.weekdays,
                slotStartTime: period.slotStartTime,
                slotEndTime: period.slotEndTime,
                excludedYmds: period.excludedYmds,
                dayOverrides: period.dayOverrides,
                eventIds: period.eventIds
            },
            {
                deleteConflicts: Boolean(opts.deleteConflicts && conflicts.length),
                conflicts,
                onProgress: reportDetail
            }
        );
        if (!r.ok) {
            return { ok: false, error: r.error || 'Enregistrement impossible.', applied };
        }
        const mr = await markAbsencePeriodApplied(period.id);
        if (!mr.ok) {
            return {
                ok: false,
                error: mr.error || 'Marquage « appliqué » impossible.',
                applied
            };
        }
        applied += 1;
    }

    if (runProfShift && appliedClosureYmdSet.size > 0) {
        reportPhase('Décalage des créneaux sur les jours fermés (+1 semaine)…');
        const cycle = getProfWeekCycleForToolbar();
        const effectiveYmd = effectiveYmdForPeriods(valid);
        const shift = await executeProfSlotsShift({
            profUserId: u.id,
            profEmail: u.email,
            effectiveYmd,
            weekDelta: 1,
            currentUser: u,
            profWeekCycle: cycle,
            restrictToClosureYmdSet: appliedClosureYmdSet,
            onProgress: reportDetail
        });
        if (!shift.ok) {
            return {
                ok: false,
                error: shift.error || 'Décalage des créneaux impossible.',
                applied
            };
        }
        if (typeof shift.count === 'number' && shift.count > 0) {
            reportDetail(
                formatApplyProgressLabel({
                    domain: 'Décalage professeur',
                    detail: `${shift.count} créneau(x) décalé(s) (uniquement sur les jours de fermeture)`
                })
            );
        } else {
            reportDetail(
                formatApplyProgressLabel({
                    domain: 'Décalage professeur',
                    detail: 'aucun de vos créneaux ne tombe sur ces jours — rien à décaler'
                })
            );
        }
    }

    opts.onProgress?.(100, formatApplyProgressLabel({ domain: 'Traitement principal', detail: 'terminé' }));
    return { ok: true, error: null, applied };
}
