const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxf38i5S-9m3TOsGxAZkvx2LGb1gQS9iT8oVfvEnH2wMTcpFA7uXa3kd9_gMAsr6TGa/exec";
let calendar;
let currentEvent = null;

// --- INITIALISATION AU CHARGEMENT ---
window.onload = () => {
    if (localStorage.getItem('orgue_user')) {
        showApp();
    }
};

// --- SYSTÈME DE CONNEXION ---
async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const msg = document.getElementById('loginMessage');
    
    if (!email || !pass) {
        msg.innerText = "Veuillez remplir tous les champs.";
        return;
    }
    
    msg.style.color = "#5f6368";
    msg.innerText = "Connexion...";
    
    try {
        const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const data = await response.json();

        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_pass', pass);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else {
            msg.style.color = "#d9534f";
            msg.innerText = "Identifiants incorrects.";
        }
    } catch (error) {
        console.error("Erreur login:", error);
        msg.style.color = "#d9534f";
        msg.innerText = "Erreur serveur (Vérifiez votre connexion).";
    }
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    setTimeout(initCalendar, 50);
}

function logout() {
    localStorage.clear();
    location.reload();
}

// --- CONFIGURATION DU CALENDRIER (TURBO MODE) ---
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
        height: 'auto',
        nowIndicator: true,
        selectable: true,
        editable: true,
        lazyFetching: true, // Optimisation : évite les appels serveurs inutiles
        
        // Sécurité visuelle immédiate
        eventOverlap: false, 
        selectOverlap: false,

        slotLabelFormat: { hour: '2-digit', minute: '2-digit', meridiem: false },
        headerToolbar: { 
            left: 'prev,next today title', 
            center: '', 
            right: 'timeGridWeek,dayGridMonth' 
        },

        // Chargement des données
        events: function(fetchInfo, successCallback, failureCallback) {
            const url = `${SCRIPT_URL}?action=getEvents&email=${email}&start=${fetchInfo.startStr}&end=${fetchInfo.endStr}`;
            fetch(url)
                .then(res => res.json())
                .then(data => {
                    // On formate les données pour FullCalendar
                    const events = data.map(ev => ({
                        id: ev.id,
                        title: ev.title,
                        start: ev.start,
                        end: ev.end,
                        backgroundColor: ev.mine ? '#93c54b' : '#3e3f3a',
                        borderColor: ev.mine ? '#93c54b' : '#3e3f3a',
                        editable: ev.mine // Seuls mes créneaux sont déplaçables
                    }));
                    successCallback(events);
                })
                .catch(err => failureCallback(err));
        },

        // Clic sur un événement
        eventClick: (info) => {
            currentEvent = info.event;
            openPopup(info.event);
        },

        // Réservation immédiate
        select: async (info) => {
            if (info.view.type === 'dayGridMonth') return;
            
            // Création visuelle immédiate (UI Optimiste)
            const tempId = 'temp-' + Date.now();
            const newEv = calendar.addEvent({
                id: tempId,
                title: name,
                start: info.start,
                end: info.end,
                backgroundColor: '#93c54b'
            });

            const params = new URLSearchParams({
                action: "reserve",
                email: email,
                title: name,
                start: info.start.toISOString(),
                end: info.end.toISOString()
            });

            try {
                const response = await fetch(`${SCRIPT_URL}?${params}`, { method: 'GET', redirect: 'follow' });
                const data = await response.json();
                if (data.result === "collision") {
                    alert("Déjà réservé !");
                    newEv.remove();
                }
                calendar.refetchEvents();
            } catch (e) {
                newEv.remove();
            }
            calendar.unselect();
        },

        // Déplacement (Drag & Drop)
        eventDrop: (info) => syncEventChange(info),
        eventResize: (info) => syncEventChange(info),

        // Indicateur de chargement
        loading: (isLoading) => {
            calendarEl.style.opacity = isLoading ? '0.6' : '1';
        }
    });

    calendar.render();
}

// --- SYNCHRONISATION ARRIÈRE-PLAN (SANS AWAIT) ---
function syncEventChange(info) {
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=update&id=${info.event.id}&email=${email}&start=${info.event.start.toISOString()}&end=${info.event.end.toISOString()}`;
    
    // On lance la requête sans bloquer l'interface
    fetch(url, { method: 'GET', redirect: 'follow' })
    .then(res => res.json())
    .then(data => {
        if (data.result !== "success") {
            alert(data.result === "collision" ? "Espace déjà occupé !" : "Erreur serveur.");
            info.revert();
        }
    })
    .catch(() => info.revert());
}

// --- MODALE ---
function openPopup(event) {
    const isMine = event.backgroundColor === '#93c54b' || event.extendedProps.mine;
    const startStr = event.start.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
    const endStr = event.end.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});

    document.getElementById('btnEdit').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('btnDelete').style.display = isMine ? 'inline-flex' : 'none';

    document.getElementById('viewMode').innerHTML = `
        <div class="mb-1 small text-muted">UTILISATEUR</div><div class="mb-3"><strong>${event.title}</strong></div>
        <div class="mb-1 small text-muted">HORAIRE</div><div>${startStr} - ${endStr}</div>
    `;

    document.getElementById('viewMode').style.display = 'block';
    document.getElementById('editMode').style.display = 'none';
    document.getElementById('popupDetails').style.display = 'flex';
}

async function deleteCurrentEvent() {
    if (!confirm("Supprimer cette réservation ?")) return;
    
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${email}`;
    
    currentEvent.remove(); 
    closeModals();

    fetch(url, { method: 'GET', redirect: 'follow' })
    .catch(() => calendar.refetchEvents());
}

function closeModals() {
    document.getElementById('popupDetails').style.display = 'none';
}

function togglePass() {
    const p = document.getElementById('userPass');
    p.type = p.type === "password" ? "text" : "password";
}
