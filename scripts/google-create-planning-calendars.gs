/**
 * Création en masse de calendriers secondaires pour le pool Planning IAMS.
 *
 * Limite pratique Google : la création peut s’arrêter / être bloquée après ~25–30 calendriers
 * en une seule exécution. Utilisez plusieurs passes en changeant START_NUM / END_NUM.
 *
 * --- Partage public (lecture) ---
 * Pour « Rendre accessible au public » (voir tous les détails des événements, lien d’intégration),
 * ce script utilise l’API Calendar avancée (ACL). Dans script.google.com : Services (puzzle) →
 * « Google Calendar API » → Activer. Sans cela, les fonctions insertPublicReaderAcl_ échouent.
 *
 * Utilisation :
 * 1. https://script.google.com (compte Google propriétaire des calendriers, ex. orgue.iams@…).
 * 2. Nouveau projet → coller ce fichier → activer le service avancé Google Calendar API.
 * 3. Exécuter UNE fois : runOnce_CreatePlanning28to47_PublicAndPoolSql()
 *    (crée Planning IAMS 28–47 s’ils n’existent pas, rend TOUS les « Planning IAMS NN » publics
 *    en lecture, journalise le SQL + fichier Drive pour Supabase).
 * 4. Copier le SQL depuis les journaux ou le fichier Drive → coller dans le dépôt ou exécuter via
 *    `npx supabase db query --linked -f …` sur la machine de dev.
 *
 * Vérification : listPlanningCalendarsPrefix() journalise les agendas dont le nom commence par NAME_PREFIX.
 *
 * Export global : exportPlanningCalendarsToSheetAndCsv() → feuille + CSV (tous les IAMS possédés).
 */

/** Premier numéro de la plage (inclus). */
var START_NUM = 1;

/** Dernier numéro de la plage (inclus). */
var END_NUM = 26;

var NAME_PREFIX = 'Planning IAMS ';

/** Pause entre deux créations (ms) pour limiter le throttling ; 0 pour désactiver. */
var SLEEP_MS_BETWEEN = 500;

/**
 * Après chaque création dans createPlanningSecondaryCalendars(), tenter ACL public (lecteur).
 * Nécessite le service avancé Google Calendar API.
 */
var CREATE_PUBLIC_ACL_AFTER_EACH = true;

/**
 * Nom du calendrier pour le numéro n (ex. 3 → Planning IAMS 03).
 */
function planningCalendarNameForNumber_(n) {
  var suffix = n < 100 ? ('00' + n).slice(-2) : String(n);
  return NAME_PREFIX + suffix;
}

/**
 * Retourne le calendrier déjà existant et possédé avec ce nom exact, sinon null.
 */
function findOwnedPlanningCalendarByNumber_(n) {
  var expectedName = planningCalendarNameForNumber_(n);
  var cals = CalendarApp.getAllCalendars();
  for (var i = 0; i < cals.length; i++) {
    var c = cals[i];
    if (!c.isOwnedByMe()) {
      continue;
    }
    if (String(c.getName()).replace(/\s+$/, '') === expectedName) {
      return c;
    }
  }
  return null;
}

/**
 * ACL « public » en lecture (équivalent réglage Agenda : disponible pour le public).
 * @see https://developers.google.com/calendar/api/v3/reference/acl/insert
 */
function insertPublicReaderAcl_(calendarId, labelForLog) {
  try {
    Calendar.Acl.insert(
      {
        role: 'reader',
        scope: { type: 'default' }
      },
      calendarId
    );
    Logger.log('[ACL public] OK : ' + labelForLog);
  } catch (e) {
    Logger.log('[ACL public] ' + labelForLog + ' : ' + e);
  }
}

/**
 * Tous les calendriers possédés dont le nom est « Planning IAMS » + chiffres → partage public lecteur.
 * À lancer après création d’un lot ou pour corriger les anciens (01–27, etc.).
 */
function makeAllPlanningIamsCalendarsPublicReader() {
  var cals = CalendarApp.getAllCalendars();
  for (var i = 0; i < cals.length; i++) {
    var c = cals[i];
    if (!c.isOwnedByMe()) {
      continue;
    }
    var name = String(c.getName()).replace(/\s+$/, '');
    var n = planningIamsNameSuffixNumber_(name);
    if (isNaN(n)) {
      continue;
    }
    insertPublicReaderAcl_(c.getId(), name);
  }
}

