// functions/update-sheet-data.js
// v60.0 - SISTEMA HÍBRIDO CON AUTO-REPARACIÓN
// Combina velocidad de batching con seguridad de guardado individual si falla la memoria.

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

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    // 1. Parsing Robusto
    let body;
    try {
        body = JSON.parse(event.body);
        if (typeof body === 'string') body = JSON.parse(body);
    } catch (e) {
        throw new Error('JSON inválido.');
    }

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
        // Siempre seguro usar addRow directamente
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

        // --- B. ACTUALIZACIÓN (UPDATES) - LÓGICA HÍBRIDA ---
        if (updates.length > 0) {
            // Intentamos cargar la matriz completa para velocidad
            try { await sheet.loadCells(); } catch(e) { console.warn("LoadCells parcial warning"); }
            
            const rows = await sheet.getRows(); 
            let hasBatchChanges = false;
            const fallbackUpdates = []; // Aquí guardaremos los que fallen en batch

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
                    const rIdx = targetRow.rowIndex - 1;
                    let rowBatchSuccess = true; // Asumimos éxito

                    // Intento de escritura en memoria (Batch)
                    try {
                        // 1. Lógica Portada Única
                        if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                            const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                            const parentCol = getColIndex(sheet, parentKey);
                            const coverCol = getColIndex(sheet, 'isCover');
                            
                            // Leemos ID padre (esto puede fallar si la celda no cargó)
                            const parentId = sheet.getCell(rIdx, parentCol).value;

                            // Barrido para apagar otros covers
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
                                    } catch(e) { /* Ignorar fallos en filas ajenas en este paso */ }
                                }
                            });
                        }

                        // 2. Aplicar datos
                        Object.keys(op.data).forEach(key => {
                            const colIdx = getColIndex(sheet, key);
                            if (colIdx !== -1) {
                                const cell = sheet.getCell(rIdx, colIdx); // Aquí es donde suele fallar
                                if (String(cell.value) !== String(op.data[key])) {
                                    cell.value = op.data[key];
                                    hasBatchChanges = true;
                                }
                            }
                        });

                    } catch (cellError) {
                        // ¡AQUÍ ESTÁ LA MAGIA!
                        // Si falla el acceso a celdas, marcamos para Fallback seguro
                        console.warn(`Fallo batch en fila ${rIdx}, pasando a modo seguro individual.`);
                        rowBatchSuccess = false;
                    }

                    // Si falló el batch, lo mandamos a la cola de guardado individual
                    if (!rowBatchSuccess) {
                        fallbackUpdates.push({ row: targetRow, data: op.data, sheetName });
                    }
                }
            }

            // 1. Guardar lo que sí funcionó en batch (1 petición)
            if (hasBatchChanges) {
                await sheet.saveUpdatedCells();
            }

            // 2. Procesar los fallbacks (1 petición por fila problemática)
            // Esto asegura que NADA se pierda, aunque sea un poco más lento para esas filas específicas
            for (const fallback of fallbackUpdates) {
                let manualChanges = false;
                
                // Lógica Portada Única (Versión Lenta/Segura)
                if ((fallback.sheetName === 'ProjectImages' || fallback.sheetName === 'RentalItemImages') && String(fallback.data.isCover).toLowerCase() === 'si') {
                    const parentKey = fallback.sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                    const pHeader = getRealHeader(sheet, parentKey);
                    const cHeader = getRealHeader(sheet, 'isCover');
                    const currentPId = fallback.row.get(pHeader);

                    for (const r of rows) {
                        if (r === fallback.row) continue;
                        if (String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') {
                            r.set(cHeader, 'No');
                            await r.save(); // Guardado individual
                        }
                    }
                }

                // Aplicar datos
                Object.keys(fallback.data).forEach(key => {
                    const h = getRealHeader(sheet, key);
                    if (h) {
                         fallback.row.set(h, fallback.data[key]);
                         manualChanges = true;
                    }
                });

                if (manualChanges) {
                    await fallback.row.save(); // Guardado individual garantizado
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
                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    if (op.data && op.data.fileId) {
                        try { await drive.files.update({ fileId: op.data.fileId, requestBody: { trashed: true } }); } catch(e){}
                    }
                    await row.delete();
                }
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Proceso completado con éxito.' }) };

  } catch (error) {
    console.error('Backend Critical Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
