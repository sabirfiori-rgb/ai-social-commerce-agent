/**
 * AI Social Commerce Agent — container-bound Apps Script.
 *
 * This script turns the Google Sheet into a control surface for the backend
 * Node service: it lets an operator add products, mark rows for
 * (re)processing, ping the backend to poll immediately, and keeps the sheet
 * tabs/headers/validation in good shape.
 *
 * No external libraries are used — only Apps Script built-in services
 * (SpreadsheetApp, HtmlService, PropertiesService, UrlFetchApp, Utilities,
 * ScriptApp).
 */

// ---------------------------------------------------------------------------
// Constants — sheet names, headers, and script property keys.
// Keep these in sync with the backend's domain/sheet-schema.
// ---------------------------------------------------------------------------

var SHEET_NAMES = {
  PRODUCTS: 'Products',
  BRAND_SETTINGS: 'Brand Settings',
  PUBLISHING_SCHEDULE: 'Publishing Schedule',
  GENERATED_CONTENT: 'Generated Content',
  LOGS: 'Logs',
  ANALYTICS: 'Analytics'
};

var PRODUCTS_HEADERS = [
  'ID',
  'Status',
  'Product Source',
  'Product URL',
  'Product ID',
  'Brand',
  'Platform',
  'Language',
  'Category',
  'Schedule Date',
  'Schedule Time',
  'Generated Caption',
  'Generated Video',
  'Published URL',
  'Error',
  'Created Time',
  'Updated Time'
];

var BRAND_SETTINGS_HEADERS = [
  'Brand',
  'Primary Color',
  'Accent Color',
  'Text Color',
  'Font',
  'Logo URL',
  'Watermark',
  'CTA',
  'Language'
];

var PUBLISHING_SCHEDULE_HEADERS = [
  'ID',
  'Product ID',
  'Platform',
  'Scheduled At',
  'Status',
  'Published At',
  'Permalink',
  'Error'
];

var GENERATED_CONTENT_HEADERS = [
  'ID',
  'Product ID',
  'Platform',
  'Tone',
  'Caption',
  'Hashtags',
  'Hooks',
  'CTAs',
  'Created At'
];

var LOGS_HEADERS = ['Time', 'Level', 'Product ID', 'Job ID', 'Stage', 'Message', 'Data'];

var ANALYTICS_HEADERS = [
  'Date',
  'Products Processed',
  'Posts Published',
  'Videos Created',
  'Queue Size',
  'Failed Jobs',
  'Success Rate',
  'Avg Processing Ms'
];

/** All known statuses for the Products.Status column, in pipeline order. */
var PRODUCT_STATUSES = [
  'NEW',
  'PROCESSING',
  'PRODUCT_IMPORTED',
  'CONTENT_CREATED',
  'VIDEO_CREATED',
  'POSTED',
  'FAILED'
];

/** Script property keys used to store backend connection details. */
var PROP_BACKEND_URL = 'BACKEND_URL';
var PROP_BACKEND_TOKEN = 'BACKEND_TOKEN';

/** Name used for the time-based polling trigger so it can be found/removed safely. */
var TRIGGER_HANDLER = 'triggerProcessingNow';

// ---------------------------------------------------------------------------
// Lifecycle / menu
// ---------------------------------------------------------------------------

/**
 * Runs automatically when the spreadsheet is opened. Builds the custom menu.
 * @param {GoogleAppsScript.Events.SheetsOnOpen} e
 */
function onOpen(e) {
  try {
    SpreadsheetApp.getUi()
      .createMenu('AI Agent')
      .addItem('Add Product…', 'showAddProductSidebar')
      .addItem('Mark Selected as NEW', 'markSelectedAsNew')
      .addItem('Trigger Processing Now', 'triggerProcessingNow')
      .addSeparator()
      .addItem('Set Backend URL…', 'setBackendUrl')
      .addItem('Initialize Sheet Tabs', 'initializeSheetTabs')
      .addToUi();
  } catch (err) {
    // onOpen must never throw — a broken menu should not block opening the sheet.
    console.error('onOpen failed: ' + describeError(err));
  }
}

