const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzHNy1on-wMEspoBbYRGnlDUwLldl5Rg_Gonos_9PJJ4bzrPeGvaK9GkAUGEt-f_Hv7/exec";
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
    msg.innerText = "Vérification...";
    
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
        msg.innerText = "Erreur de connexion au serveur.";
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

// --- CONFIGURATION DU CALENDRIER ---
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
        
        // --- SÉCURITÉ ANTI-CHEVAUCHEMENT CLIENT ---
        eventOverlap: false, 
        selectOverlap: false,

        slotLabelFormat: { hour: '2-digit', minute: '2-digit', meridiem: false },
        headerToolbar: { 
            left: 'prev,next today title', 
            center: '', 
            right: 'timeGridWeek,dayGridMonth' 
        },

        // Source des données (Planning)
        events: `${SCRIPT_URL}?action=getEvents&email=${email}`,

        // Styles des événements (Couleurs)
        eventDidMount: (info) => {
            if (info.event.extendedProps?.mine) {
                info.el.style.backgroundColor = '#93c54b'; // Vert (Mien)
                info.el.style.borderColor = '#93c54b';
            } else {
                info.el.style.backgroundColor = '#3e3f3a'; // Gris (Autres)
                info.el.style.borderColor = '#3e3f3a';
                info.event.setProp('editable', false);    // Interdit de bouger ceux des autres
            }
        },

        // Action : Cliquer sur un créneau existant
        eventClick: (info) => {
            currentEvent = info.event;
            openPopup(info.event);
        },

        // Action : Glisser pour réserver (Nouveau créneau)
        select: async (info) => {
            if (info.view.type === 'dayGridMonth') return;
            
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
                    alert("Ce créneau est déjà occupé !");
                }
                calendar.refetchEvents();
            } catch (e) {
                console.error("Erreur réservation:", e);
            }
            calendar.unselect();
        },

        // Action : Déplacer ou redimensionner (Update)
        eventDrop: (info) => syncEventChange(info),
        eventResize: (info) => syncEventChange(info)
    });

    calendar.render();
}

// --- SYNCHRONISATION AVEC LE SERVEUR ---
async function syncEventChange(info) {
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=update&id=${info.event.id}&email=${email}&start=${info.event.start.toISOString()}&end=${info.event.end.toISOString()}`;
    
    try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const data = await response.json();
        
        if (data.result !== "success") {
            alert(data.result === "collision" ? "Espace déjà occupé par un autre utilisateur !" : "Erreur de mise à jour.");
            info.revert(); // Remet le créneau à sa place initiale
        }
    } catch (e) {
        console.error("Erreur réseau:", e);
        info.revert();
    }
}

// --- GESTION DE LA MODALE DÉTAILS / SUPPRESSION ---
function openPopup(event) {
    const isMine = event.extendedProps.mine;
    const startStr = event.start.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
    const endStr = event.end.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});

    // Afficher les boutons seulement si c'est notre créneau
    document.getElementById('btnEdit').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('btnDelete').style.display = isMine ? 'inline-flex' : 'none';

    document.getElementById('viewMode').innerHTML = `
        <div class="mb-1 small text-muted">UTILISATEUR</div><div class="mb-3"><strong>${event.title}</strong></div>
        <div class="mb-1 small text-muted">HORAIRE</div><div>${startStr} - ${endStr}</div>
    `;

    // Pré-remplir le mode édition
    document.getElementById('editTitle').value = event.title;
    document.getElementById('editDate').value = event.start.toISOString().split('T')[0];
    document.getElementById('editStart').value = startStr.replace('h', ':');
    document.getElementById('editEnd').value = endStr.replace('h', ':');

    document.getElementById('viewMode').style.display = 'block';
    document.getElementById('editMode').style.display = 'none';
    document.getElementById('popupDetails').style.display = 'flex';
}

async function deleteCurrentEvent() {
    if (!confirm("Supprimer cette réservation ?")) return;
    
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${email}`;
    
    currentEvent.remove(); // Suppression visuelle immédiate
    closeModals();

    try {
        await fetch(url, { method: 'GET', redirect: 'follow' });
    } catch (e) {
        console.error("Erreur suppression:", e);
        calendar.refetchEvents();
    }
}

// --- UTILITAIRES INTERFACE ---
function closeModals() {
    document.getElementById('popupDetails').style.display = 'none';
}

function togglePass() {
    const p = document.getElementById('userPass');
    p.type = p.type === "password" ? "text" : "password";
}

function switchToEditMode() {
    document.getElementById('viewMode').style.display = 'none';
    document.getElementById('editMode').style.display = 'block';
}
