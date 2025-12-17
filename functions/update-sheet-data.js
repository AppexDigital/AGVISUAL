// functions/update-sheet-data.js
// v200.0 - ESTRATEGIA TANQUE (Seguridad Absoluta)
// - Eliminado por completo el uso de celdas (adiós error "Cell not loaded").
// - Incluye helpers getDataVal y getRealHeader corregidos.
// - Lógica de borrado robusta.

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

// Reemplaza tu función getRealHeader con esta:
function getRealHeader(sheet, name) {
    // AJUSTE: Si la hoja no existe o no cargó cabeceras, devuelve undefined sin romper nada
    if (!sheet || !sheet.headerValues) return undefined;
    
    const headers = sheet.headerValues;
    const target = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // AJUSTE: Verifica que 'h' exista antes de aplicar toLowerCase
    return headers.find(h => h && h.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
}

// Helper Sabueso de Datos (ESTE FALTABA)
function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? dataObj[key] : undefined;
}

// Cascada segura (Solo borra filas, deja que el bloque principal borre archivos)
async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        
        await childSheet.loadHeaderRow();
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        
        if (!header) return;

        // Filtrar filas a borrar
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        
        // Borrar uno a uno (Lento pero seguro, evita errores de índice)
        for (const row of rowsToDelete) {
            await row.delete();
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

    /* --- INICIO AJUSTE: INTERCEPTOR DE BORRADO --- */
    // Este bloque permite enviar a la PAPELERA la foto VIEJA cuando guardas una NUEVA.
    for (const op of operations) {
        if (op.action === 'delete_file_only' && op.data && op.data.fileId) {
            try {
                console.log(`[Drive] Moviendo a papelera (Soft Delete): ${op.data.fileId}`);
                // CAMBIO: Usamos 'update' para marcar como 'trashed' en vez de destruir
                await drive.files.update({ 
                    fileId: op.data.fileId, 
                    requestBody: { trashed: true },
                    supportsAllDrives: true 
                });
            } catch (e) {
                console.warn(`[Drive Warning] No se pudo mover a papelera ${op.data.fileId}:`, e.message);
            }
            // Marcamos como procesada para que no intente buscar una fila en Excel
            op._processed = true; 
        }
    }
    /* --- FIN AJUSTE --- */

    const opsBySheet = {};
    operations.forEach(op => {
        if (op._processed) return; // Saltamos las que el interceptor ya manejó
        if (!opsBySheet[op.sheet]) opsBySheet[op.sheet] = [];
        opsBySheet[op.sheet].push(op);
    });

    for (const sheetName of Object.keys(opsBySheet)) {
        const sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) continue;
        // --- VALIDACIÓN ANTI-COLISIÓN (SOLO RESERVAS) ---
        if (sheetName === 'Bookings') {
            const bookingsToAddOrUpdate = sheetOps.filter(op => op.action === 'add' || op.action === 'update');
            
            if (bookingsToAddOrUpdate.length > 0) {
                const blockedSheet = doc.sheetsByTitle['BlockedDates'];
                
                // AJUSTE CRÍTICO: Verificamos si blockedSheet existe antes de usarlo
                if (blockedSheet) {
                    await blockedSheet.loadHeaderRow();
                    const blockedRows = await blockedSheet.getRows();
                    
                    const hStart = getRealHeader(blockedSheet, 'startDate');
                    const hEnd = getRealHeader(blockedSheet, 'endDate');
                    const hItem = getRealHeader(blockedSheet, 'itemId');
                    const hBook = getRealHeader(blockedSheet, 'bookingId');

                    // Solo validamos si encontramos las columnas necesarias
                    if (hStart && hEnd && hItem) {
                        const blocks = blockedRows.map(r => ({
                            start: new Date(r.get(hStart)),
                            end: new Date(r.get(hEnd)),
                            itemId: r.get(hItem),
                            bookingId: hBook ? r.get(hBook) : null
                        }));

                        for (const op of bookingsToAddOrUpdate) {
                            if (op.data.status === 'Cancelado') continue;

                            const reqStart = new Date(op.data.startDate);
                            const reqEnd = new Date(op.data.endDate);
                            const reqItem = op.data.itemId;
                            const currentBookingId = op.criteria ? op.criteria.id : null;

                            const conflict = blocks.find(b => {
                                if (b.itemId !== reqItem) return false;
                                if (currentBookingId && b.bookingId && String(b.bookingId) === String(currentBookingId)) return false;
                                return reqStart <= b.end && reqEnd >= b.start;
                            });

                            if (conflict) {
                                throw new Error(`CONFLICTO: El equipo ya está reservado o bloqueado en esas fechas.`);
                            }
                        }
                    }
                } else {
                    console.warn("Hoja 'BlockedDates' no encontrada. Saltando validación anti-colisión.");
                }
            }
        }
        // --- FIN VALIDACIÓN ---
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

          // AJUSTE: Limpieza de datos. No guardamos URLs de imágenes que caducan.
            const cleanData = { ...op.data };
            
          
            const rowData = {};
            Object.keys(op.data).forEach(k => {
                const h = getRealHeader(sheet, k);
                if (h) rowData[h] = op.data[k];
            });
            await sheet.addRow(rowData); 
        }

        // --- B. ACTUALIZACIÓN (UPDATES) ---
        if (updates.length > 0) {
            // NO usamos loadCells. Usamos getRows (objetos seguros).
            const rows = await sheet.getRows(); 
            
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
                  
                    // Renombrado (Drive) - CORREGIDO
                if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const titleKey = sheetName === 'RentalItems' ? 'name' : 'title';
                      
                        const newTitle = getDataVal(op.data, titleKey);
                        
                        if (newTitle) {
                            const hTitle = getRealHeader(sheet, titleKey);
                            const hFolder = getRealHeader(sheet, 'driveFolderId');
                            
                            const currentTitle = hTitle ? targetRow.get(hTitle) : '';
                            const folderId = hFolder ? targetRow.get(hFolder) : null;

                            if (folderId && currentTitle !== newTitle) {
                                console.log(`[Drive] Renombrando carpeta ${folderId} a "${newTitle}"`);
                                try { 
                                    await drive.files.update({ 
                                        fileId: folderId, 
                                        requestBody: { name: newTitle },
                                        supportsAllDrives: true  // <--- CLAVE PARA CARPETAS COMPARTIDAS
                                    }); 
                                } catch(e){ console.warn("[Drive Error] Renombrado falló:", e.message); }
                            }
                        }
                    }

                    // Lógica Portada Única (Segura con Objetos)
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const pHeader = getRealHeader(sheet, pKey);
                        const cHeader = getRealHeader(sheet, 'isCover');
                        
                        if (pHeader && cHeader) {
                            const currentPId = targetRow.get(pHeader);
                            // Barrido seguro fila por fila
                            for (const r of rows) {
                                if (r !== targetRow && String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') {
                                    r.set(cHeader, 'No');
                                    await r.save(); // Guardado individual seguro
                                }
                            }
                        }
                    }

                    // Aplicar Datos
                    let hasChanges = false;

                  // AJUSTE: Limpieza de datos para Updates
                    const cleanData = { ...op.data };
                    
                  
                    Object.keys(op.data).forEach(key => {
                        const h = getRealHeader(sheet, key);
                        if (h) {
                            targetRow.set(h, op.data[key]);
                            hasChanges = true;
                        }
                    });

                    if (hasChanges) await targetRow.save(); // Guardado individual seguro
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

                // Integridad
                if (sheetName === 'RentalCategories') {
                    const itemsSheet = doc.sheetsByTitle['RentalItems'];
                    if (itemsSheet) {
                        await itemsSheet.loadHeaderRow();
                        const allItems = await itemsSheet.getRows();
                        const catHeader = getRealHeader(itemsSheet, 'categoryId');
                        if (allItems.some(i => String(i.get(catHeader)).trim() === String(criteriaVal))) {
                            throw new Error(`⚠️ No se puede eliminar: Hay equipos asociados.`);
                        }
                    }
                }

                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    // 1. Borrar Archivo Drive (Imagen)
                    // Prioridad: 1. Dato enviado desde frontend 2. Dato en la fila
                    let fileId = getDataVal(op.data, 'fileId');
                    
                    if (!fileId) {
                        const hFile = getRealHeader(sheet, 'fileId');
                        if (hFile) fileId = row.get(hFile);
                    }

                    if (fileId) {
                        console.log(`[Drive] Enviando archivo ${fileId} a papelera`);
                        try { 
                            await drive.files.update({ 
                                fileId: fileId, 
                                requestBody: { trashed: true },
                                supportsAllDrives: true // <--- CLAVE
                            }); 
                        } catch(e) { console.warn("[Drive Error] Borrado archivo:", e.message); }
                    }

                    // 2. Borrar Carpeta y Hijos (Proyecto)
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getRealHeader(sheet, 'driveFolderId');
                        const folderId = hFolder ? row.get(hFolder) : null;
                        
                        if (folderId) {
                            console.log(`[Drive] Enviando carpeta ${folderId} a papelera`);
                            try { 
                                await drive.files.update({ 
                                    fileId: folderId, 
                                    requestBody: { trashed: true },
                                    supportsAllDrives: true // <--- CLAVE
                                }); 
                            } catch(e) { console.warn("[Drive Error] Borrado carpeta:", e.message); }
                        }

                        // Cascada de Hijos (Solo limpieza de Excel)
                        if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal);
                        if (sheetName === 'RentalItems') {
                            await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal);
                            await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal);
                            await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal);
                        }
                        if (sheetName === 'Services') {
                            await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal);
                            await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal);
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