/**
 * Opens the "Add Product" sidebar (Sidebar.html).
 */
function showAddProductSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Add Product')
    .setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

// ---------------------------------------------------------------------------
// Product operations
// ---------------------------------------------------------------------------

/**
 * Appends a new row to the Products tab from the sidebar form payload.
 *
 * @param {Object} form Plain object from the client with keys:
 *   source, url, productId, brand, platform, language, category,
 *   scheduleDate, scheduleTime. `platform` may be an array (multi-select) or
 *   a comma-separated string; it is normalized to a comma-separated string.
 * @return {{rowNumber: number, id: string}} the new row number (1-based) and generated ID.
 */
function addProduct(form) {
  if (!form || typeof form !== 'object') {
    throw new Error('addProduct: form payload is required');
  }

  var sheet = getOrCreateSheet_(SHEET_NAMES.PRODUCTS, PRODUCTS_HEADERS);
  var now = nowIso_();
  var id = generateId_();

  var platform = form.platform;
  if (Array.isArray(platform)) {
    platform = platform.filter(Boolean).join(', ');
  } else {
    platform = (platform || '').toString();
  }

  var row = [
    id, // ID
    'NEW', // Status
    (form.source || 'manual').toString().trim(), // Product Source
    (form.url || '').toString(), // Product URL
    (form.productId || '').toString().trim(), // Product ID
    (form.brand || '').toString().trim(), // Brand
    platform, // Platform
    (form.language || '').toString().trim(), // Language
    (form.category || '').toString().trim(), // Category
    (form.scheduleDate || '').toString().trim(), // Schedule Date
    (form.scheduleTime || '').toString().trim(), // Schedule Time
    '', // Generated Caption
    '', // Generated Video
    '', // Published URL
    '', // Error
    now, // Created Time
    now // Updated Time
  ];

  sheet.appendRow(row);
  var rowNumber = sheet.getLastRow();

  // Re-apply the Status dropdown to the new row in case data validation
  // rules do not automatically extend to appended rows.
  applyStatusValidation_(sheet, rowNumber, rowNumber);

  return { rowNumber: rowNumber, id: id };
}

/**
 * Sets Status = NEW for every selected row in the active sheet (Products tab
 * only). Supports multi-row and multi-range selections. Skips the header row.
 */
function markSelectedAsNew() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();

  if (sheet.getName() !== SHEET_NAMES.PRODUCTS) {
    ui.alert('Please select row(s) on the "' + SHEET_NAMES.PRODUCTS + '" tab first.');
    return;
  }

  var statusCol = PRODUCTS_HEADERS.indexOf('Status') + 1;
  var ranges = sheet.getActiveRangeList
    ? (sheet.getActiveRangeList() ? sheet.getActiveRangeList().getRanges() : null)
    : null;
  if (!ranges || ranges.length === 0) {
    var single = sheet.getActiveRange();
    ranges = single ? [single] : [];
  }

  if (ranges.length === 0) {
    ui.alert('No rows selected.');
    return;
  }

  var updatedRows = 0;
  var nowValue = nowIso_();

  for (var r = 0; r < ranges.length; r++) {
    var range = ranges[r];
    var startRow = range.getRow();
    var numRows = range.getNumRows();

    for (var i = 0; i < numRows; i++) {
      var rowNumber = startRow + i;
      if (rowNumber <= 1) continue; // never touch the header row
      if (rowNumber > sheet.getLastRow()) continue;

      sheet.getRange(rowNumber, statusCol).setValue('NEW');
      var updatedCol = PRODUCTS_HEADERS.indexOf('Updated Time') + 1;
      if (updatedCol > 0) {
        sheet.getRange(rowNumber, updatedCol).setValue(nowValue);
      }
      updatedRows++;
    }
  }

  if (updatedRows === 0) {
    ui.alert('No product rows were updated (header row is not editable this way).');
  } else {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      updatedRows + ' row(s) marked as NEW.',
      'AI Agent',
      5
    );
  }
}

