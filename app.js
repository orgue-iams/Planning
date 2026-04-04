const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzCQsg4C7y4jgCj5n9qCXWUUrRPelcHI6vGAbJnyX4mYfHSJ9ZxmiTsHMUR0OpLFhY/exec";
let calendar;
let currentEvent = null;

async function sendData(params) {
    try {
        await fetch(`${SCRIPT_URL}?${params}`, { mode: 'no-cors', method: 'GET' });
        return true;
    } catch (e) {
        console.error("Erreur d'envoi:", e);
        return false;
    }
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const msg = document.getElementById('loginMessage');
    
    if (!email || !pass) { msg.innerText = "Veuillez saisir vos identifiants."; return; }
    msg.style.color = "#5f6368"; msg.innerText = "Vérification...";
    
    try {
        const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
        
        // Ajout du redirect: 'follow' pour gérer la redirection Google Script
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        if (!response.ok) throw new Error('Erreur réseau');
        
        const data = await response.json();
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_pass', pass);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else {
            msg.style.color = "#d9534f"; msg.innerText = "Email ou mot de passe incorrect.";
        }
    } catch (error) {
        console.error("Erreur Login:", error);
        msg.style.color = "#d9534f"; msg.innerText = "Erreur de connexion au serveur.";
    }
}

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
        eventDurationEditable: true,
        slotLabelFormat: { hour: '2-digit', minute: '2-digit', meridiem: false },
        headerToolbar: { left: 'prev,next today title', center: '', right: 'timeGridWeek,dayGridMonth' },
        
        eventDrop: syncEventChange,
        eventResize: syncEventChange,

        eventDidMount: (info) => {
            if (info.event.extendedProps?.mine) {
                info.el.style.backgroundColor = '#93c54b'; info.el.style.borderColor = '#93c54b';
            } else {
                info.el.style.backgroundColor = '#3e3f3a'; info.el.style.borderColor = '#3e3f3a';
            }
        },

        events: `${SCRIPT_URL}?action=getEvents&email=${email}&password=${pass}`,

        eventClick: (info) => { currentEvent = info.event; openPopup(info.event); },

        select: async (info) => {
            if (info.view.type === 'dayGridMonth') return;
            const params = new URLSearchParams({ 
                action: "reserve", email, password: pass, title: name, 
                start: info.start.toISOString(), end: info.end.toISOString() 
            });
            await sendData(params);
            setTimeout(() => calendar.refetchEvents(), 600);
            calendar.unselect();
        }
    });
    calendar.render();
}

function openPopup(event) {
    const isMine = event.extendedProps.mine;
    const startStr = event.start.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
    const endStr = event.end.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});

    document.getElementById('btnEdit').style.display = isMine ? 'inline-flex' : 'none';
    document.getElementById('btnDelete').style.display = isMine ? 'inline-flex' : 'none';

    document.getElementById('viewMode').innerHTML = `
        <div class="mb-1 small text-muted">UTILISATEUR</div><div class="mb-3">${event.title}</div>
        <div class="mb-1 small text-muted">HORAIRE</div><div>${startStr} - ${endStr}</div>
    `;

    document.getElementById('editTitle').value = event.title;
    document.getElementById('editDate').value = event.start.toISOString().split('T')[0];
    document.getElementById('editStart').value = startStr.replace('h', ':');
    document.getElementById('editEnd').value = endStr.replace('h', ':');

    document.getElementById('viewMode').style.display = 'block';
    document.getElementById('editMode').style.display = 'none';
    document.getElementById('popupDetails').style.display = 'flex';
}

function switchToEditMode() {
    document.getElementById('viewMode').style.display = 'none';
    document.getElementById('editMode').style.display = 'block';
}

async function saveChanges() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    const delParams = new URLSearchParams({ action: "delete", id: currentEvent.id, email, password: pass });
    await sendData(delParams);
    
    const addParams = new URLSearchParams({
        action: "reserve", email, password: pass, title: document.getElementById('editTitle').value,
        start: new Date(`${document.getElementById('editDate').value}T${document.getElementById('editStart').value}:00`).toISOString(),
        end: new Date(`${document.getElementById('editDate').value}T${document.getElementById('editEnd').value}:00`).toISOString()
    });
    await sendData(addParams);
    
    closeModals();
    setTimeout(() => calendar.refetchEvents(), 800);
}

async function deleteCurrentEvent() {
    if (confirm("Supprimer cette réservation ?")) {
        const id = currentEvent.id;
        const email = localStorage.getItem('orgue_user');
        const pass = localStorage.getItem('orgue_pass');
        const params = new URLSearchParams({ action: "delete", id, email, password: pass });
        currentEvent.remove();
        closeModals();
        await sendData(params);
    }
}

async function syncEventChange(info) {
    if (!info.event.extendedProps.mine) { info.revert(); return; }
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    const params = new URLSearchParams({
        action: "update", id: info.event.id, email, password: pass,
        start: info.event.start.toISOString(), end: info.event.end.toISOString(), title: info.event.title
    });
    await sendData(params);
}

function closeModals() { document.getElementById('popupDetails').style.display = 'none'; }
function logout() { localStorage.clear(); location.reload(); }
function togglePass() { 
    const p = document.getElementById('userPass'); 
    p.type = p.type === "password" ? "text" : "password"; 
}
window.onload = () => { if(localStorage.getItem('orgue_user')) showApp(); };
