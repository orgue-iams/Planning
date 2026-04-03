const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw7Cy5TDwRIwtPyUvW4JTo6SzU7RaGWI9Fg0nq9vFnSAxpKoEriOTpk_pmuePC0RHtI/exec";
let calendar;
let currentEvent = null;

function togglePass() {
    const p = document.getElementById('userPass');
    p.type = p.type === "password" ? "text" : "password";
}

function showMsg(text, isError = true) {
    const el = document.getElementById('loginMessage');
    el.innerText = text; el.style.color = isError ? "#e74c3c" : "#27ae60";
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    if(!email || !pass) return showMsg("Champs vides");
    showMsg("Connexion...");
    const resp = await fetch(`${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
    const data = await resp.json();
    if(data.result === "success") {
        localStorage.setItem('orgue_user', email);
        localStorage.setItem('orgue_pass', pass);
        localStorage.setItem('orgue_name', data.name);
        showApp();
    } else { showMsg(data.message); }
}

async function forgotPassword() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    if(!email) return showMsg("Saisissez l'email d'abord");
    showMsg("Envoi...", false);
    const resp = await fetch(`${SCRIPT_URL}?action=forgot&email=${encodeURIComponent(email)}`);
    const data = await resp.json();
    showMsg(data.message, data.result === "error");
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    initCalendar();
}

function initCalendar() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    const name = localStorage.getItem('orgue_name');

    calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
        initialView: 'timeGridWeek',
        locale: 'fr',
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        height: 'calc(100vh - 120px)',
        allDaySlot: false,
        selectable: true,
        editable: true,
        eventOverlap: false,
        nowIndicator: true,
        headerToolbar: {
            left: 'today prev,next',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
        },
        events: `${SCRIPT_URL}?action=getEvents&email=${email}&password=${pass}`,

        // DRAG & DROP / RESIZE
        eventDrop: (info) => handleMove(info),
        eventResize: (info) => handleMove(info),

        // RENDU DU BOUTON X
        eventContent: function(arg) {
            let nodes = [];
            let title = document.createElement('div');
            title.innerHTML = arg.event.title;
            title.style.fontWeight = '600';
            nodes.push(title);

            if (arg.event.extendedProps.mine) {
                let x = document.createElement('div');
                x.innerHTML = '✕';
                x.className = 'delete-event-btn';
                x.onclick = async (e) => {
                    e.stopPropagation();
                    arg.event.remove();
                    await fetch(`${SCRIPT_URL}?action=delete&id=${arg.event.id}&email=${email}&password=${pass}`);
                };
                nodes.push(x);
            }
            return { domNodes: nodes };
        },

        // CLIC SUR UN CRÉNEAU
        eventClick: function(info) {
            currentEvent = info.event;
            if (info.event.extendedProps.mine) {
                document.getElementById('editTitle').value = info.event.title;
                document.getElementById('editStart').value = info.event.start.toTimeString().substring(0,5);
                document.getElementById('editEnd').value = info.event.end.toTimeString().substring(0,5);
                document.getElementById('modalEdit').style.display = 'flex';
            } else {
                document.getElementById('viewContent').innerHTML = `<strong>${info.event.title}</strong><br>${info.event.start.toLocaleTimeString([], {hour:'2h', minute:'2m'})} - ${info.event.end.toLocaleTimeString([], {hour:'2h', minute:'2m'})}`;
                document.getElementById('popupView').style.display = 'block';
            }
        },

        // RÉSERVATION ZONE VIDE
        select: async function(info) {
            if (info.view.type === 'dayGridMonth') return calendar.changeView('timeGridDay', info.start);
            const params = new URLSearchParams({action: "reserve", email, password: pass, title: name, start: info.start.toISOString(), end: info.end.toISOString()});
            await fetch(`${SCRIPT_URL}?${params}`);
            calendar.refetchEvents();
            calendar.unselect();
        }
    });
    calendar.render();
}

async function handleMove(info) {
    if (!info.event.extendedProps.mine) return info.revert();
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    await fetch(`${SCRIPT_URL}?action=delete&id=${info.event.id}&email=${email}&password=${pass}`);
    const params = new URLSearchParams({action: "reserve", email, password: pass, title: info.event.title, start: info.event.start.toISOString(), end: info.event.end.toISOString()});
    await fetch(`${SCRIPT_URL}?${params}`);
    calendar.refetchEvents();
}

async function updateEvent() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    await fetch(`${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${email}&password=${pass}`);
    const baseDate = currentEvent.start.toISOString().split('T')[0];
    const finalStart = new Date(`${baseDate}T${document.getElementById('editStart').value}:00`);
    const finalEnd = new Date(`${baseDate}T${document.getElementById('editEnd').value}:00`);
    const params = new URLSearchParams({action: "reserve", email, password: pass, title: document.getElementById('editTitle').value, start: finalStart.toISOString(), end: finalEnd.toISOString()});
    await fetch(`${SCRIPT_URL}?${params}`);
    closeModals();
    calendar.refetchEvents();
}

function closeModals() {
    document.getElementById('modalEdit').style.display = 'none';
    document.getElementById('popupView').style.display = 'none';
}

function logout() { localStorage.clear(); location.reload(); }
window.onload = () => { if(localStorage.getItem('orgue_user')) showApp(); };