function createPlanningSecondaryCalendars() {
  if (END_NUM < START_NUM) {
    throw new Error('END_NUM doit être >= START_NUM');
  }
  var rows = [];
  for (var i = START_NUM; i <= END_NUM; i++) {
    var name = planningCalendarNameForNumber_(i);
    var cal = findOwnedPlanningCalendarByNumber_(i);
    if (cal) {
      Logger.log('Existe déjà (skip création) : ' + name + '\t' + cal.getId());
    } else {
      cal = CalendarApp.createCalendar(name, {
        timeZone: 'Europe/Paris'
      });
      Logger.log('Créé : ' + name + '\t' + cal.getId());
    }
    var id = cal.getId();
    rows.push([name, id]);
    if (CREATE_PUBLIC_ACL_AFTER_EACH) {
      insertPublicReaderAcl_(id, name);
    }
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

function escapeSqlString_(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Génère le SQL d’insertion pool pour une plage de numéros IAMS (calendriers déjà créés).
 * Copier depuis l’onglet Exécution → Journal.
 */
function logSqlInsertsPlanningIamsRange(startN, endN) {
  var cals = CalendarApp.getAllCalendars();
  var pairs = [];
  for (var i = 0; i < cals.length; i++) {
    var c = cals[i];
    if (!c.isOwnedByMe()) {
      continue;
    }
    var name = String(c.getName()).replace(/\s+$/, '');
    var n = planningIamsNameSuffixNumber_(name);
    if (!isNaN(n) && n >= startN && n <= endN) {
      pairs.push({ n: n, name: name, id: c.getId() });
    }
  }
  pairs.sort(function (a, b) {
    return a.n - b.n;
  });
  if (pairs.length === 0) {
    Logger.log('Aucun calendrier IAMS dans la plage ' + startN + '–' + endN);
    return;
  }
  var lines = [];
  for (var j = 0; j < pairs.length; j++) {
    var p = pairs[j];
    lines.push(
      "    ('" +
        escapeSqlString_(p.id) +
        "', '" +
        escapeSqlString_(p.name) +
        "', " +
        p.n +
        ')'
    );
  }
  var sql =
    'insert into public.google_calendar_pool (google_calendar_id, label, sort_order)\nvalues\n' +
    lines.join(',\n') +
    '\non conflict (google_calendar_id) do nothing;\n\nselect public.planning_backfill_unassigned_calendars();\n';
  Logger.log(sql);
}

/**
 * Même SQL que logSqlInsertsPlanningIamsRange, enregistré sur Drive (plus pratique à récupérer).
 */
function savePoolSqlInsertsToDrive(startN, endN) {
  var cals = CalendarApp.getAllCalendars();
  var pairs = [];
  for (var i = 0; i < cals.length; i++) {
    var c = cals[i];
    if (!c.isOwnedByMe()) {
      continue;
    }
    var name = String(c.getName()).replace(/\s+$/, '');
    var n = planningIamsNameSuffixNumber_(name);
    if (!isNaN(n) && n >= startN && n <= endN) {
      pairs.push({ n: n, name: name, id: c.getId() });
    }
  }
  pairs.sort(function (a, b) {
    return a.n - b.n;
  });
  if (pairs.length === 0) {
    Logger.log('savePoolSqlInsertsToDrive : aucune ligne pour ' + startN + '–' + endN);
    return;
  }
  var lines = [];
  for (var j = 0; j < pairs.length; j++) {
    var p = pairs[j];
    lines.push(
      "    ('" +
        escapeSqlString_(p.id) +
        "', '" +
        escapeSqlString_(p.name) +
        "', " +
        p.n +
        ')'
    );
  }
  var sql =
    'insert into public.google_calendar_pool (google_calendar_id, label, sort_order)\nvalues\n' +
    lines.join(',\n') +
    '\non conflict (google_calendar_id) do nothing;\n\nselect public.planning_backfill_unassigned_calendars();\n';
  var fileName =
    'planning-pool-insert-' +
    startN +
    '-' +
    endN +
    '-' +
    new Date().toISOString().slice(0, 10) +
    '.sql';
  var file = DriveApp.createFile(fileName, sql, MimeType.PLAIN_TEXT);
  Logger.log('Fichier SQL Drive : ' + file.getUrl());
}

/**
 * À exécuter une fois sur le compte Google propriétaire :
 * 1) Crée Planning IAMS 28 … 47 s’ils n’existent pas encore.
 * 2) Rend publics en lecture TOUS les calendriers « Planning IAMS NN » possédés (y compris 01–27).
 * 3) Journalise le SQL pool pour 28–47 + fichier .sql sur Drive.
 */
function runOnce_CreatePlanning28to47_PublicAndPoolSql() {
  var prevStart = START_NUM;
  var prevEnd = END_NUM;
  START_NUM = 28;
  END_NUM = 47;
  try {
    createPlanningSecondaryCalendars();
    makeAllPlanningIamsCalendarsPublicReader();
    logSqlInsertsPlanningIamsRange(28, 47);
    savePoolSqlInsertsToDrive(28, 47);
  } finally {
    START_NUM = prevStart;
    END_NUM = prevEnd;
  }
}

/**
 * Uniquement rendre publics tous les calendriers Planning IAMS (sans création).
 * Utile si la création 28–47 est déjà faite mais pas l’ACL.
 */
function runOnce_OnlyMakeAllPlanningIamsPublicReader() {
  makeAllPlanningIamsCalendarsPublicReader();
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
