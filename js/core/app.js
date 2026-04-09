import { loadUIComponents } from '../utils/loader.js';
import { getCalendarConfig, bindResponsiveCalendarToolbar } from '../config/fc-settings.js';
import { initCalendarToolbar } from './calendar-toolbar.js';
import { populateTimeSelects } from '../utils/time-helpers.js';
import { initSwipe } from '../utils/touch-handler.js';
import {
    getEventContent,
    openModal,
    saveReservation,
    deleteReservation,
    quickCreateFromSelection,
    addSlotEndFromStart,
    setRecurringOptionsVisible,
    handleEventResize,
    canCurrentUserEditEvent,
    isReservationStartBeforeTodayLocal,
    isCalendarEventDropLocationValid,
    onCalendarEventDragStart,
    onCalendarEventDragStop,
    syncReservationEventToGoogle,
    bridgeGoogleIdFromFcEvent,
    ensureGoogleAgendaSlotsFreeOrAbort,
    captureResizeStart,
    maybeNotifySlotOwnerAfterThirdPartyEdit,
    ownerInfoFromEvent
} from './calendar-logic.js';
import {
    login,
    logout,
    sendResetLink,
    checkUrlToken,
    updatePassword,
    setPasswordModalMode,
    setLogoutHandler,
    tryRestoreSession,
    tryRestoreDemoSession,
    getRememberMePreference,
    isPrivilegedUser,
    roleLabelFr,
    PASSWORD_POLICY_LINES,
    hasSupabaseRecoveryInUrl,
    subscribeSupabasePasswordRecovery,
    stripSupabaseAuthFromUrl,
    isBackendAuthConfigured,
    markSupabasePasswordRecoveryPending,
    isSupabasePasswordRecoveryPending,
    shouldResumeSupabasePasswordRecovery
} from './auth-logic.js';
import { initMessagesUi, resetMessagesUiBindings, tryShowBroadcastPopup } from './messages-ui.js';
import { destroyPlanningQuillMount } from '../utils/planning-quill.js';
import { initProfileLabelsUi, resetProfileLabelsUiBindings } from './profile-labels-ui.js';
import { applyLoginBanner } from './login-banner.js';
import { initAdminUsersUi, resetAdminUsersUiBindings } from './admin-users-ui.js';
import { initAnnouncementsUi, resetAnnouncementsUiBindings } from './announcements-ui.js';
import { showToast } from '../utils/toast.js';
import { setPlanningSessionUser } from './session-user.js';
import { formatVersionBadgeText } from '../config/version-info.js';

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url)).catch(() => {});
}

let calendar;
let currentEvent = null;
let currentUser = null;

function performLogout() {
    currentUser = null;
    setPlanningSessionUser(null);
    destroyPlanningQuillMount(document.getElementById('rules-quill-mount'));
    resetMessagesUiBindings();
    resetAnnouncementsUiBindings();
    resetAdminUsersUiBindings();
    resetProfileLabelsUiBindings();
    currentEvent = null;
    if (calendar) {
        calendar.destroy();
        calendar = null;
    }
    document.body.classList.add('auth-pending');
    refreshHeaderUser(null);
    [
        'modal_forgot',
        'modal_password',
        'modal_reservation',
        'modal_profile_labels',
        'modal_rules',
        'modal_broadcast',
        'modal_users_admin',
        'modal_admin_password',
        'modal_announcements'
    ].forEach((id) => document.getElementById(id)?.close());
    const loginDlg = document.getElementById('modal_login');
    void applyLoginBanner();
    const rememberCb = document.getElementById('login-remember-me');
    if (rememberCb) rememberCb.checked = getRememberMePreference();
    loginDlg?.showModal();
    requestAnimationFrame(() => document.getElementById('login-email')?.focus());
}

