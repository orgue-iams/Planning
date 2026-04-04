const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxcJzXEDx5f0o59jRX4U9EUhE3Bsdlw5Bl_X4SkKLqdcSHn99atQ-6qnxoK6aO7EL3X/exec";
let calendar; // Unique déclaration autorisée
let currentEvent = null;

// --- INITIALISATION ---
window.onload = () => { 
    if (localStorage.getItem('orgue_user')) showApp(); 
};

// --- INTERFACE ---
function toggleLoader(show) {
    const loader = document.getElementById('loader');
    if (loader) loader.style.display = show ? 'flex' : 'none';
}

function togglePasswordVisibility() {
    const passInput = document.getElementById('userPass');
    const icon = document.getElementById('togglePassword');
    if (passInput.type === "password") {
        passInput.type = "text";
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        passInput.type = "password";
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// --- AUTHENTIFICATION ---
async function login() {
    const emailInput = document.getElementById('userEmail');
    const passInput = document.getElementById('userPass');
    const msg = document.getElementById('loginMessage');
    
    const email = emailInput.value.trim().toLowerCase();
    const pass = passInput.value.trim();
    const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
    
    toggleLoader(true);
    try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const data = await response.json();
        toggleLoader(false);
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else { msg.innerText = "Identifiants incorrects."; }
    } catch (e) { 
        toggleLoader(false);
        msg.innerText = "Erreur de connexion serveur."; 
    }
}

function logout() { 
    localStorage.clear(); 
    location.reload(); 
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('userNameDisplay').innerText = localStorage.getItem('orgue_name') || "";
    setTimeout(initCalendar, 50);
}

// --- LOGIQUE CALENDRIER ---
function initCalendar() {
    const email = localStorage.getItem('orgue_user');
    const name = localStorage.getItem('orgue_name');
    const calendarEl = document.getElementById('calendar');

    // On utilise la variable 'calendar' déclarée en haut (sans 'let' devant ici)
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
                        backgroundColor: ev.mine ? '#10b981' : '#1e3a8a',
                        borderColor: ev.mine ? '#10b981' : '#1e3a8a',
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
            toggleLoader(true);
            try {
                await fetch(`${SCRIPT_URL}?${params}`, { method: 'GET', redirect: 'follow' });
                toggleLoader(false);
                calendar.refetchEvents();
            } catch (e) { 
                toggleLoader(false);
                calendar.refetchEvents(); 
            }
            calendar.unselect();
        },

        eventDrop: (info) => syncEventChange(info),
        eventResize: (info) => syncEventChange(info),
        loading: (isLoading) => { if(calendarEl) calendarEl.style.opacity = isLoading ? '0.6' : '1'; }
    });
    calendar.render();
}

// --- ACTIONS RÉSEAU ---
function syncEventChange(info) {
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=update&id=${info.event.id}&email=${email}&start=${info.event.start.toISOString()}&end=${info.event.end.toISOString()}`;
    toggleLoader(true);
    fetch(url, { method: 'GET', redirect: 'follow' })
    .then(res => res.json())
    .then(data => { 
        toggleLoader(false);
        if (data.result !== "success") info.revert(); 
    })
    .catch(() => {
        toggleLoader(false);
        info.revert();
    });
}

function openPopup(event) {
    const isMine = event.extendedProps.mine;
    document.getElementById('btnDelete').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('viewMode').innerHTML = `<h3 style="margin-top:0; color:#1e3a8a;">${event.title}</h3><p style="color:#64748b;">${event.start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${event.end.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>`;
    document.getElementById('popupDetails').style.display = 'flex';
}

async function deleteCurrentEvent() {
    if (!confirm("Voulez-vous supprimer cette réservation ?")) return;
    const url = `${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${localStorage.getItem('orgue_user')}`;
    toggleLoader(true);
    currentEvent.remove();
    document.getElementById('popupDetails').style.display = 'none';
    try {
        await fetch(url, { method: 'GET', redirect: 'follow' });
        toggleLoader(false);
    } catch(e) { toggleLoader(false); }
}
