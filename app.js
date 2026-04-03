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
        
        // Configuration de l'en-tête FullCalendar pour tout mettre sur une ligne
        headerToolbar: {
            left: 'title today prev,next',
            center: '',
            right: 'timeGridWeek,dayGridMonth'
        },
        buttonText: { today: "Aujourd'hui", week: "Semaine", month: "Mois" },
        
        // On sépare le nom du jour et le numéro pour le style
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
                x.innerHTML = '✕';
                x.className = 'delete-event-btn';
                x.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm("Supprimer ?")) {
                        arg.event.remove();
                        await fetch(`${SCRIPT_URL}?action=delete&id=${arg.event.id}&email=${email}&password=${pass}`);
                    }
                };
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
            if (info.event.extendedProps?.mine) {
                document.getElementById('editTitle').value = info.event.title;
                document.getElementById('editStart').value = info.event.start.toTimeString().substring(0,5);
                document.getElementById('editEnd').value = info.event.end.toTimeString().substring(0,5);
                document.getElementById('modalEdit').style.display = 'flex';
            } else {
                const start = info.event.start.toLocaleTimeString([], {hour:'2h', minute:'2m'});
                const end = info.event.end.toLocaleTimeString([], {hour:'2h', minute:'2m'});
                document.getElementById('viewContent').innerHTML = `<strong>${info.event.title}</strong><br>${start} - ${end}`;
                document.getElementById('popupView').style.display = 'block';
            }
        },

        select: async function(info) {
            if (info.view.type === 'dayGridMonth') return;
            const params = new URLSearchParams({action: "reserve", email, password: pass, title: name, start: info.start.toISOString(), end: info.end.toISOString()});
            await fetch(`${SCRIPT_URL}?${params}`);
            calendar.refetchEvents();
            calendar.unselect();
        }
    });
    calendar.render();
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const resp = await fetch(`${SCRIPT_URL}?action=login&email=${email}&password=${pass}`);
    const data = await resp.json();
    if(data.result === "success") {
        localStorage.setItem('orgue_user', email);
        localStorage.setItem('orgue_pass', pass);
        localStorage.setItem('orgue_name', data.name);
        showApp();
    }
}
function logout() { localStorage.clear(); location.reload(); }
function closeModals() { document.getElementById('modalEdit').style.display = 'none'; document.getElementById('popupView').style.display = 'none'; }
window.onload = () => { if(localStorage.getItem('orgue_user')) showApp(); };
