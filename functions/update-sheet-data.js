// functions/update-sheet-data.js
// v73.0 - MAESTRÍA EN GESTIÓN DE DATOS (Cascada Completa + Integridad)
// - RentalItems: Limpieza automática de Fotos, Bloqueos y Reservas al borrar el equipo.
// - RentalCategories: Bloqueo de seguridad si tiene hijos.
// - Sync total con Drive y Google Sheets.

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
    const target = name.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

function getColIndex(sheet, name) {
    const headers = sheet.headerValues;
    const target = name.toLowerCase().trim();
    return headers.findIndex(h => h.toLowerCase().trim() === target);
}

// Helper universal para limpieza en cascada
async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        if (!header) return;

        // Filtramos las filas que coinciden con el ID del padre eliminado
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        
        // Borrado seguro uno a uno
        for (const row of rowsToDelete) {
            await row.delete();
        }
        if (rowsToDelete.length > 0) {
            console.log(`Limpieza cascada: ${rowsToDelete.length} registros borrados en ${childSheetName}`);
        }
    } catch (e) {
        console.warn(`Advertencia en cascada ${childSheetName}:`, e.message);
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
            try { await sheet.loadCells(); } catch(e) {}
            const rows = await sheet.getRows(); 
            let hasBatchChanges = false;
            const fallbackUpdates = [];

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
                    // Renombrado de Carpeta Drive
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                        const newTitle = op.data[titleKey];
                        if (newTitle) {
                            const currentTitle = targetRow.get(getRealHeader(sheet, titleKey));
                            const folderId = targetRow.get(getRealHeader(sheet, 'driveFolderId'));
                            if (folderId && currentTitle !== newTitle) {
                                try { await drive.files.update({ fileId: folderId, requestBody: { name: newTitle } }); } catch(e){}
                            }
                        }
                    }

                    // Lógica Batch
                    const rIdx = targetRow.rowIndex - 1;
                    let rowBatchSuccess = true;
                    try {
                        // Portada Única
                        if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                            const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                            const parentCol = getColIndex(sheet, parentKey);
                            const coverCol = getColIndex(sheet, 'isCover');
                            const parentId = sheet.getCell(rIdx, parentCol).value;
                            rows.forEach(r => {
                                const otherIdx = r.rowIndex - 1;
                                if (otherIdx !== rIdx) {
                                    try {
                                        const pVal = sheet.getCell(otherIdx, parentCol).value;
                                        if (String(pVal) === String(parentId)) {
                                            const cCell = sheet.getCell(otherIdx, coverCol);
                                            if (String(cCell.value).toLowerCase() === 'si') {
                                                cCell.value = 'No';
                                                hasBatchChanges = true;
                                            }
                                        }
                                    } catch(e) {}
                                }
                            });
                        }
                        // Aplicar Datos
                        Object.keys(op.data).forEach(key => {
                            const colIdx = getColIndex(sheet, key);
                            if (colIdx !== -1) {
                                const cell = sheet.getCell(rIdx, colIdx);
                                if (String(cell.value) !== String(op.data[key])) { cell.value = op.data[key]; hasBatchChanges = true; }
                            }
                        });
                    } catch (cellError) { rowBatchSuccess = false; }

                    if (!rowBatchSuccess) fallbackUpdates.push({ row: targetRow, data: op.data, sheetName });
                }
            }
            if (hasBatchChanges) await sheet.saveUpdatedCells();
            for (const fallback of fallbackUpdates) {
                // Fallback seguro (resumido)
                Object.keys(fallback.data).forEach(k=>{ const h=getRealHeader(sheet,k); if(h) fallback.row.set(h,fallback.data[k]); });
                await fallback.row.save();
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

                // 1. PROTECCIÓN DE CATEGORÍAS (Integridad Referencial)
                if (sheetName === 'RentalCategories') {
                    const itemsSheet = doc.sheetsByTitle['RentalItems'];
                    if (itemsSheet) {
                        await itemsSheet.loadHeaderRow();
                        const allItems = await itemsSheet.getRows();
                        const catHeader = getRealHeader(itemsSheet, 'categoryId');
                        const hasDependents = allItems.some(item => String(item.get(catHeader)).trim() === String(criteriaVal));
                        if (hasDependents) {
                            throw new Error(`⚠️ No se puede eliminar: Hay equipos asociados a esta categoría.`);
                        }
                    }
                }

                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    // 2. Borrar archivo Drive (Imagen individual)
                    const fileIdHeader = getRealHeader(sheet, 'fileId');
                    const fileId = (op.data && op.data.fileId) || (fileIdHeader ? row.get(fileIdHeader) : null);
                    if (fileId) try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true } }); } catch(e){}

                    // 3. Borrar Carpeta Drive y Hijos (Cascada de Entidades)
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const folderIdHeader = getRealHeader(sheet, 'driveFolderId');
                        const folderId = folderIdHeader ? row.get(folderIdHeader) : null;
                        if (folderId) try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true } }); } catch(e){}
                        
                        // Cascada Proyectos
                        if (sheetName === 'Projects') {
                            await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal);
                        }
                        // Cascada Servicios
                        if (sheetName === 'Services') {
                            await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal);
                            await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal);
                        }
                        // Cascada ALQUILER (NUEVO: Limpieza profunda)
                        if (sheetName === 'RentalItems') {
                            await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal); // Fotos
                            await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal);     // Bloqueos
                            await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal);         // Reservas
                        }
                    }
                    await row.delete();
                }
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Proceso completado con éxito.' }) };

  } catch (error) {
    console.error('Backend Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
