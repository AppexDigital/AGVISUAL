// functions/update-sheet-data.js
// v91.0 - BACKEND RÁPIDO (Sin pausas)
// - Eliminamos el throttle del servidor para evitar Timeout 504.
// - Mantenemos la lógica de borrado por bloques y búsqueda inteligente.

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

function getRealHeader(sheet, name) {
    const headers = sheet.headerValues;
    const target = name.toLowerCase().replace(/\s/g, '');
    return headers.find(h => h.toLowerCase().replace(/\s/g, '') === target);
}

function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/\s/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/\s/g, '') === target);
    return key ? dataObj[key] : undefined;
}

function getColIndex(sheet, name) {
    const header = getRealHeader(sheet, name);
    if (!header) return -1;
    return sheet.headerValues.indexOf(header);
}

async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue, drive) {
    try {
        const sheet = doc.sheetsByTitle[childSheetName];
        if (!sheet) return;
        
        const rows = await sheet.getRows(); 
        const pHeader = getRealHeader(sheet, parentIdHeader);
        const fHeader = getRealHeader(sheet, 'fileId');

        if (!pHeader) return;

        const rowsToDelete = rows.filter(r => String(r.get(pHeader)).trim() === String(parentIdValue).trim());
        
        if (rowsToDelete.length === 0) return;

        // Borrar archivos de Drive (Intentar lo más rápido posible)
        if (fHeader && drive) {
            // Ejecutamos en paralelo para velocidad (Promise.all)
            const fileDeletions = rowsToDelete.map(row => {
                const fileId = row.get(fHeader);
                if (fileId) {
                    return drive.files.update({ fileId: fileId, requestBody: { trashed: true } })
                        .catch(e => console.warn(`Error file ${fileId}:`, e.message));
                }
            });
            await Promise.all(fileDeletions);
        }

        // BORRADO POR BLOQUES (Optimizado)
        const ranges = [];
        const sortedRows = [...rowsToDelete].sort((a, b) => b.rowIndex - a.rowIndex);

        sortedRows.forEach(row => {
            const lastRange = ranges[ranges.length - 1];
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

        // A. CREACIÓN
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

        // B. ACTUALIZACIÓN (Batching en Memoria)
        if (updates.length > 0) {
            try { await sheet.loadCells(); } catch(e) {}
            const rows = await sheet.getRows(); 
            let hasBatchChanges = false;
            const fallbackUpdates = [];

            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realHeaderKey = getRealHeader(sheet, criteriaKey);

                if (!realHeaderKey) { 
                    if(['Settings', 'About'].includes(sheetName)) await sheet.addRow({ ...op.criteria, ...op.data });
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

                    const rIdx = targetRow.rowIndex - 1;
                    let rowBatchSuccess = true;
                    try {
                        // Portada Única
                        if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                            const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                            const pCol = getColIndex(sheet, pKey);
                            const cCol = getColIndex(sheet, 'isCover');
                            const pId = sheet.getCell(rIdx, pCol).value;
                            
                            for(let i=0; i<rows.length; i++) {
                                const otherIdx = rows[i].rowIndex - 1;
                                if(otherIdx === rIdx) continue;
                                try {
                                    if(String(sheet.getCell(otherIdx, pCol).value) === String(pId) && 
                                       String(sheet.getCell(otherIdx, cCol).value).toLowerCase() === 'si') {
                                        sheet.getCell(otherIdx, cCol).value = 'No';
                                        hasBatchChanges = true;
                                    }
                                } catch(e){}
                            }
                        }
                        // Aplicar Datos
                        Object.keys(op.data).forEach(key => {
                            const colIdx = getColIndex(sheet, key);
                            if (colIdx !== -1) {
                                const cell = sheet.getCell(rIdx, colIdx);
                                if (String(cell.value) !== String(op.data[key])) { cell.value = op.data[key]; hasBatchChanges = true; }
                            }
                        });
                    } catch (err) { rowBatchSuccess = false; }

                    if (!rowBatchSuccess) fallbackUpdates.push({ row: targetRow, data: op.data, sheetName });
                }
            }

            if (hasBatchChanges) await sheet.saveUpdatedCells();
            for (const fallback of fallbackUpdates) {
                Object.keys(fallback.data).forEach(k=>{ const h=getRealHeader(sheet,k); if(h) fallback.row.set(h,fallback.data[k]); });
                await fallback.row.save();
            }
        }

        // C. BORRADOS
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
                        if (allItems.some(item => String(item.get(catHeader)).trim() === String(criteriaVal))) {
                            throw new Error(`⚠️ No se puede eliminar: Hay equipos asociados.`);
                        }
                    }
                }

                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    // Borrar archivo Drive
                    let fileId = getDataVal(op.data, 'fileId');
                    if (!fileId) {
                        const hFile = getRealHeader(sheet, 'fileId'); 
                        if (hFile) fileId = row.get(hFile);
                    }
                    if (fileId) try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true } }); } catch(e){}

                    // Borrar Carpeta y Cascada
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getRealHeader(sheet, 'driveFolderId');
                        const folderId = hFolder ? row.get(hFolder) : null;
                        if (folderId) try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true } }); } catch(e){}

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

    return { statusCode: 200, body: JSON.stringify({ message: 'Proceso completado.' }) };

  } catch (error) {
    console.error('Backend Critical Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
