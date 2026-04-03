const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxNVdQN_Tw77CeBdagV1P_U0ilWQsZuD_shqOOMtOBQ-8T4xDbH7k_MJwIjwBzpcCoZ/exec";
let calendar;

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const resp = await fetch(`${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
    const data = await resp.json();
    
    if(data.result === "success") {
        localStorage.setItem('orgue_user', email);
        localStorage.setItem('orgue_pass', pass);
        localStorage.setItem('orgue_name', data.name);
        showApp();
    } else { alert("Erreur"); }
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
        height: 'auto',
        selectable: true,
        headerToolbar: { left: 'prev,next', center: 'title', right: 'timeGridDay,timeGridWeek' },
        
        // CHARGEMENT DES ÉVÉNEMENTS
        events: `${SCRIPT_URL}?action=getEvents&email=${email}&password=${pass}`,

        // CRÉATION PAR CLIC/GLISSEMENT
        select: async function(info) {
            if(confirm(`Réserver de ${info.start.toLocaleTimeString()} à ${info.end.toLocaleTimeString()} ?`)) {
                const params = new URLSearchParams({
                    action: "reserve", email, password: pass, title: name,
                    start: info.start.toISOString(), end: info.end.toISOString()
                });
                const res = await fetch(`${SCRIPT_URL}?${params}`);
                calendar.refetchEvents();
            }
            calendar.unselect();
        },

        // SUPPRESSION PAR CLIC SUR ÉVÉNEMENT
        eventClick: async function(info) {
            if(!info.event.extendedProps.mine) return alert("Ce créneau ne vous appartient pas.");
            
            if(confirm("Supprimer votre réservation ?")) {
                const params = new URLSearchParams({
                    action: "delete", email, password: pass, id: info.event.id
                });
                await fetch(`${SCRIPT_URL}?${params}`);
                info.event.remove();
            }
        }
    });
    calendar.render();
}

function logout() { localStorage.clear(); location.reload(); }
