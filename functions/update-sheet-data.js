// functions/update-sheet-data.js
// v16.0 - ROBUST DELETE & RETRY SYSTEM
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
            console.log(`Quota hit in Update. Retrying in ${delay}ms...`);
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

async function deleteFileFromDrive(drive, fileId) {
    if (!fileId) return;
    try {
        await executeWithRetry(() => drive.files.delete({ fileId: fileId, supportsAllDrives: true }));
        console.log(`Drive Deleted: ${fileId}`);
    } catch (e) {
        console.warn(`Drive Delete Warn (${fileId}): ${e.message}`);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { sheet: sheetTitle, action, data, criteria } = body;
    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: `Hoja ${sheetTitle} no existe` }) };
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
             const allRows = await sheet.getRows();
             for (const r of allRows) {
                 if (r.get(parentKey) === row.get(parentKey) && r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await executeWithRetry(() => r.save());
                 }
             }
        }
        Object.keys(data).forEach(key => row.set(key, data[key]));
        await executeWithRetry(() => row.save());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (CASCADA MAESTRA) ---
    if (action === 'delete') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // 1. Si es una IMAGEN INDIVIDUAL
        if (sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages' || sheetTitle === 'ClientLogos') {
            await deleteFileFromDrive(drive, row.get('fileId'));
        }

        // 2. Si es un PROYECTO o RENTAL ITEM (Borrar hijos + Carpeta)
        if (sheetTitle === 'Projects' || sheetTitle === 'RentalItems') {
            const parentId = row.get('id');
            const driveFolderId = row.get('driveFolderId');
            const childSheetName = sheetTitle === 'Projects' ? 'ProjectImages' : 'RentalItemImages';
            const childFk = sheetTitle === 'Projects' ? 'projectId' : 'itemId';

            // A. Borrar Imágenes Hijas (Drive + Rows)
            const childSheet = doc.sheetsByTitle[childSheetName];
            if (childSheet) {
                const childRows = await findRows(childSheet, { [childFk]: parentId });
                for (const childRow of childRows) {
                    await deleteFileFromDrive(drive, childRow.get('fileId'));
                    await executeWithRetry(() => childRow.delete());
                }
            }

            // B. Borrar Carpeta Principal de Drive
            await deleteFileFromDrive(drive, driveFolderId);
        }

        // 3. Borrar la fila principal
        await executeWithRetry(() => row.delete());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

  } catch (error) {
    console.error('Update Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
