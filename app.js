const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwPznpQrAuJkyvr_IqcmtzOXTRTKYXuNpaVTqGIIAaHHEiNhSrv1nB_JMdcWV0VpIxm/exec";
let calendar;
let currentEvent = null;

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    setTimeout(initCalendar, 50);
}

function initCalendar() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    const name = localStorage.getItem('orgue_name');
    const calendarEl = document.getElementById('calendar');

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        locale: 'fr',
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        allDaySlot: false,
        height: 'auto',
        nowIndicator: true,
        selectable: true,
        editable: true,
        slotLabelFormat: { hour: '2-digit', minute: '2-digit', meridiem: false },
        titleFormat: { year: 'numeric', month: 'short' },
        headerToolbar: { left: 'prev,next today title', center: '', right: 'timeGridWeek,dayGridMonth' },
        buttonText: { today: "Auj.", week: "Sem.", month: "Mois" },
        
        eventDrop: async function(info) {
            if (!info.event.extendedProps.mine) { info.revert(); return; }
            const params = new URLSearchParams({
                action: "update", id: info.event.id, email, password: pass,
                start: info.event.start.toISOString(), end: info.event.end.toISOString(), title: info.event.title
            });
            await fetch(`${SCRIPT_URL}?${params}`);
        },

        dayHeaderContent: function(arg) {
            let dayName = arg.date.toLocaleDateString('fr-FR', { weekday: 'short' }).toUpperCase().replace('.', '');
            let dayNum = arg.date.getDate();
            let container = document.createElement('div');
            container.className = 'custom-header-container';
            container.innerHTML = `<span class="day-name">${dayName}</span><span class="day-number">${dayNum}</span>`;
            return { domNodes: [container] };
        },

        events: `${SCRIPT_URL}?action=getEvents&email=${email}&password=${pass}`,

        eventContent: function(arg) {
            let container = document.createElement('div');
            container.className = 'fc-event-main-container';
            let title = document.createElement('div');
            title.innerHTML = arg.event.title;
            title.className = 'fc-event-title-custom';
            container.appendChild(title);
            if (arg.event.extendedProps?.mine) {
                let x = document.createElement('div');
                x.innerHTML = '✕'; x.className = 'delete-event-btn';
                x.onclick = (e) => { e.stopPropagation(); if (confirm("Supprimer ?")) { arg.event.remove(); fetch(`${SCRIPT_URL}?action=delete&id=${arg.event.id}&email=${email}&password=${pass}`); }};
                container.appendChild(x);
            }
            return { domNodes: [container] };
        },

        eventDidMount: function(arg) {
            if (arg.event.extendedProps?.mine) arg.el.classList.add('fc-event-mine');
            else arg.el.classList.add('fc-event-others');
        },

        eventClick: function(info) {
            currentEvent = info.event;
            const startStr = info.event.start.toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            const endStr = info.event.end.toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            if (info.event.extendedProps?.mine) {
                document.getElementById('editTitle').value = info.event.title;
                document.getElementById('editDate').value = info.event.start.toISOString().split('T')[0];
                document.getElementById('editStart').value = startStr.replace('h', ':');
                document.getElementById('editEnd').value = endStr.replace('h', ':');
                document.getElementById('modalEdit').style.display = 'flex';
            } else {
                document.getElementById('viewContent').innerHTML = `<div class="view-item"><strong>Utilisateur :</strong>${info.event.title}</div><div class="view-item"><strong>Horaire :</strong>${startStr} - ${endStr}</div>`;
                document.getElementById('popupView').style.display = 'flex';
            }
        },

        select: async function(info) {
            if (info.view.type === 'dayGridMonth') return;
            const params = new URLSearchParams({ action: "reserve", email, password: pass, title: name, start: info.start.toISOString(), end: info.end.toISOString() });
            await fetch(`${SCRIPT_URL}?${params}`);
            calendar.refetchEvents();
            calendar.unselect();
        }
    });
    calendar.render();
}

async function updateEvent() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    await fetch(`${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${email}&password=${pass}`);
    const params = new URLSearchParams({
        action: "reserve", email, password: pass, title: document.getElementById('editTitle').value,
        start: new Date(`${document.getElementById('editDate').value}T${document.getElementById('editStart').value}:00`).toISOString(),
        end: new Date(`${document.getElementById('editDate').value}T${document.getElementById('editEnd').value}:00`).toISOString()
    });
    await fetch(`${SCRIPT_URL}?${params}`);
    closeModals(); calendar.refetchEvents();
}

function login() { /* ... login logic ... */ }
function logout() { localStorage.clear(); location.reload(); }
function closeModals() { document.getElementById('modalEdit').style.display = 'none'; document.getElementById('popupView').style.display = 'none'; }
window.onload = () => { if(localStorage.getItem('orgue_user')) showApp(); };