// ---------------------------------------------------------------------------
// Backend integration
// ---------------------------------------------------------------------------

/**
 * Pings the backend's immediate-poll webhook so it processes NEW rows right
 * away, instead of waiting for its own polling interval. Safe to call
 * repeatedly; failures are surfaced via toast rather than thrown, so menu
 * clicks never show a raw stack trace to the operator.
 */
function triggerProcessingNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var backendUrl = (props.getProperty(PROP_BACKEND_URL) || '').trim();

  if (!backendUrl) {
    ss.toast('No Backend URL configured. Use "AI Agent > Set Backend URL…" first.', 'AI Agent', 6);
    return;
  }

  var endpoint = joinUrl_(backendUrl, '/api/actions/run');
  var headers = { 'Content-Type': 'application/json' };
  var token = (props.getProperty(PROP_BACKEND_TOKEN) || '').trim();
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }

  var options = {
    method: 'post',
    headers: headers,
    payload: JSON.stringify({ source: 'apps-script', triggeredAt: nowIso_() }),
    muteHttpExceptions: true,
    followRedirects: true
  };

  try {
    var response = UrlFetchApp.fetch(endpoint, options);
    var code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      ss.toast('Backend accepted the request (HTTP ' + code + ').', 'AI Agent', 5);
    } else {
      var bodySnippet = safeSnippet_(response.getContentText());
      ss.toast('Backend responded with HTTP ' + code + '. ' + bodySnippet, 'AI Agent', 8);
    }
  } catch (err) {
    ss.toast('Could not reach backend: ' + describeError(err), 'AI Agent', 8);
  }
}

/**
 * Prompts the operator for the backend base URL (and optional shared-secret
 * token) and stores them as script properties for later use by
 * triggerProcessingNow().
 */
function setBackendUrl() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var currentUrl = props.getProperty(PROP_BACKEND_URL) || '';

  var urlResponse = ui.prompt(
    'Set Backend URL',
    'Enter the backend base URL (e.g. https://your-service.example.com).' +
      (currentUrl ? '\nCurrently set to: ' + currentUrl : ''),
    ui.ButtonSet.OK_CANCEL
  );

  if (urlResponse.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  var rawUrl = (urlResponse.getResponseText() || '').trim();
  if (!rawUrl) {
    ui.alert('Backend URL was empty — nothing was changed.');
    return;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    ui.alert('The URL must start with http:// or https://. Nothing was saved.');
    return;
  }

  // Normalize by stripping a trailing slash so joinUrl_ never double-slashes.
  var normalizedUrl = rawUrl.replace(/\/+$/, '');

  var tokenResponse = ui.prompt(
    'Backend Shared Secret (optional)',
    'Enter a bearer token for authenticating requests to the backend, or leave blank ' +
      'to send requests unauthenticated. This is stored privately in Script Properties.',
    ui.ButtonSet.OK_CANCEL
  );

  if (tokenResponse.getSelectedButton() !== ui.Button.OK) {
    // User cancelled the token step — still save the URL they already confirmed.
    props.setProperty(PROP_BACKEND_URL, normalizedUrl);
    ui.alert('Backend URL saved. Token step was cancelled, so no token was changed.');
    return;
  }

  var token = (tokenResponse.getResponseText() || '').trim();

  props.setProperty(PROP_BACKEND_URL, normalizedUrl);
  if (token) {
    props.setProperty(PROP_BACKEND_TOKEN, token);
  } else {
    props.deleteProperty(PROP_BACKEND_TOKEN);
  }

  ui.alert('Saved. Backend URL: ' + normalizedUrl + (token ? '\nToken: (stored)' : '\nToken: (none)'));
}

// ---------------------------------------------------------------------------
// Sheet initialization
// ---------------------------------------------------------------------------

