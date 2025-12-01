// functions/get-admin-data.js
// v6.0 - ROBUSTEZ TOTAL (Tolerancia a fallos parciales)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { validateGoogleToken } = require('./google-auth-helper');

async function getDoc() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

function rowsToObjects(sheet, rows) {
  if (!rows || rows.length === 0) return [];
  const headers = sheet.headerValues || [];
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      let val = row.get(header);
      if (val === undefined || val === null) val = '';
      obj[header] = val;
      // Copia normalizada para búsquedas fáciles (ej: obj['projectid'])
      obj[header.toLowerCase().trim()] = val;
    });
    obj._rawId = row.rowIndex;
    return obj;
  });
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  }

  try {
    const doc = await getDoc();
    const sheetTitles = [
      'Settings', 'About', 'Videos', 'ClientLogos', 'Projects', 'ProjectImages',
      'Services', 'ServiceContentBlocks', 'ServiceImages',
      'RentalCategories', 'RentalItems', 'RentalItemImages',
      'Bookings', 'BlockedDates'
    ];

    // Usamos map para procesar en paralelo, pero con captura de errores individual
    const results = await Promise.all(sheetTitles.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) {
                console.warn(`Hoja no encontrada: ${title}`);
                return { title, data: [] };
            }
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            return { title, data: rowsToObjects(sheet, rows) };
        } catch (innerError) {
            console.error(`Error leyendo hoja ${title}:`, innerError.message);
            // Si una hoja falla, devolvemos array vacío en lugar de romper todo el sistema
            return { title, data: [] };
        }
    }));

    const adminData = results.reduce((acc, item) => {
      acc[item.title] = item.data;
      return acc;
    }, {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminData),
    };

  } catch (error) {
    console.error('Error fatal en get-admin-data:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
