// functions/update-sheet-data.js
// v17.0 - BORRADO A PRUEBA DE FALLOS & OPTIMIZADO
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
    await executeWithRetry(() => sheet.loadHeaderRow());

    // --- ADD ---
    if (action === 'add') {
        if (!data.id && sheetTitle !== 'BlockedDates') data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        
        // Lógica Portada Única
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const rows = await sheet.getRows();
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             for (const r of rows) {
                 if (r.get(parentKey) === data[parentKey] && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await executeWithRetry(() => r.save());
                 }
             }
        }
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
        Object.keys(data).forEach(key => row.set(key, data[key]));
        await executeWithRetry(() => row.save());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (BLINDADO) ---
    if (action === 'delete') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // 1. Borrar archivo de Drive (Solo si existe ID)
        const fileId = row.get('fileId');
        if (fileId) {
            try {
                await executeWithRetry(() => drive.files.delete({ fileId: fileId, supportsAllDrives: true }));
                console.log(`Archivo eliminado: ${fileId}`);
            } catch (e) {
                console.warn(`No se pudo borrar archivo Drive (no crítico): ${e.message}`);
            }
        }

        // 2. Si es Proyecto/Item, borrar carpeta y fotos hijas
        if (sheetTitle === 'Projects' || sheetTitle === 'RentalItems') {
            const folderId = row.get('driveFolderId');
            // Solo intentamos borrar carpeta si folderId existe y no está vacío
            if (folderId && folderId.trim() !== '') {
                try {
                    await executeWithRetry(() => drive.files.delete({ fileId: folderId, supportsAllDrives: true }));
                    console.log(`Carpeta eliminada: ${folderId}`);
                } catch (e) {
                    console.warn(`No se pudo borrar carpeta Drive (no crítico): ${e.message}`);
                }
            }

            // Borrar filas hijas en cascada
            const childSheetName = sheetTitle === 'Projects' ? 'ProjectImages' : 'RentalItemImages';
            const childFk = sheetTitle === 'Projects' ? 'projectId' : 'itemId';
            const childSheet = doc.sheetsByTitle[childSheetName];
            
            if (childSheet) {
                // Obtenemos todas las filas y filtramos manualmente para evitar muchas llamadas a la API
                const allChildRows = await executeWithRetry(() => childSheet.getRows());
                const parentIdStr = String(row.get('id'));
                const childrenToDelete = allChildRows.filter(r => String(r.get(childFk)) === parentIdStr);
                
                // Borramos hijos uno por uno (Sheets API no tiene delete batch para filas no contiguas fácilmente)
                for (const childRow of childrenToDelete) {
                     await executeWithRetry(() => childRow.delete());
                }
            }
        }

        // 3. Borrar la fila principal (LO MÁS IMPORTANTE)
        await executeWithRetry(() => row.delete());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Fatal Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
