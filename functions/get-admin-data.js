// functions/get-admin-data.js
// v4.0 - LECTURA SEGURA DE ENCABEZADOS (Fix Carga Infinita)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { validateGoogleToken } = require('./google-auth-helper');

// Helper seguro para convertir filas a objetos
function rowsToObjects(rows, headers) {
  if (!rows || rows.length === 0) return [];
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      // Usamos row.get() de forma segura
      const val = row.get(header);
      obj[header] = (val !== undefined && val !== null) ? val : '';
    });
    return obj;
  });
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    const sheetTitles = [
      'Settings', 'About', 'Videos', 'ClientLogos',
      'Projects', 'ProjectImages',
      'Services', 'ServiceContentBlocks', 'ServiceImages',
      'RentalCategories', 'RentalItems', 'RentalItemImages',
      'Bookings', 'BlockedDates'
    ];

    // Lectura Paralela Segura
    const sheetPromises = sheetTitles.map(async (title) => {
      try {
        const sheet = doc.sheetsByTitle[title];
        if (!sheet) return { title, data: [] };
        
        // 1. Cargar encabezados explícitamente
        await sheet.loadHeaderRow(); 
        const headers = sheet.headerValues; // Obtener headers oficiales
        
        // 2. Obtener filas
        const rows = await sheet.getRows();
        
        // 3. Convertir pasando los headers (evita el error de _sheet)
        return { title, data: rowsToObjects(rows, headers) };
      } catch (e) {
        console.warn(`Error leyendo hoja ${title}:`, e.message);
        return { title, data: [] }; 
      }
    });

    const results = await Promise.all(sheetPromises);

    const adminData = results.reduce((acc, res) => {
      acc[res.title] = res.data;
      return acc;
    }, {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminData),
    };

  } catch (error) {
    console.error('Fatal Admin Data Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error crítico cargando datos.', details: error.message }),
    };
  }
};
