// functions/update-sheet-data.js
// v20.0 - SMART DELETE (Flexible Column Names & Cascading Fix)
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
    // Comparación flexible para encontrar la fila
    return rows.filter(row => String(row.get(key)) === String(criteria[key]));
}

// HELPER MAESTRO: Busca el valor de una columna probando variantes de nombre
// Esto soluciona problemas como "driveFolderld" vs "driveFolderId" o "fileid" vs "fileId"
function getFlexibleValue(row, keyCandidates) {
    for (const key of keyCandidates) {
        const val = row.get(key);
        if (val && val !== '') return val;
    }
    return null;
}

async function deleteFileFromDrive(drive, fileId, resourceName = 'Archivo') {
    if (!fileId) {
        console.warn(`[Drive] No se proporcionó ID para borrar ${resourceName}.`);
        return;
    }
    try {
        await executeWithRetry(() => drive.files.delete({ fileId: fileId, supportsAllDrives: true }));
        console.log(`[Drive] Eliminado ${resourceName}: ${fileId}`);
    } catch (e) {
        // 404 significa que ya no existe, lo cual es bueno en un delete.
        if (e.code === 404) {
            console.log(`[Drive] ${resourceName} ${fileId} ya no existía (404).`);
        } else {
            console.warn(`[Drive] Error borrando ${resourceName} (${fileId}): ${e.message}`);
        }
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
        // Escritura directa del objeto data
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
        Object.keys(data).forEach(key => { try { row.set(key, data[key]); } catch(e){} });
        await executeWithRetry(() => row.save());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (SUPER BLINDADO) ---
    if (action === 'delete') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // 1. Borrar archivo de Drive (Imagen individual)
        // Buscamos el ID en todas las variantes posibles de nombre de columna
        const fileId = getFlexibleValue(row, ['fileId', 'fileid', 'FileId', 'FILEID']);
        if (fileId) {
            await deleteFileFromDrive(drive, fileId, 'Imagen');
        }

        // 2. Si es Proyecto/Item (Borrar Carpeta y Hijos)
        if (sheetTitle === 'Projects' || sheetTitle === 'RentalItems') {
            // Buscar ID de carpeta con variantes (incluyendo el typo común 'driveFolderld')
            const folderId = getFlexibleValue(row, ['driveFolderId', 'driveFolderld', 'drivefolderid', 'DriveFolderId']);
            
            const childSheetName = sheetTitle === 'Projects' ? 'ProjectImages' : 'RentalItemImages';
            const childFk = sheetTitle === 'Projects' ? 'projectId' : 'itemId'; // projectId es lo que arreglamos en el frontend
            const childSheet = doc.sheetsByTitle[childSheetName];
            
            // A. Borrar Imágenes Hijas
            if (childSheet) {
                await executeWithRetry(() => childSheet.loadHeaderRow()); // CRÍTICO: Cargar headers de la hoja hija
                const allChildRows = await executeWithRetry(() => childSheet.getRows());
                const parentIdStr = String(row.get('id'));
                
                // Filtrar hijos
                const childrenToDelete = allChildRows.filter(r => String(r.get(childFk) || r.get('projectID') || r.get('ItemID')) === parentIdStr);
                
                console.log(`[Delete] Encontrados ${childrenToDelete.length} hijos para borrar en ${childSheetName}`);

                for (const childRow of childrenToDelete) {
                     const childFileId = getFlexibleValue(childRow, ['fileId', 'fileid', 'FileId']);
                     if (childFileId) {
                         await deleteFileFromDrive(drive, childFileId, 'Imagen Hija');
                     }
                     await executeWithRetry(() => childRow.delete());
                }
            }

            // B. Borrar Carpeta Principal de Drive (Al final, cuando está vacía)
            if (folderId) {
                await deleteFileFromDrive(drive, folderId, 'Carpeta de Proyecto');
            }
        }

        // 3. Borrar la fila principal
        await executeWithRetry(() => row.delete());
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Fatal Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