/**
 * Ensures every expected tab exists with the correct header row, freezes the
 * header row on each, and applies a dropdown data-validation rule to the
 * Products.Status column. Safe to run multiple times — it only creates what
 * is missing and never deletes or reorders existing data.
 */
function initializeSheetTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  getOrCreateSheet_(SHEET_NAMES.PRODUCTS, PRODUCTS_HEADERS);
  getOrCreateSheet_(SHEET_NAMES.BRAND_SETTINGS, BRAND_SETTINGS_HEADERS);
  getOrCreateSheet_(SHEET_NAMES.PUBLISHING_SCHEDULE, PUBLISHING_SCHEDULE_HEADERS);
  getOrCreateSheet_(SHEET_NAMES.GENERATED_CONTENT, GENERATED_CONTENT_HEADERS);
  getOrCreateSheet_(SHEET_NAMES.LOGS, LOGS_HEADERS);
  getOrCreateSheet_(SHEET_NAMES.ANALYTICS, ANALYTICS_HEADERS);

  var productsSheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  var lastRow = Math.max(productsSheet.getLastRow(), 2);
  applyStatusValidation_(productsSheet, 2, Math.max(lastRow, 1000));

  SpreadsheetApp.getActiveSpreadsheet().toast('Sheet tabs are initialized and up to date.', 'AI Agent', 5);
}

/**
 * Returns the sheet with the given name, creating it (with a header row) if
 * it does not already exist. If it exists but has no header row (row 1 is
 * blank), the header row is written. Existing headers are never overwritten,
 * so manual edits to header text are preserved.
 *
 * @param {string} name
 * @param {string[]} headers
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  var existingHeaders = headerRange.getValues()[0];
  var hasAnyHeader = existingHeaders.some(function (v) {
    return v !== '' && v !== null && v !== undefined;
  });

  if (!hasAnyHeader) {
    headerRange.setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  if (sheet.getFrozenRows() < 1) {
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * Applies a dropdown (list) data-validation rule with the 7 canonical status
 * values to the Status column of the Products sheet, for the given row
 * range. Existing cell values outside the allowed list are left untouched
 * (validation flags them but does not clear them).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} startRow 1-based, should be >= 2 to avoid the header row.
 * @param {number} endRow 1-based, inclusive.
 */
function applyStatusValidation_(sheet, startRow, endRow) {
  if (sheet.getName() !== SHEET_NAMES.PRODUCTS) return;
  var firstRow = Math.max(startRow, 2);
  var lastRow = Math.max(endRow, firstRow);
  var statusCol = PRODUCTS_HEADERS.indexOf('Status') + 1;
  if (statusCol <= 0) return;

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(PRODUCT_STATUSES, true)
    .setAllowInvalid(true)
    .build();

  sheet.getRange(firstRow, statusCol, lastRow - firstRow + 1, 1).setDataValidation(rule);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/**
 * Installs a time-based trigger that calls triggerProcessingNow() every 5
 * minutes. This is a convenience nudge, independent of (and redundant with)
 * the backend's own polling loop — see README for how the two relate.
 * Removes any pre-existing trigger for the same handler first, so calling
 * this repeatedly never creates duplicates.
 */
function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(5).create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Installed a 5-minute trigger that pings the backend.',
    'AI Agent',
    5
  );
}

