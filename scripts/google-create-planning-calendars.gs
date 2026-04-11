/**
 * Création en masse de calendriers secondaires pour le pool Planning IAMS.
 *
 * Limite pratique Google : la création peut s’arrêter / être bloquée après ~25–30 calendriers
 * en une seule exécution. Utilisez plusieurs passes en changeant START_NUM / END_NUM (ex. 1–26,
 * puis plus tard 27–60). Attendre quelques heures entre les passes si besoin.
 *
 * Utilisation :
 * 1. https://script.google.com (compte Google propriétaire des calendriers).
 * 2. Nouveau projet → coller ce fichier → enregistrer.
 * 3. Ajuster START_NUM, END_NUM (et optionnellement SLEEP_MS_BETWEEN) puis Exécuter
 *    createPlanningSecondaryCalendars → autoriser l’accès Agenda.
 * 4. Journaux + feuille créée : colonne google_calendar_id → pool admin Planning ou SQL.
 *
 * Vérification : listPlanningCalendarsPrefix() journalise les agendas dont le nom commence par NAME_PREFIX.
 */

/** Premier numéro de la plage (inclus), ex. 1 puis 27 après un premier lot. */
var START_NUM = 1;

/** Dernier numéro de la plage (inclus). Premier lot ~26 ; plus tard 60 pour aller jusqu’à « Planning IAMS 60 ». */
var END_NUM = 26;

var NAME_PREFIX = 'Planning IAMS ';

/** Pause entre deux créations (ms) pour limiter le throttling ; 0 pour désactiver. */
var SLEEP_MS_BETWEEN = 500;

function createPlanningSecondaryCalendars() {
  if (END_NUM < START_NUM) {
    throw new Error('END_NUM doit être >= START_NUM');
  }
  var rows = [];
  for (var i = START_NUM; i <= END_NUM; i++) {
    var suffix = i < 100 ? ('00' + i).slice(-2) : String(i);
    var name = NAME_PREFIX + suffix;
    var cal = CalendarApp.createCalendar(name, {
      timeZone: 'Europe/Paris'
    });
    var id = cal.getId();
    rows.push([name, id]);
    Logger.log(name + '\t' + id);
    if (SLEEP_MS_BETWEEN > 0 && i < END_NUM) {
      Utilities.sleep(SLEEP_MS_BETWEEN);
    }
  }

  var stamp =
    new Date().toISOString().slice(0, 10) +
    ' n' +
    START_NUM +
    '-' +
    END_NUM;
  var ss = SpreadsheetApp.create('Planning IAMS — IDs calendriers ' + stamp);
  var sh = ss.getActiveSheet();
  sh.getRange(1, 1, 1, 2).setValues([['label', 'google_calendar_id']]);
  sh.getRange(2, 1, rows.length + 1, 2).setValues(rows);
  sh.autoResizeColumns(1, 2);
  Logger.log('Feuille créée : ' + ss.getUrl());
}

/**
 * Liste les calendriers dont le nom commence par NAME_PREFIX (vérification).
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
