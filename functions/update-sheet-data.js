// functions/update-sheet-data.js
// v14.0 - BORRADO HÍBRIDO INTELIGENTE (ID + Nombre)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

// Helper para borrar archivo por ID
async function deleteDriveFile(drive, fileId) {
    if (!fileId) return;
    try {
        await drive.files.delete({ fileId, supportsAllDrives: true });
        console.log(`[Drive] Eliminado ID: ${fileId}`);
    } catch (e) {
        console.warn(`[Drive] No se pudo borrar ID ${fileId}:`, e.message);
    }
}

// Helper para borrar carpeta buscando por nombre (Fallback)
async function deleteFolderByName(drive, folderName, categorySubfolder) {
    try {
        const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
        // 1. Buscar carpeta Categoría (ej. Projects)
        const qCat = `mimeType='application/vnd.google-apps.folder' and name='${categorySubfolder}' and '${rootId}' in parents and trashed = false`;
        const resCat = await drive.files.list({ q: qCat, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        
        if (resCat.data.files.length > 0) {
            const parentId = resCat.data.files[0].id;
            // 2. Buscar carpeta del Proyecto dentro
            const qProj = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed = false`;
            const resProj = await drive.files.list({ q: qProj, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
            
            if (resProj.data.files.length > 0) {
                await deleteDriveFile(drive, resProj.data.files[0].id);
                console.log(`[Drive] Eliminada carpeta por nombre: ${folderName}`);
            }
        }
    } catch (e) {
        console.warn(`[Drive] Error búsqueda por nombre ${folderName}:`, e.message);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);

    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: 'Hoja no encontrada' }) };
    
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;

    // --- ADD ---
    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        
        // Portada Única
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
           for (const r of rows) { 
               if (r.get(parentKey) === data[parentKey] && r.get('isCover') === 'Si') { 
                   r.set('isCover', 'No'); await r.save(); 
               } 
           }
        }
        const cleanData = {};
        headers.forEach(h => { if (data[h] !== undefined) cleanData[h] = data[h]; });
        cleanData['id'] = data.id;
        await sheet.addRow(cleanData);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    // --- BUSCAR FILA ---
    const rows = await sheet.getRows();
    const key = Object.keys(criteria)[0];
    const row = rows.find(r => String(r.get(key)) === String(criteria[key]));

    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado.' }) };

    // --- UPDATE ---
    if (action === 'update') {
        if ((sheetTitle === 'ProjectImages' || sheetTitle === 'RentalItemImages') && data.isCover === 'Si') {
             const parentKey = sheetTitle === 'ProjectImages' ? 'projectId' : 'itemId';
             const parentId = row.get(parentKey);
             for (const r of rows) {
                 if (r.get(parentKey) === parentId && r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                     r.set('isCover', 'No'); await r.save();
                 }
             }
        }
        Object.keys(data).forEach(k => { if (headers.includes(k)) row.set(k, data[k]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    // --- DELETE (Lógica Reforzada) ---
    if (action === 'delete') {
        const drive = google.drive({ version: 'v3', auth });

        // 1. BORRAR ARCHIVO DE IMAGEN
        const fileId = row.get('fileId');
        if (fileId) {
            await deleteDriveFile(drive, fileId);
        } else {
             // Intento de rescate: Extraer ID de la URL vieja
             const imgUrl = row.get('imageUrl');
             if (imgUrl && imgUrl.includes('id=')) {
                 const match = imgUrl.match(/id=([a-zA-Z0-9_-]+)/);
                 if (match) await deleteDriveFile(drive, match[1]);
             }
        }

        // 2. BORRAR CARPETA (Si es Proyecto)
        if (sheetTitle === 'Projects' || sheetTitle === 'RentalItems') {
            // A. Intentar por ID
            const folderId = row.get('driveFolderId');
            if (folderId) {
                await deleteDriveFile(drive, folderId);
            } 
            
            // B. Intentar por Nombre (Cazador de carpetas huérfanas)
            // Esto asegura que si el ID falló o no existía, la carpeta se borre igual
            const name = row.get('title') || row.get('name');
            const category = sheetTitle === 'Projects' ? 'Projects' : 'Rentals';
            if (name) {
                await deleteFolderByName(drive, name, category);
            }
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Backend Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
