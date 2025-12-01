// functions/update-sheet-data.js
// v8.0 - ELIMINACIÓN QUIRÚRGICA (IDs para todo)
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

async function findRow(sheet, criteria) {
  if (!criteria) throw new Error("Criteria requerido.");
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const key = Object.keys(criteria)[0];
  return rows.find(row => String(row.get(key)) === String(criteria[key]));
}

// Borrar archivo o carpeta por ID exacto (Infalible)
async function deleteItemById(drive, id) {
    if (!id) return;
    try {
        await drive.files.delete({ fileId: id, supportsAllDrives: true });
        console.log(`[Drive] Item eliminado por ID: ${id}`);
    } catch (e) {
        console.warn(`[Drive] Error borrando ID ${id}:`, e.message);
    }
}

// Fallback: Borrar carpeta por nombre (Solo si no tenemos ID)
async function deleteFolderByNameFallback(drive, folderName, categorySubfolder) {
    try {
        const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
        const qCat = `mimeType='application/vnd.google-apps.folder' and name='${categorySubfolder}' and '${rootId}' in parents and trashed = false`;
        const resCat = await drive.files.list({ q: qCat, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        
        if (resCat.data.files.length === 0) return;
        const categoryId = resCat.data.files[0].id;

        const qProj = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${categoryId}' in parents and trashed = false`;
        const resProj = await drive.files.list({ q: qProj, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });

        if (resProj.data.files.length > 0) {
            await deleteItemById(drive, resProj.data.files[0].id);
        }
    } catch (e) {
        console.warn(`[Drive] Fallback delete falló para ${folderName}:`, e.message);
    }
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { sheet: sheetTitle, action, data, criteria } = JSON.parse(event.body);
    const { doc, drive } = await getServices();
    const sheet = doc.sheetsByTitle[sheetTitle];
    if (!sheet) return { statusCode: 404, body: JSON.stringify({ error: 'Hoja no encontrada.' }) };
    
    await sheet.loadHeaderRow();

    if (action === 'add') {
        if (!data.id) data.id = `${sheetTitle.toLowerCase().slice(0, 5)}_${Date.now()}`;
        // Lógica Portada Única
        if (sheetTitle === 'ProjectImages' && data.isCover === 'Si') {
           const rows = await sheet.getRows();
           for (const r of rows) { if (r.get('projectId') === data.projectId && r.get('isCover') === 'Si') { r.set('isCover', 'No'); await r.save(); } }
        }
        const newRow = await sheet.addRow(data);
        return { statusCode: 200, body: JSON.stringify({ message: 'OK', newId: data.id }) };
    }

    if (action === 'update') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'No encontrado' }) };
        
        if (sheetTitle === 'ProjectImages' && data.isCover === 'Si') {
            const allRows = await sheet.getRows();
            for (const r of allRows) {
                if (r.get('projectId') === row.get('projectId') && r.get('id') !== row.get('id') && r.get('isCover') === 'Si') {
                    r.set('isCover', 'No'); await r.save();
                }
            }
        }

        Object.keys(data).forEach(k => { if (sheet.headerValues.includes(k)) row.set(k, data[k]); });
        await row.save();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    if (action === 'delete') {
        const row = await findRow(sheet, criteria);
        if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Registro no encontrado' }) };

        // 1. BORRAR FOTO INDIVIDUAL (Prioridad ID)
        const fileId = row.get('fileId'); 
        if (fileId) {
            await deleteItemById(drive, fileId);
        } else if (row.get('imageUrl')) {
             // Intento desesperado de extraer ID de la URL vieja si no hay fileId
             const match = row.get('imageUrl').match(/id=([a-zA-Z0-9_-]+)/);
             if (match) await deleteItemById(drive, match[1]);
        }

        // 2. BORRAR CARPETA DE PROYECTO/EQUIPO
        if (sheetTitle === 'Projects' || sheetTitle === 'RentalItems') {
            // Plan A: Usar ID de carpeta si existe (Nuevo sistema)
            const folderId = row.get('driveFolderId');
            if (folderId) {
                await deleteItemById(drive, folderId);
            } else {
                // Plan B: Buscar por nombre (Sistema viejo)
                const name = row.get('title') || row.get('name');
                const cat = sheetTitle === 'Projects' ? 'Projects' : 'Rentals';
                if (name) await deleteFolderByNameFallback(drive, name, cat);
            }

            // Nota: No necesitamos borrar las filas de las fotos hijas manualmente aquí.
            // Lo haremos desde el Frontend (cascada) para asegurar que se limpien bien.
        }

        await row.delete();
        return { statusCode: 200, body: JSON.stringify({ message: 'OK' }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Acción desconocida' }) };

  } catch (error) {
    console.error('Sheet Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
