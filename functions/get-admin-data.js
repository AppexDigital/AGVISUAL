// functions/get-admin-data.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { validateGoogleToken } = require('./google-auth-helper');

exports.handler = async (event, context) => {
  const headers = { 'Content-Type': 'application/json' };

  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado.' }) };
  }

  try {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();

    // AJUSTE: Se añaden las nuevas hojas al default para pruebas o cargas completas
    let requestedSheets = event.queryStringParameters.sheets ? event.queryStringParameters.sheets.split(',') : ['Projects', 'ProjectImages', 'Bookings', 'Identidad', 'About', 'LogosClientes', 'ImagenesIdentidad'];
    const adminData = {};

    const promises = requestedSheets.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) return { title, data: [] };
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            
            // Convertimos filas a objetos simples (incluyendo imageUrl del excel)
            const headerValues = sheet.headerValues;
            const rowData = rows.map(row => {
                const obj = {};
                headerValues.forEach(h => {
                    obj[h] = row.get(h) || '';
                    obj[h.toLowerCase().trim()] = obj[h];
                });
                return obj;
            });
            return { title, data: rowData };
        } catch (e) { return { title, data: [] }; }
    });

    const results = await Promise.all(promises);
    results.forEach(res => adminData[res.title] = res.data);

    return { statusCode: 200, headers, body: JSON.stringify(adminData) };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
