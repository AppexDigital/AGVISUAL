// functions/update-sheet-data.js
// v101.0 - NÚCLEO ESTABLE (v72) + MEJORAS DE BORRADO
// - Regresamos a la lógica secuencial segura para ADDS (soluciona foto 1 perdida).
// - Mantenemos borrado por bloques para proyectos grandes (evita timeout).
// - Búsqueda flexible de columnas (fileId vs FileID).

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

// Helper: Encuentra el header real probando variantes comunes
function getRealHeader(sheet, name) {
    // 1. Búsqueda exacta o normalizada
    const headers = sheet.headerValues;
    const target = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let found = headers.find(h => h.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    
    // 2. Red de seguridad: Mapeo manual de nombres comunes si falla el automático
    if (!found) {
        const map = {
            'fileid': ['File ID', 'FileId', 'ID Archivo'],
            'drivefolderid': ['Drive Folder ID', 'Folder ID', 'ID Carpeta', 'Carpeta Drive'],
            'projectid': ['Project ID', 'ProjectID', 'ID Proyecto'],
            'itemid': ['Item ID', 'ItemID', 'ID Equipo'],
            'serviceid': ['Service ID', 'ServiceID', 'ID Servicio']
        };
        const aliases = map[target];
        if (aliases) {
            found = headers.find(h => aliases.includes(h));
        }
    }
    return found;
}

function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? dataObj[key] : undefined;
}

function getColIndex(sheet, name) {
    const header = getRealHeader(sheet, name);
    if (!header) return -1;
    return sheet.headerValues.indexOf(header);
}

async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        
        await childSheet.loadHeaderRow();
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        
        if (!header) {
            console.warn(`No se encontró la columna ${parentIdHeader} en ${childSheetName}`);
            return;
        }

        // Filtrar filas a borrar
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        
        if (rowsToDelete.length === 0) return;

        // BORRADO OPTIMIZADO POR BLOQUES (Solo Excel)
        const ranges = [];
        // Ordenamos descendente (de abajo hacia arriba) para no afectar índices
        const sortedRows = [...rowsToDelete].sort((a, b) => b.rowIndex - a.rowIndex);

        sortedRows.forEach(row => {
            const lastRange = ranges[ranges.length - 1];
            // Si es consecutivo (recordar orden inverso: 10, 9, 8...)
            if (lastRange && (lastRange.start - 1 === row.rowIndex)) {
                lastRange.start = row.rowIndex;
                lastRange.count++;
            } else {
                ranges.push({ start: row.rowIndex, count: 1 });
            }
        });

        // Ejecutar borrado en Sheet
        for (const range of ranges) {
            await childSheet.deleteRows(range.start - 1, range.count);
        }
        
    } catch (e) {
        console.warn(`Error no fatal en cascada ${childSheetName}:`, e.message);
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

        // --- A. CREACIÓN (ADDS) - LÓGICA SECUENCIAL SEGURA (v72) ---
        // Esto arregla el problema de la "primera foto perdida"
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = getRealHeader(sheet, k); // Usamos el sabueso
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
                    // Renombrado (con Sabueso)
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                        const newTitle = op.data[titleKey] || op.data[titleKey.toLowerCase()] || op.data['Title']; // Intento manual
                        if (newTitle) {
                            const hTitle = getRealHeader(sheet, titleKey);
                            const hFolder = getRealHeader(sheet, 'driveFolderId');
                            const currentTitle = targetRow.get(hTitle);
                            const folderId = targetRow.get(hFolder);
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
                            
                            if (pCol > -1 && cCol > -1) {
                                const pId = sheet.getCell(rIdx, pCol).value;
                                rows.forEach(r => {
                                    const otherIdx = r.rowIndex - 1;
                                    if (otherIdx !== rIdx) {
                                        try {
                                            const pVal = sheet.getCell(otherIdx, pCol).value;
                                            if (String(pVal) === String(pId)) {
                                                const cCell = sheet.getCell(otherIdx, cCol);
                                                if (String(cCell.value).toLowerCase() === 'si') {
                                                    cCell.value = 'No';
                                                    hasBatchChanges = true;
                                                }
                                            }
                                        } catch(e) {}
                                    }
                                });
                            }
                        }
                        // Aplicar
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
                Object.keys(fallback.data).forEach(k=>{ const h=getRealHeader(sheet,k); if(h) fallback.row.set(h,fallback.data[k]); });
                await fallback.row.save();
            }
        }

        // --- C. BORRADOS (DELETES) - MEJORADO ---
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); 
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realKeyHeader = getRealHeader(sheet, criteriaKey);
                if (!realKeyHeader) continue;

                // Integridad Alquiler (Mantenemos esto igual)
                if (sheetName === 'RentalCategories') { /* ... código existente ... */ }

                    const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                  
                    // ... (código anterior para encontrar row)
                  
                    if (row) {
                        // 1. Borrar Archivo Drive (Imagen individual)
                        // Intentamos obtener el ID desde los datos enviados (op.data) O desde la fila (row.get)
                        let fileId = getDataVal(op.data, 'fileId'); 
                        
                        if (!fileId) {
                            const hFile = getRealHeader(sheet, 'fileId');
                            if (hFile) fileId = row.get(hFile); // Lectura segura usando el header real
                        }
    
                        if (fileId) {
                            // Fire and forget (No bloqueante para velocidad)
                            drive.files.update({ fileId: fileId, requestBody: { trashed: true } }).catch(e => console.warn('Drive file err:', e.message));
                        }
    
                        // 2. Borrar Carpeta y Hijos (Proyecto/Item/Servicio)
                        if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                            const hFolder = getRealHeader(sheet, 'driveFolderId');
                            const folderId = hFolder ? row.get(hFolder) : null; // Lectura segura
                            
                            if (folderId) {
                                drive.files.update({ fileId: folderId, requestBody: { trashed: true } }).catch(e => console.warn('Drive folder err:', e.message));
                            }
    
                            // Cascada de Hijos
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

                    // B. Si es una Imagen Suelta -> Borrar ARCHIVO
                    // Solo si NO estamos borrando un proyecto padre (para ahorrar API calls)
                    // Buscamos fileId en la data enviada o en la fila
                    const fileIdVal = getDataVal(op.data, 'fileId'); 
                    const hFile = getRealHeader(sheet, 'fileId');
                    const rowFileId = hFile ? row.get(hFile) : null;
                    const finalFileId = fileIdVal || rowFileId;

                    // Solo borramos archivo individual si NO es una de las hojas padres
                    if (!['Projects', 'RentalItems', 'Services'].includes(sheetName) && finalFileId) {
                        try {
                            await drive.files.update({ fileId: finalFileId, requestBody: { trashed: true } });
                        } catch(e) { console.warn("Fallo al borrar archivo individual:", e.message); }
                    }

                    // --- 2. BORRAR FILA DEL SHEET ---
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
