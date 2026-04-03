const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwPznpQrAuJkyvr_IqcmtzOXTRTKYXuNpaVTqGIIAaHHEiNhSrv1nB_JMdcWV0VpIxm/exec";
let calendar;
let currentEvent = null;

// Vérification du chargement
console.log("App.js chargé avec succès.");

function togglePass() {
    const p = document.getElementById('userPass');
    p.type = p.type === "password" ? "text" : "password";
}

function showMsg(text, isError = true) {
    const el = document.getElementById('loginMessage');
    if (el) {
        el.innerText = text; 
        el.style.color = isError ? "#ff3b30" : "#34c759";
    }
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    
    if(!email || !pass) return showMsg("Veuillez remplir les champs");
    
    showMsg("Connexion en cours...", false);
    
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
        }
    } catch(e) { 
        showMsg("Erreur de communication avec le serveur"); 
        console.error(e);
    }
}

async function forgotPassword() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    if(!email) return showMsg("Saisissez l'email d'abord");
    
    showMsg("Envoi du mail...", false);
    try {
        const resp = await fetch(`${SCRIPT_URL}?action=forgot&email=${encodeURIComponent(email)}`);
        const data = await resp.json();
        showMsg(data.message, data.result === "error");
    } catch(e) { 
        showMsg("Erreur lors de l'envoi"); 
    }
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    // On attend un court instant pour s'assurer que le DOM est rendu
    setTimeout(initCalendar, 50);
}

function initCalendar() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    const name = localStorage.getItem('orgue_name');

    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;

    calendar = new FullCalendar.Calendar(calendarEl, {
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
            left: 'title',
            center: '',
            right: 'today prev,next dayGridMonth,timeGridWeek,timeGridDay'
        },
        buttonText: { today: "Auj.", month: "Mois", week: "Sem.", day: "Jour" },
        
        events: `${SCRIPT_URL}?action=getEvents&email=${email}&password=${pass}`,

        eventDrop: (info) => handleSync(info),
        eventResize: (info) => handleSync(info),

        eventContent: function(arg) {
            let nodes = [];
            let title = document.createElement('div');
            title.innerHTML = arg.event.title;
            title.className = 'fc-event-title-custom';
            nodes.push(title);

            if (arg.event.extendedProps.mine) {
                arg.el.classList.add('fc-event-mine');
                let x = document.createElement('div');
                x.innerHTML = '✕';
                x.className = 'delete-event-btn';
                x.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm("Supprimer cette réservation ?")) {
                        arg.event.remove();
                        await fetch(`${SCRIPT_URL}?action=delete&id=${arg.event.id}&email=${email}&password=${pass}`);
                    }
                };
                nodes.push(x);
            }
            return { domNodes: nodes };
        },

        eventClick: function(info) {
            currentEvent = info.event;
            if (info.event.extendedProps.mine) {
                document.getElementById('editTitle').value = info.event.title;
                document.getElementById('editStart').value = info.event.start.toTimeString().substring(0,5);
                document.getElementById('editEnd').value = info.event.end.toTimeString().substring(0,5);
                document.getElementById('modalEdit').style.display = 'flex';
            } else {
                const startStr = info.event.start.toLocaleTimeString([], {hour:'2h', minute:'2m'});
                const endStr = info.event.end.toLocaleTimeString([], {hour:'2h', minute:'2m'});
                document.getElementById('viewContent').innerHTML = `<strong>${info.event.title}</strong><br>${startStr} - ${endStr}`;
                document.getElementById('popupView').style.display = 'block';
            }
        },

        select: async function(info) {
            if (info.view.type === 'dayGridMonth') {
                calendar.changeView('timeGridDay', info.start);
                return;
            }
            const params = new URLSearchParams({
                action: "reserve", 
                email, 
                password: pass, 
                title: name, 
                start: info.start.toISOString(), 
                end: info.end.toISOString()
            });
            await fetch(`${SCRIPT_URL}?${params}`);
            calendar.refetchEvents();
            calendar.unselect();
        }
    });
    calendar.render();
}

async function handleSync(info) {
    if (!info.event.extendedProps.mine) {
        info.revert();
        return;
    }
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    
    await fetch(`${SCRIPT_URL}?action=delete&id=${info.event.id}&email=${email}&password=${pass}`);
    
    const params = new URLSearchParams({
        action: "reserve", email, password: pass, 
        title: info.event.title, 
        start: info.event.start.toISOString(), 
        end: info.event.end.toISOString()
    });
    await fetch(`${SCRIPT_URL}?${params}`);
    calendar.refetchEvents();
}

async function updateEvent() {
    const email = localStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass');
    
    await fetch(`${SCRIPT_URL}?action=delete&id=${currentEvent.id}&email=${email}&password=${pass}`);
    
    const baseDate = currentEvent.start.toISOString().split('T')[0];
    const newStart = new Date(`${baseDate}T${document.getElementById('editStart').value}:00`).toISOString();
    const newEnd = new Date(`${baseDate}T${document.getElementById('editEnd').value}:00`).toISOString();
    
    const params = new URLSearchParams({
        action: "reserve", email, password: pass, 
        title: document.getElementById('editTitle').value,
        start: newStart,
        end: newEnd
    });
    
    await fetch(`${SCRIPT_URL}?${params}`);
    closeModals();
    calendar.refetchEvents();
}

function closeModals() {
    document.getElementById('modalEdit').style.display = 'none';
    document.getElementById('popupView').style.display = 'none';
}

function logout() {
    localStorage.clear();
    location.reload();
}

// Lancement automatique
window.addEventListener('load', () => {
    if(localStorage.getItem('orgue_user')) {
        showApp();
    }
});
