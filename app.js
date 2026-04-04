const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxcJzXEDx5f0o59jRX4U9EUhE3Bsdlw5Bl_X4SkKLqdcSHn99atQ-6qnxoK6aO7EL3X/exec";
let calendar;
let currentEvent = null;

// Au chargement, on vérifie si l'utilisateur est déjà connecté
window.onload = () => { 
    if (localStorage.getItem('orgue_user')) showApp(); 
};

// --- AUTHENTIFICATION ---
async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const msg = document.getElementById('loginMessage');
    const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
    
    try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const data = await response.json();
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else { msg.innerText = "Identifiants incorrects."; }
    } catch (e) { msg.innerText = "Erreur de connexion serveur."; }
}

function logout() { 
    localStorage.clear(); 
    location.reload(); 
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    setTimeout(initCalendar, 50);
}

// --- CALENDRIER ---
function initCalendar() {
    const email = localStorage.getItem('orgue_user');
    const name = localStorage.getItem('orgue_name');
    const calendarEl = document.getElementById('calendar');

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        locale: 'fr',
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        allDaySlot: false,
        editable: true,
        selectable: true,
        eventOverlap: false, 
        selectOverlap: false,
        headerToolbar: { left: 'prev,next today title', center: '', right: 'timeGridWeek,dayGridMonth' },

        events: function(fetchInfo, successCallback, failureCallback) {
            const url = `${SCRIPT_URL}?action=getEvents&email=${email}&start=${fetchInfo.start.toISOString()}&end=${fetchInfo.end.toISOString()}`;
            fetch(url, { method: 'GET', redirect: 'follow' })
                .then(res => res.json())
                .then(data => {
                    if (data.result === "error") return successCallback([]);
                    successCallback(data.map(ev => ({
                        id: ev.id, title: ev.title, start: ev.start, end: ev.end,
                        backgroundColor: ev.mine ? '#93c54b' : '#3e3f3a',
                        borderColor: ev.mine ? '#93c54b' : '#3e3f3a',
                        editable: ev.mine,
                        extendedProps: { mine: ev.mine }
                    })));
                }).catch(e => failureCallback(e));
        },

        eventClick: (info) => { 
            currentEvent = info.event; 
            openPopup(info.event); 
        },

        select: async (info) => {
            if (info.view.type === 'dayGridMonth') return;
            const params = `action=reserve&email=${email}&title=${name}&start=${info.start.toISOString()}&end=${info.end.toISOString()}`;
            try {
                await fetch(`${SCRIPT_URL}?${params}`, { method: 'GET', redirect: 'follow' });
                calendar.refetchEvents();
            } catch (e) { calendar.refetchEvents(); }
            calendar.unselect();
        },

        eventDrop: (info) => syncEventChange(info),
        eventResize: (info) => syncEventChange(info),
        loading: (isLoading) => { if(calendarEl) calendarEl.style.opacity = isLoading ? '0.6' : '1'; }
    });
    calendar.render();
}

// --- ACTIONS SYNCHRONES ---
function syncEventChange(info) {
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=update&id=${info.event.id}&email=${email}&start=${info.event.start.toISOString()}&end=${info.event.end.toISOString()}`;
    fetch(url, { method: 'GET', redirect: 'follow' })
    .then(res => res.json())
    .then(data => { if (data.result !== "success") info.revert(); })
    .catch(() => info.revert());
}

function openPopup(event) {
    const isMine = event.extendedProps.mine;
    document.getElementById('btnEdit').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('btnDelete').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('viewMode').innerHTML = `<strong>${event.title}</strong><br>${event.start.toLocaleTimeString()} - ${event.end.toLocaleTimeString()}`;
    document.getElementById('popupDetails').style.display = 'flex';
}

async function deleteCurrentEvent() {
    if (!confirm("Voulez-vous vraiment supprimer cette réservation ?")) return;
    const url = `${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${localStorage.getItem('orgue_user')}`;
    currentEvent.remove();
    document.getElementById('popupDetails').style.display = 'none';
    fetch(url, { method: 'GET', redirect: 'follow' });
}
