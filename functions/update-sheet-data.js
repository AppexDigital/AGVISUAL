// functions/update-sheet-data.js
// v50.0 - BATCHING HÍBRIDO DE ALTO RENDIMIENTO
// Estrategia: 1 Carga Global -> Edición en Memoria -> 1 Guardado Global.
// Respeta encabezados (fila 1) y evita el rate-limit.

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

// Helper para encontrar índices de columnas insensible a mayúsculas/espacios
function getColIndex(sheet, name) {
    const headers = sheet.headerValues;
    const target = name.toLowerCase().trim();
    return headers.findIndex(h => h.toLowerCase().trim() === target);
}

// Helper para obtener nombre real del header
function getRealHeader(sheet, name) {
    const headers = sheet.headerValues;
    const target = name.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

exports.handler = async (event, context) => {
  // 1. Seguridad
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    // 2. Parsing Robusto
    let body;
    try {
        body = JSON.parse(event.body);
        if (typeof body === 'string') body = JSON.parse(body);
    } catch (e) {
        throw new Error('JSON inválido.');
    }

    const operations = Array.isArray(body) ? body : [body];
    const { doc, drive } = await getServices();

    // Agrupar por hoja
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

        // --- FASE 1: CREACIÓN (ADDS) ---
        // Los ADDS son seguros hacerlos uno a uno o en paralelo con addRow, 
        // pero para garantizar IDs y orden, el bucle es aceptable.
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            
            // Preparar datos con headers reales
            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = getRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            
            // NOTA: addRow añade al final (después de la última fila con datos).
            // Esto respeta implícitamente la fila 1 de headers.
            await sheet.addRow(rowData); 
        }

        // --- FASE 2: ACTUALIZACIÓN MASIVA (UPDATES) - LA JOYA DE LA CORONA ---
        if (updates.length > 0) {
            // A. Cargar TODO en una sola petición (Eficiencia)
            await sheet.loadCells(); 
            
            // B. Obtener mapa de filas (Seguridad)
            // getRows() nos da los objetos fila, ignorando headers vacíos o fila 1.
            const rows = await sheet.getRows(); 
            
            let hasBatchChanges = false;

            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0]; // ej: 'id'
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realHeaderKey = getRealHeader(sheet, criteriaKey);

                if (!realHeaderKey && ['Settings', 'About'].includes(sheetName)) {
                    // Upsert especial para configuración (raro en batch, pero soportado)
                    await sheet.addRow({ ...op.criteria, ...op.data });
                    continue;
                }

                // C. Buscar la fila usando la lógica segura de la librería
                const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);

                if (targetRow) {
                    // D. Traducir a coordenadas de celda (0-based)
                    // targetRow.rowIndex es 1-based (Fila 2 = 1). getCell usa 0-based.
                    // Por tanto: rowIndex - 1.
                    const rIdx = targetRow.rowIndex - 1;

                    // Lógica "Portada Única" (Batch Friendly)
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const parentCol = getColIndex(sheet, parentKey);
                        const coverCol = getColIndex(sheet, 'isCover');
                        
                        // Leer el ID del padre de la fila actual directamente de la celda cargada
                        const parentId = sheet.getCell(rIdx, parentCol).value;

                        // Barrer TODAS las filas en memoria para apagar covers del mismo grupo
                        // Usamos 'rows' para iterar solo sobre filas válidas de datos
                        rows.forEach(r => {
                            const otherIdx = r.rowIndex - 1;
                            if (otherIdx !== rIdx) { // No tocar la actual
                                const pVal = sheet.getCell(otherIdx, parentCol).value;
                                if (String(pVal) === String(parentId)) {
                                    const cCell = sheet.getCell(otherIdx, coverCol);
                                    if (String(cCell.value).toLowerCase() === 'si') {
                                        cCell.value = 'No';
                                        hasBatchChanges = true;
                                    }
                                }
                            }
                        });
                    }

                    // E. Aplicar cambios en memoria
                    Object.keys(op.data).forEach(key => {
                        const colIdx = getColIndex(sheet, key);
                        if (colIdx !== -1) {
                            const cell = sheet.getCell(rIdx, colIdx);
                            // Convertir a string para comparar, pero guardar valor original si es diferente
                            if (String(cell.value) !== String(op.data[key])) {
                                cell.value = op.data[key];
                                hasBatchChanges = true;
                            }
                        }
                    });
                }
            }

            // F. Guardar TODO de una sola vez (1 Petición)
            if (hasBatchChanges) {
                await sheet.saveUpdatedCells();
            }
        }

        // --- FASE 3: BORRADOS (DELETES) ---
        if (deletes.length > 0) {
            // Recargamos filas para asegurar índices correctos tras posibles adds
            const currentRows = await sheet.getRows(); 
            
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realKeyHeader = getRealHeader(sheet, criteriaKey);

                if (!realKeyHeader) continue;

                // Buscar y borrar
                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    // Borrar archivo de Drive si aplica (No bloqueante)
                    if (op.data && op.data.fileId) {
                        try { await drive.files.update({ fileId: op.data.fileId, requestBody: { trashed: true } }); } catch(e){}
                    }
                    await row.delete(); // Esto hace 1 petición por delete, pero deletes masivos son raros
                }
            }
        }
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Lote procesado correctamente' }) };

  } catch (error) {
    console.error('Backend Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
