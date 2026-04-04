// CONFIGURATION
const CALENDAR_ID = 'orgue.iams@gmail.com';
const SPREADSHEET_NAME = 'Planning';
const SHEET_NAME = 'Users';

/**
 * Fonction principale (GET)
 */
function doGet(e) {
  const action = e.parameter.action;
  
  try {
    // 1. CONNEXION / LOGIN
    if (action === 'login') {
      const email = e.parameter.email;
      const pass = e.parameter.password;
      
      // Récupération du classeur par nom ou par le fichier actif
      let ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss.getName() !== SPREADSHEET_NAME) {
        // Sécurité si le script est détaché : cherche par nom
        const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
        if (files.hasNext()) {
          ss = SpreadsheetApp.open(files.next());
        }
      }
      
      const sheet = ss.getSheetByName(SHEET_NAME);
      if (!sheet) return createResponse({result: "error", message: "Onglet '" + SHEET_NAME + "' introuvable"});
      
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        // A: Email, B: Pass, C: Nom
        if (data[i][0].toString().toLowerCase() === email.toLowerCase() && data[i][1].toString() === pass) {
          return createResponse({result: "success", name: data[i][2]});
        }
      }
      return createResponse({result: "error", message: "Identifiants incorrects"});
    } 

    // 2. RECUPERATION DES EVENEMENTS
    else if (action === 'getEvents') {
      const optionalArgs = {
        timeMin: e.parameter.start,
        timeMax: e.parameter.end,
        singleEvents: true,
        orderBy: 'startTime'
      };
      
      const response = Calendar.Events.list(CALENDAR_ID, optionalArgs);
      const items = response.items || [];
      
      const events = items.map(event => ({
        id: event.id,
        title: event.summary || "(Sans titre)",
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        extendedProps: { 
          mine: (event.description && event.description.includes(e.parameter.email)) 
        }
      }));
      return createResponse(events);
    } 

    // 3. RESERVATION
    else if (action === 'reserve') {
      const cal = CalendarApp.getCalendarById(CALENDAR_ID);
      const ev = cal.createEvent(e.parameter.title, new Date(e.parameter.start), new Date(e.parameter.end), {
        description: "Réservé par : " + e.parameter.email
      });
      return createResponse({result: "success", id: ev.getId()});
    }

    // 4. SUPPRESSION
    else if (action === 'delete') {
      const cal = CalendarApp.getCalendarById(CALENDAR_ID);
      const ev = cal.getEventById(e.parameter.id);
      if (ev && ev.getDescription().includes(e.parameter.email)) {
        ev.deleteEvent();
        return createResponse({result: "success"});
      }
      return createResponse({result: "error", message: "Non autorisé"});
    }

    return createResponse({result: "error", message: "Action non reconnue"});

  } catch (err) {
    return createResponse({result: "error", message: err.toString()});
  }
}

/**
 * Formate la réponse en JSON
 */
function createResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