function refreshHeaderUser(user) {
    const nameEl = document.getElementById('user-display-name');
    const roleEl = document.getElementById('user-display-role');
    const menuWrap = document.getElementById('user-menu-wrap');
    if (!user?.email) {
        if (nameEl) nameEl.textContent = 'Invité';
        if (roleEl) {
            roleEl.textContent = '';
            roleEl.classList.add('hidden');
        }
        menuWrap?.classList.add('hidden');
        return;
    }
    if (nameEl) nameEl.textContent = user.name;
    if (roleEl) {
        roleEl.textContent = roleLabelFr(user.role);
        roleEl.classList.remove('hidden');
    }
    menuWrap?.classList.remove('hidden');
}

function initCalendarAndRevealUi() {
    if (calendar) return;
    let suppressDateClickUntil = 0;

    const handlers = {
        onDatesSet: null,
        onResizeStart: (info) => captureResizeStart(info),

        /** Glisser / appui long puis plage : création rapide (motif favori, type réservation). */
        onSelect: (info) => {
            suppressDateClickUntil = Date.now() + 700;
            currentEvent = null;
            void quickCreateFromSelection(calendar, info, currentUser).catch((err) =>
                console.error(err)
            );
            calendar.unselect();
        },
        /** Clic simple : modale avec préremplissage (un créneau grille de durée). */
        onDateClick: (info) => {
            if (Date.now() < suppressDateClickUntil) return;
            currentEvent = null;
            let start = info.date;
            const isMonthLike =
                info.view.type === 'dayGridMonth' || info.view.type.startsWith('multiMonth');
            if (isMonthLike) {
                start = new Date(info.date);
                if (info.allDay !== false) {
                    start.setHours(8, 0, 0, 0);
                }
            }
            const end = addSlotEndFromStart(start, calendar);
            openModal(start, end, null, currentUser);
        },
        onEventClick: (info) => {
            currentEvent = info.event;
            openModal(info.event.start, info.event.end, info.event, currentUser);
        },
        onEventDragStart: (info) => onCalendarEventDragStart(info),
        onEventDragStop: (info) => onCalendarEventDragStop(info),
        onEventDrop: async (info) => {
            if (!isCalendarEventDropLocationValid(info.jsEvent)) {
                info.revert();
                showToast('Déposez le créneau sur la grille du planning.', 'error');
                return;
            }
            if (isReservationStartBeforeTodayLocal(info.event)) {
                info.revert();
                const hadRight =
                    info.oldEvent && canCurrentUserEditEvent(currentUser, info.oldEvent);
                showToast(
                    hadRight
                        ? 'Impossible de placer un créneau avant aujourd’hui.'
                        : 'Vous ne pouvez pas déplacer ce créneau.',
                    'error'
                );
                return;
            }
            if (!canCurrentUserEditEvent(currentUser, info.event)) {
                info.revert();
                showToast('Vous ne pouvez pas déplacer ce créneau.', 'error');
                return;
            }
            const okGoogle = await ensureGoogleAgendaSlotsFreeOrAbort(
                info.view.calendar,
                [{ start: info.event.start, end: info.event.end }],
                bridgeGoogleIdFromFcEvent(info.event)
            );
            if (!okGoogle) {
                info.revert();
                return;
            }
            const sync = await syncReservationEventToGoogle(info.event);
            if (!sync.ok) return;
            const oi = ownerInfoFromEvent(info.event, currentUser);
            const me = String(currentUser?.email ?? '')
                .trim()
                .toLowerCase();
            if (
                oi.ownerEmail &&
                oi.ownerEmail !== me &&
                info.oldEvent?.start &&
                info.oldEvent?.end
            ) {
                await maybeNotifySlotOwnerAfterThirdPartyEdit({
                    currentUser,
                    action: 'moved',
                    targetOwnerEmail: oi.ownerEmail,
                    targetOwnerDisplayName: oi.ownerName,
                    slotTitle: info.event.title,
                    slotStart: info.event.start,
                    slotEnd: info.event.end,
                    previousStartIso: info.oldEvent.start.toISOString(),
                    previousEndIso: info.oldEvent.end.toISOString()
                });
            }
        },
        onEventResize: (info) => {
            if (!canCurrentUserEditEvent(currentUser, info.event)) {
                info.revert();
                showToast('Vous ne pouvez pas redimensionner ce créneau.', 'error');
                return;
            }
            void handleEventResize(info, currentUser).catch((err) => console.error(err));
        },
        renderEventContent: (arg) => getEventContent(arg, currentUser)
    };

    const calendarEl = document.getElementById('calendar');

    // FullCalendar mesure le conteneur au render : il doit être visible (plus auth-pending).
    document.body.classList.remove('auth-pending');

    const mount = () => {
        calendar = new FullCalendar.Calendar(calendarEl, getCalendarConfig(handlers, currentUser));
        calendar.render();
        const toolbarCtl = initCalendarToolbar(calendar);
        handlers.onDatesSet = () => {
            toolbarCtl?.refreshTitle();
            toolbarCtl?.syncViewTriggerLabel();
        };
        handlers.onDatesSet();
        bindResponsiveCalendarToolbar(calendar);

        initSwipe(calendarEl, calendar);

        document.getElementById('btn-save').onclick = () =>
            void saveReservation(calendar, currentUser, currentEvent).catch((err) =>
                console.error(err)
            );
        document.getElementById('btn-delete').onclick = () =>
            void deleteReservation(calendar, currentEvent, currentUser).catch((err) =>
                console.error(err)
            );

        // Recalcul grille + événements après que height:100% / flex soit appliqué (Chrome, Safari, etc.)
        calendar.updateSize();
        requestAnimationFrame(() => {
            calendar.updateSize();
        });

        initMessagesUi(currentUser);
        initProfileLabelsUi(currentUser);
        initAdminUsersUi(currentUser);
        initAnnouncementsUi(currentUser);
        window.setTimeout(
            () => void tryShowBroadcastPopup(currentUser).catch((e) => console.warn(e)),
            500
        );
    };

    requestAnimationFrame(mount);
}

