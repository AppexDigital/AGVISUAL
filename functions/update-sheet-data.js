// functions/update-sheet-data.js
// v30.0 - GUARDADO MASIVO DE CELDAS (Batch Cells Fix)
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
    const body = JSON.parse(event.body);
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

        // 1. ADDS (Creación)
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) {
                 op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
            }
            
            // Lógica Portada Única (Add)
            if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
               const rows = await sheet.getRows();
               const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
               const realParentKey = findRealHeader(sheet, parentKey);
               const realCoverKey = findRealHeader(sheet, 'isCover');
               // Si estamos agregando una portada, quitamos las otras primero (esto requiere save individual, inevitable)
               if (realParentKey && realCoverKey) {
                   for (const r of rows) { 
                       if (r.get(realParentKey) === op.data[parentKey] && String(r.get(realCoverKey)).toLowerCase() === 'si') { 
                           r.set(realCoverKey, 'No'); await r.save(); 
                       } 
                   }
               }
            }

            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = findRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            await sheet.addRow(rowData);
        }

        // 2. UPDATES (EDICIÓN MASIVA - CORREGIDO)
        if (updates.length > 0) {
            // A. Cargar filas para encontrar índices y CELDAS para escribir
            const rows = await sheet.getRows(); 
            await sheet.loadCells(); // Carga toda la data para poder escribir en celdas específicas
            
            let hasChanges = false;

            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0];
                const realCriteriaHeader = findRealHeader(sheet, criteriaKey);
                
                if (!realCriteriaHeader) continue;

                // Encontrar la fila usando getRows (que ya tiene los datos mapeados)
                const row = rows.find(r => String(r.get(realCriteriaHeader)).trim() === String(op.criteria[criteriaKey]).trim());

                if (row) {
                    // Lógica Portada Única (Update en memoria)
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const parentKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const realParentKey = findRealHeader(sheet, parentKey);
                        const realCoverKey = findRealHeader(sheet, 'isCover');
                        const coverColIndex = getHeaderIndex(sheet, 'isCover');

                        if (realParentKey && coverColIndex !== -1) {
                            const parentId = row.get(realParentKey);
                            // Recorrer todas las filas para quitar 'Si' a las otras
                            rows.forEach(r => {
                                if (r.get(realParentKey) === parentId && r.rowIndex !== row.rowIndex) {
                                    // Escribir directamente en la celda
                                    const cell = sheet.getCell(r.rowIndex - 1, coverColIndex);
                                    if (String(cell.value).toLowerCase() === 'si') {
                                        cell.value = 'No';
                                        hasChanges = true;
                                    }
                                }
                            });
                        }
                    }

                    // Aplicar cambios de la operación
                    Object.keys(op.data).forEach(key => {
                        const colIndex = getHeaderIndex(sheet, key);
                        if (colIndex !== -1) {
                            // sheet.getCell usa coordenadas (fila, columna). 
                            // row.rowIndex es base-1 (fila 1 es header), getCell es base-0.
                            // Por tanto: fila de datos 1 (rowIndex 2) -> getCell(1, col)
                            const cell = sheet.getCell(row.rowIndex - 1, colIndex);
                            const newVal = op.data[key];
                            if (cell.value !== newVal) {
                                cell.value = newVal;
                                hasChanges = true;
                            }
                        }
                    });
                } else if (['Settings', 'About'].includes(sheetName)) {
                    // Upsert simple si no existe
                     await sheet.addRow({ ...op.criteria, ...op.data });
                }
            }

            if (hasChanges) {
                await sheet.saveUpdatedCells(); // GUARDA TODO DE UN GOLPE
            }
        }

        // 3. DELETES
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

    return { statusCode: 200, body: JSON.stringify({ message: 'Lote procesado' }) };

  } catch (error) {
    console.error('Batch Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