/**
 * Removes every trigger this script owns that targets triggerProcessingNow.
 * Safe to call even if none exist.
 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  if (removed > 0) {
    SpreadsheetApp.getActiveSpreadsheet().toast(removed + ' trigger(s) removed.', 'AI Agent', 4);
  }
}

// ---------------------------------------------------------------------------
// onEdit — lightweight, defensive default-status behavior
// ---------------------------------------------------------------------------

/**
 * Simple installable-free "onEdit" trigger (runs with the editor's own
 * authorization, no external calls). When a user finishes typing a value
 * into one of the core Products fields on a data row and that row's Status
 * cell is still blank, defaults Status to NEW so the row enters the queue.
 *
 * Deliberately conservative:
 *  - Only acts on the Products sheet.
 *  - Ignores the header row.
 *  - Ignores edits to the Status column itself (never overrides an explicit
 *    status the user just set, including clearing it back to blank).
 *  - Ignores multi-cell / paste-into-range edits where e.range spans more
 *    than one row, to avoid surprising bulk side effects; use the
 *    "Mark Selected as NEW" menu item for bulk changes instead.
 *  - Wrapped in try/catch so a malformed event object can never surface an
 *    error dialog to the end user.
 *
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;

    var sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAMES.PRODUCTS) return;

    var editedRow = e.range.getRow();
    if (editedRow <= 1) return; // header row

    if (e.range.getNumRows() > 1) return; // ignore bulk/paste edits

    var editedCol = e.range.getColumn();
    if (e.range.getNumColumns() > 1) return;

    var statusColIndex = PRODUCTS_HEADERS.indexOf('Status') + 1;
    if (editedCol === statusColIndex) return; // never fight the user's own status edit

    var coreFieldNames = [
      'Product Source',
      'Product URL',
      'Product ID',
      'Brand',
      'Platform',
      'Language',
      'Category',
      'Schedule Date',
      'Schedule Time'
    ];
    var editedHeader = PRODUCTS_HEADERS[editedCol - 1];
    if (coreFieldNames.indexOf(editedHeader) === -1) return;

    var newValue = e.range.getValue();
    if (newValue === '' || newValue === null || newValue === undefined) return;

    var statusCell = sheet.getRange(editedRow, statusColIndex);
    var currentStatus = statusCell.getValue();
    if (currentStatus === '' || currentStatus === null || currentStatus === undefined) {
      statusCell.setValue('NEW');

      var updatedColIndex = PRODUCTS_HEADERS.indexOf('Updated Time') + 1;
      if (updatedColIndex > 0) {
        sheet.getRange(editedRow, updatedColIndex).setValue(nowIso_());
      }

      var createdColIndex = PRODUCTS_HEADERS.indexOf('Created Time') + 1;
      if (createdColIndex > 0) {
        var createdCell = sheet.getRange(editedRow, createdColIndex);
        if (createdCell.getValue() === '' || createdCell.getValue() === null) {
          createdCell.setValue(nowIso_());
        }
      }
    }
  } catch (err) {
    // onEdit must never throw — a bad edit should never break the sheet UI.
    console.error('onEdit failed: ' + describeError(err));
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Generates a reasonably unique, sortable-ish row ID. Uses Utilities.getUuid()
 * for guaranteed uniqueness, prefixed with a millisecond timestamp encoded in
 * base36 so IDs are roughly chronologically sortable as plain text (a
 * lightweight ULID-style approach) without pulling in any external library.
 * @return {string}
 */
function generateId_() {
  var timePart = Date.now().toString(36).toUpperCase();
  var uuidPart = Utilities.getUuid().replace(/-/g, '').toUpperCase();
  return timePart + '-' + uuidPart.substring(0, 12);
}

/**
 * @return {string} current time as an ISO-8601 UTC string.
 */
function nowIso_() {
  return new Date().toISOString();
}

/**
 * Joins a base URL and a path without producing a double slash or losing the
 * separator, regardless of whether either side already has one.
 * @param {string} base
 * @param {string} path
 * @return {string}
 */
function joinUrl_(base, path) {
  var trimmedBase = (base || '').replace(/\/+$/, '');
  var trimmedPath = (path || '').replace(/^\/+/, '');
  return trimmedBase + '/' + trimmedPath;
}

/**
 * Truncates a possibly-large response body to a short human-readable snippet
 * for toasts, so a large HTML error page never floods the UI.
 * @param {string} text
 * @return {string}
 */
function safeSnippet_(text) {
  if (!text) return '';
  var oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? oneLine.substring(0, 160) + '…' : oneLine;
}

/**
 * Extracts a readable message from anything Apps Script might throw.
 * @param {*} err
 * @return {string}
 */
function describeError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}