/** Fermer une modale en cliquant sur le fond (hors .modal-box). L’événement a pour cible l’élément <dialog>. */
function wireDialogBackdropClose() {
    document.addEventListener('click', (e) => {
        if (e.target instanceof HTMLDialogElement && e.target.open) {
            if (
                e.target.id === 'modal_password' &&
                isBackendAuthConfigured() &&
                isSupabasePasswordRecoveryPending()
            ) {
                return;
            }
            e.target.close();
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadUIComponents();
    const versionText = formatVersionBadgeText();
    const loginV = document.getElementById('login-version-badge');
    const buildLegend = document.getElementById('app-build-badge');
    if (loginV) loginV.textContent = versionText;
    if (buildLegend) buildLegend.textContent = versionText;
    setLogoutHandler(performLogout);
    wireDialogBackdropClose();

    const policyUl = document.getElementById('password-policy-lines');
    if (policyUl) {
        policyUl.replaceChildren();
        for (const line of PASSWORD_POLICY_LINES) {
            const li = document.createElement('li');
            li.textContent = line;
            policyUl.appendChild(li);
        }
    }

    const pwToggle = document.getElementById('pw-toggle-visible');
    const pwFieldIds = ['old-pass', 'new-pass', 'confirm-pass'];
    const applyPwVisibility = (visible) => {
        const type = visible ? 'text' : 'password';
        for (const id of pwFieldIds) {
            document.getElementById(id)?.setAttribute('type', type);
        }
    };
    pwToggle?.addEventListener('change', () => applyPwVisibility(pwToggle.checked));
    document.getElementById('modal_password')?.addEventListener('close', () => {
        if (pwToggle) pwToggle.checked = false;
        applyPwVisibility(false);
    });

    const loginPass = document.getElementById('login-pass');
    const loginPassToggle = document.getElementById('login-pass-toggle');
    const loginPassIconShow = document.getElementById('login-pass-icon-show');
    const loginPassIconHide = document.getElementById('login-pass-icon-hide');
    const setLoginPassVisible = (visible) => {
        loginPass?.setAttribute('type', visible ? 'text' : 'password');
        loginPassToggle?.setAttribute('aria-pressed', String(visible));
        loginPassToggle?.setAttribute(
            'aria-label',
            visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'
        );
        loginPassIconShow?.classList.toggle('hidden', visible);
        loginPassIconHide?.classList.toggle('hidden', !visible);
    };
    loginPassToggle?.addEventListener('click', () => {
        const vis = loginPass?.getAttribute('type') === 'text';
        setLoginPassVisible(!vis);
    });

    populateTimeSelects('event-start', 'event-end');
    populateTimeSelects('event-recur-start', 'event-recur-end');
    checkUrlToken();

    let unsubscribeRecovery = () => {};
    unsubscribeRecovery = subscribeSupabasePasswordRecovery(() => {
        unsubscribeRecovery();
        unsubscribeRecovery = () => {};
        markSupabasePasswordRecoveryPending();
        setPasswordModalMode(true);
        document.getElementById('modal_login')?.close();
        document.getElementById('modal_forgot')?.close();
        document.getElementById('modal_password')?.showModal();
        stripSupabaseAuthFromUrl();
        requestAnimationFrame(() => document.getElementById('new-pass')?.focus());
    });

    // Laisser le client traiter #access_token / ?code= avant getSession() (évite la course avec la modale login).
    if (isBackendAuthConfigured()) {
        await new Promise((r) => setTimeout(r, 200));
    }

    const restored = isBackendAuthConfigured()
        ? await tryRestoreSession()
        : tryRestoreDemoSession();
    if (restored) {
        currentUser = restored;
        setPlanningSessionUser(currentUser);
        refreshHeaderUser(currentUser);
        initCalendarAndRevealUi();
        document.getElementById('modal_login')?.close();
    }

    if (await shouldResumeSupabasePasswordRecovery()) {
        setPasswordModalMode(true);
        document.getElementById('modal_login')?.close();
        document.getElementById('modal_forgot')?.close();
        document.getElementById('modal_password')?.showModal();
        requestAnimationFrame(() => document.getElementById('new-pass')?.focus());
    }

    document.getElementById('btn-password-cancel')?.addEventListener('click', async () => {
        if (isBackendAuthConfigured() && isSupabasePasswordRecoveryPending()) {
            if (
                !confirm(
                    'Annuler la réinitialisation ? Vous devrez demander un nouveau lien par e-mail. Le lien déjà reçu ne fonctionnera plus.'
                )
            ) {
                return;
            }
            await logout();
            return;
        }
        document.getElementById('modal_password')?.close();
    });

    document.getElementById('btn-do-login').onclick = async () => {
        const rememberMe = document.getElementById('login-remember-me')?.checked !== false;
        const result = await login(
            document.getElementById('login-email').value,
            document.getElementById('login-pass').value,
            rememberMe
        );
        if (result.success) {
            currentUser = result.user;
            setPlanningSessionUser(currentUser);
            refreshHeaderUser(currentUser);
            initCalendarAndRevealUi();
        }
    };
    document.getElementById('modal_login')?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.closest('#login-email, #login-pass, #login-remember-me')) return;
        e.preventDefault();
        document.getElementById('btn-do-login')?.click();
    });

    document.getElementById('btn-save-pass').onclick = async () => {
        if ((await updatePassword()) && !currentUser) {
            document.getElementById('modal_login')?.showModal();
            requestAnimationFrame(() => document.getElementById('login-email')?.focus());
        }
    };

    document.getElementById('menu-item-change-password')?.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        if (!currentUser) return;
        setPasswordModalMode(false);
        document.getElementById('modal_password')?.showModal();
        requestAnimationFrame(() => document.getElementById('old-pass')?.focus());
    });
    document.getElementById('menu-item-logout')?.addEventListener('click', async (e) => {
        e.preventDefault();
        document.getElementById('btn-user-menu')?.blur();
        await logout();
    });

    window.openForgotPassword = () => {
        document.getElementById('modal_login').close();
        document.getElementById('modal_forgot').showModal();
    };

    document.getElementById('btn-send-token').onclick = () => {
        sendResetLink(document.getElementById('forgot-email').value);
    };

    document.getElementById('btn-forgot-cancel')?.addEventListener('click', () => {
        document.getElementById('modal_forgot')?.close();
        document.getElementById('modal_login')?.showModal();
        requestAnimationFrame(() => document.getElementById('login-email')?.focus());
    });

    document.getElementById('modal_forgot')?.addEventListener('close', async () => {
        if (currentUser?.email) return;
        const loginDlg = document.getElementById('modal_login');
        if (loginDlg && !loginDlg.open) {
            await applyLoginBanner();
            loginDlg.showModal();
            requestAnimationFrame(() => document.getElementById('login-email')?.focus());
        }
    });

    document.getElementById('modal_login')?.addEventListener('close', () => {
        setLoginPassVisible(false);
        if (currentUser?.email) return;
        setTimeout(() => {
            if (currentUser?.email) return;
            if (document.getElementById('modal_password')?.open) return;
            if (document.getElementById('modal_forgot')?.open) return;
            const loginDlg = document.getElementById('modal_login');
            if (loginDlg && !loginDlg.open) {
                loginDlg.showModal();
                document.getElementById('login-email')?.focus();
            }
        }, 0);
    });

    document.getElementById('app-modals')?.addEventListener('change', (e) => {
        const t = e.target;
        if (t?.id === 'event-recurring') {
            const on = t.checked;
            if (on) {
                const ds = document.getElementById('event-date-start')?.value;
                if (ds) {
                    const rps = document.getElementById('event-recur-period-start');
                    const rpe = document.getElementById('event-recur-period-end');
                    if (rps) rps.value = ds;
                    if (rpe) rpe.value = ds;
                }
                const es = document.getElementById('event-start')?.value;
                const ee = document.getElementById('event-end')?.value;
                const rs = document.getElementById('event-recur-start');
                const re = document.getElementById('event-recur-end');
                if (es && rs) rs.value = es;
                if (ee && re) re.value = ee;
            } else {
                const p0 = document.getElementById('event-recur-period-start')?.value;
                if (p0) {
                    const d0 = document.getElementById('event-date-start');
                    if (d0) d0.value = p0;
                }
                const rs = document.getElementById('event-recur-start')?.value;
                const re = document.getElementById('event-recur-end')?.value;
                const es = document.getElementById('event-start');
                const ee = document.getElementById('event-end');
                if (rs && es) es.value = rs;
                if (re && ee) ee.value = re;
            }
            setRecurringOptionsVisible(on);
        }
        if (t?.name === 'recur-mode') {
            const custom = document.getElementById('recur-mode-days')?.checked;
            document.getElementById('recur-dow-grid')?.classList.toggle('hidden', !custom);
        }
    });

    document.getElementById('modal_login')?.addEventListener('toggle', (ev) => {
        const el = ev.target;
        if (el instanceof HTMLDialogElement && el.open) {
            const cb = document.getElementById('login-remember-me');
            if (cb) cb.checked = getRememberMePreference();
            void applyLoginBanner();
        }
    });

    const hasResetToken = new URLSearchParams(window.location.search).has('token');
    const supabaseRecoveryUrl = hasSupabaseRecoveryInUrl();
    const passModalOpen = document.getElementById('modal_password')?.open;
    if (!hasResetToken && !supabaseRecoveryUrl && !currentUser?.email && !passModalOpen) {
        const dlg = document.getElementById('modal_login');
        const rememberCb = document.getElementById('login-remember-me');
        if (rememberCb) rememberCb.checked = getRememberMePreference();
        await applyLoginBanner();
        dlg?.showModal();
        requestAnimationFrame(() => document.getElementById('login-email')?.focus());
    }
});
