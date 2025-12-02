// functions/update-sheet-data.js
// v27.0 - OPERACIONES POR LOTES (BATCH)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return { doc, drive: google.drive({ version: 'v3', auth }) };
}

function findRealHeader(sheet, targetName) {
    const headers = sheet.headerValues;
    const target = targetName.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    // Aceptamos una sola operación o un array de operaciones ("batch")
    const operations = Array.isArray(body) ? body : [body];
    
    const { doc, drive } = await getServices();
    
    // Procesamos en serie para no saturar, pero en una sola ejecución de Lambda
    for (const op of operations) {
        const { sheet: sheetTitle, action, data, criteria } = op;
        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) continue; 

        await sheet.loadHeaderRow();

        if (action === 'add') {
            if (!data.id && !['Settings', 'About'].includes(sheetTitle)) {
                 data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            }
            const rowData = {};
            Object.keys(data).forEach(k => {
                const realHeader = findRealHeader(sheet, k);
                if (realHeader) rowData[realHeader] = data[k];
            });
            await sheet.addRow(rowData);
        } 
        
        else if (action === 'update') {
            const rows = await sheet.getRows();
            const criteriaKey = Object.keys(criteria)[0];
            const realKey = findRealHeader(sheet, criteriaKey);
            if (!realKey) continue;

            const row = rows.find(r => String(r.get(realKey)).trim() === String(criteria[criteriaKey]).trim());
            
            // Upsert para Settings/About
            if (!row && ['Settings', 'About'].includes(sheetTitle)) {
                await sheet.addRow({ ...criteria, ...data });
                continue;
            }

            if (row) {
                Object.keys(data).forEach(key => { 
                    const h = findRealHeader(sheet, key);
                    if (h) row.set(h, data[key]);
                });
                await row.save(); // Guarda fila individual
            }
        }
        
        else if (action === 'delete') {
            const rows = await sheet.getRows();
            const criteriaKey = Object.keys(criteria)[0];
            const realKey = findRealHeader(sheet, criteriaKey);
            if(!realKey) continue;

            const row = rows.find(r => String(r.get(realKey)).trim() === String(criteria[criteriaKey]).trim());
            
            if (row) {
                // Lógica de borrado de archivos (simplificada para batch)
                // En operaciones masivas, es mejor borrar el archivo primero si se tiene el ID a mano
                if (row.get('fileId')) {
                    try { await drive.files.update({ fileId: row.get('fileId'), requestBody: { trashed: true } }); } catch(e){}
                }
                await row.delete();
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Lote procesado' }) };

  } catch (error) {
    console.error('Batch Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
