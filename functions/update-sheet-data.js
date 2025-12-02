// functions/update-sheet-data.js
// v28.0 - ESCRITURA EN MASA REAL (Batch Update)
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
    const operations = Array.isArray(body) ? body : [body];
    const { doc, drive } = await getServices();

    // Agrupar operaciones por hoja para optimizar carga
    const opsBySheet = {};
    operations.forEach(op => {
        if (!opsBySheet[op.sheet]) opsBySheet[op.sheet] = [];
        opsBySheet[op.sheet].push(op);
    });

    for (const sheetName of Object.keys(opsBySheet)) {
        const sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) continue;
        
        await sheet.loadHeaderRow();
        const sheetOps = opsBySheet[sheetName];
        
        // Separar ADD, UPDATE y DELETE
        const adds = sheetOps.filter(op => op.action === 'add');
        const updates = sheetOps.filter(op => op.action === 'update');
        const deletes = sheetOps.filter(op => op.action === 'delete');

        // 1. PROCESAR ADDS (Uno por uno es seguro, no suelen ser masivos)
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            // Mapeo de columnas seguro
            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = findRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            await sheet.addRow(rowData);
        }

        // 2. PROCESAR UPDATES (MASIVO / BATCH REAL)
        if (updates.length > 0) {
            const rows = await sheet.getRows(); // Carga una sola vez
            let hasChanges = false;

            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const realKey = findRealHeader(sheet, criteriaKey);
                if (!realKey) continue;

                // Buscar fila en memoria
                const row = rows.find(r => String(r.get(realKey)).trim() === String(op.criteria[criteriaKey]).trim());
                
                if (row) {
                    // Aplicar cambios en memoria local de la fila
                    Object.keys(op.data).forEach(key => {
                        const header = findRealHeader(sheet, key);
                        if (header) {
                            const newVal = op.data[key];
                            if (row.get(header) !== newVal) {
                                row.set(header, newVal); // Esto solo marca la celda como "dirty"
                                hasChanges = true;
                            }
                        }
                    });
                } else if (['Settings', 'About'].includes(sheetName)) {
                    // Upsert para config
                     await sheet.addRow({ ...op.criteria, ...op.data });
                }
            }

            // GUARDADO ATÓMICO: Si hubo cambios, guardar todas las filas modificadas de una sola vez
            if (hasChanges) {
                await sheet.saveUpdatedCells(); // ESTA ES LA MAGIA QUE EVITA EL ERROR 429
            }
        }

        // 3. PROCESAR DELETES
        if (deletes.length > 0) {
            // Recargamos filas por si los updates cambiaron algo, aunque para deletes es mejor ser precisos
            const rows = await sheet.getRows(); 
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const realKey = findRealHeader(sheet, criteriaKey);
                if (!realKey) continue;
                
                const row = rows.find(r => String(r.get(realKey)).trim() === String(op.criteria[criteriaKey]).trim());
                if (row) {
                    // Borrar archivo de drive si existe
                    if (row.get('fileId')) {
                        try { await drive.files.update({ fileId: row.get('fileId'), requestBody: { trashed: true } }); } catch(e){}
                    }
                    await row.delete(); // Delete sigue siendo 1 por 1, pero suelen ser pocos
                }
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Lote procesado' }) };

  } catch (error) {
    console.error('Batch Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
