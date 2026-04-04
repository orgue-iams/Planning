let calendar;

function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        locale: 'fr',
        firstDay: 1, // Lundi
        slotMinTime: '08:00:00',
        slotMaxTime: '22:00:00',
        allDaySlot: false,
        height: 'auto',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'timeGridWeek,timeGridDay'
        },
        events: function(info, successCallback, failureCallback) {
            fetchEvents(info, successCallback, failureCallback);
        },
        eventClick: function(info) {
            alert("Événement : " + info.event.title);
        }
    });

    calendar.render();
}

async function fetchEvents(info, successCallback, failureCallback) {
    const email = localStorage.getItem('orgue_user');
    // On passe les dates de début et fin au format ISO pour Google Script
    const url = `${SCRIPT_URL}?action=getEvents&email=${encodeURIComponent(email)}&start=${info.startStr}&end=${info.endStr}`;
    
    try {
        const response = await fetch(url);
        const result = await response.json();
        
        if (result.result === "success") {
            // result.data contient la liste des événements formatés par le script
            successCallback(result.data);
        } else {
            console.error("Erreur serveur:", result.message);
            failureCallback(result.message);
        }
    } catch (error) {
        console.error("Erreur fetch:", error);
        failureCallback(error);
    }
}
