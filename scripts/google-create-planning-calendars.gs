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
 *
 * Export pour la base Supabase :
 * Exécuter exportPlanningCalendarsToSheetAndCsv() → une feuille Google + un fichier CSV sur Drive
 * (colonnes label, google_calendar_id), calendriers dont vous êtes propriétaire et nom « Planning IAMS NN ».
 * Transmettre le CSV ou copier la feuille pour générer le script SQL seed du dépôt.
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

/**
 * Extrait le numéro final du nom « Planning IAMS 26 » → 26 ; sinon NaN.
 */
function planningIamsNameSuffixNumber_(name) {
  var re = new RegExp(
    '^' + NAME_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)\\s*$'
  );
  var m = String(name).match(re);
  return m ? parseInt(m[1], 10) : NaN;
}

function escapeCsvField_(s) {
  var t = String(s);
  if (/[",\n\r]/.test(t)) {
    return '"' + t.replace(/"/g, '""') + '"';
  }
  return t;
}

/**
 * Produit :
 * 1) Une feuille de calcul avec en-têtes label | google_calendar_id (tri par numéro IAMS).
 * 2) Un fichier CSV sur Mon Drive avec le même contenu (pratique à télécharger / envoyer).
 * Inclut uniquement les calendriers dont le compte courant est propriétaire et dont le nom
 * correspond à « Planning IAMS » + un ou plusieurs chiffres (espaces en fin ignorés).
 */
function exportPlanningCalendarsToSheetAndCsv() {
  var cals = CalendarApp.getAllCalendars();
  var pairs = [];
  for (var i = 0; i < cals.length; i++) {
    var c = cals[i];
    if (!c.isOwnedByMe()) {
      continue;
    }
    var name = String(c.getName()).replace(/\s+$/, '');
    var n = planningIamsNameSuffixNumber_(name);
    if (!isNaN(n)) {
      pairs.push({ n: n, name: name, id: c.getId() });
    }
  }
  pairs.sort(function (a, b) {
    return a.n - b.n;
  });

  var rows = [['label', 'google_calendar_id']];
  for (var j = 0; j < pairs.length; j++) {
    rows.push([pairs[j].name, pairs[j].id]);
  }

  var stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  var title = 'Planning IAMS — export calendriers ' + stamp;

  var ss = SpreadsheetApp.create(title);
  var sh = ss.getActiveSheet();
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.autoResizeColumns(1, 2);
  Logger.log('Feuille : ' + ss.getUrl());

  var lines = [];
  for (var k = 0; k < rows.length; k++) {
    lines.push(
      escapeCsvField_(rows[k][0]) + ',' + escapeCsvField_(rows[k][1])
    );
  }
  var csv = lines.join('\r\n');
  var fileName = 'planning-iams-calendars-export-' + new Date().toISOString().slice(0, 10) + '.csv';
  var file = DriveApp.createFile(fileName, csv, MimeType.CSV);
  Logger.log('CSV Drive : ' + file.getUrl());

  return { sheetUrl: ss.getUrl(), csvUrl: file.getUrl(), count: pairs.length };
}
