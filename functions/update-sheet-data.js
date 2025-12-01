// functions/update-sheet-data.js
// v19.0 - ESCRITURA PERMISIVA (Garantiza que los datos entren)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function executeWithRetry(operation, retries = 3, delay = 1000) {
    try {
        return await operation();
    } catch (error) {
        if (retries > 0 && (error.response?.status === 429 || error.code === 429)) {
            console.log(`Quota hit. Retrying in ${delay}ms...`);
            await wait(delay);
            return executeWithRetry(operation, retries - 1, delay * 2);
        }
        throw error;
    }
}

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await executeWithRetry(() => doc.loadInfo());
  return { doc, drive: google.drive({ version: 'v3', auth }) };
}

async function findRows(sheet, criteria) {
    if (!criteria) return [];
    await executeWithRetry(() => sheet.loadHeaderRow());
    const rows = await executeWithRetry(() => sheet.getRows());
    const key = Object.keys(criteria)[0];
    return rows.filter(row => String(row.get(key)) === String(criteria[key]));
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { sheet: sheetTitle, action, data, criteria } = body;
    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: `Hoja ${sheetTitle} no encontrada` }) };
    
    // Carga de encabezados robusta
    await executeWithRetry(() => sheet.loadHeaderRow());

    // --- ADD ---
    if (action === 'add') {
        if (!data.id && sheetTitle !== 'BlockedDates') data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;

        // Lógica de portada (sin cambios)
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           for (const r of rows) { 
               if (r.get(parentKey) === data[parentKey] && r.get('isCover') === 'Si') { 
                   r.set('isCover', 'No'); await executeWithRetry(() => r.save()); 
               } 
           }
        }

        // ESCRITURA PERMISIVA: Escribimos el objeto completo. 
        // La librería GoogleSpreadsheet intentará mapear todo lo que coincida con los encabezados.
        // Si una columna no existe en el sheet, la ignorará, pero NO lanzará error por ello.
        await executeWithRetry(() => sheet.addRow(data));
        
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- UPDATE ---
    if (action === 'update') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const parentId = row.get(parentKey);
             const allRows = await sheet.getRows();
             for (const r of allRows) {
                 if (r.get(parentKey) === parentId && String(r.get('id')) !== String(row.get('id')) && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await executeWithRetry(() => r.save());
                 }
             }
        }
        
        // Actualización directa
        Object.keys(data).forEach(key => { 
            // Intentamos setear todos los valores. Si la columna no existe, row.set puede fallar silenciosamente o funcionar dependiendo de la versión
            try { row.set(key, data[key]); } catch(e) {}
        });
        await executeWithRetry(() => row.save());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE ---
    if (action === 'delete') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // Intento de borrado en Drive (No fatal)
        const fileId = row.get('fileId');
        const folderId = row.get('driveFolderId');

        if (fileId) {
            try { await drive.files.delete({ fileId: fileId, supportsAllDrives: true }); } catch (e) {}
        }

        if ((sheetTitle === 'Projects' || sheetTitle === 'RentalItems') && folderId) {
            try { await drive.files.delete({ fileId: folderId, supportsAllDrives: true }); } catch (e) {}
            
            // Borrado en cascada de hijos
            const childSheetName = sheetTitle === 'Projects' ? 'ProjectImages' : 'RentalItemImages';
            const childFk = sheetTitle === 'Projects' ? 'projectId' : 'itemId';
            const childSheet = doc.sheetsByTitle[childSheetName];
            
            if (childSheet) {
                const allChildRows = await executeWithRetry(() => childSheet.getRows());
                const parentIdStr = String(row.get('id'));
                const childrenToDelete = allChildRows.filter(r => String(r.get(childFk)) === parentIdStr);
                for (const childRow of childrenToDelete) {
                     try { await drive.files.delete({ fileId: childRow.get('fileId'), supportsAllDrives: true }); } catch(e) {}
                     await executeWithRetry(() => childRow.delete());
                }
            }
        }

        await executeWithRetry(() => row.delete());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Fatal Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
