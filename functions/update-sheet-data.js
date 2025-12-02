// functions/update-sheet-data.js
// v26.0 - CASCADA TOTAL, PORTADAS ÚNICAS Y SOPORTE SETTINGS
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

// --- HELPERS DE NORMALIZACIÓN ---
function findRealHeader(sheet, targetName) {
    const headers = sheet.headerValues;
    const target = targetName.toLowerCase().trim();
    return headers.find(h => h.toLowerCase().trim() === target);
}

function getSafeValue(row, sheet, targetColumnName) {
    const realHeader = findRealHeader(sheet, targetColumnName);
    if (!realHeader) return null;
    return row.get(realHeader);
}

async function findRows(sheet, criteria) {
    if (!criteria) return [];
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();
    const criteriaKey = Object.keys(criteria)[0];
    const realKeyHeader = findRealHeader(sheet, criteriaKey);
    
    if (!realKeyHeader) return [];
    // Comparación flexible (string)
    return rows.filter(row => String(row.get(realKeyHeader)).trim() === String(criteria[criteriaKey]).trim());
}

async function trashFileInDrive(drive, fileId) {
    if (!fileId) return;
    try {
        await drive.files.update({
            fileId: fileId,
            requestBody: { trashed: true },
            supportsAllDrives: true
        });
        console.log(`[Drive] Movido a papelera: ${fileId}`);
    } catch (e) {
        // Si ya no existe (404), lo consideramos éxito
        if (e.code !== 404) console.warn(`[Drive Error] No se pudo mover a papelera ${fileId}: ${e.message}`);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { sheet: sheetTitle, action, data, criteria } = body;
    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: `Hoja ${sheetTitle} no encontrada` }) };
    await sheet.loadHeaderRow();

    // --- ADD (CREAR) ---
    if (action === 'add') {
        // Generación de ID: Solo para tablas de datos, NO para Settings/About
        if (!data.id && !['Settings', 'About'].includes(sheetTitle)) {
             data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        }

        // LOGICA PORTADA ÚNICA (Projects Y RentalItems)
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && String(data.isCover).toLowerCase() === 'si') {
           const rows = await sheet.getRows();
           const parentKeyTarget = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           const realParentKey = findRealHeader(sheet, parentKeyTarget);
           const realCoverKey = findRealHeader(sheet, 'isCover');

           if (realParentKey && realCoverKey) {
               // Poner en "No" todas las demás imágenes de este padre
               for (const r of rows) { 
                   if (r.get(realParentKey) === data[parentKeyTarget] && String(r.get(realCoverKey)).toLowerCase() === 'si') { 
                       r.set(realCoverKey, 'No'); await r.save(); 
                   } 
               }
           }
        }
        
        // Mapeo seguro de columnas (Solo escribe si la columna existe en el Sheet)
        const rowData = {};
        Object.keys(data).forEach(k => {
            const realHeader = findRealHeader(sheet, k);
            if (realHeader) rowData[realHeader] = data[k];
        });

        await sheet.addRow(rowData);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- UPDATE (ACTUALIZAR) ---
    if (action === 'update') {
        const rows = await findRows(sheet, criteria);
        
        // SI ES SETTINGS/ABOUT Y NO EXISTE LA FILA -> CREARLA (UPSERT)
        if (rows.length === 0 && ['Settings', 'About'].includes(sheetTitle)) {
            const newData = { ...criteria, ...data }; // Combinar criterio (ej. key: logo) con datos (value: url)
            await sheet.addRow(newData);
            return { statusCode: 200, body: JSON.stringify({ message: 'Created (Upsert)' }) };
        }

        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado para actualizar' }) };

        // Lógica Portada Única en Update
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && String(data.isCover).toLowerCase() === 'si') {
             const parentKeyTarget = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const realParentKey = findRealHeader(sheet, parentKeyTarget);
             const realCoverKey = findRealHeader(sheet, 'isCover');
             const realIdKey = findRealHeader(sheet, 'id');
             
             if (realParentKey && realCoverKey && realIdKey) {
                 const parentId = row.get(realParentKey);
                 const allRows = await sheet.getRows();
                 for (const r of allRows) {
                     // Si es el mismo padre, pero diferente imagen, quitar portada
                     if (r.get(realParentKey) === parentId && String(r.get(realIdKey)) !== String(row.get(realIdKey)) && String(r.get(realCoverKey)).toLowerCase() === 'si') {
                         r.set(realCoverKey, 'No'); await r.save();
                     }
                 }
             }
        }

        Object.keys(data).forEach(key => { 
            const realHeader = findRealHeader(sheet, key);
            if (realHeader) row.set(realHeader, data[key]);
        });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (BORRAR Y LIMPIAR DRIVE) ---
    if (action === 'delete') {
        const rows = await findRows(sheet, criteria);
        const row = rows[0];
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado para eliminar' }) };

        // 1. Borrar Archivo Asociado (Imágenes, Logos)
        const fileId = getSafeValue(row, sheet, 'fileId');
        if (fileId) await trashFileInDrive(drive, fileId);

        // 2. Borrar Carpetas (Proyectos, Items)
        if (['Projects', 'RentalItems'].includes(sheetTitle)) {
            const folderId = getSafeValue(row, sheet, 'driveFolderId');
            if (folderId) await trashFileInDrive(drive, folderId);

            // CASCADA: Borrar Imágenes Hijas
            const childSheetName = sheetTitle === 'Projects' ? 'ProjectImages' : 'RentalItemImages';
            const childFkTarget = sheetTitle === 'Projects' ? 'projectId' : 'itemId';
            const childSheet = doc.sheetsByTitle[childSheetName];
            
            if (childSheet) {
                await childSheet.loadHeaderRow();
                const realChildFk = findRealHeader(childSheet, childFkTarget);
                const realChildId = findRealHeader(sheet, 'id');
                if (realChildFk && realChildId) {
                    const allChildRows = await childSheet.getRows();
                    const parentIdStr = String(row.get(realChildId));
                    const children = allChildRows.filter(r => String(r.get(realChildFk)) === parentIdStr);
                    
                    for (const child of children) {
                        const childFileId = getSafeValue(child, childSheet, 'fileId');
                        if (childFileId) await trashFileInDrive(drive, childFileId);
                        await child.delete();
                    }
                }
            }
        }

        // 3. CASCADA ESPECIAL SERVICIOS (Bloques + Imágenes)
        if (sheetTitle === 'Services') {
            const realIdKey = findRealHeader(sheet, 'id');
            const serviceId = String(row.get(realIdKey));

            // Borrar Bloques de Contenido
            const blocksSheet = doc.sheetsByTitle['ServiceContentBlocks'];
            if (blocksSheet) {
                await blocksSheet.loadHeaderRow();
                const realBlockFk = findRealHeader(blocksSheet, 'serviceId');
                const allBlocks = await blocksSheet.getRows();
                const blocksToDelete = allBlocks.filter(r => String(r.get(realBlockFk)) === serviceId);
                for (const b of blocksToDelete) await b.delete();
            }

            // Borrar Imágenes de Servicio
            const imagesSheet = doc.sheetsByTitle['ServiceImages'];
            if (imagesSheet) {
                await imagesSheet.loadHeaderRow();
                const realImgFk = findRealHeader(imagesSheet, 'serviceId');
                const allImgs = await imagesSheet.getRows();
                const imgsToDelete = allImgs.filter(r => String(r.get(realImgFk)) === serviceId);
                for (const img of imgsToDelete) {
                     const fId = getSafeValue(img, imagesSheet, 'fileId');
                     if (fId) await trashFileInDrive(drive, fId);
                     await img.delete();
                }
            }
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Fatal Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
