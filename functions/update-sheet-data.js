// functions/update-sheet-data.js
// v200.0 - ESTRATEGIA TANQUE (Seguridad Absoluta)
// - Eliminado por completo el uso de celdas (adiós error "Cell not loaded").
// - Incluye helpers getDataVal y getRealHeader corregidos.
// - Lógica de borrado robusta.

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

// Helper Sabueso de Columnas
function getRealHeader(sheet, name) {
    const headers = sheet.headerValues;
    const target = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return headers.find(h => h.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
}

// Helper Sabueso de Datos (ESTE FALTABA)
function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? dataObj[key] : undefined;
}

// Cascada segura (Solo borra filas, deja que el bloque principal borre archivos)
async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        
        await childSheet.loadHeaderRow();
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        
        if (!header) return;

        // Filtrar filas a borrar
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        
        // Borrar uno a uno (Lento pero seguro, evita errores de índice)
        for (const row of rowsToDelete) {
            await row.delete();
        }
    } catch (e) {
        console.warn(`Error cascada ${childSheetName}:`, e.message);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    let body;
    try {
        body = JSON.parse(event.body);
        if (typeof body === 'string') body = JSON.parse(body);
    } catch (e) { throw new Error('JSON inválido.'); }

    const operations = Array.isArray(body) ? body : [body];
    const { doc, drive } = await getServices();

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
        const adds = sheetOps.filter(op => op.action === 'add');
        const updates = sheetOps.filter(op => op.action === 'update');
        const deletes = sheetOps.filter(op => op.action === 'delete');

        // --- A. CREACIÓN (ADDS) ---
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = getRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            await sheet.addRow(rowData); 
        }

        // --- B. ACTUALIZACIÓN (UPDATES) ---
        if (updates.length > 0) {
            // NO usamos loadCells. Usamos getRows (objetos seguros).
            const rows = await sheet.getRows(); 
            
            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realHeaderKey = getRealHeader(sheet, criteriaKey);

                if (!realHeaderKey && ['Settings', 'About'].includes(sheetName)) {
                    await sheet.addRow({ ...op.criteria, ...op.data });
                    continue;
                }

                const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);

                if (targetRow) {
                    // Renombrado
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                        const newTitle = getDataVal(op.data, titleKey);
                        if (newTitle) {
                            const currentTitle = targetRow.get(getRealHeader(sheet, titleKey));
                            const folderId = targetRow.get(getRealHeader(sheet, 'driveFolderId'));
                            if (folderId && currentTitle !== newTitle) {
                                try { await drive.files.update({ fileId: folderId, requestBody: { name: newTitle } }); } catch(e){}
                            }
                        }
                    }

                    // Lógica Portada Única (Segura con Objetos)
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const pHeader = getRealHeader(sheet, pKey);
                        const cHeader = getRealHeader(sheet, 'isCover');
                        
                        if (pHeader && cHeader) {
                            const currentPId = targetRow.get(pHeader);
                            // Barrido seguro fila por fila
                            for (const r of rows) {
                                if (r !== targetRow && String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') {
                                    r.set(cHeader, 'No');
                                    await r.save(); // Guardado individual seguro
                                }
                            }
                        }
                    }

                    // Aplicar Datos
                    let hasChanges = false;
                    Object.keys(op.data).forEach(key => {
                        const h = getRealHeader(sheet, key);
                        if (h) {
                            targetRow.set(h, op.data[key]);
                            hasChanges = true;
                        }
                    });

                    if (hasChanges) await targetRow.save(); // Guardado individual seguro
                }
            }
        }

        // --- C. BORRADOS (DELETES) ---
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); 
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realKeyHeader = getRealHeader(sheet, criteriaKey);
                if (!realKeyHeader) continue;

                // Integridad
                if (sheetName === 'RentalCategories') {
                    const itemsSheet = doc.sheetsByTitle['RentalItems'];
                    if (itemsSheet) {
                        await itemsSheet.loadHeaderRow();
                        const allItems = await itemsSheet.getRows();
                        const catHeader = getRealHeader(itemsSheet, 'categoryId');
                        if (allItems.some(i => String(i.get(catHeader)).trim() === String(criteriaVal))) {
                            throw new Error(`⚠️ No se puede eliminar: Hay equipos asociados.`);
                        }
                    }
                }

                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    // 1. Borrar Archivo Drive (Imagen)
                    // Buscamos ID en data o en la fila
                    let fileId = getDataVal(op.data, 'fileId');
                    if (!fileId) {
                        const hFile = getRealHeader(sheet, 'fileId');
                        if (hFile) fileId = row.get(hFile);
                    }

                    if (fileId) {
                        // AWAIT EXPLÍCITO PARA QUE NO FALLE
                        try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true } }); } catch(e) { console.warn("Drive file err:", e.message); }
                    }

                    // 2. Borrar Carpeta y Hijos
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getRealHeader(sheet, 'driveFolderId');
                        const folderId = hFolder ? row.get(hFolder) : null;
                        
                        if (folderId) {
                            try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true } }); } catch(e) { console.warn("Drive folder err:", e.message); }
                        }

                        if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal);
                        if (sheetName === 'RentalItems') {
                            await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal);
                            await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal);
                            await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal);
                        }
                        if (sheetName === 'Services') {
                            await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal);
                            await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal);
                        }
                    }
                    
                    await row.delete();
                }
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
