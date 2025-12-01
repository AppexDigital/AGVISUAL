// functions/update-sheet-data.js
// v22.0 - BORRADO CONSCIENTE DEL CONTEXTO
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

// Normalización de columnas
function findRealHeader(sheet, targetName) {
    const headers = sheet.headerValues;
    const target = targetName.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

function getSafeValue(row, sheet, targetColumnName) {
    const realHeader = findRealHeader(sheet, targetColumnName);
    if (!realHeader) return null;
    return row.get(realHeader);
}

async function findRows(sheet, criteria) {
    if (!criteria) return [];
    await executeWithRetry(() => sheet.loadHeaderRow());
    const rows = await executeWithRetry(() => sheet.getRows());
    const criteriaKey = Object.keys(criteria)[0];
    const realKeyHeader = findRealHeader(sheet, criteriaKey);
    if (!realKeyHeader) return [];
    return rows.filter(row => String(row.get(realKeyHeader)) === String(criteria[criteriaKey]));
}

async function deleteFileFromDrive(drive, fileId) {
    if (!fileId) return;
    try {
        await executeWithRetry(() => drive.files.delete({ fileId: fileId, supportsAllDrives: true }));
        console.log(`Drive: Eliminado ${fileId}`);
    } catch (e) {
        if (e.code !== 404) console.warn(`Drive Error (${fileId}): ${e.message}`);
    }
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
        
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           const parentKeyTarget = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           const realParentKey = findRealHeader(sheet, parentKeyTarget);
           const realCoverKey = findRealHeader(sheet, 'isCover');

           if (realParentKey && realCoverKey) {
               for (const r of rows) { 
                   if (r.get(realParentKey) === data[parentKeyTarget] && r.get(realCoverKey) === 'Si') { 
                       r.set(realCoverKey, 'No'); await executeWithRetry(() => r.save()); 
                   } 
               }
           }
        }
        
        const rowData = {};
        Object.keys(data).forEach(k => {
            const realHeader = findRealHeader(sheet, k);
            if (realHeader) rowData[realHeader] = data[k];
        });
        await executeWithRetry(() => sheet.addRow(rowData));
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- UPDATE ---
    if (action === 'update') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        Object.keys(data).forEach(key => { 
            const realHeader = findRealHeader(sheet, key);
            if (realHeader) row.set(realHeader, data[key]);
        });
        await executeWithRetry(() => row.save());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (LÓGICA CONTEXTUAL) ---
    if (action === 'delete') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado en Sheet' }) };

        // A. Si estamos en una hoja de IMÁGENES, buscamos 'fileId'
        if (['ProjectImages', 'RentalItemImages', 'ClientLogos'].includes(sheetTitle)) {
            const fileId = getSafeValue(row, sheet, 'fileId');
            if (fileId) {
                console.log(`Borrando imagen individual: ${fileId}`);
                await deleteFileFromDrive(drive, fileId);
            }
        }

        // B. Si estamos en una hoja de PADRES (Proyectos/Items), buscamos 'driveFolderId' y borramos hijos
        if (['Projects', 'RentalItems'].includes(sheetTitle)) {
            // 1. Borrar Carpeta
            const folderId = getSafeValue(row, sheet, 'driveFolderId');
            
            // 2. Borrar Hijos en Cascada
            const childSheetName = sheetTitle === 'Projects' ? 'ProjectImages' : 'RentalItemImages';
            const childFkTarget = sheetTitle === 'Projects' ? 'projectId' : 'itemId';
            const childSheet = doc.sheetsByTitle[childSheetName];
            
            if (childSheet) {
                await executeWithRetry(() => childSheet.loadHeaderRow());
                const realChildFk = findRealHeader(childSheet, childFkTarget);
                const realChildId = findRealHeader(sheet, 'id'); 
                
                if (realChildFk) {
                    const allChildRows = await executeWithRetry(() => childSheet.getRows());
                    const parentIdStr = String(row.get(realChildId));
                    const childrenToDelete = allChildRows.filter(r => String(r.get(realChildFk)) === parentIdStr);

                    for (const childRow of childrenToDelete) {
                         const childFileId = getSafeValue(childRow, childSheet, 'fileId');
                         if (childFileId) await deleteFileFromDrive(drive, childFileId);
                         await executeWithRetry(() => childRow.delete());
                    }
                }
            }
            
            // Borrar carpeta AL FINAL (después de vaciarla, aunque Drive permite borrar carpetas llenas)
            if (folderId) {
                console.log(`Borrando carpeta de proyecto: ${folderId}`);
                await deleteFileFromDrive(drive, folderId);
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
