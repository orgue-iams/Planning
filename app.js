let calendar;
let currentEvent = null;

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('userNameDisplay').innerText = localStorage.getItem('orgue_name');
    initCalendar();
}

function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        locale: 'fr',
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        allDaySlot: false,
        headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,dayGridMonth' },
        events: function(info, success) {
            const email = localStorage.getItem('orgue_user');
            fetch(`${SCRIPT_URL}?action=getEvents&email=${email}&start=${info.startStr}&end=${info.endStr}`)
                .then(r => r.json())
                .then(data => success(data));
        },
        eventClick: (info) => {
            currentEvent = info.event;
            const isMine = info.event.extendedProps.mine;
            document.getElementById('btnDelete').style.display = isMine ? 'block' : 'none';
            document.getElementById('viewMode').innerHTML = `<h3>${info.event.title}</h3><p>${info.event.start.toLocaleTimeString()} - ${info.event.end.toLocaleTimeString()}</p>`;
            document.getElementById('popupDetails').style.display = 'flex';
        },
        selectable: true,
        select: async (info) => {
            const email = localStorage.getItem('orgue_user');
            const name = localStorage.getItem('orgue_name');
            toggleLoader(true);
            await fetch(`${SCRIPT_URL}?action=reserve&email=${email}&title=${name}&start=${info.startStr}&end=${info.endStr}`);
            toggleLoader(false);
            calendar.refetchEvents();
        }
    });
    calendar.render();
}

async function deleteCurrentEvent() {
    if(!confirm("Supprimer cette réservation ?")) return;
    const email = localStorage.getItem('orgue_user');
    toggleLoader(true);
    await fetch(`${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${email}`);
    toggleLoader(false);
    document.getElementById('popupDetails').style.display = 'none';
    calendar.refetchEvents();
}
