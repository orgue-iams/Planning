let votrePlanning; 
let currentEvent = null;

// Passage de l'écran login à l'écran calendrier
function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('userNameDisplay').innerText = localStorage.getItem('orgue_name') || "";
    setTimeout(initCalendar, 50);
}

function initCalendar() {
    const email = localStorage.getItem('orgue_user');
    const name = localStorage.getItem('orgue_name');
    const calendarEl = document.getElementById('calendar');

    votrePlanning = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        locale: 'fr',
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        allDaySlot: false,
        editable: true,
        selectable: true,
        headerToolbar: { left: 'prev,next today title', center: '', right: 'timeGridWeek,dayGridMonth' },
        events: function(fetchInfo, successCallback, failureCallback) {
            const url = `${SCRIPT_URL}?action=getEvents&email=${email}&start=${fetchInfo.start.toISOString()}&end=${fetchInfo.end.toISOString()}`;
            fetch(url, { method: 'GET', redirect: 'follow' })
                .then(res => res.json())
                .then(data => {
                    successCallback(data.map(ev => ({
                        id: ev.id, title: ev.title, start: ev.start, end: ev.end,
                        backgroundColor: ev.mine ? '#10b981' : '#1e3a8a',
                        borderColor: ev.mine ? '#10b981' : '#1e3a8a',
                        extendedProps: { mine: ev.mine }
                    })));
                });
        },
        eventClick: (info) => { currentEvent = info.event; openPopup(info.event); },
        select: async (info) => {
            if (info.view.type === 'dayGridMonth') return;
            const params = `action=reserve&email=${email}&title=${name}&start=${info.start.toISOString()}&end=${info.end.toISOString()}`;
            toggleLoader(true);
            await fetch(`${SCRIPT_URL}?${params}`, { method: 'GET', redirect: 'follow' });
            toggleLoader(false);
            votrePlanning.refetchEvents();
            votrePlanning.unselect();
        }
    });
    votrePlanning.render();
}

function openPopup(event) {
    const isMine = event.extendedProps.mine;
    document.getElementById('btnDelete').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('viewMode').innerHTML = `
        <h3 style="color:#1e3a8a; margin-top:0;">${event.title}</h3>
        <p style="color:#64748b;">${event.start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${event.end.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
    `;
    document.getElementById('popupDetails').style.display = 'flex';
}

async function deleteCurrentEvent() {
    if (!confirm("Supprimer cette réservation ?")) return;
    const url = `${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${localStorage.getItem('orgue_user')}`;
    toggleLoader(true);
    currentEvent.remove();
    document.getElementById('popupDetails').style.display = 'none';
    await fetch(url, { method: 'GET', redirect: 'follow' });
    toggleLoader(false);
}
