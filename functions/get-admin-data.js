// functions/get-admin-data.js
// v9.0 - ARQUITECTURA ESCALABLE (Carga Selectiva Real)
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
      // Copia normalizada para búsquedas fáciles
      obj[header.toLowerCase().trim()] = val;
    });
    obj._rawId = row.rowIndex; 
    return obj;
  });
}

exports.handler = async (event, context) => {
  // 1. Seguridad
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  }

  try {
    const doc = await getDoc();
    
    // 2. IDENTIFICAR QUÉ HOJAS SE NECESITAN
    // Si el frontend no especifica sheets, cargamos solo Dashboard (ligero)
    let requestedSheets = [];
    if (event.queryStringParameters && event.queryStringParameters.sheets) {
        requestedSheets = event.queryStringParameters.sheets.split(',');
    } else {
        // Carga por defecto (Dashboard)
        requestedSheets = ['Projects', 'ProjectImages', 'Bookings']; 
    }

    const adminData = {};

    // 3. CARGA PARALELA CONTROLADA (Solo de lo solicitado)
    // Al ser pocas hojas (2 o 3), podemos usar Promise.all sin saturar la cuota
    const promises = requestedSheets.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) return { title, data: [] };
            
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            return { title, data: rowsToObjects(sheet, rows) };
        } catch (e) {
            console.warn(`Error cargando hoja ${title}: ${e.message}`);
            return { title, data: [] };
        }
    });

    const results = await Promise.all(promises);

    results.forEach(res => {
        adminData[res.title] = res.data;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminData),
    };

  } catch (error) {
    console.error('Data Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
