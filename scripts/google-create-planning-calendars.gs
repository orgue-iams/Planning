/**
 * Création en masse de calendriers secondaires pour le pool Planning IAMS.
 *
 * Utilisation :
 * 1. Aller sur https://script.google.com (compte Google du calendrier principal, ex. orgue.iams@…).
 * 2. Nouveau projet → coller ce fichier → enregistrer.
 * 3. Menu Exécuter → createPlanningSecondaryCalendars → autoriser les accès Agenda.
 * 4. Voir le journal (Affichage → Journaux) et/ou la feuille créée : colonne google_calendar_id
 *    à recopier dans l’admin Planning (pool) ou en SQL INSERT sur google_calendar_pool.
 *
 * Ne pas lancer deux fois sans garde-fou : des doublons de noms sont possibles (IDs différents).
 * Pour ajuster le nombre ou le préfixe, modifier COUNT et NAME_PREFIX ci-dessous.
 */

var COUNT = 60;
var NAME_PREFIX = 'Planning IAMS ';

function createPlanningSecondaryCalendars() {
  var rows = [];
  for (var i = 1; i <= COUNT; i++) {
    var suffix = ('00' + i).slice(-2);
    var name = NAME_PREFIX + suffix;
    var cal = CalendarApp.createCalendar(name, {
      timeZone: 'Europe/Paris'
    });
    var id = cal.getId();
    rows.push([name, id]);
    Logger.log(name + '\t' + id);
  }

  var ss = SpreadsheetApp.create('Planning IAMS — IDs calendriers secondaires ' + new Date().toISOString().slice(0, 10));
  var sh = ss.getActiveSheet();
  sh.getRange(1, 1, 1, 2).setValues([['label', 'google_calendar_id']]);
  sh.getRange(2, 1, rows.length + 1, 2).setValues(rows);
  sh.autoResizeColumns(1, 2);
  Logger.log('Feuille créée : ' + ss.getUrl());
}

/**
 * Optionnel : liste les calendriers dont le nom commence par NAME_PREFIX (vérification).
 */
function listPlanningCalendarsPrefix() {
  var cals = CalendarApp.getAllCalendars();
  var re = new RegExp('^' + NAME_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (var i = 0; i < cals.length; i++) {
    var c = cals[i];
    if (re.test(c.getName())) {
      Logger.log(c.getName() + '\t' + c.getId());
    }
  }
}
