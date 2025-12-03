// functions/update-sheet-data.js
// v100.0 - PARALELISMO + ROBUSTEZ
// - Eliminación en Drive paralela (Promise.all) para evitar timeout con 79 fotos.
// - Búsqueda de columnas simplificada y segura.

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

// Helper simple y efectivo
function getHeaderKey(sheet, keyName) {
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, ''); // solo letras y numeros
    return sheet.headerValues.find(h => h.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
}

function getDataValue(data, keyName) {
    if(!data) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(data).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? data[key] : undefined;
}

// Borrado en cascada optimizado
async function deleteChildRows(doc, childSheetName, parentIdHeaderName, parentIdValue, drive) {
    try {
        const sheet = doc.sheetsByTitle[childSheetName];
        if (!sheet) return;
        const rows = await sheet.getRows();
        const pHeader = getHeaderKey(sheet, parentIdHeaderName);
        const fHeader = getHeaderKey(sheet, 'fileId');

        if (!pHeader) return;

        // Filtrar filas a borrar
        const rowsToDelete = rows.filter(r => String(r.get(pHeader)).trim() === String(parentIdValue).trim());
        if (rowsToDelete.length === 0) return;

        // 1. Borrar de Drive en PARALELO (Velocidad máxima)
        if (fHeader && drive) {
            const drivePromises = rowsToDelete
                .map(r => r.get(fHeader))
                .filter(fid => fid)
                .map(fid => drive.files.update({ fileId: fid, requestBody: { trashed: true } }).catch(e => console.log('Error Drive:', e.message)));
            
            await Promise.all(drivePromises); // Esperamos a que todos se borren a la vez
        }

        // 2. Borrar del Sheet en BLOQUES
        const ranges = [];
        // Ordenamos descendente por índice
        const sortedRows = [...rowsToDelete].sort((a, b) => b.rowIndex - a.rowIndex);

        sortedRows.forEach(row => {
            const lastRange = ranges[ranges.length - 1];
            // rowIndex es 1-based. Si lastRange.start - 1 == row.rowIndex, son contiguos hacia arriba
            if (lastRange && (lastRange.start - 1 === row.rowIndex)) {
                lastRange.start = row.rowIndex;
                lastRange.count++;
            } else {
                ranges.push({ start: row.rowIndex, count: 1 });
            }
        });

        for (const range of ranges) {
            await sheet.deleteRows(range.start - 1, range.count);
        }
    } catch (e) {
        console.error(`Fallo cascada ${childSheetName}:`, e.message);
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

    // Agrupar
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

        // A. ADDS
        if (adds.length > 0) {
            const rowsToAdd = [];
            for (const op of adds) {
                if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                     op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
                }
                const rowData = {};
                Object.keys(op.data).forEach(k => {
                    const h = getHeaderKey(sheet, k);
                    if (h) rowData[h] = op.data[k];
                });
                rowsToAdd.push(rowData);
            }
            if (rowsToAdd.length > 0) await sheet.addRows(rowsToAdd);
        }

        // B. UPDATES
        if (updates.length > 0) {
            try { await sheet.loadCells(); } catch(e) {}
            const rows = await sheet.getRows(); 
            let hasChanges = false;

            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realHeaderKey = getHeaderKey(sheet, criteriaKey);

                if (!realHeaderKey) { // Config upsert
                    if(['Settings', 'About'].includes(sheetName)) await sheet.addRow({ ...op.criteria, ...op.data });
                    continue;
                }

                const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);

                if (targetRow) {
                    // Renombrado (Drive)
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                        const newTitle = getDataValue(op.data, titleKey);
                        if (newTitle) {
                            const currentTitle = targetRow.get(getHeaderKey(sheet, titleKey));
                            const folderId = targetRow.get(getHeaderKey(sheet, 'driveFolderId'));
                            if (folderId && currentTitle !== newTitle) {
                                try { await drive.files.update({ fileId: folderId, requestBody: { name: newTitle } }); } catch(e){}
                            }
                        }
                    }

                    const rIdx = targetRow.rowIndex - 1;
                    
                    // Portada Única
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                         const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                         const pHeader = getHeaderKey(sheet, pKey);
                         const cHeader = getHeaderKey(sheet, 'isCover');
                         const pCol = sheet.headerValues.indexOf(pHeader);
                         const cCol = sheet.headerValues.indexOf(cHeader);
                         
                         if (pCol > -1 && cCol > -1) {
                             const pId = sheet.getCell(rIdx, pCol).value;
                             for(let i=0; i<rows.length; i++) {
                                 if((rows[i].rowIndex - 1) === rIdx) continue;
                                 try {
                                     if(String(sheet.getCell(rows[i].rowIndex - 1, pCol).value) === String(pId)) {
                                         sheet.getCell(rows[i].rowIndex - 1, cCol).value = 'No';
                                         hasChanges = true;
                                     }
                                 } catch(e){}
                             }
                         }
                    }

                    // Aplicar
                    Object.keys(op.data).forEach(key => {
                        const h = getHeaderKey(sheet, key);
                        if (h) {
                            const col = sheet.headerValues.indexOf(h);
                            if (col > -1) {
                                const cell = sheet.getCell(rIdx, col);
                                if (String(cell.value) !== String(op.data[key])) {
                                    cell.value = op.data[key];
                                    hasChanges = true;
                                }
                            }
                        }
                    });
                }
            }
            if (hasChanges) await sheet.saveUpdatedCells();
        }

        // C. DELETES
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); 
            
            // Integridad Alquiler
            if (sheetName === 'RentalCategories') {
                 const itemsSheet = doc.sheetsByTitle['RentalItems'];
                 if (itemsSheet) {
                     const allItems = await itemsSheet.getRows();
                     const catHeader = getHeaderKey(itemsSheet, 'categoryId');
                     const idsToCheck = deletes.map(d => String(d.criteria[Object.keys(d.criteria)[0]]).trim());
                     if (allItems.some(i => idsToCheck.includes(String(i.get(catHeader)).trim()))) {
                         throw new Error('⚠️ No se puede borrar: Categoría en uso.');
                     }
                 }
            }

            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realKeyHeader = getHeaderKey(sheet, criteriaKey);
                if (!realKeyHeader) continue;

                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    // 1. Borrar Archivo Drive
                    let fileId = getDataValue(op.data, 'fileId');
                    if (!fileId) {
                        const hFile = getHeaderKey(sheet, 'fileId');
                        if (hFile) fileId = row.get(hFile);
                    }
                    if (fileId) {
                        // No esperamos a que termine, lanzamos la promesa (fire and forget para velocidad)
                        drive.files.update({ fileId: fileId, requestBody: { trashed: true } }).catch(e => console.warn('Drive err:', e.message));
                    }

                    // 2. Borrar Carpeta Drive y Hijos
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getHeaderKey(sheet, 'driveFolderId');
                        const folderId = hFolder ? row.get(hFolder) : null;
                        if (folderId) drive.files.update({ fileId: folderId, requestBody: { trashed: true } }).catch(e => {});

                        if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal, drive);
                        if (sheetName === 'RentalItems') {
                            await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal, drive);
                            await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal, drive);
                            await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal, drive);
                        }
                        if (sheetName === 'Services') {
                            await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal, drive);
                            await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal, drive);
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
