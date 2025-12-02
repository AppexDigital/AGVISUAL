// functions/update-sheet-data.js
// v31.0 - CORRECCIÓN DE ESCRITURA POR COORDENADAS (CELL-BASED)
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

function findRealHeader(sheet, targetName) {
    const headers = sheet.headerValues;
    const target = targetName.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

function getHeaderIndex(sheet, targetName) {
    const headers = sheet.headerValues;
    const target = targetName.toLowerCase().trim();
    return headers.findIndex(h => h.toLowerCase().trim() === target);
}

function getSafeValue(row, sheet, targetColumnName) {
    const realHeader = findRealHeader(sheet, targetColumnName);
    if (!realHeader) return null;
    return row.get(realHeader);
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    // CORRECCIÓN APPEX: Parsing robusto para evitar el error de doble serialización
    let body;
    try {
        body = JSON.parse(event.body);
        // Si el body sigue siendo un string después del primer parse (doble stringify del frontend), lo parseamos de nuevo
        if (typeof body === 'string') {
            body = JSON.parse(body);
        }
    } catch (e) {
        throw new Error('El cuerpo de la petición no es un JSON válido.');
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

        // 1. ADDS (Creación - Fila por Fila es seguro aquí)
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            
            // Manejo de "Portada Única" al crear
            if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                // Si estamos subiendo una nueva portada, cargamos celdas para apagar las otras
                await sheet.loadCells(); 
                const rows = await sheet.getRows();
                const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                const parentColIndex = getHeaderIndex(sheet, parentKey);
                const coverColIndex = getHeaderIndex(sheet, 'isCover');

                if (parentColIndex > -1 && coverColIndex > -1) {
                    rows.forEach(r => {
                        // Usamos getCell con coordenadas (fila, columna)
                        // rowIndex es base-1, getCell es base-0. Restamos 1.
                        const pVal = sheet.getCell(r.rowIndex - 1, parentColIndex).value;
                        if (String(pVal) === String(op.data[parentKey])) {
                            const cell = sheet.getCell(r.rowIndex - 1, coverColIndex);
                            cell.value = 'No';
                        }
                    });
                    await sheet.saveUpdatedCells();
                }
            }

            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = findRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            await sheet.addRow(rowData);
        }

        // 2. UPDATES (EDICIÓN MASIVA REAL)
        if (updates.length > 0) {
            const rows = await sheet.getRows(); // Para encontrar IDs rápidamente
            await sheet.loadCells(); // Carga la matriz completa para edición rápida
            
            let hasChanges = false;

            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const realCriteriaHeader = findRealHeader(sheet, criteriaKey);
                
                if (!realCriteriaHeader) {
                     // Caso especial: Settings/About (Upsert si no existe)
                     if(['Settings', 'About'].includes(sheetName)) {
                        const exists = rows.find(r => String(r.get(realCriteriaHeader || 'key')).trim() === String(op.criteria[criteriaKey]).trim());
                        if(!exists) { await sheet.addRow({ ...op.criteria, ...op.data }); }
                     }
                     continue;
                }

                // Buscar la fila que coincide con el ID
                const targetRow = rows.find(r => String(r.get(realCriteriaHeader)).trim() === String(op.criteria[criteriaKey]).trim());
                
                if (targetRow) {
                    // COORDENADA Y DE LA FILA
                    const rowIndex = targetRow.rowIndex - 1; // Convertir a base-0 para getCell

                    // Lógica Portada Única (Apagar otras en memoria)
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const parentColIdx = getHeaderIndex(sheet, parentKey);
                        const coverColIdx = getHeaderIndex(sheet, 'isCover');
                      
                        if (parentColIdx > -1 && coverColIdx > -1) {
                            // CORRECCIÓN APPEX: Usar getCell de forma segura
                            const currentParentId = sheet.getCell(rowIndex, parentColIdx).value;
                            
                            // Iteramos SOLO sobre las filas cargadas (rows) para evitar error de celda no cargada
                            rows.forEach(r => {
                                const rIdx = r.rowIndex - 1; // Convertir a índice base-0 (fila 2 = índice 1)
                                
                                // Saltamos la fila que estamos editando actualmente
                                if (rIdx === rowIndex) return;

                                // Envolvemos en try-catch por seguridad absoluta
                                try {
                                    const pCell = sheet.getCell(rIdx, parentColIdx);
                                    // Si pertenece al mismo proyecto/item
                                    if (String(pCell.value) === String(currentParentId)) {
                                        const cCell = sheet.getCell(rIdx, coverColIdx);
                                        // Si está marcada como portada, la desmarcamos
                                        if (String(cCell.value).toLowerCase() === 'si') {
                                            cCell.value = 'No';
                                            hasChanges = true;
                                        }
                                    }
                                } catch (cellError) {
                                    // Ignoramos celdas que no estén en memoria
                                }
                            });
                        }
                    }

                    // APLICAR CAMBIOS
                    Object.keys(op.data).forEach(key => {
                        const colIndex = getHeaderIndex(sheet, key);
                        if (colIndex !== -1) {
                            const cell = sheet.getCell(rowIndex, colIndex);
                            // Normalizar valor a string para comparación flexible, pero guardar el valor real
                            if (String(cell.value) !== String(op.data[key])) {
                                cell.value = op.data[key];
                                hasChanges = true;
                            }
                        }
                    });
                }
            }

            if (hasChanges) {
                await sheet.saveUpdatedCells(); // ¡ESTO ES LO QUE GUARDA DE VERDAD!
            }
        }

        // 3. DELETES (Uno a uno, con limpieza de archivo)
        if (deletes.length > 0) {
            const rows = await sheet.getRows(); 
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const realKey = findRealHeader(sheet, criteriaKey);
                if (!realKey) continue;
                
                const row = rows.find(r => String(r.get(realKey)).trim() === String(op.criteria[criteriaKey]).trim());
                if (row) {
                    const fileId = getSafeValue(row, sheet, 'fileId');
                    if (fileId) try { await drive.files.update({ fileId, requestBody: { trashed: true } }); } catch(e){}
                    await row.delete();
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
