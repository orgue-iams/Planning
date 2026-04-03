const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyyuHuc7g6SrbdAv7KQDDhPxG4go3UfAFDvQT5J-gl7RtCRTTJyxF8GA8ozQfnvoAeq/exec";
let calendar;

function togglePass() {
    const p = document.getElementById('userPass');
    p.type = p.type === "password" ? "text" : "password";
}

function showMsg(text, isError = true) {
    const el = document.getElementById('loginMessage');
    el.innerText = text;
    el.style.color = isError ? "#e74c3c" : "#27ae60";
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const btn = document.getElementById('btnLogin');

    if(!email || !pass) return showMsg("Veuillez remplir les champs");
    
    btn.disabled = true;
    showMsg("Connexion...");

    try {
        const resp = await fetch(`${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
        const data = await resp.json();
        
        if(data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_pass', pass);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else {
            showMsg(data.message);
            btn.disabled = false;
        }
    } catch(e) {
        showMsg("Erreur de connexion au serveur");
        btn.disabled = false;
    }
}

async function forgotPassword() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    if(!email) return showMsg("Saisissez votre email d'abord");
    
    showMsg("Envoi en cours...", false);
    try {
        const resp = await fetch(`${SCRIPT_URL}?action=forgot&email=${encodeURIComponent(email)}`);
        const data = await resp.json();
        showMsg(data.message, data.result === "error");
    } catch(e) { showMsg("Erreur serveur"); }
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    initCalendar();
}

function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    const name = localStorage.getItem('orgue_name');

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        locale: 'fr',
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        allDaySlot: false,
        height: '85vh',
        selectable: true,
        headerToolbar: { left: 'prev,next', center: 'title', right: 'timeGridDay,timeGridWeek' },
        events: `${SCRIPT_URL}?action=getEvents&email=${email}&password=${pass}`,

        select: async function(info) {
            if(confirm(`Réserver ce créneau ?`)) {
                const params = new URLSearchParams({
                    action: "reserve", email, password: pass, title: name,
                    start: info.start.toISOString(), end: info.end.toISOString()
                });
                await fetch(`${SCRIPT_URL}?${params}`);
                calendar.refetchEvents();
            }
            calendar.unselect();
        },

        eventClick: async function(info) {
            if(!info.event.extendedProps.mine) return;
            if(confirm("Supprimer votre réservation ?")) {
                const params = new URLSearchParams({
                    action: "delete", email, password: pass, id: info.event.id
                });
                await fetch(`${SCRIPT_URL}?${params}`);
                calendar.refetchEvents();
            }
        }
    });
    calendar.render();
}

function logout() { localStorage.clear(); location.reload(); }

window.onload = () => {
    if(localStorage.getItem('orgue_user')) showApp();
};
