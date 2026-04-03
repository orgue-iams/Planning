const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwPznpQrAuJkyvr_IqcmtzOXTRTKYXuNpaVTqGIIAaHHEiNhSrv1nB_JMdcWV0VpIxm/exec";
let calendar;

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
        
        // Configuration pour tout aligner sur une seule ligne
        headerToolbar: {
            left: 'prev,next today title',
            center: '',
            right: 'timeGridWeek,dayGridMonth'
        },
        buttonText: { today: "Auj.", week: "Sem.", month: "Mois" },
        
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
                x.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm("Supprimer ?")) {
                        arg.event.remove();
                        fetch(`${SCRIPT_URL}?action=delete&id=${arg.event.id}&email=${email}&password=${pass}`);
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
            if (!info.event.extendedProps?.mine) {
                const start = info.event.start.toLocaleTimeString([], {hour:'2h', minute:'2m'});
                const end = info.event.end.toLocaleTimeString([], {hour:'2h', minute:'2m'});
                document.getElementById('viewContent').innerHTML = `<strong>${info.event.title}</strong><br>${start} - ${end}`;
                document.getElementById('popupView').style.display = 'block';
            }
        }
    });
    calendar.render();
}
// Garder les fonctions login/logout/update inchangées...
