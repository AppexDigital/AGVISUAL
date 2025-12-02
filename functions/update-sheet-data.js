// functions/update-sheet-data.js
// v90.0 - RESILIENCIA TOTAL + BORRADO POR BLOQUES + RATE LIMITER
// - Borrado masivo optimizado: Agrupa filas contiguas para borrar 79 fotos en 1 segundo.
// - Freno de emergencia: Si hay muchas operaciones individuales, pausa para evitar error 429.
// - Buscador de FileId mejorado: Encuentra la columna aunque cambie mayúsculas/minúsculas.

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

const RATE_LIMIT_THRESHOLD = 45; // Pausar antes de llegar a 60
const RATE_LIMIT_PAUSE = 60000; // 60 segundos de enfriamiento
let requestCounter = 0;

async function throttle() {
    requestCounter++;
    if (requestCounter >= RATE_LIMIT_THRESHOLD) {
        console.log(`⚠️ Límite de velocidad cercano (${requestCounter}). Enfriando motores por 60s...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_PAUSE));
        requestCounter = 0;
        console.log("✅ Motores listos. Reanudando...");
    }
}

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

// Helper "Sabueso": Encuentra columnas buscando variaciones
function getRealHeader(sheet, name) {
    const headers = sheet.headerValues;
    const target = name.toLowerCase().replace(/\s/g, ''); // "File ID" -> "fileid"
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

// Borrado Inteligente en Cascada
async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue, drive) {
    try {
        const sheet = doc.sheetsByTitle[childSheetName];
        if (!sheet) return;
        
        // Necesitamos filas para encontrar IDs de archivo
        const rows = await sheet.getRows(); 
        const pHeader = getRealHeader(sheet, parentIdHeader);
        const fHeader = getRealHeader(sheet, 'fileId'); // Columna I

        if (!pHeader) return;

        // 1. Identificar filas a borrar y recolectar FileIDs para Drive
        const rowsToDelete = rows.filter(r => String(r.get(pHeader)).trim() === String(parentIdValue).trim());
        
        if (rowsToDelete.length === 0) return;

        console.log(`Iniciando borrado en cascada de ${rowsToDelete.length} elementos en ${childSheetName}`);

        // 2. Borrar archivos de Drive (Esto gasta quota, aplicamos throttle)
        if (fHeader && drive) {
            for (const row of rowsToDelete) {
                const fileId = row.get(fHeader);
                if (fileId) {
                    await throttle(); // Protección
                    try {
                        await drive.files.update({ fileId: fileId, requestBody: { trashed: true } });
                    } catch(e) { console.warn(`Error borrando archivo ${fileId}:`, e.message); }
                }
            }
        }

        // 3. BORRADO OPTIMIZADO POR BLOQUES (La clave para velocidad)
        // Agrupamos filas contiguas para borrarlas en 1 sola petición
        // rowIndex es 1-based. Ejemplo: filas [10, 11, 12, 15]
        
        // Ordenamos descendente para que al borrar las de abajo no cambien los índices de las de arriba
        const ranges = [];
        const sortedRows = [...rowsToDelete].sort((a, b) => b.rowIndex - a.rowIndex);

        sortedRows.forEach(row => {
            const lastRange = ranges[ranges.length - 1];
            // Si es consecutivo al último rango (recordar que vamos hacia atrás)
            if (lastRange && (lastRange.start - 1 === row.rowIndex)) {
                lastRange.start = row.rowIndex;
                lastRange.count++;
            } else {
                ranges.push({ start: row.rowIndex, count: 1 });
            }
        });

        // Ejecutar borrado por bloques
        for (const range of ranges) {
            await throttle(); // Protección por si hay muchos bloques dispersos
            // sheet.deleteRows(startIndex, count). startIndex es 0-based.
            // rowIndex es 1-based. Así que startIndex = rowIndex - 1.
            await sheet.deleteRows(range.start - 1, range.count);
            console.log(`Bloque borrado: fila ${range.start}, cantidad ${range.count}`);
        }

    } catch (e) {
        console.warn(`Error crítico en cascada ${childSheetName}:`, e.message);
    }
}

exports.handler = async (event, context) => {
  requestCounter = 0; // Reset por ejecución
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
            await throttle();
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

                if (!realHeaderKey) { // Upsert config
                    if(['Settings', 'About'].includes(sheetName)) await sheet.addRow({ ...op.criteria, ...op.data });
                    continue;
                }

                const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);

                if (targetRow) {
                    // Renombrado Carpeta (Con Throttle)
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                        const newTitle = getDataVal(op.data, titleKey);
                        if (newTitle) {
                            const currentTitle = targetRow.get(getRealHeader(sheet, titleKey));
                            const folderId = targetRow.get(getRealHeader(sheet, 'driveFolderId'));
                            if (folderId && currentTitle !== newTitle) {
                                await throttle();
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
                            const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                            const pCol = getColIndex(sheet, pKey);
                            const cCol = getColIndex(sheet, 'isCover');
                            const pId = sheet.getCell(rIdx, pCol).value;
                            
                            // Barrido optimizado
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

            if (hasBatchChanges) {
                await throttle();
                await sheet.saveUpdatedCells();
            }

            // Fallback seguro con Throttle
            for (const fallback of fallbackUpdates) {
                await throttle(); // Freno aquí para las 79 fotos si falló el batch
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

                // Integridad Categorías
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
                    // 1. Borrar archivo Drive (Sabueso de fileId)
                    let fileId = getDataVal(op.data, 'fileId');
                    if (!fileId) {
                        const hFile = getRealHeader(sheet, 'fileId'); 
                        if (hFile) fileId = row.get(hFile);
                    }

                    if (fileId) {
                        await throttle();
                        try { 
                            await drive.files.update({ fileId: fileId, requestBody: { trashed: true } }); 
                            console.log(`Archivo ${fileId} a papelera.`);
                        } catch(e){ console.warn("Error drive file:", e.message); }
                    }

                    // 2. Borrar Carpeta y Cascada
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getRealHeader(sheet, 'driveFolderId');
                        const folderId = hFolder ? row.get(hFolder) : null;
                        
                        if (folderId) {
                            await throttle();
                            try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true } }); } catch(e){}
                        }

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
                    
                    await throttle();
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
